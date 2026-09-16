import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotationPage from "@/app/page";
import { calculatePouchCost, type CostResult } from "@/lib/calculation";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { QUOTATION_DRAFT_KEY } from "@/lib/quotation-draft";
import type { PouchSpec } from "@/lib/types";
import type { PrintCandidate } from "@/lib/print-recommendation";

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
    expect(screen.getByTestId("input-summary")).toHaveTextContent("50×60 / 1連 / 10,000枚 / デジタル印刷 / SKU 1件（充填物1 10,000枚）");
    expect(screen.getByLabelText("左右幅 (mm)")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("カスタム区分")).toBeEnabled();
  });

  it("keeps first-time guidance compact until the user opens it", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);

    const guide = screen.getByTestId("simulator-guide");
    expect(guide).toHaveTextContent("はじめての方へ：5ステップで進める");
    expect(screen.getByTestId("simulator-guide-step-1")).not.toBeVisible();
    await user.click(screen.getByText("はじめての方へ：5ステップで進める"));

    const steps = [
      screen.getByTestId("simulator-guide-step-1"),
      screen.getByTestId("simulator-guide-step-2"),
      screen.getByTestId("simulator-guide-step-3"),
      screen.getByTestId("simulator-guide-step-4"),
      screen.getByTestId("simulator-guide-step-5"),
    ];
    expect(screen.getByTestId("simulator-guide").querySelectorAll("li")).toHaveLength(5);
    for (const step of steps) expect(step).toBeVisible();
    expect(steps[0]).toHaveTextContent("パウチの形・サイズ・発注数量");
    expect(steps[1]).toHaveTextContent("充填方法・SKU・色数");
    expect(steps[2]).toHaveTextContent("デジタル印刷試算");
    expect(steps[3]).toHaveTextContent("D／K／Yの調達計画");
    expect(steps[4]).toHaveTextContent("見積書発行");
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
	    expect(screen.getByTestId("stale-input-warning")).toHaveTextContent("入力内容が変わりました");
	    expect(screen.getByTestId("stale-input-warning")).toHaveTextContent("今すぐ再計算");
	    expect(screen.getByTestId("calculate-desktop")).toHaveTextContent("入力が変わりました。再計算する");

	    await user.click(screen.getByTestId("stale-recalc-button"));
	    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
	    expect(screen.queryByTestId("stale-input-warning")).not.toBeInTheDocument();
	    expect(screen.getByTestId("calculate-desktop")).toHaveTextContent("サーバーで再計算する");
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

  it("shows an actionable timeout message and clears it after a later successful calculation", async () => {
    vi.useFakeTimers();
    render(<QuotationPage />);
    global.fetch = vi.fn(() => new Promise<Response>(() => undefined));

    fireEvent.click(screen.getByTestId("calculate-desktop"));
    expect(screen.queryByTestId("calculation-error")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });

    expect(screen.getByTestId("calculation-error")).toHaveTextContent("サーバーへの接続が15秒でタイムアウトしました");
    expect(screen.getByTestId("calculation-error")).toHaveTextContent("もう一度「サーバーで再計算する」を押してください");
    expect(screen.getByTestId("server-result").getAttribute("data-state")).not.toBe("calculated");

    vi.useRealTimers();
    const user = userEvent.setup();
    const successfulResult = calculatePouchCost({
      spec: {
        sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3",
        connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4, isCustom: false,
        colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      },
      quantity: "10000",
      printingMethod: "digital",
      recommendationMode: true,
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      result: successfulResult,
      originalResult: successfulResult,
      candidates: successfulResult.recommendationCandidates ?? [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    expect(screen.queryByTestId("calculation-error")).not.toBeInTheDocument();
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
    expect(screen.queryByTestId("printing-method-block")).not.toBeInTheDocument();
    expect(screen.getByTestId("calculate-desktop")).toBeEnabled();
    const input = {
      spec: {
        sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0",
        skuCount: 1,
      } as PouchSpec,
      quantity: "10000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalCalculation = calculatePouchCost({ ...input, recommendationMode: true });
    const candidate = originalCalculation.recommendationCandidates!.find((item) => item.printingMethod === "gravure")!;
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result = body.selectedCandidateId
        ? calculatePouchCost({
          ...input,
          targetMargins: body.targetMargins,
          recommendationMode: true,
          selectedCandidateId: body.selectedCandidateId,
          selectedCandidateTargetMargins: body.selectedCandidateTargetMargins,
        })
        : originalCalculation;
      return new Response(JSON.stringify({
        result,
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    expect(screen.getByTestId("input-summary")).toHaveTextContent("デジタル印刷");
    await user.click(screen.getByRole("button", { name: /Y \/ 国内調達/ }));
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
    expect(screen.getAllByTestId("gravure-parameters").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("cost-copper").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("cost-film").every((node) => !node.textContent?.includes("販売マージン"))).toBe(true);
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

  it("collapses candidate alternatives after selection and hides the route selector", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-35x80", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 2, bulkUnitPrice: "0", skuCount: 1,
      } as PouchSpec,
      quantity: "10000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const targetMargins = ["0.3", "0.35", "0.4"];
    const originalRequest = {
      ...input,
      targetMargins,
      recommendationMode: true,
      selectedCandidateId: "",
      selectedCandidateTargetMargins: targetMargins,
    };
    const originalCalculation = calculatePouchCost(originalRequest);
    const candidate = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
    const selectedRequest = {
      ...input,
      targetMargins,
      recommendationMode: true,
      selectedCandidateId: candidate.id,
      selectedCandidateTargetMargins: targetMargins,
    };
    const selectedCalculation = calculatePouchCost(selectedRequest);
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
        const result = body.selectedCandidateId ? selectedCalculation : originalCalculation;
      return new Response(JSON.stringify({
        result,
        originalResult: originalCalculation,
        candidates: result.recommendationCandidates ?? [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    expect(screen.queryByTestId("printing-method-block")).not.toBeInTheDocument();
    expect(screen.getByText("フィルム調達・製造計画候補")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Y \/ 国内調達（グラビア印刷）/ })).toBeInTheDocument();
    expect(screen.getByText(/パウチ 50×60mm ／ 1連 ／ 4列/)).toBeInTheDocument();
    expect(screen.queryByTestId("selection-status")).not.toBeInTheDocument();
    expect(screen.getByTestId("unit-cost-summary")).toHaveTextContent("総単価（初期費用込）");
    expect(screen.getByTestId("unit-cost-summary")).toHaveTextContent("パウチ単価（変動費）");
    expect(screen.getByTestId("unit-cost-summary")).toHaveTextContent("初期費用単価");
    expect(within(screen.getByTestId("input-basis-card")).getByText(/原反 /)).toBeInTheDocument();
    expect(within(screen.getByTestId("input-basis-card")).getByText("選択中")).toBeInTheDocument();
    expect(screen.getByText(/4色/)).toBeInTheDocument();
    expect(within(screen.getByTestId("input-basis-card")).getByText(/フィルム PET12\+AL7\+PET12\+LLDPE50/)).toBeInTheDocument();
    expect(screen.getAllByText(/余剰 /).length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("input-basis-card"));
    await waitFor(() => expect(screen.queryByText("フィルム調達・製造計画候補")).not.toBeInTheDocument());
    expect(screen.getByTestId("selected-candidate-summary")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "候補一覧" }));
    await waitFor(() => expect(screen.getByText("フィルム調達・製造計画候補")).toBeInTheDocument());

	    await user.click(screen.getByRole("button", { name: /Y \/ 国内調達（グラビア印刷）/ }));
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
    await user.click(screen.getByTestId("cost-film").querySelector("summary")!);
    const filmChain = screen.getByTestId("film-loss-chain");
    expect(filmChain).toHaveTextContent("国内調達はSKUごとに独立発注です");
    expect(filmChain).toHaveTextContent("固定出荷パターンをSKUごとに選びます");
    expect(filmChain).toHaveTextContent("未使用長さ");
    expect(filmChain).not.toHaveTextContent("輸入パターンを使いません");
    expect(filmChain).not.toHaveTextContent("K / 韓国輸入の");
    expect(filmChain).not.toHaveTextContent("5,500m発注パターンへ切り上げます");
    expect(filmChain).not.toHaveTextContent("製造マージン＝");
    expect(filmChain).not.toHaveTextContent("海外配送はロスを含めず");
    await waitFor(() => expect(screen.getByTestId("selected-candidate-summary")).toBeInTheDocument());
    expect(screen.queryByTestId("selection-status")).not.toBeInTheDocument();
    expect(screen.queryByText("発注数量・パターン候補")).not.toBeInTheDocument();
    expect(screen.queryByTestId("printing-method-block")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quantity-policy")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("製造計画");
    expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("固定です");
    expect(screen.getByLabelText("発注数量 (枚)")).toHaveValue("10000");
    expect(screen.getByLabelText("利益率 30%")).toBeChecked();
    expect(screen.queryByLabelText("利益率 40%")).not.toBeInTheDocument();
  });

  it("restores the original printing method and target margin when returning from a candidate", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      } as PouchSpec,
      quantity: "50000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalCalculation = calculatePouchCost({
      ...input,
      targetMargins: ["0.4", "0.35", "0.3"],
      recommendationMode: true,
    });
    const gravureCandidate = originalCalculation.recommendationCandidates!.find((candidate) => candidate.route === "Y")!;
    expect(gravureCandidate).toBeTruthy();
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result = body.selectedCandidateId
        ? calculatePouchCost({
          ...input,
          printingMethod: body.printingMethod,
          targetMargins: body.targetMargins,
          recommendationMode: true,
          selectedCandidateId: body.selectedCandidateId,
        })
        : originalCalculation;
      return new Response(JSON.stringify({
        result,
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    global.fetch = fetchMock;

    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
	    await user.click(screen.getByRole("button", { name: /Y \/ 国内調達/ }));
	    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
	    expect(screen.getByLabelText("利益率 30%")).toBeChecked();
	    await user.click(screen.getByTestId("cost-copper").querySelector("summary")!);
	    expect(screen.getByTestId("copper-plate-amount")).toHaveTextContent("￥120,960");
	    expect(screen.getByTestId("cost-copper")).toHaveTextContent("4色分を別計上");
	    expect(screen.getByTestId("cost-copper")).not.toHaveTextContent("PDF掲載金額に12%適用");
	    expect(screen.getByTestId("cost-copper")).not.toHaveTextContent("12%販売マージン");

	    await waitFor(() => expect(screen.getByRole("button", { name: "候補一覧" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "候補一覧" }));
    await user.click(screen.getAllByRole("button", { name: /D \/ デジタル/ })[0]);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（デジタル印刷）"));
    expect(screen.getByLabelText("利益率 40%")).toBeChecked();
    expect(screen.getByLabelText("利益率 30%")).not.toBeChecked();

    await waitFor(() => expect(screen.getByRole("button", { name: "候補一覧" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "候補一覧" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Y \/ 国内調達/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Y \/ 国内調達/ }));
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
    expect(screen.getByLabelText("利益率 30%")).toBeChecked();

    await waitFor(() => expect(screen.getByTestId("calculate-desktop")).toBeEnabled());
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.queryByTestId("active-candidate-note")).not.toBeInTheDocument());
    expect(screen.getByTestId("input-summary")).toHaveTextContent("デジタル印刷");
    expect(within(screen.getByTestId("input-basis-card")).getByText("選択中")).toBeInTheDocument();
    expect(screen.getByLabelText("利益率 40%")).toBeChecked();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    const recalculationBasis = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(recalculationBasis.printingMethod).toBe("digital");
    expect(recalculationBasis.selectedCandidateId).toBe("");

    await user.click(screen.getAllByRole("button", { name: "元の数量へ戻る" })[0]);
    await waitFor(() => expect(screen.getByTestId("input-summary")).toHaveTextContent("デジタル印刷"));
    expect(screen.getByLabelText("利益率 40%")).toBeChecked();
    expect(screen.getByLabelText("利益率 30%")).not.toBeChecked();
  });

  it("shows all-in comparison and overproduction risk for the first-time audit case", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1 as const, fillingMethod: "hopper" as const,
        fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
        skuQuantities: ["50000"], skuColorCounts: ["4"],
      } as PouchSpec,
      quantity: "50000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalCalculation = calculatePouchCost({ ...input, recommendationMode: true });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      result: originalCalculation,
      originalResult: originalCalculation,
      candidates: originalCalculation.recommendationCandidates ?? [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));

    expect(screen.getByTestId("comparison-input")).toHaveTextContent("￥572,671");
    expect(screen.getByTestId("comparison-Y")).toHaveTextContent("￥549,647");
    expect(screen.getByTestId("comparison-Y")).toHaveTextContent("-￥23,024");
    expect(screen.getByTestId("candidate-Y-film-delta")).toHaveTextContent("フィルムのみ差額 -￥143,984");
    expect(screen.getByTestId("candidate-Y-copper")).toHaveTextContent("銅版費 +￥120,960");
    expect(screen.getByTestId("candidate-Y-all-in-delta")).toHaveTextContent("-￥23,024");
    expect(screen.getByTestId("comparison-K")).toHaveTextContent("50,000枚");
    expect(screen.getByTestId("comparison-K")).toHaveTextContent("￥856,513");
    expect(screen.getByTestId("comparison-K")).toHaveTextContent("顧客発注の4.1倍製造／在庫リスク");
    expect(screen.getByTestId("candidate-K-risk")).toHaveTextContent("顧客発注の4.1倍製造／在庫リスク");
  });

  it("progressively discloses and keeps a selected shortage reference accessible", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1 as const, fillingMethod: "hopper" as const,
        fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
        skuQuantities: ["500000"], skuColorCounts: ["4"],
      } as PouchSpec,
      quantity: "500000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalCalculation = calculatePouchCost({ ...input, recommendationMode: true });
    const shortage = originalCalculation.recommendationCandidates!.find((candidate) => candidate.route === "Y" && !candidate.isFulfilling)!;
    expect(shortage).toBeTruthy();
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result = body.selectedCandidateId
        ? calculatePouchCost({
          ...input,
          targetMargins: body.targetMargins,
          recommendationMode: true,
          selectedCandidateId: body.selectedCandidateId,
          selectedCandidateTargetMargins: body.selectedCandidateTargetMargins,
        })
        : originalCalculation;
      return new Response(JSON.stringify({
        result,
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await user.selectOptions(screen.getByLabelText("サイズ"), "tube-50x90");
    const quantityInput = screen.getByLabelText("発注数量 (枚)");
    await user.clear(quantityInput);
    await user.type(quantityInput, "500000");
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    const disclosure = screen.getByRole("button", { name: "不足プランを比較する" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/顧客発注に届かない小さいまとめ購入です/)).toBeInTheDocument();

    await user.click(disclosure);
    expect(screen.getByTestId("comparison-Y")).toBeInTheDocument();
    const shortageCard = screen.getByRole("button", { name: /Y \/ 国内調達/ });
    expect(shortageCard).toBeEnabled();
    await user.click(shortageCard);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
    expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("63,000 枚");
    await user.click(screen.getByRole("button", { name: "候補一覧" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Y \/ 国内調達/ })).toBeVisible());
    expect(screen.getByTestId("comparison-Y")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "不足プラン選択中" })).toBeDisabled();
  });

  it.each([
    ["candidate ID", (result: CostResult, candidate: PrintCandidate): CostResult => ({
      ...result,
      selectedCandidateId: `${candidate.id}-wrong`,
    })],
    ["printing method", (result: CostResult, _candidate: PrintCandidate): CostResult => ({
      ...result,
      printingMethod: "digital",
    })],
    ["adjusted quantity", (result: CostResult, _candidate: PrintCandidate): CostResult => ({
      ...result,
      quantity: "49999",
    })],
  ])("rejects a selected candidate response with a mismatched %s", async (_label, tamper) => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1 as const, fillingMethod: "hopper" as const,
        fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
        skuQuantities: ["50000"], skuColorCounts: ["4"],
      } as PouchSpec,
      quantity: "50000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalCalculation = calculatePouchCost({ ...input, recommendationMode: true });
    const candidate = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (!body.selectedCandidateId) {
        return new Response(JSON.stringify({
          result: originalCalculation,
          originalResult: originalCalculation,
          candidates: originalCalculation.recommendationCandidates ?? [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const selectedResult = calculatePouchCost({
        ...input,
        targetMargins: body.targetMargins,
        recommendationMode: true,
        selectedCandidateId: body.selectedCandidateId,
        selectedCandidateTargetMargins: body.selectedCandidateTargetMargins,
      });
      return new Response(JSON.stringify({
        result: tamper(selectedResult, candidate),
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await user.selectOptions(screen.getByLabelText("サイズ"), "tube-50x90");
    const quantityInput = screen.getByLabelText("発注数量 (枚)");
    await user.clear(quantityInput);
    await user.type(quantityInput, "500000");
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));

    await user.click(screen.getByRole("button", { name: /Y \/ 国内調達/ }));
    await waitFor(() => expect(screen.getByTestId("calculation-error")).toHaveTextContent("candidate_result_mismatch"));
    expect(screen.getByTestId("calculation-error")).toHaveTextContent("もう一度「サーバーで再計算する」を押してください");
    expect(screen.queryByTestId("active-candidate-note")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Y \/ 国内調達/ })).toBeEnabled();
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  });

  it("preserves a custom original margin across same-method candidate switches", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    await user.click(screen.getByLabelText("利益率 カスタム"));
    const customMargin = screen.getByLabelText("カスタム利益率 (%)");
    await user.clear(customMargin);
    await user.type(customMargin, "42");

    const input = {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      } as PouchSpec,
      quantity: "50000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalTargetMargins = ["0.3", "0.35", "0.4", "0.42"];
    const originalCalculation = calculatePouchCost({
      ...input,
      targetMargins: originalTargetMargins,
      recommendationMode: true,
    });
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result = body.selectedCandidateId
        ? calculatePouchCost({
          ...input,
          printingMethod: body.printingMethod,
          targetMargins: body.targetMargins,
          recommendationMode: true,
          selectedCandidateId: body.selectedCandidateId,
        })
        : originalCalculation;
      return new Response(JSON.stringify({
        result,
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    global.fetch = fetchMock;

    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    await user.click(screen.getAllByRole("button", { name: /D \/ デジタル/ })[0]);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（デジタル印刷）"));
    expect(screen.getByLabelText("利益率 カスタム")).toBeChecked();
    expect(screen.getByLabelText("カスタム利益率 (%)")).toHaveValue("42");
    const sameMethodCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    const sameMethodBody = JSON.parse(String(sameMethodCall[1]?.body));
    expect(sameMethodBody.printingMethod).toBe("digital");
    expect(sameMethodBody.targetMargins).toEqual(originalTargetMargins);

    await waitFor(() => expect(screen.getByRole("button", { name: "候補一覧" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "候補一覧" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Y \/ 国内調達/ })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: /Y \/ 国内調達/ }));
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
    expect(screen.getByLabelText("利益率 30%")).toBeChecked();
    expect(screen.getByLabelText("利益率 カスタム")).not.toBeChecked();

    await waitFor(() => expect(screen.getByRole("button", { name: "候補一覧" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "候補一覧" }));
    await user.click(screen.getAllByRole("button", { name: /D \/ デジタル/ })[0]);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（デジタル印刷）"));
    expect(screen.getByLabelText("利益率 カスタム")).toBeChecked();
    expect(screen.getByLabelText("カスタム利益率 (%)")).toHaveValue("42");

    await waitFor(() => expect(screen.getAllByRole("button", { name: /元の数量へ戻る/ })[0]).toBeEnabled());
    await user.click(screen.getAllByRole("button", { name: /元の数量へ戻る/ })[0]);
    await waitFor(() => expect(screen.getByTestId("input-summary")).toHaveTextContent("デジタル印刷"));
    expect(screen.getByLabelText("利益率 カスタム")).toBeChecked();
    expect(screen.getByLabelText("カスタム利益率 (%)")).toHaveValue("42");
  });

  it("rejects a legacy selected candidate state without an original margin mode", async () => {
    const input = {
      spec: {
        sizeKey: "tube-35x80", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 2, bulkUnitPrice: "0", skuCount: 1,
      } as PouchSpec,
      quantity: "133000", printingMethod: "gravure" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalRequest = {
      ...input,
      targetMargins: ["0.2", "0.25", "0.3"],
      recommendationMode: true,
      selectedCandidateId: "",
      selectedCandidateTargetMargins: ["0.2", "0.25", "0.3"],
    };
    const originalCalculation = calculatePouchCost(originalRequest);
    const candidate = originalCalculation.recommendationCandidates![0];
    const selectedRequest = {
      ...input,
      targetMargins: ["0.2", "0.25", "0.3"],
      recommendationMode: true,
      selectedCandidateId: candidate.id,
      selectedCandidateTargetMargins: ["0.2", "0.25", "0.3"],
    };
    const selectedCalculation = calculatePouchCost(selectedRequest);
    const inputJson = JSON.stringify({ printingMethod: "gravure" });
    sessionStorage.setItem(QUOTATION_DRAFT_KEY, JSON.stringify({ stale: true }));
    sessionStorage.setItem("pouch-simulator-state-v1", JSON.stringify({
      version: 1,
      form: {
        quantity: input.quantity,
        printingMethod: selectedCalculation.printingMethod,
        targetMargin: "0.3",
      },
      serverResult: {
        result: selectedCalculation,
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
        inputJson,
        requestNonQuantityJson: inputJson,
        selectedCandidateId: candidate.id,
        originalQuantity: input.quantity,
        originalSkuQuantities: [input.quantity],
        originalInputJson: inputJson,
        originalRequestNonQuantityJson: inputJson,
        originalPrintingMethod: input.printingMethod,
        originalTargetMargin: "0.3",
        calculationRequest: selectedRequest,
        originalCalculationRequest: originalRequest,
      },
      calculatedAt: "09:00:00",
    }));

    render(<QuotationPage />);
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "not_calculated"));
    expect(screen.getByTestId("server-result")).toHaveTextContent("サーバー再計算待ち");
    expect(sessionStorage.getItem(QUOTATION_DRAFT_KEY)).toBeNull();
    expect(sessionStorage.getItem("pouch-simulator-stale-status-v1")).toBe("legacy-selected-state");
    await waitFor(() => {
      const savedState = JSON.parse(sessionStorage.getItem("pouch-simulator-state-v1")!);
      expect(savedState.serverResult).toBeNull();
    });
  });

  it("rejects a saved calculation without a valid calculation request", async () => {
    const input = {
      spec: {
        sizeKey: "round-50x60", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      } as PouchSpec,
      quantity: "10000", printingMethod: "digital" as const,
    };
    const result = calculatePouchCost(input);
    sessionStorage.setItem(QUOTATION_DRAFT_KEY, JSON.stringify({ stale: true }));
    sessionStorage.setItem("pouch-simulator-state-v1", JSON.stringify({
      version: 1,
      form: { quantity: input.quantity, printingMethod: "digital" },
      serverResult: {
        result,
        originalResult: result,
        candidates: [],
        inputJson: JSON.stringify({ printingMethod: "digital" }),
        selectedCandidateId: "",
      },
      calculatedAt: "09:00:00",
    }));

    render(<QuotationPage />);
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "not_calculated"));
    expect(sessionStorage.getItem(QUOTATION_DRAFT_KEY)).toBeNull();
    expect(sessionStorage.getItem("pouch-simulator-stale-status-v1")).toBe("calculation-provenance-invalid");
    await waitFor(() => {
      const savedState = JSON.parse(sessionStorage.getItem("pouch-simulator-state-v1")!);
      expect(savedState.serverResult).toBeNull();
    });
  });

  it("clears stale quotation status for a fresh candidate and marks changed inputs stale", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      } as PouchSpec,
      quantity: "50000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const targetMargins = ["0.3", "0.35", "0.4"];
    const originalCalculation = calculatePouchCost({
      ...input,
      targetMargins,
      recommendationMode: true,
    });
    const candidate = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
    expect(candidate).toBeTruthy();
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result = body.selectedCandidateId
        ? calculatePouchCost({
          ...input,
          targetMargins: body.targetMargins,
          recommendationMode: true,
          selectedCandidateId: body.selectedCandidateId,
          selectedCandidateTargetMargins: body.selectedCandidateTargetMargins,
        })
        : originalCalculation;
      return new Response(JSON.stringify({
        result,
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    sessionStorage.setItem("pouch-simulator-stale-status-v1", "input-changed");
    sessionStorage.removeItem(QUOTATION_DRAFT_KEY);

    await user.click(screen.getByRole("button", { name: /Y \/ 国内調達/ }));
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
    await waitFor(() => {
      expect(sessionStorage.getItem(QUOTATION_DRAFT_KEY)).not.toBeNull();
      expect(sessionStorage.getItem("pouch-simulator-stale-status-v1")).toBeNull();
    });

    await waitFor(() => expect(screen.getAllByRole("button", { name: /元の数量へ戻る/ })[0]).toBeEnabled());
    await user.click(screen.getAllByRole("button", { name: /元の数量へ戻る/ })[0]);
    await waitFor(() => expect(screen.getByTestId("input-summary")).toHaveTextContent("デジタル印刷"));
    await waitFor(() => {
      const draft = JSON.parse(sessionStorage.getItem(QUOTATION_DRAFT_KEY)!);
      expect(draft.resultHash).toBe(originalCalculation.audit.resultJsonSha256);
      expect(draft.calculationRequest.selectedCandidateId).toBe("");
      expect(draft.calculationRequest.targetMargins).toEqual(targetMargins);
    });

    fireEvent.change(screen.getByLabelText("発注数量 (枚)"), { target: { value: "50001" } });
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "stale"));
    await waitFor(() => {
      expect(sessionStorage.getItem(QUOTATION_DRAFT_KEY)).toBeNull();
      expect(sessionStorage.getItem("pouch-simulator-stale-status-v1")).toBe("input-changed");
    });
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
