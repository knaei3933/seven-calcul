"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { PublicUser } from "@/lib/auth-store";

const menuItems = [
  { href: "/", label: "原価シミュレーター" },
  { href: "/quote", label: "見積書発行" },
  { href: "/history", label: "見積履歴" },
] as const;

export function GlobalHeaderClient({ user }: { user: PublicUser | null }) {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="global-header-inner">
      <Link href="/" className="menu-brand" aria-label="セブン化学 Quotation Suite ホーム">
        <span className="logo-mark" aria-hidden="true">7</span>
        <span>
          セブン化学
          <small>Quotation Suite</small>
        </span>
      </Link>

      <nav className="global-menu" aria-label="メインメニュー">
        {menuItems.map((item) => (
          <Link key={item.href} href={item.href} aria-current={pathname === item.href ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
        {user?.role === "admin" ? (
          <Link href="/admin/users" aria-current={pathname === "/admin/users" ? "page" : undefined}>
            ユーザー管理
          </Link>
        ) : null}
      </nav>

      <div className="global-user-area">
        <span className="version-badge">Decimal計算コア 2026-09.1</span>
        {user ? (
          <>
            <span className="current-user" data-testid="current-user">
              <strong>{user.name}</strong>
              <small>{user.email}</small>
            </span>
            <button className="button secondary small" type="button" onClick={() => void logout()}>
              ログアウト
            </button>
          </>
        ) : (
          <Link className="button small" href="/login">ログイン</Link>
        )}
      </div>
    </div>
  );
}
