/**
 * フィルム発注ワークフローの権限。
 * 見積を作成した会社（発注側）と、供給側（金井貿易 or 外部メーカー）で操作権限が決まる。
 * - Seven Chemical (@727.co.jp) が発注側: 入稿・承認はセブン化学、校正登録等は金井貿易
 * - Kanei Trade (@kanei-trade.co.jp) が発注側（カネイ自身の営業）: すべて金井貿易が操作
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

export function isKaneiTradeUser(email: string | null | undefined): boolean {
  return hasDomain(email, KANEI_TRADE_EMAIL_DOMAIN);
}

export function canViewFilmOrders(email: string | null | undefined): boolean {
  return isSevenChemicalUser(email) || isKaneiTradeUser(email);
}

/** 発注側ドメイン（見積作成者の会社）を返す。 */
export function buyerDomainOf(createdByEmail: string | null | undefined): "seven" | "kanei" {
  return isSevenChemicalUser(createdByEmail) ? "seven" : "kanei";
}

export type FilmOrderActionSide = "buyer" | "kanei";

const ACTION_SIDE: Record<string, FilmOrderActionSide> = {
  "mark-ordered": "buyer",
  "register-receiving": "buyer",
  "register-receiving-extra": "buyer",
  "resend-receiving-notice": "buyer",
  approve: "buyer",
  "request-re-proof": "buyer",
  "register-proof": "kanei",
  "send-proof-notice": "kanei",
  "set-supplier": "kanei",
  "send-po": "kanei",
};

/**
 * 発注側会社のアカウントが buyer 操作を、金井貿易が seller 側操作を行う。
 * 金井貿易が発注側の場合は seller 操作も金井貿易が行う。
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
  return isKaneiTradeUser(actorEmail);
}

/** 発注ワークフロー一覧の閲覧範囲。Seven は自社発注のみ、カネイは全件（供給側として関与）。 */
export function canViewFilmOrderRow(
  orderBuyerDomain: string,
  actorEmail: string | null | undefined,
): boolean {
  return orderBuyerDomain === "seven" ? isSevenChemicalUser(actorEmail) : isKaneiTradeUser(actorEmail);
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
