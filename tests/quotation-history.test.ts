import { describe, expect, it } from "vitest";
import { calculatePouchCost } from "@/lib/calculation";
import { calculateAutomaticQuotation } from "@/lib/quotation-pricing";
import { D } from "@/lib/decimal";
import { analyzeQuotation, filmCompositionOf } from "@/lib/quotation-history";
import { DEFAULT_FILM_COMPOSITION, type QuotationRecord } from "@/lib/quotation-shared";

const baseRecord = {
  id: 1,
  quotationNumber: "Q-TEST",
  status: "draft",
  issueDate: "2026-09-05",
  validUntil: "2026-09-30",
  customerName: "テスト株式会社",
  customerContact: "田中様",
  productName: "テストパウチ",
  sizeSummary: "50×60mm / 1連",
  quantity: "10000",
  fillingCostPerPiece: "3",
  filmCostPerPiece: "2",
  filmMeterPrice: "226",
  filmOrderLengthM: "500",
  targetMargin: "0.4",
  taxRatePercent: "10",
  pricePerPiece: "8.333333333333334",
  subtotal: "83333",
  tax: "8333",
  grandTotal: "91666",
  deliveryDate: "別途相談",
  paymentTerms: "別途相談",
  notes: "",
  calculationVersion: "simulator-linked",
  resultHash: "hash",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  payload: {},
} as unknown as QuotationRecord;

describe("quotation history analysis", () => {
  it("uses the connected-surcharge pricing basis for the target filling unit when stored", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: {
        ...baseRecord.payload,
        pricingFillingCostPerPiece: "12.72",
        targetMargin: "0.4",
      },
    });
    // 신규 규칙: 1연 기준×연결수×(1+가산) 을 마진으로 나눈 값이 목표 충진 단가.
    expect(analysis.targetFillingUnit.eq("21.2")).toBe(true);
    // 구 레코드(기준값 없음)는 종래대로 원가÷(1−마진).
    const legacy = analyzeQuotation(baseRecord);
    expect(legacy.targetFillingUnit.eq("5")).toBe(true);
  });

  it("splits filling cost into processing and bulk when the checklist snapshot provides components", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: {
        ...baseRecord.payload,
        fillingCostPerPiece: "53.8",
        calculationChecklistSnapshot: {
          bulkCost: "486000",
          variableProcessingTotal: "27178.1",
          fixedLotCost: "23380.7",
        },
      },
    });
    expect(analysis.hasFillingCostBreakdown).toBe(true);
    // 매수당 1자리 올림: 가공 2.8＋2.4＝5.2／バルク 48.6 → 합계 53.8＝통합 원가.
    expect(analysis.processingCostUnit.toNumber()).toBeCloseTo(5.2, 8);
    expect(analysis.bulkCostUnit.toNumber()).toBeCloseTo(48.6, 8);
    expect(analysis.processingCostUnit.plus(analysis.bulkCostUnit).eq("53.8")).toBe(true);
    expect(analysis.fillingCostUnit.eq("53.8")).toBe(true);
  });

  it("keeps the combined filling cost for legacy records without a snapshot", () => {
    const analysis = analyzeQuotation(baseRecord);
    expect(analysis.hasFillingCostBreakdown).toBe(false);
    expect(analysis.processingCostUnit.toNumber()).toBe(0);
    expect(analysis.bulkCostUnit.toNumber()).toBe(0);
    expect(analysis.fillingCostUnit.eq("3")).toBe(true);
  });

  it("matches history analysis with formula-applied quotation values end to end", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "round-60x80", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false,
        colorCount: 4, bulkUnitPrice: "0.37", skuCount: 1,
      },
      quantity: "10000",
      printingMethod: "digital",
    });
    const quote = calculateAutomaticQuotation(result, "0.4")!;
    const fillingCostUnit = D(result.costPerPieceComponents.bulk)
      .plus(result.costPerPieceComponents.variableProcessing)
      .plus(result.costPerPieceComponents.fixedLot);
    const formulaRecord = {
      ...baseRecord,
      payload: {
        quantity: result.quantity,
        fillingCostPerPiece: fillingCostUnit.toString(),
        pricingFillingCostPerPiece: result.singleConnectedFillingCostPerPiece,
        filmCostPerPiece: result.costPerPieceComponents.film,
        targetMargin: "0.4",
        fillingUnitDisplay: quote.display.fillingUnit,
        fillingAmountDisplay: quote.display.fillingAmount,
        filmPouchUnitDisplay: quote.display.filmPouchUnit,
        filmAmountDisplay: quote.display.filmAmount,
        filmOrderLengthM: result.film.orderLengthM,
        pricePerPieceDisplay: quote.display.pricePerPiece,
        subtotalDisplay: quote.display.subtotal,
        taxDisplay: quote.display.tax,
        grandTotalDisplay: quote.display.grandTotal,
        calculationChecklistSnapshot: {
          bulkCost: result.bulkCost,
          variableProcessingTotal: result.costComponents.variableProcessing,
          fixedLotCost: result.costComponents.fixedLot,
        },
      },
    } as unknown as QuotationRecord;
    const analysis = analyzeQuotation(formulaRecord);
    // 견적 표시값 ↔ 이력 분석 전 항목 일치.
    expect(analysis.fillingUnit.eq(quote.display.fillingUnit)).toBe(true);
    expect(analysis.fillingAmount.eq(quote.fillingAmount)).toBe(true);
    expect(analysis.filmUnit.eq(quote.display.filmPouchUnit)).toBe(true);
    expect(analysis.filmAmount.eq(quote.display.filmAmount)).toBe(true);
    expect(analysis.sellingUnit.eq(quote.display.pricePerPiece)).toBe(true);
    expect(analysis.subtotal.eq(quote.subtotal)).toBe(true);
    expect(analysis.tax.eq(quote.tax)).toBe(true);
    expect(analysis.grandTotal.eq(quote.grandTotal)).toBe(true);
    // 원가 체계: 통합 충진원가 ＝ 가공(변동＋고정)＋벌크, 총원가 구성 일치.
    expect(analysis.fillingCostUnit.eq(fillingCostUnit)).toBe(true);
    expect(analysis.hasFillingCostBreakdown).toBe(true);
    expect(analysis.processingCostUnit.plus(analysis.bulkCostUnit).eq(fillingCostUnit)).toBe(true);
    expect(analysis.costUnit.eq(fillingCostUnit.plus(result.costPerPieceComponents.film))).toBe(true);
  });

  it("reflects a manually edited filling unit in saved totals while keeping the cost basis", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "round-60x80", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false,
        colorCount: 4, bulkUnitPrice: "0.37", skuCount: 1,
      },
      quantity: "10000",
      printingMethod: "digital",
    });
    const fillingCostUnit = D(result.costPerPieceComponents.bulk)
      .plus(result.costPerPieceComponents.variableProcessing)
      .plus(result.costPerPieceComponents.fixedLot);
    // 충진 단가를 90엔으로 수동 수정한 경우의 저장값 (디지털 필름 450엔/m×500m＝225,000엔 유지).
    const manualRecord = {
      ...baseRecord,
      payload: {
        quantity: "10000",
        fillingCostPerPiece: fillingCostUnit.toString(),
        filmCostPerPiece: result.costPerPieceComponents.film,
        targetMargin: "0.4",
        fillingUnitDisplay: "90",
        fillingAmountDisplay: "900000",
        filmPouchUnitDisplay: "22.5",
        filmAmountDisplay: "225000",
        filmOrderLengthM: "500",
        pricePerPieceDisplay: "112.5",
        subtotalDisplay: "1125000",
        taxDisplay: "112500",
        grandTotalDisplay: "1237500",
        calculationChecklistSnapshot: {
          bulkCost: result.bulkCost,
          variableProcessingTotal: result.costComponents.variableProcessing,
          fixedLotCost: result.costComponents.fixedLot,
        },
      },
    } as unknown as QuotationRecord;
    const analysis = analyzeQuotation(manualRecord);
    expect(analysis.fillingUnit.eq("90")).toBe(true);
    expect(analysis.fillingAmount.eq("900000")).toBe(true);
    expect(analysis.subtotal.eq("1125000")).toBe(true);
    expect(analysis.grandTotal.eq("1237500")).toBe(true);
    // 수동 수정은 판매단가만 바꾸고 원가 기준은 그대로 유지한다.
    expect(analysis.fillingCostUnit.eq(fillingCostUnit)).toBe(true);
    expect(analysis.costUnit.eq(fillingCostUnit.plus(result.costPerPieceComponents.film))).toBe(true);
    expect(analysis.profitUnit.eq(D("112.5").minus(analysis.costUnit))).toBe(true);
  });

  it("separates gravure copper cost and keeps displayed snapshot values", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      filmCostPerPiece: "3",
      payload: {
        ...baseRecord.payload,
        printingMethod: "gravure",
        fillingCostPerPiece: "3",
        filmCostPerPiece: "2",
        copperPlateCostPerPiece: "1",
        pricePerPieceDisplay: "10",
        fillingUnitDisplay: "5",
        fillingAmountDisplay: "50000",
        filmUnitDisplay: "400",
        filmPouchUnitDisplay: "3",
        filmAmountDisplay: "30000",
        copperUnitDisplay: "2",
        copperAmountDisplay: "20000",
        subtotalDisplay: "100000",
        taxDisplay: "10000",
        grandTotalDisplay: "110000",
        orderPatternCount: "1",
        deliverablePatternLengthM: "5500",
        recommendedQuantity: "11000",
      },
    });

    expect(analysis.costUnit.toNumber()).toBe(6);
    expect(analysis.copperCostUnit.toNumber()).toBe(1);
    expect(analysis.copperUnit.toNumber()).toBe(2);
    expect(analysis.copperAmount.toNumber()).toBe(20000);
    expect(analysis.sellingUnit.toNumber()).toBe(10);
    expect(analysis.profitUnit.toNumber()).toBe(4);
    expect(analysis.profitRate.toNumber()).toBe(40);
    expect(analysis.subtotal.toNumber()).toBe(100000);
    expect(analysis.orderPatternCount.toNumber()).toBe(1);
    expect(analysis.deliverablePatternLengthM.toNumber()).toBe(5500);
    expect(analysis.recommendedQuantity.toNumber()).toBe(11000);
  });

  it("recalculates profit from an edited selling price", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: { ...baseRecord.payload, pricePerPieceDisplay: "6" },
    });

    expect(analysis.costUnit.toNumber()).toBe(5);
    expect(analysis.sellingUnit.toNumber()).toBe(6);
    expect(analysis.profitUnit.toNumber()).toBe(1);
    expect(analysis.profitRate.toFixed(2)).toBe("16.67");
    expect(analysis.totalProfit.toNumber()).toBe(10000);
  });

  it("keeps the film composition backward compatible for older records", () => {
    expect(filmCompositionOf(baseRecord)).toBe(DEFAULT_FILM_COMPOSITION);
    expect(filmCompositionOf({
      ...baseRecord,
      payload: { ...baseRecord.payload, filmComposition: "PET12/AL7" },
    })).toBe("PET12/AL7");
  });

  it("uses the displayed-value snapshot without recomputing rounded quote lines", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: {
        ...baseRecord.payload,
        quantity: "10000",
        fillingCostPerPiece: "3",
        filmCostPerPiece: "2",
        pricePerPieceDisplay: "38.8",
        fillingUnitDisplay: "16.3",
        fillingAmountDisplay: "163000",
        filmUnitDisplay: "450",
        filmPouchUnitDisplay: "22.5",
        filmAmountDisplay: "225000",
        adjustmentDisplay: "-",
        subtotalDisplay: "388000",
        taxDisplay: "38800",
        grandTotalDisplay: "426800",
      },
    });

    expect(analysis.sellingUnit.toNumber()).toBe(38.8);
    expect(analysis.fillingUnit.toNumber()).toBe(16.3);
    expect(analysis.fillingAmount.toNumber()).toBe(163000);
    expect(analysis.displayedFilmMeterUnit?.toNumber()).toBe(450);
    expect(analysis.filmUnit.toNumber()).toBe(22.5);
    expect(analysis.filmAmount.toNumber()).toBe(225000);
    expect(analysis.adjustment.toNumber()).toBe(0);
    expect(analysis.subtotal.toNumber()).toBe(388000);
    expect(analysis.tax.toNumber()).toBe(38800);
    expect(analysis.grandTotal.toNumber()).toBe(426800);
  });

  it("uses record totals as the display fallback for legacy payloads", () => {
    const analysis = analyzeQuotation(baseRecord);

    expect(analysis.sellingUnit.toNumber()).toBe(Number(baseRecord.pricePerPiece));
    expect(analysis.subtotal.toNumber()).toBe(Number(baseRecord.subtotal));
    expect(analysis.tax.toNumber()).toBe(Number(baseRecord.tax));
    expect(analysis.grandTotal.toNumber()).toBe(Number(baseRecord.grandTotal));
  });

  it("restores legacy quote lines from the record total and film order", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      fillingCostPerPiece: "5.055864785420340975896531452087007642563",
      filmCostPerPiece: "18.22",
      filmMeterPrice: "328",
      pricePerPiece: "38.8",
      payload: {},
    });

    expect(analysis.displayedFilmMeterUnit?.toNumber()).toBe(450);
    expect(analysis.fillingUnit.toFixed(2)).toBe("16.30");
    expect(analysis.fillingAmount.toNumber()).toBe(163000);
    expect(analysis.filmUnit.toFixed(2)).toBe("22.50");
    expect(analysis.filmAmount.toNumber()).toBe(225000);
    expect(analysis.profitRate.toFixed(4)).toBe("40.0107");
  });

  it("reconstructs legacy copper pricing with the fixed ten-percent target margin", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: {
        ...baseRecord.payload,
        printingMethod: "gravure",
        fillingCostPerPiece: "3",
        filmCostPerPiece: "2",
        copperPlateCostPerPiece: "1",
        copperColorCount: "4",
        targetMargin: "0.4",
      },
    });

    expect(analysis.targetCopperUnit.toFixed(10)).toBe("1.1111111111");
    expect(analysis.copperColorUnit.toNumber()).toBe(2778);
    expect(analysis.copperColorCount.toNumber()).toBe(4);
    expect(analysis.copperAmount.toNumber()).toBe(11112);
  });

  it("reconstructs custom mold quantity and unit from the mold-set basis", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: {
        ...baseRecord.payload,
        customLotCost: "30000",
        customQuantity: "2",
        targetMargin: "0.4",
      },
    });

    expect(analysis.customQuantity.toNumber()).toBe(2);
    expect(analysis.customUnit.toNumber()).toBe(25000);
    expect(analysis.customAmount.toNumber()).toBe(50000);
  });
});
