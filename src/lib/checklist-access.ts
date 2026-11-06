import { canActForQuoteOwner } from "./quotation-access";
import { isKaneiTradeUser } from "./film-order-access";
import type { QuotationOwnerDomain } from "./quotation-shared";

/**
 * Legacy callers without a quote owner retain Kanei Trade QA behavior.
 * Owner-aware checklist routes pass the durable quotation owner.
 */
export function canViewInternalChecklist(
  email: string | null | undefined,
  ownerDomain?: QuotationOwnerDomain,
): boolean {
  if (ownerDomain) return canActForQuoteOwner(email, ownerDomain);
  if (!email) return false;
  return isKaneiTradeUser(email);
}

export const KANEI_TRADE_EMAIL_DOMAIN = "@kanei-trade.co.jp";
