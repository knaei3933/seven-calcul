"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { PublicUser } from "@/lib/auth-store";
import { CALCULATION_VERSION } from "@/lib/constants";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { canViewFilmOrders } from "@/lib/film-order-access";

const menuItems = [
  { href: "/", label: "原価シミュレーター" },
  { href: "/quote", label: "見積書発行" },
  { href: "/history", label: "見積履歴" },
] as const;

export function GlobalHeaderClient({ user }: { user: PublicUser | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  const settingsItems = [
    user?.role === "admin" ? { href: "/admin/users", label: "ユーザー管理" } : null,
    user?.role === "admin" && isKaneiTradeUser(user.email)
      ? { href: "/admin/film-prices", label: "フィルム単価" }
      : null,
    user && isKaneiTradeUser(user.email)
      ? { href: "/settings/mail", label: "メール設定" }
      : null,
  ].filter((item): item is { href: Route; label: string } => item != null);

  const settingsActive = settingsItems.some((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="global-header-inner">
      <Link href="/" className="menu-brand" aria-label="セブン化学 Quotation Suite ホーム">
        {/* eslint-disable-next-line @next/next/no-img-element -- The brand SVG is a fixed-height identity mark shared by all pages. */}
        <img className="menu-brand-logo" src="/seven-chemical-logo.svg" alt="" />
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
        {user?.role === "admin" && isKaneiTradeUser(user.email) ? (
          <Link href="/admin/film-prices" aria-current={pathname === "/admin/film-prices" ? "page" : undefined}>
            フィルム単価
          </Link>
        ) : null}
        {canViewFilmOrders(user?.email) ? (
          <Link href="/film-orders" aria-current={pathname === "/film-orders" ? "page" : undefined}>
            フィルム発注
          </Link>
        ) : null}
      </nav>

      <div className="global-user-area">
        {settingsItems.length ? (
          <div className="header-settings" ref={settingsRef}>
            <button
              className={`button secondary small header-settings-button ${settingsActive ? "active" : ""}`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
              data-testid="header-settings-button"
            >
              設定
              <span aria-hidden="true">{settingsOpen ? "▲" : "▼"}</span>
            </button>
            {settingsOpen ? (
              <div className="header-settings-menu" role="menu" aria-label="設定メニュー">
                {settingsItems.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    aria-current={pathname === item.href ? "page" : undefined}
                    onClick={() => setSettingsOpen(false)}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <span className="version-badge">Decimal計算コア {CALCULATION_VERSION}</span>
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
