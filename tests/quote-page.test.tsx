import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotePage from "@/app/quote/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("quotation page stale draft", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps direct manual entry actions available when no stale marker exists", async () => {
    render(<QuotePage />);

    await waitFor(() => {
      expect(screen.getByTestId("save-history")).toBeEnabled();
      expect(screen.getByTestId("print-pdf")).toBeEnabled();
      expect(screen.getByTestId("open-checklist")).toBeEnabled();
    });
    expect(screen.queryByTestId("stale-quote-warning")).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows a warning and blocks linked quotation actions while the simulator draft is stale", async () => {
    sessionStorage.setItem("pouch-simulator-stale-status-v1", "input-changed");
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("stale-quote-warning")).toBeVisible());
    expect(screen.getByTestId("stale-quote-warning")).toHaveTextContent("この見積書は古くなっています");
    expect(screen.getByTestId("stale-quote-warning")).toHaveTextContent("シミュレーターの条件が変わったため");
    expect(screen.getByTestId("stale-quote-warning")).toHaveTextContent("シミュレーターに戻り、「サーバーで再計算する」を実行");
    expect(screen.getByTestId("stale-quote-warning")).toHaveTextContent("保存・PDF出力・チェックリスト");
    expect(screen.getByTestId("save-history")).toBeDisabled();
    expect(screen.getByTestId("print-pdf")).toBeDisabled();
    expect(screen.getByTestId("open-checklist")).toBeDisabled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

	  it("does not expose purchase and selling price guidance", async () => {
	    render(<QuotePage />);

	    const a4Sheet = screen.getByLabelText("お見積書A4プレビュー");
	    expect(screen.queryByTestId("purchase-selling-guide")).not.toBeInTheDocument();
	    expect(screen.queryByText("仕入価格と販売価格の見方")).not.toBeInTheDocument();
	    expect(screen.queryByText(/PDF掲載金額に12%/)).not.toBeInTheDocument();
	    expect(within(a4Sheet).queryByTestId("purchase-selling-guide")).not.toBeInTheDocument();
	    expect(a4Sheet).not.toHaveTextContent("仕入価格と販売価格の見方");
	    expect(a4Sheet).not.toHaveTextContent("PDF掲載金額に12%の販売マージン");
	  });

	  it("keeps side editor cards collapsed by default and lets users expand them independently", async () => {
	    const user = userEvent.setup();
	    render(<QuotePage />);

	    const leftPanel = screen.getByTestId("quote-editor-left");
	    const rightPanel = screen.getByTestId("quote-editor-right");
	    expect(leftPanel).toHaveClass("desktop-collapsed");
	    expect(rightPanel).toHaveClass("desktop-collapsed");

	    await user.click(screen.getByTestId("toggle-editor-left"));
	    expect(leftPanel).not.toHaveClass("desktop-collapsed");
	    expect(rightPanel).toHaveClass("desktop-collapsed");

	    await user.click(screen.getByTestId("toggle-editor-right"));
	    expect(leftPanel).not.toHaveClass("desktop-collapsed");
	    expect(rightPanel).not.toHaveClass("desktop-collapsed");

	    await user.click(screen.getByTestId("toggle-editor-left"));
	    expect(leftPanel).toHaveClass("desktop-collapsed");
	    expect(rightPanel).not.toHaveClass("desktop-collapsed");
	  });
});
