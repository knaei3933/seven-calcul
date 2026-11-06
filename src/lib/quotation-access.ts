import { isKaneiTradeUser, isSevenChemicalUser } from "./film-order-access";
import type { QuotationOwnerDomain, QuotationRecord } from "./quotation-shared";

export type QuotationActor = {
  id: number;
  email: string | null | undefined;
  isActive?: boolean;
  role?: string | null;
};

export function canActForQuoteOwner(
  email: string | null | undefined,
  ownerDomain: QuotationOwnerDomain,
): boolean {
  if (ownerDomain === "kanei") return isKaneiTradeUser(email);
  if (ownerDomain === "seven") return isSevenChemicalUser(email);
  return false;
}

function canOwnerCompanyActorAct(
  actor: QuotationActor,
  record: Pick<QuotationRecord, "id" | "ownerDomain" | "createdBy">,
): boolean {
  if (actor.isActive === false) return false;
  // The durable owner company is authoritative. Creator identity alone never
  // grants owner workflow, and inactive users are normalized to an unusable email.
  return record.ownerDomain !== "unresolved"
    && canActForQuoteOwner(actor.email, record.ownerDomain);
}

export function canInternalApproveQuotation(
  email: string | null | undefined,
  ownerDomain: QuotationOwnerDomain,
): boolean {
  return canActForQuoteOwner(email, ownerDomain);
}

export function canManageQuotationCustomerRequest(
  email: string | null | undefined,
  ownerDomain: QuotationOwnerDomain,
): boolean {
  return canActForQuoteOwner(email, ownerDomain);
}

/** Cross-company reads are limited to admins; unresolved records hide from all other domains. */
export function canReadQuotation(actor: QuotationActor, record: Pick<QuotationRecord, "id" | "ownerDomain" | "createdBy">): boolean {
  if (actor.role === "admin") return true;
  if (actor.id === record.createdBy.id) return true;
  return canActForQuoteOwner(actor.email, record.ownerDomain);
}

/**
 * G004 authorization: the creator or a user in the durable owner company may mutate.
 * Admin role grants no implicit ownership. Unresolved owners fail closed for owner workflow,
 * while the explicit creator may perform only generic cleanup such as deletion.
 */
export function canMutateQuotation(
  actor: QuotationActor,
  record: Pick<QuotationRecord, "id" | "ownerDomain" | "createdBy">,
): boolean {
  if (record.ownerDomain === "unresolved") return actor.id === record.createdBy.id;
  // Universal Seven issuance: the active preparer may issue/revise the quote it
  // created, even when the preparer's company differs from Seven.
  if (record.ownerDomain === "seven" && actor.id === record.createdBy.id && actor.isActive !== false) return true;
  return canOwnerCompanyActorAct(actor, record);
}

/** Owner-specific workflow additionally fails closed when the quote owner is unresolved. */
export function canPerformOwnerWorkflowAction(
  actor: QuotationActor,
  record: Pick<QuotationRecord, "id" | "ownerDomain" | "createdBy">,
): boolean {
  return canOwnerCompanyActorAct(actor, record);
}

export function quotationOwnerActionReason(
  actor: QuotationActor,
  record: Pick<QuotationRecord, "id" | "ownerDomain" | "createdBy">,
): string {
  if (canMutateQuotation(actor, record)) return "";
  if (record.ownerDomain === "unresolved") {
    return "所有会社が未解決のため、この操作は実行できません。";
  }
  return record.ownerDomain === "kanei"
    ? "この見積書は金井貿易（KT）の担当者のみ操作できます。"
    : "この見積書はセブン化学（S7）の担当者のみ操作できます。";
}
