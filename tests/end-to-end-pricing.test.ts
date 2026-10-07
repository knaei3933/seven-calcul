import { describe, expect, it } from "vitest";
import { calculatePouchCost, type CostResult } from "@/lib/calculation";
import { calculateAutomaticQuotation } from "@/lib/quotation-pricing";
import { buildQuotationDraft } from "@/lib/quotation-draft";
import { buildCalculationChecklistSnapshot, buildChecklistItems } from "@/lib/calculation-checklist";
import { analyzeQuotation } from "@/lib/quotation-history";
import { D } from "@/lib/decimal";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import type { PouchSpec } from "@/lib/types";
import type { QuotationRecord as SharedQuotationRecord } from "@/lib/quotation-shared";

const spec = (overrides: Partial<PouchSpec> = {}): PouchSpec => ({
  sizeKey: "round-60x120",
  fillMlPerChamber: "10",
  connectedChambers: 2,
  fillingMethod: "hopper",
  fillingLanes: 4,
  isCustom: false,
  colorCount: 4,
  bulkUnitPrice: "0",
  skuCount: 1,
  ...overrides,
});

function historyRecord(result: CostResult, extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    quotationNumber: "E2E",
    status: "draft",
    issueDate: "2026-10-07",
    validUntil: "2026-11-07",
    customerName: "検証",
    customerContact: "",
    productName: "検証パウチ",
    sizeSummary: "60×120mm / 2連",
    quantity: result.quantity,
    fillingCostPerPiece: "0",
    filmCostPerPiece: "0",
    filmMeterPrice: "0",
    filmOrderLengthM: result.film.orderLengthM,
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "0",
    subtotal: "0",
    tax: "0",
    grandTotal: "0",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "simulator-linked",
    resultHash: "e2e",
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    payload: {
      quantity: result.quantity,
      filmCostPerPiece: result.costPerPieceComponents.film,
      targetMargin: "0.4",
      filmPouchUnitDisplay: D(result.film.filmTotal).div(result.quantity).toString(),
      filmAmountDisplay: result.film.filmTotal,
      filmOrderLengthM: result.film.orderLengthM,
      taxRatePercent: "10",
      ...extra,
    },
  } as unknown as SharedQuotationRecord;
}

describe("end-to-end pricing integrity", () => {
  it("keeps sold-bulk quotations consistent from calculation to history (single liquid)", () => {
    const result = calculatePouchCost({ spec: spec({ bulkUnitPrice: "0.37" }), quantity: "10000", printingMethod: "digital" });
    const quote = calculateAutomaticQuotation(result, "0.4")!;
    // 가공: (1연 가공 5.3 × 2 × 1.2) ÷ 0.6 = 21.2 → 디지털 잔액 배분 36.1.
    expect(result.singleConnectedProcessingCostPerPiece).toBe("5.3");
    expect(quote.fillingSellingUnit.toNumber()).toBeCloseTo(21.2, 6);
    // 벌크: 원가 9.0 ÷ 0.6 = 15.0 (별도 라인).
    expect(result.costPerPieceComponents.bulk).toBe("9");
    expect(quote.display.bulkUnit).toBe("15");
    expect(quote.display.bulkAmount).toBe("150000");
    // 라인 구성: 충진 361,000 + 벌크 150,000 + 필름 360,000 = 871,000.
    expect(quote.display.fillingUnit).toBe("36.1");
    expect(quote.display.filmUnit).toBe("450");
    expect(quote.display.subtotal).toBe("871000");
    expect(quote.display.tax).toBe("87100");
    expect(quote.display.grandTotal).toBe("958100");

    const draft = buildQuotationDraft(result, {
      quotationNumber: "E2E",
      sourceHash: "s",
      resultHash: "r",
      widthMm: "60",
      lengthMm: "120",
      connected: "2",
      skuNames: ["充填物1"],
      targetMargin: "0.4",
      printingMethod: "digital",
      filmComposition: "PET12+AL7+PET12+LLDPE50μ",
      parameters: defaultParameters,
      lossRate: "0.1",
      bulkUnitPrice: "0.37",
      webWidthMm: 556,
      lanes: 4,
      pitchMm: "126",
      pitchAddMm: "6",
      prodMultiplier: 6,
      colorCount: 4,
      skus: [{ name: "充填物1", quantity: "10000", fillMl: "10", colorCount: "4" }],
      gravureParameters: defaultGravureRollParameters(),
    });
    expect(draft.fillingCostPerPiece).toBe("8.3"); // 가공(변동 5.9＋고정 2.4)만, 벌크 제외.
    expect(draft.bulkCostPerPiece).toBe("9");

    const analysis = analyzeQuotation(historyRecord(result, {
      fillingCostPerPiece: draft.fillingCostPerPiece,
      bulkCostPerPiece: draft.bulkCostPerPiece,
      pricingFillingCostPerPiece: draft.pricingFillingCostPerPiece,
      fillingUnitDisplay: quote.display.fillingUnit,
      fillingAmountDisplay: quote.display.fillingAmount,
      bulkUnitDisplay: quote.display.bulkUnit,
      bulkAmountDisplay: quote.display.bulkAmount,
      filmUnitDisplay: quote.display.filmUnit,
      filmAmountDisplay: quote.display.filmAmount,
      pricePerPieceDisplay: quote.display.pricePerPiece,
      subtotalDisplay: quote.display.subtotal,
      taxDisplay: quote.display.tax,
      grandTotalDisplay: quote.display.grandTotal,
    }));
    expect(analysis.hasSeparatedBulkLine).toBe(true);
    expect(analysis.bulkUnit.eq("15")).toBe(true);
    expect(analysis.bulkAmount.eq("150000")).toBe(true);
    expect(analysis.fillingCostUnit.eq("8.3")).toBe(true);
    expect(analysis.bulkCostUnit.eq("9")).toBe(true);
    expect(analysis.costUnit.eq(D("8.3").plus("9").plus(result.costPerPieceComponents.film))).toBe(true);
    expect(analysis.subtotal.eq("871000")).toBe(true);
    expect(analysis.grandTotal.eq("958100")).toBe(true);
  });

  it("keeps chamber-specific liquid pricing and checklists consistent", () => {
    const result = calculatePouchCost({
      spec: spec({
        chambers: [
          { liquidName: "エッセンスA", fillMl: "10", bulkUnitPrice: "0.37" },
          { liquidName: "ミストB", fillMl: "5", bulkUnitPrice: "0.8" },
        ],
      }),
      quantity: "10000",
      printingMethod: "digital",
    });
    const quote = calculateAutomaticQuotation(result, "0.4")!;
    // 액체별: A 48,840엔 + B 53,600엔 = 102,440엔 → 10.3엔/枚 → 17.2엔/枚 판매.
    expect(result.liquidCount).toBe(2);
    expect(result.bulkCost).toBe("102440");
    expect(result.costPerPieceComponents.bulk).toBe("10.3");
    expect(quote.display.bulkUnit).toBe("17.2");
    expect(quote.display.bulkAmount).toBe("172000");
    expect(quote.display.subtotal).toBe("892000");
    // 속도는 병목(10ml) 기준 80/분 → 2연 2,400枚/h.
    expect(result.baseProductionSpeedPerMinute).toBe("80");
    expect(result.effectiveProductionSpeed).toBe("2400");

    const snapshot = buildCalculationChecklistSnapshot(result, {
      quotationNumber: "E2E",
      printingMethod: "digital",
      sourceHash: "s",
      resultHash: "r",
      filmComposition: "PET12+AL7+PET12+LLDPE50μ",
      widthMm: "60",
      lengthMm: "120",
      pitchMm: "126",
      pitchAddMm: "6",
      webWidthMm: 556,
      skus: [{ name: "充填物1", quantity: "10000", fillMl: "7.5", colorCount: "4" }],
    });
    expect(snapshot.liquids).toHaveLength(2);
    expect(D(snapshot.bulkUnitPrice).times(snapshot.bulkUsageMl).toDecimalPlaces(0, 4).toString()).toBe(snapshot.bulkCost);
    const items = buildChecklistItems(snapshot);
    const chamberItem = items.find((item) => item.id === "bulk.chamber-structure");
    const liquidRows = items.filter((item) => item.id.startsWith("bulk.liquid."));
    expect(chamberItem?.inputs).toContain("1室=エッセンスA");
    expect(chamberItem?.inputs).toContain("2室=ミストB");
    expect(liquidRows).toHaveLength(2);
    expect(liquidRows[0]!.result).toBe("48,840");
    expect(liquidRows[1]!.result).toBe("53,600");
  });

  it("hides the bulk line for customer-supplied bulk without breaking totals", () => {
    const result = calculatePouchCost({ spec: spec(), quantity: "10000", printingMethod: "digital" });
    const quote = calculateAutomaticQuotation(result, "0.4")!;
    expect(result.costPerPieceComponents.bulk).toBe("0");
    expect(quote.display.bulkUnit).toBe("0");
    expect(quote.display.bulkAmount).toBe("0");
    // 지급 시에도 충진(36.1)+필름(360,000) 합계는 정확히 유지.
    expect(quote.display.fillingUnit).toBe("36.1");
    expect(quote.display.subtotal).toBe("721000");

    const analysis = analyzeQuotation(historyRecord(result, {
      fillingCostPerPiece: "5.2",
      bulkCostPerPiece: "0",
      fillingUnitDisplay: quote.display.fillingUnit,
      fillingAmountDisplay: quote.display.fillingAmount,
      bulkUnitDisplay: "0",
      bulkAmountDisplay: "0",
      pricePerPieceDisplay: quote.display.pricePerPiece,
      subtotalDisplay: quote.display.subtotal,
      taxDisplay: quote.display.tax,
      grandTotalDisplay: quote.display.grandTotal,
    }));
    expect(analysis.hasSeparatedBulkLine).toBe(true);
    expect(analysis.bulkAmount.toNumber()).toBe(0);
    expect(analysis.subtotal.eq("721000")).toBe(true);
    expect(analysis.grandTotal.eq("793100")).toBe(true);
  });
});
