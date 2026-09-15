import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
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

  it("keeps purchase and selling price guidance editor-side only", async () => {
    render(<QuotePage />);

    const editorGuide = await waitFor(() => {
      const guide = screen.getByTestId("purchase-selling-guide");
      expect(guide).toBeVisible();
      return guide;
    });
    expect(editorGuide).toHaveTextContent("仕入価格と販売価格の見方（社内用・非印刷）");
    expect(editorGuide).toHaveTextContent("仕入m単価（参考）");
    expect(editorGuide).toHaveTextContent("フィルム販売m単価");
    expect(editorGuide).toHaveTextContent("目標利益率を含めた顧客への見積単価");
    expect(editorGuide).toHaveTextContent("PDF掲載金額に12%の販売マージン");
    expect(editorGuide).toHaveTextContent("￥27,000 → ￥30,240");

    const a4Sheet = screen.getByLabelText("お見積書A4プレビュー");
    expect(within(a4Sheet).queryByTestId("purchase-selling-guide")).not.toBeInTheDocument();
    expect(a4Sheet).not.toHaveTextContent("仕入価格と販売価格の見方");
    expect(a4Sheet).not.toHaveTextContent("PDF掲載金額に12%の販売マージン");
  });
});
