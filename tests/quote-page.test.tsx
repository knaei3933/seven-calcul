import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotePage from "@/app/quote/quote-client";

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

  it("keeps adjusted-plan quotation output available while showing its basis", async () => {
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "不足参考プラン",
      sizeSummary: "60×120mm / 2連",
      quantity: "49000",
      targetMargin: "0.4",
      fillingCostPerPiece: "5",
      filmCostPerPiece: "10",
      filmMeterPrice: "280",
      filmOrderLengthM: "3500",
      totalCostPerPiece: "16.7",
      calculationVersion: "simulator-linked",
      resultHash: "shortage-reference",
      calculationFilmTotal: "495096",
      originalQuantity: "50000",
      selectedCandidateShortage: true,
    }));
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("shortage-quote-warning")).toBeVisible());
    expect(screen.getByTestId("shortage-quote-warning")).toHaveTextContent("数量調整プラン");
    expect(screen.getByTestId("shortage-quote-warning")).toHaveTextContent("選択後の製造計画数量基準");
    expect(screen.getByTestId("shortage-quote-warning")).toHaveTextContent("元の数量へ戻る");
    expect(screen.getByTestId("save-history")).toBeEnabled();
    expect(screen.getByTestId("print-pdf")).toBeEnabled();
    expect(screen.getByTestId("open-checklist")).toBeEnabled();
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

  it("keeps mold amount and an edited subtotal reconciled across line edits", async () => {
    const user = userEvent.setup();
    render(<QuotePage />);
    await user.click(screen.getByTestId("toggle-editor-right"));

    await user.clear(screen.getByLabelText("金型 原価（ロット合計）"));
    await user.type(screen.getByLabelText("金型 原価（ロット合計）"), "30000");
    await user.clear(screen.getByLabelText("フィルム発注長さ (m)"));
    await user.type(screen.getByLabelText("フィルム発注長さ (m)"), "50");

    const moldAmount = screen.getByLabelText("金型金額");
    await waitFor(() => expect(moldAmount).toHaveTextContent("50,000"));

    const editAmount = async (label: string, value: string) => {
      const node = screen.getByLabelText(label);
      node.focus();
      document.getSelection()?.selectAllChildren(node);
      await user.keyboard(value);
      await user.tab();
    };
    await editAmount("充填・加工金額", "10000");
    await editAmount("フィルム金額", "10000");
    await expect(screen.getByLabelText("金型金額")).toHaveTextContent("50,000");

    await editAmount("小計", "90000");
    const fillingAmount = screen.getByLabelText("充填・加工金額");
    const filmAmount = screen.getByLabelText("フィルム金額");
    const subtotal = screen.getByLabelText("小計");
    expect(fillingAmount.textContent?.match(/[0-9]/)).toBeTruthy();
    expect(filmAmount.textContent?.match(/[0-9]/)).toBeTruthy();
    expect(screen.getByLabelText("金型金額")).toHaveTextContent("50,000");
    expect(subtotal).toHaveTextContent("90,000");
  });
});
