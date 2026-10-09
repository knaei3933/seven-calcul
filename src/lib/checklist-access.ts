/**
 * 社内QA（金井貿易）チェックリストの閲覧権限。
 * 金井貿易のメールアドレスを持つアカウントだけが社内QAタブを表示・更新できる。
 */
export const KANEI_TRADE_EMAIL_DOMAIN = "@kanei-trade.co.jp";

export function canViewInternalChecklist(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(KANEI_TRADE_EMAIL_DOMAIN);
}
