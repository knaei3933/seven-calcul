import { AgentAuthError, type AgentRequestContext } from "@/lib/agent-auth-store";
import { canPerformOwnerWorkflowAction } from "@/lib/quotation-access";
import {
  getQuotation,
  getQuotationPdfDownload,
  QuotationPdfIntegrityError,
  isQuotationValidityExpired,
} from "@/lib/quotation-store";
import { buildCustomerApprovalToken } from "@/lib/quotation-approval-token";
import { buildCustomerQuotationEmail } from "@/lib/quotation-email";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";
import { findCustomerDesignAttachments } from "@/lib/customer-design-data";
import type { QuotationRecord } from "@/lib/quotation-shared";

export type AgentQuoteSummary = {
  quotation: {
    id: number;
    number: string;
    ownerDomain: "kanei";
    status: QuotationRecord["status"];
    dates: {
      issueDate: string;
      validUntil: string;
      deliveryDate: string;
      createdAt: string;
      updatedAt: string;
    };
    customer: { name: string };
    product: { name: string };
    spec: string;
    quantity: string;
    pdf: {
      available: boolean;
      fileName: string;
      sha256: string | null;
      byteLength: number | null;
    };
    approvals: {
      internal: { approved: boolean; approvedAt: string | null };
      customer: {
        approvedAt: string | null;
        source: "customer_token" | "owner_domain" | null;
      };
    };
  };
};

export type AgentQuoteEmailDraft = {
  subject: string;
  body: string;
  recipient: string;
  pdf: {
    available: boolean;
    fileName: string;
    sha256: string | null;
    byteLength: number | null;
  };
  designAttachments: Array<{
    fileName: string;
    sizeBytes: number;
    revision: number | null;
    contentType: string | null;
  }>;
  approvalMaterial: {
    policy: "internal_actor_only";
    approvalUrl: string | null;
    approvalUrlEmbeddedInBody: boolean;
    approvalTokenFieldPolicy: "not_returned";
  };
};

export type AgentApprovalState = "customer_approved" | "owner_domain_approved"
  | "awaiting_customer_approval" | "approval_expired" | "approval_blocked"
  | "approval_evidence_unresolved";

export type AgentQuoteApprovalState = {
  quotationId: number;
  quotationNumber: string;
  ownerDomain: "kanei";
  internalApproval: { approved: boolean; approvedAt: string | null };
  customerApproval: {
    state: AgentApprovalState;
    approvedAt: string | null;
    source: "customer_token" | "owner_domain" | null;
  };
};

function authorizedKaneiQuote(context: AgentRequestContext, id: number): Promise<QuotationRecord> {
  if (!Number.isInteger(id) || id <= 0) {
    throw new AgentAuthError(400, "invalid_quotation_id");
  }
  return (async () => {
    const record = await getQuotation(id);
    if (!record) throw new AgentAuthError(404, "quotation_not_found");
    if (record.ownerDomain !== "kanei") {
      throw new AgentAuthError(403, "quote_owner_action_forbidden");
    }
    if (!canPerformOwnerWorkflowAction(
      { id: context.auth.userId, email: context.auth.principalEmail, isActive: true },
      record,
    )) {
      throw new AgentAuthError(403, "quote_owner_action_forbidden");
    }
    return record;
  })();
}

async function pdfMetadata(id: number, fileName: string): Promise<AgentQuoteSummary["quotation"]["pdf"]> {
  const pdf = await getQuotationPdfDownload(id).catch((error) => {
    if (error instanceof QuotationPdfIntegrityError) {
      throw new AgentAuthError(409, "pdf_integrity_failed");
    }
    throw error;
  });
  return {
    available: pdf !== null,
    fileName: pdf?.downloadName ?? fileName,
    sha256: pdf?.sha256 ?? null,
    byteLength: pdf?.data.byteLength ?? null,
  };
}

function originOf(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) return `${forwardedProto ?? "https"}://${forwardedHost}`;
  return new URL(request.url).origin;
}

export async function readAgentQuoteSummary(
  request: Request,
  context: AgentRequestContext,
  id: number,
): Promise<AgentQuoteSummary> {
  const record = await authorizedKaneiQuote(context, id);
  const fileName = buildQuotationPdfFileName({
    issueDate: record.issueDate,
    productName: record.productName,
    customerName: record.customerName,
  });
  return {
    quotation: {
      id: record.id,
      number: record.quotationNumber,
      ownerDomain: "kanei",
      status: record.status,
      dates: {
        issueDate: record.issueDate,
        validUntil: record.validUntil,
        deliveryDate: record.deliveryDate,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
      customer: { name: record.customerName },
      product: { name: record.productName },
      spec: record.sizeSummary,
      quantity: record.quantity,
      pdf: await pdfMetadata(record.id, fileName),
      approvals: {
        internal: {
          approved: Boolean(record.internalApproval),
          approvedAt: record.internalApproval?.approvedAt ?? null,
        },
        customer: {
          approvedAt: record.customerApproval?.approvedAt ?? null,
          source: record.customerApproval?.source ?? null,
        },
      },
    },
  };
}

export async function readAgentQuoteEmailDraft(
  request: Request,
  context: AgentRequestContext,
  id: number,
): Promise<AgentQuoteEmailDraft> {
  const record = await authorizedKaneiQuote(context, id);
  const fileName = buildQuotationPdfFileName({
    issueDate: record.issueDate,
    productName: record.productName,
    customerName: record.customerName,
  });
  const recipient = typeof record.payload.customerEmail === "string"
    ? record.payload.customerEmail.trim()
    : "";
  if (!recipient || recipient.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)) {
    throw new AgentAuthError(409, "customer_email_unavailable");
  }
  const approvalUrl = record.internalApproval
    ? `${originOf(request)}/quote-approvals/${encodeURIComponent(buildCustomerApprovalToken(record))}`
    : null;
  const email = buildCustomerQuotationEmail(
    record,
    approvalUrl ?? "※内部承認後に承認専用URLを発行します",
    fileName,
  );
  let designAttachments: AgentQuoteEmailDraft["designAttachments"] = [];
  try {
    designAttachments = (await findCustomerDesignAttachments(record)).map((file) => ({
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      revision: file.revision,
      contentType: file.contentType,
    }));
  } catch {
    designAttachments = [];
  }
  return {
    subject: email.subject,
    body: email.body,
    recipient,
    pdf: await pdfMetadata(record.id, fileName),
    designAttachments,
    approvalMaterial: {
      policy: "internal_actor_only",
      approvalUrl,
      approvalUrlEmbeddedInBody: approvalUrl !== null && email.body.includes(approvalUrl),
      approvalTokenFieldPolicy: "not_returned",
    },
  };
}

export async function readAgentQuoteApprovalState(
  request: Request,
  context: AgentRequestContext,
  id: number,
): Promise<AgentQuoteApprovalState> {
  void request;
  const record = await authorizedKaneiQuote(context, id);
  let state: AgentApprovalState;
  if (record.customerApproval?.source === "customer_token") {
    state = "customer_approved";
  } else if (record.customerApproval?.source === "owner_domain") {
    state = "owner_domain_approved";
  } else if (record.status === "rejected") {
    state = "approval_blocked";
  } else if (record.status === "expired" || isQuotationValidityExpired(record.validUntil)) {
    state = "approval_expired";
  } else if (record.customerApproval) {
    state = "approval_evidence_unresolved";
  } else {
    state = "awaiting_customer_approval";
  }
  return {
    quotationId: record.id,
    quotationNumber: record.quotationNumber,
    ownerDomain: "kanei",
    internalApproval: {
      approved: Boolean(record.internalApproval),
      approvedAt: record.internalApproval?.approvedAt ?? null,
    },
    customerApproval: {
      state,
      approvedAt: record.customerApproval?.approvedAt ?? null,
      source: record.customerApproval?.source ?? null,
    },
  };
}
