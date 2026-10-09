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

    // 発行には会社名・郵便番号・電話番号・住所が必須。
    await userEvent.setup().type(screen.getByLabelText("会社名 ★"), "手入力株式会社");
    await userEvent.setup().type(screen.getByLabelText("郵便番号 ★"), "123-4567");
    await userEvent.setup().type(screen.getByLabelText("電話番号 ★"), "03-1234-5678");
    await userEvent.setup().type(screen.getByLabelText("住所 ★"), "東京都千代田区テスト1-1");

    await waitFor(() => {
      expect(screen.getByTestId("save-history")).toBeEnabled();
      expect(screen.getByTestId("print-pdf")).toBeEnabled();
      expect(screen.getByTestId("open-checklist")).toBeEnabled();
    });
    expect(screen.queryByTestId("stale-quote-warning")).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("shows pouch specifications, film printing method, and standard notes on the A4 sheet", async () => {
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("quote-spec")).toBeVisible());
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("お見積製品仕様");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("品名");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("パウチ仕様");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("50×60mm / 1連");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("充填仕様");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("フィルム構成");
    // 印刷方式は右上ではなくフィルム費用の行に表示する。
    expect(screen.getByTestId("film-printing-method")).toHaveTextContent("印刷方式：デジタル印刷");
    expect(screen.queryByTestId("quote-printing-method")).not.toBeInTheDocument();
    // 標準備考（入金・容器処分・振込手数料・保管・出来高±10%）を含む。
    const sheet = within(document.getElementById("quote-preview")!);
    expect(sheet.getAllByText(/ご入金およびデータ入稿後に正式受注処理/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/バルク支給時の容器処分費用/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/お振込手数料は御社負担/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/金型・版は受注より1年間保管/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/【出来高について】/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/±10%程度の過不足/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/超過分×充填単価/).length).toBeGreaterThan(0);
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

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("会社名 ★"), "調整プラン株式会社");
    await user.type(screen.getByLabelText("郵便番号 ★"), "100-0001");
    await user.type(screen.getByLabelText("電話番号 ★"), "06-1234-5678");
    await user.type(screen.getByLabelText("住所 ★"), "大阪府テスト市1-2-3");

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

  it("stores a manually edited filling unit and its recalculated totals into history", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ record: { id: 71 } }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "充填物1",
      sizeSummary: "60×80mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "53.8",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "manual-edit-check",
      calculationFilmTotal: "201000",
    }));
    render(<QuotePage />);

    await user.type(screen.getByLabelText("会社名 ★"), "単価修正株式会社");
    await user.type(screen.getByLabelText("郵便番号 ★"), "530-0001");
    await user.type(screen.getByLabelText("電話番号 ★"), "06-9999-9999");
    await user.type(screen.getByLabelText("住所 ★"), "大阪府修正市テスト3-4");

    await waitFor(() => expect(screen.getByTestId("save-history")).toBeEnabled());
    const fillingUnit = screen.getByLabelText("充填・加工単価");
    await user.clear(fillingUnit);
    await user.type(fillingUnit, "90");
    await user.tab();

    // 90엔×10,000매＝900,000엔, 필름 450엔/m×500m＝225,000엔 유지.
    expect(screen.getByLabelText("充填・加工金額")).toHaveTextContent("900,000");
    expect(screen.getByLabelText("税込合計")).toHaveTextContent("1,237,500");

    await user.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.payload.fillingUnitDisplay).toBe("90");
    expect(body.payload.fillingAmountDisplay).toBe("900000");
    expect(body.payload.filmAmountDisplay).toBe("225000");
    expect(body.payload.subtotalDisplay).toBe("1125000");
    expect(body.payload.taxDisplay).toBe("112500");
    expect(body.payload.grandTotalDisplay).toBe("1237500");
    // 원가 기준은 수동 수정의 영향을 받지 않는다.
    expect(body.fillingCostPerPiece).toBe("53.8");
  });

  it("shows the bulk line only when bulk is sold", async () => {
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "充填物1",
      sizeSummary: "60×80mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "5.2",
      bulkCostPerPiece: "48.6",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "bulk-line-test",
      calculationFilmTotal: "201000",
    }));
    render(<QuotePage />);
    await waitFor(() => expect(screen.getByTestId("bulk-line")).toBeVisible());
    expect(screen.getByTestId("bulk-unit-price")).toBeVisible();
    // バルク原価48.6÷(1−0.4)＝81/枚。
    expect(screen.getByTestId("bulk-unit-price")).toHaveTextContent("81");

    cleanup();
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "充填物1",
      sizeSummary: "60×80mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "53.8",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "bulk-line-test-zero",
      calculationFilmTotal: "201000",
    }));
    render(<QuotePage />);
    await waitFor(() => expect(screen.getByTestId("filling-unit-price")).toBeVisible());
    // 客給（バルク原価なし）の場合はバルクラインを表示しない。
    expect(screen.queryByTestId("bulk-line")).not.toBeInTheDocument();
  });
});
