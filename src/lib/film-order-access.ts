/**
 * フィルム発注ワークフローの権限。
 * - Seven Chemical (@727.co.jp): 発注書送信・入稿データ登録・校正承認/再校正依頼
 * - Kanei Trade (@kanei-trade.co.jp): 仕入先管理・校正データ登録・アップロード案内
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

export function canMarkFilmOrderOrdered(email: string | null | undefined): boolean {
  return canViewFilmOrders(email);
}

export function canRegisterFilmOrderReceiving(email: string | null | undefined): boolean {
  return isSevenChemicalUser(email);
}

export function canManageFilmOrderProof(email: string | null | undefined): boolean {
  return isKaneiTradeUser(email);
}

export function canApproveFilmOrderProof(email: string | null | undefined): boolean {
  return isSevenChemicalUser(email);
}
