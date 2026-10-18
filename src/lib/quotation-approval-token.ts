import { createHmac, timingSafeEqual } from "node:crypto";
import type { QuotationRecord } from "./quotation-shared";

interface CustomerApprovalTokenPayload {
  qid: number;
  qno: string;
  resultHash: string;
  validUntil: string;
  internalApprovedAt: string;
  email: string;
}

function approvalSecret(): string {
  const secret = process.env.QUOTATION_APPROVAL_SECRET?.trim() || process.env.AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("quotation_approval_secret_required");
    return "pouch-quotation-approval-development-secret";
  }
  return secret;
}

function payloadOf(record: QuotationRecord): CustomerApprovalTokenPayload {
  return {
    qid: record.id,
    qno: record.quotationNumber,
    resultHash: record.resultHash,
    validUntil: record.validUntil,
    internalApprovedAt: record.internalApproval?.approvedAt ?? "",
    email: typeof record.payload.customerEmail === "string" ? record.payload.customerEmail.trim() : "",
  };
}

export function buildCustomerApprovalToken(record: QuotationRecord): string {
  if (!record.internalApproval) throw new Error("internal_approval_required");
  const body = Buffer.from(JSON.stringify(payloadOf(record)), "utf8").toString("base64url");
  const signature = createHmac("sha256", `${approvalSecret()}:customer-approval`).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function customerApprovalIpHash(ip: string): string {
  return createHmac("sha256", `${approvalSecret()}:customer-approval-client`).update(ip).digest("hex");
}

export function verifyCustomerApprovalToken(token: string): CustomerApprovalTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts;
  const expected = createHmac("sha256", `${approvalSecret()}:customer-approval`).update(body).digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<CustomerApprovalTokenPayload>;
    if (
      typeof parsed.qid !== "number" || !Number.isInteger(parsed.qid) || parsed.qid <= 0
      || typeof parsed.qno !== "string" || !parsed.qno.trim()
      || typeof parsed.resultHash !== "string"
      || typeof parsed.validUntil !== "string"
      || typeof parsed.internalApprovedAt !== "string"
      || typeof parsed.email !== "string"
    ) return null;
    return {
      qid: parsed.qid,
      qno: parsed.qno,
      resultHash: parsed.resultHash,
      validUntil: parsed.validUntil,
      internalApprovedAt: parsed.internalApprovedAt,
      email: parsed.email,
    };
  } catch {
    return null;
  }
}
