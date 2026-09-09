import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotationPage from "@/app/page";
import { calculatePouchCost } from "@/lib/calculation";

describe("quotation UI", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  it("does not calculate automatically before server recalculation", async () => {
    render(<QuotationPage />);
    expect(screen.queryByTestId("bulk-usage")).not.toBeInTheDocument();
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "not_calculated");
    expect(screen.getByTestId("server-result")).toHaveTextContent("サーバー再計算待ち");
    expect(screen.getByTestId("customer-total")).toHaveTextContent("-");
    expect(screen.queryByTestId("customer-commission")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cost-processing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cost-fixed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cost-film")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cost-bulk")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cost-custom")).not.toBeInTheDocument();
  });

  it("exposes complete SKU inputs with labels and a calculation-only CTA", () => {
    render(<QuotationPage />);
    expect(screen.getByLabelText("SKU数（並列生産数）")).toBeInTheDocument();
    expect(screen.getByText(/SKUごとに製品名・発注枚数・充填量・色数を設定でき/)).toBeInTheDocument();
    expect(screen.getByTestId("calculate-desktop")).toBeEnabled();
  });

  it("separates provisional and server states and exposes selected margin", () => {
    render(<QuotationPage />);
    expect(screen.getByTestId("server-result")).toHaveTextContent("サーバー再計算待ち");
    expect(screen.getByLabelText("1回の充填列数 (列)")).toBeInTheDocument();
    expect(screen.getByText("テスト充填は500回 × 列数 × 充填量としてバルク使用量に加算します。")).toBeInTheDocument();
    expect(screen.getByLabelText("利益率 40%")).toBeChecked();
    expect(screen.getByTestId("input-summary")).toHaveTextContent("50×60 / 1連 / 10,000枚 / SKU 1件（充填物1 10,000枚）");
    expect(screen.getByLabelText("左右幅 (mm)")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("カスタム区分")).toBeEnabled();
  });

  it("exposes adjustable calculation parameters before recalculation", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    fireEvent.click(screen.getByTestId("parameters").querySelector("summary")!);
    const overseasInput = screen.getByLabelText("海外配送費 / 回 (円)");
    expect(overseasInput).toHaveValue("16000");
    await user.clear(overseasInput);
    await user.type(overseasInput, "20000");
    expect(overseasInput).toHaveValue("20000");
  });

  it("marks a completed server calculation as stale after input changes", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const result = calculatePouchCost({
      spec: {
        sizeKey: "mouthwash-45x145", customWidthMm: "45", customLengthMm: "145", fillMlPerChamber: "30", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0",
        skuCount: 2,
      },
      quantity: "10000", printingMethod: "digital",
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    await user.clear(screen.getByLabelText("発注数量 (枚)"));
    await user.type(screen.getByLabelText("発注数量 (枚)"), "20000");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "stale");
    expect(screen.getByTestId("server-result")).toHaveTextContent("再計算が必要");
  });

  it("keeps only the latest server calculation when responses arrive out of order", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const resolvers: Array<(response: Response) => void> = [];
    global.fetch = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)));

    await user.click(screen.getByTestId("calculate-desktop"));
    await user.clear(screen.getByLabelText("発注数量 (枚)"));
    await user.type(screen.getByLabelText("発注数量 (枚)"), "20000");
    const skuQuantity = screen.getByTestId("sku-quantity-0");
    await user.clear(skuQuantity);
    await user.type(skuQuantity, "20000");
    fireEvent.submit(screen.getByTestId("quotation-form"));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await waitFor(() => expect(screen.getByLabelText("発注数量 (枚)")).toHaveValue("20000"));

    const secondResult = calculatePouchCost({
      spec: {
        sizeKey: "mouthwash-45x145", customWidthMm: "45", customLengthMm: "145", fillMlPerChamber: "30", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0",
        skuCount: 2,
      },
      quantity: "20000", printingMethod: "digital",
    });
    await act(async () => {
      resolvers[1](new Response(JSON.stringify({ result: secondResult }), { status: 200 }));
    });
    await waitFor(() => expect(screen.getByTestId("bulk-usage")).toHaveTextContent("722,000 ml"));
  });

  it("keeps the provisional result when server recalculation fails and reports the failure", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const dispatchDebugError = vi.fn();
    window.dispatchDebugError = dispatchDebugError;
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "calculation_failed" }), { status: 400 }));

    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(dispatchDebugError).toHaveBeenCalledWith("calculation_failed"));
    expect(screen.queryByTestId("bulk-usage")).not.toBeInTheDocument();
    expect(screen.getByTestId("server-result").getAttribute("data-state")).not.toBe("calculated");
  });

  it("unlocks custom dimensions and derives film web width from the custom pouch width", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    await user.click(screen.getByLabelText("カスタム区分"));
    const width = screen.getByLabelText("左右幅 (mm)");
    expect(width).not.toHaveAttribute("readonly");
    await user.clear(width);
    await user.type(width, "42");
    expect(await screen.findByTestId("custom-size-info")).toHaveTextContent("原反幅（自動）＝383mm");
    expect(screen.getByTestId("calculate-desktop")).toBeEnabled();
  });

  it("reflects connected chambers immediately in chamber count and bulk usage", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    expect(screen.getByTestId("connected-preview")).toHaveTextContent("総室数＝10,000枚×1＝10,000 室");
    await user.click(screen.getByLabelText("2連"));
    expect(screen.getByTestId("total-fill")).toHaveTextContent("1枚あたり総充填量（平均）＝3ml × 2＝6 ml");
    expect(screen.getByTestId("connected-preview")).toHaveTextContent("総室数＝10,000枚×2＝20,000 室");
    expect(screen.getByTestId("connected-preview")).toHaveTextContent("バルク使用量（概算）＝74,000 ml");
  });

  it("calculates gravure roll film and shows the new copper plate separately", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    await user.click(screen.getByLabelText("グラビア印刷"));
    expect(screen.getByTestId("calculate-desktop")).toBeEnabled();
    expect(screen.getAllByTestId("gravure-parameters").length).toBeGreaterThan(0);
    const result = calculatePouchCost({
      spec: {
        sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0",
        skuCount: 1,
      },
      quantity: "10000", printingMethod: "gravure",
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ result }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    expect(screen.getAllByTestId("cost-copper").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("cost-film").some((node) => node.textContent?.includes("製造者販売価格"))).toBe(true);
    expect(screen.getAllByTestId("cost-copper").some((node) => node.textContent?.includes("新規銅版費"))).toBe(true);
  });

  it("supports a custom target margin between the 40% and 50% defaults", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    expect(screen.getByLabelText("利益率 40%")).toBeChecked();
    await user.click(screen.getByLabelText("利益率 カスタム"));
    const customMargin = screen.getByLabelText("カスタム利益率 (%)");
    expect(customMargin).toHaveValue("45");
    await user.clear(customMargin);
    await user.type(customMargin, "42");
    expect(screen.getByTestId("input-summary")).toBeInTheDocument();
    expect(screen.getByTestId("calculate-desktop")).toBeEnabled();
  });

  it("supports per-SKU pouch quantities and blocks when the sum differs from the order quantity", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const skuCountInput = screen.getByTestId("sku-count");
    await user.clear(skuCountInput);
    await user.type(skuCountInput, "2");
    const sku1 = screen.getByTestId("sku-quantity-0");
    await user.clear(sku1);
    await user.type(sku1, "6000");
    const sku2 = screen.getByTestId("sku-quantity-1");
    await user.clear(sku2);
    await user.type(sku2, "4000");
    expect(screen.queryByTestId("sku-sum-error")).not.toBeInTheDocument();
    expect(screen.getByTestId("calculate-desktop")).toBeEnabled();
    expect(screen.getByTestId("input-summary")).toHaveTextContent("SKU 2件（充填物1 6,000枚＋充填物2 4,000枚）");
    await user.clear(sku1);
    await user.type(sku1, "5000");
    expect(screen.getByTestId("sku-sum-error")).toHaveTextContent("SKU合計 9,000 枚 ≠ 発注数量 10,000 枚");
    expect(screen.getByTestId("calculate-desktop")).toBeDisabled();
    await user.clear(sku1);
    await user.type(sku1, "6000");
    expect(screen.getByTestId("calculate-desktop")).toBeEnabled();
    const fill1 = screen.getByTestId("sku-fill-0");
    await user.clear(fill1);
    await user.type(fill1, "5");
    expect(screen.getByTestId("avg-fill")).toHaveTextContent("4.2 ml/室");
    const name1 = screen.getByTestId("sku-name-0");
    await user.type(name1, "レモン琺瑯");
    expect(screen.getByTestId("input-summary")).toHaveTextContent("SKU 2件（レモン琺瑯 6,000枚＋充填物2 4,000枚）");
  });
});
