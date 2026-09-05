"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const menuItems = [
  { href: "/", label: "原価シミュレーター" },
  { href: "/quote", label: "見積書発行" },
  { href: "/history", label: "見積履歴" },
] as const;

export function GlobalHeader() {
  const pathname = usePathname();

  return (
    <header className="global-header no-print">
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
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <span className="version-badge">Decimal計算コア 2026-09.1</span>
      </div>
    </header>
  );
}
