/**
 * フィルム発注ワークフローの権限。
 * 商流は「顧客 → セブン化学（パウチ充填製造） → 金井貿易（フィルム調達） → フィルムメーカー」。
 * 見積の営業チャネル所有者が誰であっても、フィルム発注主は Seven Chemical (@727.co.jp)。
 * - セブン化学: Buyer操作（発注書送信・入稿・Buyer最終承認・受領）
 * - 金井貿易: フィルム調達・校正データ登録・金井貿易承認・メーカー発注
 */
export const SEVEN_CHEMICAL_EMAIL_DOMAIN = "@727.co.jp";
export const KANEI_TRADE_EMAIL_DOMAIN = "@kanei-trade.co.jp";

function hasDomain(email: string | null | undefined, domain: string): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(domain);
}

export function isSevenChemicalUser(email: string | null | undefined): boolean {
  return hasDomain(email, SEVEN_CHEMICAL_EMAIL_DOMAIN);
}

export type CustomerOwnerDomain = "seven" | "kanei";

export function customerOwnerDomainOf(email: string | null | undefined): CustomerOwnerDomain {
  return isKaneiTradeUser(email) ? "kanei" : "seven";
}

export function isKaneiTradeUser(email: string | null | undefined): boolean {
  return hasDomain(email, KANEI_TRADE_EMAIL_DOMAIN);
}

export type SupplierLocale = "ko" | "ja";

/**
 * 原材料調達先の言語。
 * - digital / K（韓国輸入）→ Korean
 * - Y（国内調達）        → Japanese
 */
export function supplierLocaleFor(order: { procurement_route: string | null | undefined }): SupplierLocale {
  return order.procurement_route === "Y" ? "ja" : "ko";
}

export function canViewFilmOrders(email: string | null | undefined): boolean {
  return isSevenChemicalUser(email) || isKaneiTradeUser(email);
}

/** 発注側ドメイン（見積作成者の会社）を返す。 */
export function buyerDomainOf(createdByEmail: string | null | undefined): "seven" | "kanei" {
  return isSevenChemicalUser(createdByEmail) ? "seven" : "kanei";
}

export type FilmOrderActionSide = "buyer" | "kanei" | "buyer_and_kanei";

const ACTION_SIDE: Record<string, FilmOrderActionSide> = {
  "mark-ordered": "buyer",
  "register-receiving": "buyer",
  "register-receiving-extra": "buyer",
  "resend-receiving-notice": "buyer",
  approve: "buyer",
  "request-re-proof": "buyer",
  "request-customer-design-upload": "buyer",
  "confirm-customer-design": "buyer",
  "request-customer-design-correction": "buyer",
  "set-customer-design-not-required": "buyer",
  "send-customer-proof-review": "kanei",
  "record-customer-proof-approval": "kanei",
  "register-proof": "kanei",
  "send-proof-notice": "kanei",
  "rotate-supplier-proof-token": "kanei",
  "set-supplier": "kanei",
  "update-supplier-order-note": "kanei",
  "preview-supplier-po": "kanei",
  "send-po": "kanei",
  "request-ship-to-registration": "buyer_and_kanei",
  "register-ship-to": "buyer_and_kanei",
  "confirm-ship-to": "buyer_and_kanei",
  "save-production-plan": "buyer",
  "confirm-production-plan": "buyer",
  "request-production-plan": "kanei",
  "resend-supplier-links": "kanei",
  "confirm-film-receipt": "buyer",
};

/**
 * セブン化学が buyer 操作を、金井貿易が seller 側操作を行う。
 * buyer_domain が旧データで空/金井の場合も、現行商流では互換目的に限定する。
 */
export function canPerformFilmOrderAction(
  action: string,
  actorEmail: string | null | undefined,
  buyerDomain: string,
): boolean {
  const side = ACTION_SIDE[action];
  if (!side) return false;
  const buyer = buyerDomain.includes("727") ? "seven" : "kanei";
  if (side === "buyer") {
    return buyer === "seven" ? isSevenChemicalUser(actorEmail) : isKaneiTradeUser(actorEmail);
  }
  if (side === "buyer_and_kanei") {
    return isSevenChemicalUser(actorEmail) || isKaneiTradeUser(actorEmail);
  }
  return isKaneiTradeUser(actorEmail);
}

/** 発注ワークフロー一覧は Seven/Kanei が共有する。処理権限は buyer/seller role で分離する。 */
export function canViewFilmOrderRow(
  orderBuyerDomain: string,
  actorEmail: string | null | undefined,
): boolean {
  // orderBuyerDomain は処理区分のためだけに使用し、閲覧は両社共有とする。
  void orderBuyerDomain;
  return isSevenChemicalUser(actorEmail) || isKaneiTradeUser(actorEmail);
}

// ---- 後方互換用（ページ表示など） ----
export function canRegisterFilmOrderReceiving(
  email: string | null | undefined,
  buyerDomain: string = "seven",
): boolean {
  return buyerDomain === "seven" ? isSevenChemicalUser(email) : isKaneiTradeUser(email);
}

export function canManageFilmOrderProof(email: string | null | undefined): boolean {
  return isKaneiTradeUser(email);
}

export function canApproveFilmOrderProof(
  email: string | null | undefined,
  buyerDomain: string = "seven",
): boolean {
  return buyerDomain === "seven" ? isSevenChemicalUser(email) : isKaneiTradeUser(email);
}

export function canMarkFilmOrderOrdered(
  email: string | null | undefined,
  buyerDomain: string = "seven",
): boolean {
  return canPerformFilmOrderAction("mark-ordered", email, buyerDomain);
}
