import type { PublicUser } from "./auth-store";

// 株式会社セブン化学の管理者は自社ドメインのアカウントのみ管理できる。
// 金井貿易など他ドメインの管理者は従来どおり全社ユーザーを管理する。
const SEVEN_CHEMICAL_EMAIL_DOMAIN = "727.co.jp";

export type UserAccessTarget = Pick<PublicUser, "email">;

export function emailDomain(email: string): string {
  const normalized = email.trim().toLowerCase();
  return normalized.slice(normalized.lastIndexOf("@") + 1);
}

export function canAdministerEmail(
  actor: Pick<PublicUser, "email" | "role">,
  targetEmail: string,
): boolean {
  if (actor.role !== "admin") return false;
  if (emailDomain(actor.email) !== SEVEN_CHEMICAL_EMAIL_DOMAIN) return true;
  return emailDomain(targetEmail) === SEVEN_CHEMICAL_EMAIL_DOMAIN;
}

export function canAdministerUser(
  actor: Pick<PublicUser, "email" | "role">,
  target: UserAccessTarget,
): boolean {
  return canAdministerEmail(actor, target.email);
}
