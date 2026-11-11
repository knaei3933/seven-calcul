import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Route } from "next";
import type { ReactNode } from "react";
import type { PublicUser } from "@/lib/auth-store";

const pathname = vi.fn(() => "/");
const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/link", () => ({
  default: function MockLink({ children, href, ...props }: { children: ReactNode; href: Route } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return <a href={href} {...props}>{children}</a>;
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useRouter: () => ({ replace, refresh }),
}));

const { GlobalHeaderClient } = await import("@/components/global-header-client");

function user(overrides: Partial<PublicUser> = {}): PublicUser {
  return {
    id: 1,
    email: "user@example.test",
    name: "Test User",
    role: "user",
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pathname.mockReturnValue("/");
});

describe("global header navigation", () => {
  it("shows only the three core menus in the header", () => {
    render(<GlobalHeaderClient user={user()} />);
    expect(screen.getByRole("link", { name: "原価シミュレーター" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "見積書発行" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "見積履歴" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "ユーザー管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "フィルム発注" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "フィルム単価" })).not.toBeInTheDocument();
  });

  it("keeps permitted administrative menus in the settings dropdown", async () => {
    render(<GlobalHeaderClient user={user({
      email: "kim@kanei-trade.co.jp",
      name: "Kanei Admin",
      role: "admin",
    })} />);

    fireEvent.click(screen.getByTestId("header-settings-button"));
    const menu = screen.getByRole("menu", { name: "設定メニュー" });
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "ユーザー管理" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "フィルム発注" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "フィルム単価" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "メール設定" })).toBeInTheDocument();
  });

  it("shows film orders, but not admin-only menus, to a Seven regular user", async () => {
    render(<GlobalHeaderClient user={user({ email: "approver@727.co.jp" })} />);
    fireEvent.click(screen.getByTestId("header-settings-button"));
    expect(screen.getByRole("menuitem", { name: "フィルム発注" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "ユーザー管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "フィルム単価" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "メール設定" })).not.toBeInTheDocument();
  });
});
