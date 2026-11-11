import {
  AGENT_API_SCOPES,
  AgentAuthError,
  recordAgentAuditEvent,
  type AgentRequestContext,
} from "@/lib/agent-auth-store";
import {
  evaluateCalculationFreshness,
  internalApprovalConfigFromEnv,
  observeInternalApprovalConfig,
  policyLimitExceeded,
  quoteValidityExpired,
  resetInternalApprovalPolicyForTest,
  type InternalApprovalBlockReason,
} from "@/lib/agent-approval-policy";
import {
  approveQuotationGate,
  getQuotation,
  getQuotationPdfDownload,
  QuotationApprovalTransitionError,
  QuotationPdfIntegrityError,
  SampleBulkConfirmationRequiredError,
} from "@/lib/quotation-store";
import { syncFilmOrderFromQuotationRecord } from "@/lib/film-orders";

export { resetInternalApprovalPolicyForTest };

export type InternalApprovalSuccess = {
  outcome: "approved";
  quotationId: number;
  quotationNumber: string;
  ownerDomain: "kanei";
  calculation: { version: string; resultHash: string };
  pdfSha256: string;
  filmOrderSynced: boolean;
};

type EvaluationContext = AgentRequestContext & { quotationId?: number };

async function audit(
  context: EvaluationContext,
  outcome: "allow" | "deny",
  reason: InternalApprovalBlockReason | "allow" | "approval_failed" | "film_order_sync_failed",
  details: {
    calculationSha256?: string;
    quotationId?: string;
    quotationNumber?: string;
    candidateId?: string;
    pdfSha256?: string;
    metadata?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<void> {
  await recordAgentAuditEvent("agent.quote.internal_approval.request", outcome, reason, context.auth.credentialId, context.auth.principalEmail, {
    scope: "internal_approval:request",
    correlationId: context.correlationId,
    ...details,
  });
}

function metadata(context: EvaluationContext, configFingerprint: string): Record<string, string | number | boolean | null> {
  return {
    principal_user_id: context.auth.userId,
    policy_fingerprint: configFingerprint,
  };
}

export async function requestInternalApproval(
  context: AgentRequestContext,
  id: number,
): Promise<InternalApprovalSuccess> {
  const quotationId = Number.isInteger(id) && id > 0 ? id : 0;
  let activeConfigFingerprint: string | null = null;
  let alreadyApproved = false;
  let evaluationContext: EvaluationContext = { ...context, quotationId };
  try {
    if (!context.auth.principalEmail || context.auth.userId <= 0) throw new AgentAuthError(401, "unauthorized");
    if (!context.auth.scopes.includes("internal_approval:request" as typeof AGENT_API_SCOPES[number])) {
      throw new AgentAuthError(403, "forbidden_scope");
    }

    const config = internalApprovalConfigFromEnv();
    activeConfigFingerprint = config.fingerprint;
    const configObservation = await observeInternalApprovalConfig(config);
    if (configObservation !== "unchanged") {
      await recordAgentAuditEvent(
        "agent.internal_approval.config.changed",
        "allow",
        "approval_policy_config_observed",
        context.auth.credentialId,
        context.auth.principalEmail,
        { scope: "internal_approval:request", correlationId: context.correlationId, metadata: metadata(context, config.fingerprint) },
      );
    }
    if (!config.enabled || !config.configComplete) throw new AgentAuthError(409, "approval_disabled");

    if (quotationId === 0) throw new AgentAuthError(400, "invalid_quotation_id");
    const record = await getQuotation(quotationId);
    if (!record) throw new AgentAuthError(404, "quotation_not_found");
    evaluationContext = { ...context, quotationId };
    if (record.ownerDomain !== "kanei") throw new AgentAuthError(403, "owner_domain_blocked");
    if (record.internalApproval || record.status !== "draft") {
      throw new AgentAuthError(409, "invalid_approval_transition");
    }

    const freshness = await evaluateCalculationFreshness(record, config).catch(() => null);
    if (!freshness?.fresh) throw new AgentAuthError(409, "stale_calculation");

    let pdfSha256: string;
    try {
      const pdf = await getQuotationPdfDownload(record.id);
      if (!pdf) throw new Error("missing");
      pdfSha256 = pdf.sha256;
    } catch (error) {
      if (error instanceof AgentAuthError) throw error;
      throw new AgentAuthError(409, error instanceof QuotationPdfIntegrityError ? "pdf_integrity_failed" : "canonical_pdf_required");
    }

    if (quoteValidityExpired(record)) throw new AgentAuthError(409, "quote_expired");
    const warnings = Array.isArray(freshness.result.warnings)
      ? freshness.result.warnings.filter((warning) => !config.acknowledgedWarnings.includes(warning))
      : [];
    const unresolved = warnings.length > 0 || checklistBlocks(record).length > 0;
    if (unresolved) throw new AgentAuthError(409, "validation_blocked");
    if (sampleBulkPending(record)) throw new AgentAuthError(409, "sample_bulk_confirmation_required");
    if (policyLimitExceeded(record, config)) throw new AgentAuthError(409, "policy_limit_exceeded");

    await audit(evaluationContext, "allow", "allow", {
      calculationSha256: record.resultHash,
      quotationId: String(record.id),
      quotationNumber: record.quotationNumber,
      candidateId: typeof record.payload.calculationRequest === "object" && record.payload.calculationRequest
        ? String((record.payload.calculationRequest as { selectedCandidateId?: unknown }).selectedCandidateId ?? "")
        : "",
      pdfSha256,
      metadata: metadata(context, config.fingerprint),
    });

    const approved = await approveQuotationGate(record.id, "internal", context.auth.userId, {
      currentRecord: record,
    });
    alreadyApproved = true;
    const synced = await syncFilmOrderFromQuotationRecord(approved, context.auth.principalEmail);
    return {
      outcome: "approved" as const,
      quotationId: approved.id,
      quotationNumber: approved.quotationNumber,
      ownerDomain: "kanei" as const,
      calculation: { version: approved.calculationVersion, resultHash: approved.resultHash },
      pdfSha256,
      filmOrderSynced: synced,
    };
  } catch (error) {
    if (error instanceof AgentAuthError) {
      const persisted = evaluationContext.quotationId ? await getQuotation(evaluationContext.quotationId) : null;
      const isPolicyDenial = [
        "unauthorized", "forbidden_scope", "approval_disabled", "owner_domain_blocked", "invalid_approval_transition",
        "stale_calculation", "canonical_pdf_required", "pdf_integrity_failed", "quote_expired",
        "validation_blocked", "sample_bulk_confirmation_required", "policy_limit_exceeded",
      ].includes(error.reason);
      if (isPolicyDenial) {
        await audit(evaluationContext, "deny", error.reason as InternalApprovalBlockReason, {
          calculationSha256: persisted?.resultHash,
          quotationId: persisted ? String(persisted.id) : undefined,
          quotationNumber: persisted?.quotationNumber,
          metadata: { policy_evaluator: true, ...metadata(context, activeConfigFingerprint ?? internalApprovalConfigFromEnv().fingerprint) },
        });
      }
      throw error;
    }
    if (error instanceof SampleBulkConfirmationRequiredError || error instanceof QuotationApprovalTransitionError) {
      const reason = error instanceof SampleBulkConfirmationRequiredError ? "sample_bulk_confirmation_required" : "invalid_approval_transition";
      await audit(evaluationContext, "deny", reason, {
        quotationId: String(evaluationContext.quotationId),
        metadata: metadata(context, activeConfigFingerprint ?? internalApprovalConfigFromEnv().fingerprint),
      });
      throw new AgentAuthError(409, reason);
    }
    await audit(evaluationContext, "deny", alreadyApproved ? "film_order_sync_failed" : "approval_failed", {
      quotationId: evaluationContext.quotationId ? String(evaluationContext.quotationId) : undefined,
      metadata: metadata(context, activeConfigFingerprint ?? internalApprovalConfigFromEnv().fingerprint),
    });
    throw new AgentAuthError(500, "approval_failed");
  }
}

function checklistBlocks(record: NonNullable<Awaited<ReturnType<typeof getQuotation>>>): string[] {
  const raw = record.payload.validationBlocks;
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

function sampleBulkPending(record: NonNullable<Awaited<ReturnType<typeof getQuotation>>>): boolean {
  const confirmation = record.payload.sampleBulkConfirmation as { required?: unknown; status?: unknown } | undefined;
  return confirmation?.required === true && confirmation.status !== "received" && confirmation.status !== "confirmed";
}
