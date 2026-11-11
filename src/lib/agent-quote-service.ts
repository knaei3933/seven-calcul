import { createHash } from "node:crypto";
import { getSqlClient, isUniqueViolation, type SqlClient } from "@/lib/db";
import {
  AgentAuthError,
  recordAgentAuditEvent,
  type AgentRequestContext,
} from "@/lib/agent-auth-store";
import { canonicalize } from "@/lib/canonical-json";
import {
  calculatePouchCost,
  type CalculationInput,
  type CostResult,
} from "@/lib/calculation";
import { defaultParameters } from "@/lib/constants";
import {
  readCalculationChecklistSnapshot,
  type CalculationChecklistSnapshot,
} from "@/lib/calculation-checklist";
import {
  CALCULATION_VERSION,
  GRAVURE_MASTER_CALCULATION_VERSION,
} from "@/lib/constants";
import { D, type Decimal } from "@/lib/decimal";
import { resolveFilmUnitPrices } from "@/lib/film-price-store";
import {
  assertDurableGravureDatabase,
  GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR,
  isGravureSnapshotIssuanceEnabled,
  resolveGravureMasters,
  saveGravureSnapshot,
  sha256Canonical,
  tokyoDate,
} from "@/lib/gravure-price-store";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";
import { calculateAutomaticQuotation } from "@/lib/quotation-pricing";
import {
  getQuotation,
  getQuotationPdf,
  saveIssuedQuotation,
  type CanonicalQuotationPdfFactory,
  type IssuedQuotationResult,
} from "@/lib/quotation-store";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";
import {
  buildCanonicalQuotationPdfModel,
  renderCanonicalQuotationPdf,
} from "@/lib/standard-quote-pdf";
import { hasValidSimulatorProvenance } from "@/app/api/quotations/route";

export const AGENT_ISSUANCE_TARGET_MARGIN = "0.4";
const IDEMPOTENCY_LEASE_MS = 30_000;
const IDEMPOTENCY_WAIT_MS = 10_000;
const FORBIDDEN_PRICING_KEYS = new Set([
  "pricePerPiece", "subtotal", "tax", "grandTotal", "filmCost", "filmCostPerPiece",
  "filmMeterPrice", "filmOrderLengthM", "cost", "costs", "costTotal", "margin",
  "targetMargin", "targetMargins", "selectedCandidateTargetMargins", "commission",
  "commissionRate", "pricingSnapshot", "resultHash", "profit", "supplier",
]);
const FORBIDDEN_CHECKLIST_INJECTION_KEYS = new Set([
  "supplier", "supplierName", "pricingSnapshot", "commission", "commissionRate",
  "payload", "payloadJson", "calculationFilmTotal", "profitAudit", "internalAudit",
]);

type AgentIssueRequest = {
  calculationRequest: CalculationInput;
  calculationEvidence: { calculationVersion: string; resultHash: string };
  calculationChecklist: CalculationChecklistSnapshot;
  selectedCandidateId: string;
  issue: Record<string, string>;
};

type IdempotencyRow = {
  credential_id: string;
  idempotency_key: string;
  fingerprint: string;
  status: "pending" | "completed" | "failed";
  response_json: string | null;
  status_code: number | null;
  quotation_id: number | null;
  updated_at: string;
};

export type AgentIssueSuccess = {
  outcome: "issued" | "duplicate";
  idempotency: { replay: boolean };
  quotation: {
    id: number;
    number: string;
    ownerDomain: "kanei";
    financials: {
      unitPrice: string;
      subtotal: string;
      tax: string;
      grandTotal: string;
    };
  };
  calculation: { version: string; resultHash: string };
  selectedCandidate: {
    id: string;
    printingMethod: CostResult["printingMethod"];
    adjustedQuantity: number;
    requiredLengthM: string;
    orderLengthM: string;
  };
  pdf: {
    fileName: string;
    sha256: string;
    byteLength: number;
    rendererVersion: string;
  };
  nextStates: {
    emailDraftAvailable: true;
    humanMailDispatchPending: true;
    customerTokenPending: true;
  };
  warnings: string[];
};

let schemaReady: Promise<SqlClient> | null = null;

async function issuanceDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_quote_idempotency (
        credential_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
        response_json TEXT,
        status_code INTEGER,
        quotation_id INTEGER,
        quotation_number TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (credential_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_quote_idempotency_updated
        ON agent_quote_idempotency(credential_id, updated_at);
    `);
    return db;
  })();
  return schemaReady;
}

export async function resetAgentQuoteServiceForTest(): Promise<void> {
  schemaReady = null;
}

function rejectForbiddenPricingAuthority(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenPricingAuthority);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_PRICING_KEYS.has(key)) throw new AgentAuthError(400, "client_pricing_authority_rejected");
    rejectForbiddenPricingAuthority(entry);
  }
}

function rejectChecklistInjection(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_CHECKLIST_INJECTION_KEYS.has(key)) {
      throw new AgentAuthError(400, "client_pricing_authority_rejected");
    }
  }
}

function boundedText(value: unknown, field: string, maxLength: number, required = false): string {
  if (typeof value !== "string") throw new AgentAuthError(400, `invalid_issue_field:${field}`);
  const normalized = value.replace(/\p{C}/gu, "").trim();
  if ((required && !normalized) || normalized.length > maxLength) {
    throw new AgentAuthError(400, `invalid_issue_field:${field}`);
  }
  return normalized;
}

function isoDate(value: unknown, field: string): string {
  const normalized = boundedText(value, field, 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new AgentAuthError(400, `invalid_issue_field:${field}`);
  }
  return normalized;
}

function parseIssue(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentAuthError(400, "invalid_issue");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "issueDate", "validUntil", "customerName", "customerContact", "customerCode",
    "customerPostalCode", "customerAddress", "customerTelephone", "customerEmail",
    "productName", "sizeSummary", "deliveryDate", "paymentTerms", "notes",
    "filmComposition", "greeting",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new AgentAuthError(400, "invalid_issue");
  }
  const customerEmail = boundedText(input.customerEmail, "customerEmail", 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(customerEmail)) {
    throw new AgentAuthError(400, "invalid_issue_field:customerEmail");
  }
  const parsed = {
    issueDate: isoDate(input.issueDate, "issueDate"),
    validUntil: isoDate(input.validUntil, "validUntil"),
    customerName: boundedText(input.customerName, "customerName", 200, true),
    customerContact: boundedText(input.customerContact, "customerContact", 200),
    customerCode: boundedText(input.customerCode, "customerCode", 100),
    customerPostalCode: boundedText(input.customerPostalCode, "customerPostalCode", 20, true),
    customerAddress: boundedText(input.customerAddress, "customerAddress", 300, true),
    customerTelephone: boundedText(input.customerTelephone, "customerTelephone", 40, true),
    customerEmail,
    productName: boundedText(input.productName, "productName", 200, true),
    sizeSummary: boundedText(input.sizeSummary, "sizeSummary", 200),
    deliveryDate: boundedText(input.deliveryDate, "deliveryDate", 100),
    paymentTerms: boundedText(input.paymentTerms, "paymentTerms", 200),
    notes: boundedText(input.notes, "notes", 1000),
    filmComposition: boundedText(input.filmComposition, "filmComposition", 300),
    greeting: boundedText(input.greeting, "greeting", 1000),
  };
  if (parsed.issueDate > parsed.validUntil) {
    throw new AgentAuthError(400, "invalid_issue_field:validUntil");
  }
  return parsed;
}

function parseRequest(value: unknown): AgentIssueRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentAuthError(400, "invalid_request");
  }
  const input = value as Record<string, unknown>;
  const allowedRoots = new Set([
    "calculationRequest", "calculationEvidence", "calculationChecklist",
    "selectedCandidateId", "issue",
  ]);
  if (Object.keys(input).some((key) => !allowedRoots.has(key))) {
    throw new AgentAuthError(400, "invalid_request");
  }
  rejectForbiddenPricingAuthority(input.calculationRequest);
  rejectForbiddenPricingAuthority(input.issue);
  if (!input.calculationRequest || typeof input.calculationRequest !== "object" || Array.isArray(input.calculationRequest)) {
    throw new AgentAuthError(400, "invalid_calculation_request");
  }
  const evidence = input.calculationEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)
    || Object.keys(evidence).sort().join(",") !== "calculationVersion,resultHash"
    || typeof (evidence as Record<string, unknown>).calculationVersion !== "string"
    || !/^[a-f0-9]{64}$/u.test(String((evidence as Record<string, unknown>).resultHash))) {
    throw new AgentAuthError(400, "invalid_calculation_evidence");
  }
  const checklist = readCalculationChecklistSnapshot(input.calculationChecklist);
  rejectChecklistInjection(checklist);
  if (!checklist) throw new AgentAuthError(400, "invalid_calculation_checklist");
  if (typeof input.selectedCandidateId !== "string"
    || !/^[A-Z]-[A-Za-z0-9-]{1,80}$/u.test(input.selectedCandidateId)) {
    throw new AgentAuthError(400, "invalid_selected_candidate");
  }
  return {
    calculationRequest: structuredClone(input.calculationRequest as CalculationInput),
    calculationEvidence: structuredClone(evidence as AgentIssueRequest["calculationEvidence"]),
    calculationChecklist: checklist,
    selectedCandidateId: input.selectedCandidateId,
    issue: parseIssue(input.issue),
  };
}

function amount(value: string | number | Decimal): string {
  return D(value).toFixed();
}

async function deriveVerifiedCalculation(
  parsed: AgentIssueRequest,
  principalEmail: string,
): Promise<{
  request: CalculationInput;
  result: CostResult;
  snapshotProjection?: unknown;
}> {
  const request = structuredClone(parsed.calculationRequest);
  if (!request.spec || !request.quantity || !request.printingMethod
    || request.recommendationMode !== true
    || Object.hasOwn(request, "selectedCandidateId")
    || Object.hasOwn(request, "selectedCandidateTargetMargins")) {
    throw new AgentAuthError(400, "invalid_calculation_request");
  }
  request.selectedCandidateId = parsed.selectedCandidateId;
  request.selectedCandidateTargetMargins = [AGENT_ISSUANCE_TARGET_MARGIN];
  const gravure = request.printingMethod === "gravure";
  if (gravure) {
    if (!isGravureSnapshotIssuanceEnabled()) {
      throw new AgentAuthError(503, GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR);
    }
    assertDurableGravureDatabase();
  }
  const asOf = gravure ? tokyoDate() : new Date().toISOString().slice(0, 10);
  const digitalValues = await resolveFilmUnitPrices(asOf, defaultParameters.filmUnitPrices);
  request.parameters = { ...(request.parameters ?? {}), filmUnitPrices: digitalValues };
  let snapshotProjection: unknown;
  let result: CostResult;
  if (gravure) {
    const resolved = await resolveGravureMasters(asOf);
    const { defaultGravureRollParameters } = await import("@/lib/gravure-roll");
    request.gravureParameters = resolved.kSet?.derived ?? defaultGravureRollParameters();
    request.gravureYRows = resolved.yRows;
    result = calculatePouchCost(request);
    const snapshot = await saveGravureSnapshot({
      asOf,
      digitalValues,
      resolved,
      request,
      result,
      createdBy: principalEmail,
    });
    if (result.audit.calculationVersion !== GRAVURE_MASTER_CALCULATION_VERSION
      || snapshot.snapshotSha256 !== snapshot.canonicalPublicProjection.pricingSnapshot.sha256
      || snapshot.publicProjectionSha256 !== sha256Canonical(snapshot.canonicalPublicProjection)) {
      throw new AgentAuthError(400, "pricing_snapshot_invalid");
    }
    snapshotProjection = {
      id: snapshot.id,
      sha256: snapshot.snapshotSha256,
      publicProjection: {
        ...snapshot.canonicalPublicProjection,
        publicProjectionHash: snapshot.publicProjectionSha256,
      },
    };
  } else {
    result = calculatePouchCost(request);
    if (result.audit.calculationVersion !== CALCULATION_VERSION) {
      throw new AgentAuthError(409, "stale_calculation");
    }
    const selected = result.recommendationCandidates?.find(
      (candidate) => candidate.id === result.selectedCandidateId,
    );
    if (!selected || result.selectedCandidateId !== parsed.selectedCandidateId) {
      throw new AgentAuthError(409, "selected_candidate_invalid");
    }
  }
  if (result.audit.resultJsonSha256 !== parsed.calculationEvidence.resultHash
    || result.audit.calculationVersion !== parsed.calculationEvidence.calculationVersion) {
    throw new AgentAuthError(400, "calculation_provenance_invalid");
  }
  return { request, result, snapshotProjection };
}

function buildIssuanceInput(input: {
  parsed: AgentIssueRequest;
  request: CalculationInput;
  result: CostResult;
  snapshotProjection?: unknown;
}): QuotationRecordInput {
  const checklist = structuredClone(input.parsed.calculationChecklist);
  checklist.quotationNumber = "agent-issuance-pending";
  checklist.customerName = input.parsed.issue.customerName;
  checklist.calculationVersion = input.result.audit.calculationVersion;
  const totals = calculateAutomaticQuotation(input.result, AGENT_ISSUANCE_TARGET_MARGIN, "10");
  if (!totals) throw new AgentAuthError(400, "quotation_pricing_invalid");
  const payload = {
    ...checklist,
    resultHash: input.result.audit.resultJsonSha256,
    printingMethod: input.result.printingMethod,
    quantity: amount(input.result.quantity),
    filmOrderLengthM: amount(input.result.film.orderLengthM),
    calculationFilmTotal: amount(input.result.film.filmTotal),
    calculationRequest: input.request,
    calculationChecklistSnapshot: checklist,
    ...(input.snapshotProjection ? { pricingSnapshot: input.snapshotProjection } : {}),
  };
  const record: QuotationRecordInput = {
    quotationNumber: "",
    status: "draft",
    issueDate: input.parsed.issue.issueDate,
    validUntil: input.parsed.issue.validUntil,
    customerName: input.parsed.issue.customerName,
    customerContact: input.parsed.issue.customerContact,
    productName: input.parsed.issue.productName,
    sizeSummary: input.parsed.issue.sizeSummary,
    quantity: amount(input.result.quantity),
    fillingCostPerPiece: amount(totals.fillingCostPerPiece),
    filmCostPerPiece: amount(input.result.costPerPieceComponents.film),
    filmMeterPrice: amount(input.result.film.unitPrice),
    filmOrderLengthM: amount(input.result.film.orderLengthM),
    targetMargin: amount(AGENT_ISSUANCE_TARGET_MARGIN),
    taxRatePercent: "10.00",
    pricePerPiece: amount(totals.display.pricePerPiece),
    subtotal: amount(totals.display.subtotal),
    tax: amount(totals.display.tax),
    grandTotal: amount(totals.display.grandTotal),
    deliveryDate: input.parsed.issue.deliveryDate,
    paymentTerms: input.parsed.issue.paymentTerms,
    notes: input.parsed.issue.notes,
    calculationVersion: input.result.audit.calculationVersion,
    resultHash: input.result.audit.resultJsonSha256,
    payload,
  };
  if (!hasValidSimulatorProvenance(record)) {
    throw new AgentAuthError(400, "calculation_provenance_invalid");
  }
  const profile = quotationOwnerProfile("kanei");
  if (!profile) throw new AgentAuthError(500, "kanei_owner_profile_missing");
  record.payload = {
    ...record.payload,
    customerPostalCode: input.parsed.issue.customerPostalCode,
    customerAddress: input.parsed.issue.customerAddress,
    customerCode: input.parsed.issue.customerCode,
    customerEmail: input.parsed.issue.customerEmail,
    customerTelephone: input.parsed.issue.customerTelephone,
    greeting: input.parsed.issue.greeting,
    skuNames: input.result.film.skuCosts.map(() => input.parsed.issue.productName),
    fillingItemName: "充填・加工",
    fillingItemDescription: "お見積りした内容による充填・加工",
    fillingUnitDisplay: totals.display.fillingUnit,
    fillingAmountDisplay: totals.display.fillingAmount,
    bulkItemName: "バルク液体",
    bulkItemDescription: "バルク液体",
    bulkUnitDisplay: totals.display.bulkUnit,
    bulkAmountDisplay: totals.display.bulkAmount,
    filmItemName: "フィルム",
    filmComposition: input.parsed.issue.filmComposition,
    filmUnitDisplay: totals.display.filmUnit,
    filmPouchUnitDisplay: totals.display.filmPouchUnit,
    filmAmountDisplay: totals.display.filmAmount,
    copperItemName: "銅版",
    copperUnitDisplay: totals.display.copperUnit,
    copperColorCount: totals.display.copperColorCount,
    copperAmountDisplay: totals.display.copperAmount,
    printingMethod: input.result.printingMethod,
    approverName: profile.representative,
    sealText: "検討済",
    footerContact: {
      companyName: profile.legalName,
      contactName: profile.representative,
      email: profile.defaultContactEmail,
      telephone: profile.defaultContactTelephone,
    },
  };
  return record;
}

const canonicalAgentPdfFactory: CanonicalQuotationPdfFactory = async ({
  input,
  ownerDomain,
  quotationNumber,
}) => renderCanonicalQuotationPdf(
  buildCanonicalQuotationPdfModel(input, quotationNumber, ownerDomain),
  ownerDomain,
);

function successFromIssuance(issued: IssuedQuotationResult): AgentIssueSuccess {
  const provenance = issued.record.payload.canonicalPdfProvenance as {
    rendererVersion?: unknown;
  } | undefined;
  const request = issued.record.payload.calculationRequest as {
    selectedCandidateId?: unknown;
  } | undefined;
  const checklist = issued.record.payload.calculationChecklistSnapshot as {
    requiredLengthM?: unknown;
    warnings?: unknown;
  } | undefined;
  return {
    outcome: "issued",
    idempotency: { replay: false },
    quotation: {
      id: issued.record.id,
      number: issued.record.quotationNumber,
      ownerDomain: "kanei",
      financials: {
        unitPrice: issued.record.pricePerPiece,
        subtotal: issued.record.subtotal,
        tax: issued.record.tax,
        grandTotal: issued.record.grandTotal,
      },
    },
    calculation: {
      version: issued.record.calculationVersion,
      resultHash: issued.record.resultHash,
    },
    selectedCandidate: {
      id: String(request?.selectedCandidateId ?? ""),
      printingMethod: issued.record.payload.printingMethod as CostResult["printingMethod"],
      adjustedQuantity: Number(issued.record.quantity),
      requiredLengthM: String(checklist?.requiredLengthM ?? ""),
      orderLengthM: issued.record.filmOrderLengthM,
    },
    pdf: {
      fileName: buildQuotationPdfFileName({
        issueDate: issued.record.issueDate,
        productName: issued.record.productName,
        customerName: issued.record.customerName,
      }),
      sha256: issued.pdfSha256,
      byteLength: issued.pdfByteLength,
      rendererVersion: String(provenance?.rendererVersion ?? ""),
    },
    nextStates: {
      emailDraftAvailable: true,
      humanMailDispatchPending: true,
      customerTokenPending: true,
    },
    warnings: checklist?.warnings ? ["calculation_warnings_present"] : [],
  };
}

async function audit(
  context: AgentRequestContext,
  operation: string,
  outcome: "allow" | "deny" | "error",
  reason: string,
  details: {
    calculationSha256?: string;
    quotationId?: string;
    quotationNumber?: string;
    candidateId?: string;
    pdfSha256?: string;
    metadata?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<void> {
  await recordAgentAuditEvent(operation, outcome, reason, context.auth.credentialId, context.auth.principalEmail, {
    scope: "quote:issue",
    ...details,
  });
}

async function claimIdempotency(input: {
  db: SqlClient;
  credentialId: string;
  key: string;
  fingerprint: string;
}): Promise<{ row: IdempotencyRow; created: boolean }> {
  const now = new Date().toISOString();
  try {
    await input.db.run(`
      INSERT INTO agent_quote_idempotency
        (credential_id,idempotency_key,fingerprint,status,response_json,status_code,quotation_id,quotation_number,created_at,updated_at)
      VALUES (?,?,?,'pending',NULL,NULL,NULL,NULL,?,?)
    `, [input.credentialId, input.key, input.fingerprint, now, now]);
    const inserted = await input.db.get<IdempotencyRow>(
      "SELECT * FROM agent_quote_idempotency WHERE credential_id = ? AND idempotency_key = ?",
      [input.credentialId, input.key],
    );
    if (!inserted) throw new AgentAuthError(500, "idempotency_state_unavailable");
    return { row: inserted, created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await input.db.get<IdempotencyRow>(
      "SELECT * FROM agent_quote_idempotency WHERE credential_id = ? AND idempotency_key = ?",
      [input.credentialId, input.key],
    );
    if (!existing) throw new AgentAuthError(500, "idempotency_state_unavailable");
    return { row: existing, created: false };
  }
}

function replayOutcome(row: IdempotencyRow): { status: number; body: unknown } | null {
  if (!row.response_json || row.status_code == null) return null;
  if (row.status === "failed") return { status: row.status_code, body: JSON.parse(row.response_json) };
  if (row.status !== "completed") return null;
  const original = JSON.parse(row.response_json) as AgentIssueSuccess;
  return {
    status: 200,
    body: { ...original, outcome: "duplicate", idempotency: { replay: true } },
  };
}

async function recoverPending(db: SqlClient, row: IdempotencyRow): Promise<boolean> {
  if (row.quotation_id != null) {
    const record = await getQuotation(Number(row.quotation_id));
    const pdf = record && record.ownerDomain === "kanei" ? await getQuotationPdf(record.id) : null;
    if (record && pdf) {
      const recovered = {
        ...successFromIssuance({
          record,
          created: true,
          pdfSha256: String(
            (record.payload.canonicalPdfProvenance as { outputSha256?: unknown } | undefined)?.outputSha256 ?? "",
          ),
          pdfByteLength: pdf.data.byteLength,
        }),
        outcome: "duplicate" as const,
        idempotency: { replay: true },
      };
      await db.run(`
        UPDATE agent_quote_idempotency
        SET status='completed',response_json=?,status_code=201,updated_at=?
        WHERE credential_id=? AND idempotency_key=? AND status='pending'
      `, [
        JSON.stringify(recovered),
        new Date().toISOString(),
        row.credential_id,
        row.idempotency_key,
      ]);
      return true;
    }
  }
  return Date.now() - new Date(row.updated_at).getTime() < IDEMPOTENCY_LEASE_MS;
}

export async function issueAgentQuote(
  request: Request,
  context: AgentRequestContext,
): Promise<Response> {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/u.test(key)) {
    await audit(context, "quote.issue.failure", "deny", "idempotency_key_required");
    throw new AgentAuthError(400, "idempotency_key_required");
  }
  let rawRequest: unknown;
  try {
    rawRequest = await request.json();
  } catch {
    await audit(context, "quote.issue.failure", "deny", "invalid_request");
    throw new AgentAuthError(400, "invalid_request");
  }
  const fingerprint = createHash("sha256").update(canonicalize(rawRequest)).digest("hex");
  const db = await issuanceDatabase();
  const claim = await claimIdempotency({ db, credentialId: context.auth.credentialId, key, fingerprint });
  const claimed = claim.row;
  if (!claim.created && claimed.fingerprint !== fingerprint) {
    await audit(context, "quote.issue.conflict", "deny", "idempotency_conflict", {
      metadata: { key_bound: true },
    });
    throw new AgentAuthError(409, "idempotency_conflict");
  }
  const replay = replayOutcome(claimed);
  if (replay) {
    const success = replay.status < 400;
    await audit(
      context,
      success ? "quote.issue.duplicate" : "quote.issue.retry",
      "allow",
      success ? "duplicate_issued" : "failed_request_replayed",
      { metadata: { idempotency_replay: true } },
    );
    return Response.json(replay.body, { status: replay.status, headers: { "cache-control": "no-store" } });
  }
  if (!claim.created && claimed.status === "pending" && await recoverPending(db, claimed)) {
    const waitedUntil = Date.now() + IDEMPOTENCY_WAIT_MS;
    while (Date.now() < waitedUntil) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const current = await db.get<IdempotencyRow>(
        "SELECT * FROM agent_quote_idempotency WHERE credential_id = ? AND idempotency_key = ?",
        [context.auth.credentialId, key],
      );
      if (!current) break;
      const completed = replayOutcome(current);
      if (completed) {
        await audit(context, "quote.issue.duplicate", "allow", "duplicate_issued", {
          metadata: { idempotency_replay: true },
        });
        return Response.json(completed.body, {
          status: completed.status,
          headers: { "cache-control": "no-store" },
        });
      }
      if (current.status === "failed") break;
    }
    await audit(context, "quote.issue.duplicate", "deny", "issuance_in_progress", {
      metadata: { idempotency_pending: true },
    });
    throw new AgentAuthError(409, "issuance_in_progress");
  }
  if (!claim.created && claimed.status === "pending") {
    const leaseClaimed = await db.run(`
      UPDATE agent_quote_idempotency
      SET updated_at=?
      WHERE credential_id=? AND idempotency_key=? AND status='pending'
        AND updated_at <= ?
    `, [
      new Date().toISOString(),
      context.auth.credentialId,
      key,
      new Date(Date.now() - IDEMPOTENCY_LEASE_MS).toISOString(),
    ]);
    if (leaseClaimed.changes !== 1) {
      await audit(context, "quote.issue.duplicate", "deny", "issuance_in_progress", {
        metadata: { idempotency_pending: true },
      });
      throw new AgentAuthError(409, "issuance_in_progress");
    }
  }
  try {
    const parsed = parseRequest(rawRequest);
    const derived = await deriveVerifiedCalculation(parsed, context.auth.principalEmail);
    const issuanceInput = buildIssuanceInput({ parsed, ...derived });
    const issued = await saveIssuedQuotation(
      issuanceInput,
      context.auth.userId,
      "user",
      null,
      buildQuotationPdfFileName({
        issueDate: issuanceInput.issueDate,
        productName: issuanceInput.productName,
        customerName: issuanceInput.customerName,
      }),
      (issuanceInput.payload.calculationChecklistSnapshot ?? null) as CalculationChecklistSnapshot | null,
      { canonicalPdfFactory: canonicalAgentPdfFactory },
    );
    const success = successFromIssuance(issued);
    await db.run(`
      UPDATE agent_quote_idempotency
      SET status='completed',response_json=?,status_code=201,quotation_id=?,quotation_number=?,updated_at=?
      WHERE credential_id=? AND idempotency_key=? AND status='pending'
    `, [
      JSON.stringify(success),
      String(issued.record.id),
      issued.record.quotationNumber,
      new Date().toISOString(),
      context.auth.credentialId,
      key,
    ]);
    await audit(context, "quote.issue", "allow", "quotation_issued", {
      calculationSha256: issued.record.resultHash,
      quotationId: String(issued.record.id),
      quotationNumber: issued.record.quotationNumber,
      candidateId: success.selectedCandidate.id,
      pdfSha256: issued.pdfSha256,
      metadata: { idempotency: "created", owner_domain: "kanei" },
    });
    return Response.json(success, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const reason = error instanceof AgentAuthError ? error.reason : "quotation_issue_failed";
    const status = error instanceof AgentAuthError ? error.status : 500;
    await db.run(`
      UPDATE agent_quote_idempotency
      SET status='failed',response_json=?,status_code=?,updated_at=?
      WHERE credential_id=? AND idempotency_key=? AND status='pending'
    `, [
      JSON.stringify({ error: reason }),
      status,
      new Date().toISOString(),
      context.auth.credentialId,
      key,
    ]);
    await audit(context, "quote.issue.failure", "error", reason, {
      metadata: { idempotency: "failed" },
    });
    throw error;
  }
}
