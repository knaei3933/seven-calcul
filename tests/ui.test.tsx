import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotationPage from "@/app/simulator-client";
import { calculatePouchCost, type CostResult } from "@/lib/calculation";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { QUOTATION_DRAFT_KEY } from "@/lib/quotation-draft";
import type { PouchSpec } from "@/lib/types";
import type { PrintCandidate } from "@/lib/print-recommendation";

describe("quotation UI", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(cleanup);

  function candidateTestInput(quantity = "50000") {
    return {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      } as PouchSpec,
      quantity, printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
  }

  function candidateFetch(input: ReturnType<typeof candidateTestInput>) {
    const originalCalculation = calculatePouchCost({ ...input, recommendationMode: true });
    return {
      originalCalculation,
      fetch: vi.fn(async (_url: RequestInfo | URL | URL, init?: RequestInit) => {
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
      }),
    };
  }

  async function openCandidateModal(quantity = "50000") {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = candidateTestInput(quantity);
    if (quantity !== "10000") {
      const quantityInput = screen.getByLabelText("発注数量 (枚)");
      await user.clear(quantityInput);
      await user.type(quantityInput, quantity);
    }
    const { fetch, originalCalculation } = candidateFetch(input);
    global.fetch = fetch;
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    return { user, fetch, originalCalculation };
  }

  async function rejectTamperedSelectedCandidate(tamperSelected: (selected: PrintCandidate) => PrintCandidate) {
    const { user, fetch, originalCalculation } = await openCandidateModal();
    const modal = screen.getByTestId("recommendation-modal");
    const stateBefore = screen.getByTestId("selected-candidate-summary").textContent;
    const candidate = within(modal).getByRole("button", { name: /Y \/ 国内調達/ });
    const selected = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.selectedCandidateId) {
        return Response.json({
          result: calculatePouchCost({
            ...candidateTestInput(),
            recommendationMode: true,
            selectedCandidateId: selected.id,
            targetMargins: ["0.3", "0.35", "0.4"],
          }),
          originalResult: originalCalculation,
          candidates: originalCalculation.recommendationCandidates!.map((item) => (
            item.id === selected.id ? tamperSelected(item) : item
          )),
        }, { status: 200 });
      }
      return await fetch(url, init);
    });

    await user.click(candidate);
    const alert = await screen.findByTestId("candidate-selection-error");
    expect(alert).toHaveTextContent("candidate_response_invalid");
    expect(screen.getByTestId("recommendation-modal")).toBe(modal);
    expect(screen.getByTestId("selected-candidate-summary").textContent).toBe(stateBefore);
    expect(screen.queryByTestId("active-candidate-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  }

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
      quantity: "10000", printingMethod: "digital", recommendationMode: true,
    });
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      result,
      originalResult: result,
      candidates: result.recommendationCandidates ?? [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    await user.clear(screen.getByLabelText("発注数量 (枚)"));
    await user.type(screen.getByLabelText("発注数量 (枚)"), "20000");
    await new Promise((resolve) => setTimeout(resolve, 0));
	    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "stale");
	    expect(screen.getByTestId("server-result")).toHaveTextContent("再計算が必要");
	    expect(screen.getByTestId("stale-input-warning")).toHaveTextContent("入力内容が変わりました");
	    expect(screen.getByTestId("stale-input-warning")).toHaveTextContent("今すぐ再計算");
	    expect(screen.getByTestId("calculate-desktop")).toHaveTextContent("再計算して候補を見る");

	    await user.click(screen.getByTestId("stale-recalc-button"));
	    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
	    expect(screen.queryByTestId("stale-input-warning")).not.toBeInTheDocument();
	    expect(screen.getByTestId("calculate-desktop")).toHaveTextContent("候補を再取得");
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
      quantity: "20000", printingMethod: "digital", recommendationMode: true,
    });
    await act(async () => {
      resolvers[1](new Response(JSON.stringify({
        result: secondResult,
        originalResult: secondResult,
        candidates: secondResult.recommendationCandidates ?? [],
      }), { status: 200 }));
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
    expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Y \/ 国内調達（グラビア印刷）/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /パウチ 35×80mm/ }).length).toBeGreaterThan(0);
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
    await user.click(screen.getByTestId("candidate-recompare"));
    await waitFor(() => expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument());

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

	    await waitFor(() => expect(screen.getByTestId("candidate-recompare")).toBeEnabled());
    await user.click(screen.getByTestId("candidate-recompare"));
    await user.click(screen.getAllByRole("button", { name: /D \/ デジタル/ })[0]);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（デジタル印刷）"));
    expect(screen.getByLabelText("利益率 40%")).toBeChecked();
    expect(screen.getByLabelText("利益率 30%")).not.toBeChecked();

    await waitFor(() => expect(screen.getByRole("button", { name: "元の数量へ戻る" })).toBeEnabled());
    await user.click(screen.getByTestId("candidate-recompare"));
    await waitFor(() => expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument());
    await user.click(within(screen.getByTestId("recommendation-modal")).getByRole("button", { name: /Y \/ 国内調達/ }));
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

    await user.click(screen.getByTestId("candidate-recompare"));
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

  it("shows a near-target domestic shortage as a selectable comparison", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-35x80", fillMlPerChamber: "3", connectedChambers: 1 as const, fillingMethod: "hopper" as const,
        fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
        skuQuantities: ["150000"], skuColorCounts: ["4"],
      } as PouchSpec,
      quantity: "150000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalCalculation = calculatePouchCost({ ...input, recommendationMode: true });
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

    const nearCandidates = originalCalculation.recommendationCandidates?.filter((candidate) => candidate.route === "Y" && !candidate.isFulfilling);
    expect(nearCandidates?.map((candidate) => candidate.orderLengthM)).toEqual(["3500", "3400"]);
    const closestCard = screen.getByRole("button", { name: /Y \/ 国内調達（グラビア印刷）.*3,500/ });
    const lowestCostCard = screen.getByRole("button", { name: /Y \/ 国内調達（グラビア印刷）.*3,400/ });
    expect(closestCard).toBeEnabled();
    expect(lowestCostCard).toBeEnabled();
    expect(closestCard).toHaveTextContent("目標数近似・不足参考");
    expect(lowestCostCard).toHaveTextContent("目標数近似・不足参考");
    expect(closestCard).toHaveTextContent("数量不足 4,000枚（2.7%）");
    expect(lowestCostCard).toHaveTextContent("数量不足 8,000枚（5.4%）");

    await user.click(lowestCostCard);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("142,000 枚"));
    expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）");
  });

  it("progressively discloses and keeps a selected shortage reference accessible", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      spec: {
        sizeKey: "tube-50x90", fillMlPerChamber: "3", connectedChambers: 1 as const, fillingMethod: "hopper" as const,
        fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
        skuQuantities: ["30000"], skuColorCounts: ["4"],
      } as PouchSpec,
      quantity: "30000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
    };
    const originalCalculation = calculatePouchCost({ ...input, recommendationMode: true });
    const shortage = originalCalculation.recommendationCandidates!.find((candidate) => candidate.route === "D" && !candidate.isFulfilling)!;
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
    await user.type(quantityInput, "30000");
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));
    const disclosure = screen.getByRole("button", { name: "不足プランを比較する" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/顧客発注に届かない小さいまとめ購入です/)).toBeInTheDocument();

    await user.click(disclosure);
    expect(screen.getByTestId("comparison-D")).toBeInTheDocument();
    const shortageCard = screen.getByRole("button", { name: /D \/ デジタル.*不足のため参考/ });
    expect(shortageCard).toBeEnabled();
    await user.click(shortageCard);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（デジタル印刷）"));
    expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("17,000 枚");
    await user.click(screen.getByTestId("candidate-recompare"));
    await waitFor(() => expect(screen.getByRole("button", { name: /D \/ デジタル.*不足のため参考/ })).toBeVisible());
    expect(screen.getByTestId("comparison-D")).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId("candidate-selection-error")).toHaveTextContent("candidate_result_mismatch"));
    expect(screen.queryByTestId("calculation-error")).not.toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByTestId("candidate-recompare")).toBeEnabled());
    await user.click(screen.getByTestId("candidate-recompare"));
    const reopenedModal = screen.getByTestId("recommendation-modal");
    await user.click(within(reopenedModal).getByRole("button", { name: /Y \/ 国内調達/ }));
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));
    expect(screen.getByLabelText("利益率 30%")).toBeChecked();
    expect(screen.getByLabelText("利益率 カスタム")).not.toBeChecked();

    await waitFor(() => expect(screen.getByTestId("candidate-recompare")).toBeEnabled());
    await user.click(screen.getByTestId("candidate-recompare"));
    await waitFor(() => expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: /D \/ デジタル/ })[0]);
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（デジタル印刷）"));
    expect(screen.getByLabelText("利益率 カスタム")).toBeChecked();
    expect(screen.getByLabelText("カスタム利益率 (%)")).toHaveValue("42");

    await waitFor(() => expect(screen.getByRole("button", { name: "元の数量へ戻る" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "元の数量へ戻る" }));
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

    await waitFor(() => expect(screen.getByRole("button", { name: "元の数量へ戻る" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "元の数量へ戻る" }));
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

  it("exposes one accessible, focus-managed modal with complete comparison content", async () => {
    const { user, fetch } = await openCandidateModal("30000");
    const modal = screen.getByTestId("recommendation-modal");
    const dialog = screen.getByRole("dialog", { name: "フィルム調達・製造計画候補" });
    expect(dialog).toBe(modal);
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(modal).toHaveTextContent("入力条件");
    for (const route of ["D", "K", "Y"]) {
      expect(within(modal).getAllByRole("button", { name: new RegExp(`${route} /`) }).length).toBeGreaterThan(0);
    }
    expect(within(modal).getAllByRole("button", { name: /推奨/ })[0]).toHaveTextContent("推奨");
    expect(within(modal).getByTestId("all-in-comparison")).toHaveAccessibleName(/すべて合算した原価比較/);
    expect(within(modal).getByTestId("comparison-input")).toBeInTheDocument();
    expect(within(modal).getByTestId("comparison-Y")).toBeInTheDocument();
    expect(within(modal).getByRole("button", { name: "不足プランを比較する" })).toBeInTheDocument();

    expect(screen.getAllByTestId("recommendation-modal")).toHaveLength(1);
    expect(screen.getAllByTestId("all-in-comparison")).toHaveLength(1);
    expect(document.body).toHaveStyle({ overflow: "hidden" });
    const closeButton = within(modal).getByTestId("recommendation-modal-close");
    expect(closeButton).toHaveFocus();

    const focusable = within(modal).getAllByRole("button").filter((button) => !button.hasAttribute("disabled"));
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0];
    const last = focusable.at(-1)!;
    first.focus();
    fireEvent.keyDown(modal, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    last.focus();
    fireEvent.keyDown(modal, { key: "Tab" });
    expect(first).toHaveFocus();
    expect(first).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("recommendation-modal")).not.toBeInTheDocument());
    expect(document.body).toHaveStyle({ overflow: "" });
    expect(screen.getByTestId("calculate-desktop")).toHaveFocus();

    const callsBeforeRecompare = fetch.mock.calls.length;
    await user.click(screen.getByTestId("candidate-recompare"));
    expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument();
    expect(fetch.mock.calls).toHaveLength(callsBeforeRecompare);
  });

  it("merges a minimum digital order with the equivalent input basis", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    const input = {
      ...candidateTestInput("10000"),
      spec: {
        ...candidateTestInput("10000").spec,
        sizeKey: "round-50x60",
      },
    } as ReturnType<typeof candidateTestInput>;
    global.fetch = candidateFetch(input).fetch;
    await user.click(screen.getByTestId("calculate-desktop"));
    await waitFor(() => expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated"));

    const modal = screen.getByTestId("recommendation-modal");
    const basis = within(modal).getByTestId("input-basis-card");
    expect(basis).toHaveTextContent("入力値と同一発注");
    expect(basis).toHaveTextContent("推奨");
    expect(basis).toHaveTextContent("合計最低発注 500mのため、最低発注量まで注文しました。");
    expect(basis).not.toHaveTextContent("undefined");
    expect(basis).toHaveTextContent("顧客 10,000枚 ／ 製作可能 25,454枚 ／ 計画 10,000枚");
    expect(within(modal).queryByRole("button", { name: /D \/ デジタル/ })).not.toBeInTheDocument();
    expect(within(modal).queryByTestId("comparison-D")).not.toBeInTheDocument();
    expect(within(modal).getByTestId("comparison-input")).toHaveTextContent("￥182,200");
    expect(within(modal).getByTestId("comparison-input")).toHaveTextContent("入力した発注数の計算");
  });

  it("protects dismissal during selection and closes only after a validated candidate commit", async () => {
    const { user, fetch, originalCalculation } = await openCandidateModal();
    const modal = screen.getByTestId("recommendation-modal");
    const candidate = within(modal).getByRole("button", { name: /Y \/ 国内調達/ });
    let resolveSelection: (value: Response) => void = () => {};
    global.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.selectedCandidateId) {
        return new Promise<Response>((resolve) => {
          resolveSelection = resolve;
        });
      }
      return fetch(url, init);
    });
    await user.click(candidate);

    expect(screen.getByTestId("candidate-selection-progress")).toHaveTextContent("選択を反映しています…");
    expect(modal).toHaveAttribute("data-state", "selecting");
    expect(within(modal).getByTestId("recommendation-modal-close")).toBeDisabled();
    expect(within(modal).getAllByRole("button", { name: /D \/|K \/|Y \// }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    const activeDuringSelection = document.activeElement;
    expect(activeDuringSelection).not.toBe(document.body);
    expect(activeDuringSelection instanceof Node && modal.contains(activeDuringSelection)).toBe(true);
    expect(within(modal).getByTestId("candidate-selection-progress")).toHaveFocus();
    fireEvent.mouseDown(screen.getByTestId("recommendation-modal-overlay"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument();
    activeDuringSelection?.dispatchEvent(new FocusEvent("focusout", { relatedTarget: document.body }));
    await waitFor(() => expect(modal).toContainElement(document.activeElement as HTMLElement));
    expect(document.activeElement).not.toBe(document.body);

    const selected = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
    await act(async () => {
      resolveSelection(Response.json({
        result: calculatePouchCost({
          ...candidateTestInput(),
          recommendationMode: true,
          selectedCandidateId: selected.id,
          targetMargins: ["0.3", "0.35", "0.4"],
        }),
        originalResult: originalCalculation,
        candidates: originalCalculation.recommendationCandidates ?? [],
      }));
    });
    await waitFor(() => expect(screen.queryByTestId("recommendation-modal")).not.toBeInTheDocument());
    expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）");
    expect(screen.getByTestId("selected-candidate-summary")).toHaveTextContent("Y / 国内調達（グラビア印刷）");
    expect(screen.getByTestId("selected-candidate-summary")).toHaveTextContent("総原価");
  });

  it("keeps a failed candidate selection in the modal with retryable alert semantics", async () => {
    const { user, fetch } = await openCandidateModal();
    const candidate = within(screen.getByTestId("recommendation-modal")).getByRole("button", { name: /Y \/ 国内調達/ });
    let selectionAttempts = 0;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.selectedCandidateId && selectionAttempts++ === 0) throw new Error("candidate_calculation_failed");
      return await fetch(url, init);
    });

    await user.click(candidate);
    const alert = await screen.findByTestId("candidate-selection-error");
    expect(alert).toHaveTextContent("candidate_calculation_failed");
    expect(alert).toHaveTextContent("もう一度候補を選択してください");
    expect(alert).toHaveTextContent("「閉じる」");
    expect(alert).not.toHaveTextContent("サーバーで再計算する");
    expect(within(screen.getByTestId("recommendation-modal")).getByRole("alert")).toBe(alert);
    expect(screen.queryByTestId("active-candidate-note")).not.toBeInTheDocument();

    const retry = within(screen.getByTestId("recommendation-modal")).getByRole("button", { name: /Y \/ 国内調達/ });
    await user.click(retry);
    await waitFor(() => expect(screen.queryByTestId("recommendation-modal")).not.toBeInTheDocument());
    expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）");
  });

  it("keeps focus inside the modal when a failed selection finishes", async () => {
    const { user } = await openCandidateModal();
    const modal = screen.getByTestId("recommendation-modal");
    const candidate = within(modal).getByRole("button", { name: /Y \/ 国内調達/ });
    global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.selectedCandidateId) throw new Error("candidate_calculation_failed");
      return await fetch(_url, init);
    });

    await user.click(candidate);
    await screen.findByTestId("candidate-selection-error");
    const status = screen.getByTestId("candidate-selection-status");
    expect(status).toHaveFocus();
    expect(status).toHaveClass("visually-hidden");
    expect(status).not.toHaveAttribute("aria-live");
    expect(status).not.toHaveAttribute("role");
    expect(modal.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("rejects a malformed candidate original result and preserves prior state", async () => {
    const { user, fetch, originalCalculation } = await openCandidateModal();
    const modal = screen.getByTestId("recommendation-modal");
    const stateBefore = screen.getByTestId("selected-candidate-summary").textContent;
    const candidate = within(modal).getByRole("button", { name: /Y \/ 国内調達/ });
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.selectedCandidateId) {
        const selected = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
        return Response.json({
          result: calculatePouchCost({
            ...candidateTestInput(),
            recommendationMode: true,
            selectedCandidateId: selected.id,
            targetMargins: ["0.3", "0.35", "0.4"],
          }),
          originalResult: { quantity: originalCalculation.quantity },
          candidates: originalCalculation.recommendationCandidates ?? [],
        }, { status: 200 });
      }
      return await fetch(url, init);
    });

    await user.click(candidate);
    const alert = await screen.findByTestId("candidate-selection-error");
    expect(alert).toHaveTextContent("candidate_response_invalid");
    expect(screen.getByTestId("recommendation-modal")).toBe(modal);
    expect(screen.queryByTestId("active-candidate-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("selected-candidate-summary").textContent).toBe(stateBefore);
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  });

  it("rejects a candidate response that omits the exact selected candidate", async () => {
    const { user, fetch, originalCalculation } = await openCandidateModal();
    const candidate = within(screen.getByTestId("recommendation-modal")).getByRole("button", { name: /Y \/ 国内調達/ });
    const stateBefore = screen.getByTestId("selected-candidate-summary").textContent;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.selectedCandidateId) {
        const selected = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
        return Response.json({
          result: calculatePouchCost({
            ...candidateTestInput(),
            recommendationMode: true,
            selectedCandidateId: selected.id,
            targetMargins: ["0.3", "0.35", "0.4"],
          }),
          originalResult: originalCalculation,
          candidates: originalCalculation.recommendationCandidates!.filter((item) => item.id !== selected.id),
        }, { status: 200 });
      }
      return await fetch(url, init);
    });

    await user.click(candidate);
    const alert = await screen.findByTestId("candidate-selection-error");
    expect(alert).toHaveTextContent("candidate_response_invalid");
    expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument();
    expect(screen.getByTestId("selected-candidate-summary").textContent).toBe(stateBefore);
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  });

  it("rejects a selected candidate that has only an ID and preserves prior state", async () => {
    const { user, fetch, originalCalculation } = await openCandidateModal();
    const modal = screen.getByTestId("recommendation-modal");
    const stateBefore = screen.getByTestId("selected-candidate-summary").textContent;
    const candidate = within(modal).getByRole("button", { name: /Y \/ 国内調達/ });
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.selectedCandidateId) {
        const selected = originalCalculation.recommendationCandidates!.find((item) => item.route === "Y")!;
        return Response.json({
          result: calculatePouchCost({
            ...candidateTestInput(),
            recommendationMode: true,
            selectedCandidateId: selected.id,
            targetMargins: ["0.3", "0.35", "0.4"],
          }),
          originalResult: originalCalculation,
          candidates: [{ id: selected.id }],
        }, { status: 200 });
      }
      return await fetch(url, init);
    });

    await user.click(candidate);
    const alert = await screen.findByTestId("candidate-selection-error");
    expect(alert).toHaveTextContent("candidate_response_invalid");
    expect(screen.getByTestId("recommendation-modal")).toBe(modal);
    expect(screen.getByTestId("selected-candidate-summary").textContent).toBe(stateBefore);
    expect(screen.queryByTestId("active-candidate-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  });

  it("rejects a returned selected candidate with a mismatched route and preserves prior state", async () => {
    await rejectTamperedSelectedCandidate((selected) => {
      const { sasche: _sasche, ...withoutRouteSpecificRoll } = selected;
      return { ...withoutRouteSpecificRoll, route: "K" };
    });
  });

  it("rejects a returned selected candidate with a mismatched SKU allocation and preserves prior state", async () => {
    await rejectTamperedSelectedCandidate((selected) => ({
      ...selected,
      adjustedSkuQuantities: selected.adjustedSkuQuantities.map((quantity, index) => (index === 0 ? "1" : quantity)),
    }));
  });

  it.each([
    ["copper economics", (selected: PrintCandidate) => ({ ...selected, copperPlateTotalYen: "NaN" })],
    ["film orders", (selected: PrintCandidate) => ({
      ...selected,
      filmOrders: [{ skuCode: selected.id, requiredLengthM: "100", orderLengthM: "NaN" }],
    })],
    ["domestic roll metadata", (selected: PrintCandidate) => ({
      ...selected,
      sasche: { ...selected.sasche!, matchedWidthMm: Number.NaN },
    })],
  ])("rejects malformed candidate %s and preserves prior state", async (_label, tamperSelected) => {
    await rejectTamperedSelectedCandidate(tamperSelected);
  });

  it("reports an invalid fresh calculation response without a result fallback", async () => {
    const user = userEvent.setup();
    render(<QuotationPage />);
    global.fetch = vi.fn(async () => Response.json({ result: { quantity: "10000" } }, { status: 200 }));

    await user.click(screen.getByTestId("calculate-desktop"));
    const alert = await screen.findByTestId("calculation-error");
    expect(alert).toHaveTextContent("calculation_response_invalid");
    expect(alert).toHaveTextContent("もう一度「サーバーで再計算する」を押してください");
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "not_calculated");
    expect(screen.queryByTestId("bulk-usage")).not.toBeInTheDocument();
  });

  it("stale recalculation sends an empty selected candidate ID and reopens recommendations", async () => {
    const { user, fetch } = await openCandidateModal();
    const modal = screen.getByTestId("recommendation-modal");
    await user.click(within(modal).getByTestId("recommendation-modal-close"));
    const callsBeforeRecompare = fetch.mock.calls.length;
    await user.click(screen.getByTestId("candidate-recompare"));
    expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument();
    expect(fetch.mock.calls).toHaveLength(callsBeforeRecompare);
    const reopened = screen.getByTestId("recommendation-modal");
    await user.click(within(reopened).getByRole("button", { name: /Y \/ 国内調達/ }));
    await waitFor(() => expect(screen.getByTestId("active-candidate-note")).toHaveTextContent("選択候補（グラビア印刷）"));

    fireEvent.change(screen.getByLabelText("発注数量 (枚)"), { target: { value: "50001" } });
    expect(screen.getByTestId("server-result")).toHaveAttribute("data-state", "stale");
    expect(screen.getByTestId("calculate-desktop")).toHaveTextContent("再計算して候補を見る");
    await user.click(screen.getByTestId("calculate-desktop"));

    await waitFor(() => expect(screen.getByTestId("recommendation-modal")).toBeInTheDocument());
    const staleBody = JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body));
    expect(staleBody.selectedCandidateId).toBe("");
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
