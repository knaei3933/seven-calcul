import { normalizeEmail } from "./auth-store";
import { isKaneiTradeUser } from "./film-order-access";

const DEFAULT_INTERNAL_APPROVER_EMAIL = "kim@kanei-trade.co.jp";

export function internalQuotationApproverEmail(): string {
  const configured = process.env.QUOTATION_INTERNAL_APPROVER_EMAIL?.trim();
  return normalizeEmail(configured || DEFAULT_INTERNAL_APPROVER_EMAIL);
}

export function isInternalQuotationApprover(email: string | null | undefined): boolean {
  return normalizeEmail(email ?? "") === internalQuotationApproverEmail();
}

export function canRecordCustomerApproval(email: string | null | undefined): boolean {
  return isKaneiTradeUser(email);
}
