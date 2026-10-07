import { describe, expect, it } from "vitest";
import { approvedCommission, calculatePouchCost } from "@/lib/calculation";
import { defaultParameters, defaultProductionSpeedForFillMl, sizeMaster } from "@/lib/constants";
import { normalizeDigitalFilmOrder } from "@/lib/digital-film";
import type { PouchSpec } from "@/lib/types";

const baseSpec: PouchSpec = {
  sizeKey: "mouthwash-45x145",
  fillMlPerChamber: "30",
  connectedChambers: 2,
  fillingMethod: "hopper",
  fillingLanes: 4,
  isCustom: false,
  colorCount: 4,
  bulkUnitPrice: "0.37",
  skuCount: 1,
};

describe("bulk calculation", () => {
  it("derives the machine charge from the documented basis (6.3 機械関連)", () => {
    // (25,000,000÷7 + 10,800×32) ÷ 1,800h = 2,176.126984...（月額賃借料は除外）
    expect(Number(defaultParameters.machineChargePerHour)).toBeCloseTo(2176.126984126984, 10);
  });

  it("uses sellable pouch quantity, chamber multiplication, test fill, and hopper initial charge", () => {
    const result = calculatePouchCost({ spec: baseSpec, quantity: "10000", printingMethod: "digital", parameters: { sellerProfitRate: "0" } });
    expect(result.chamberCount).toBe("20000");
    expect(result.testFillMl).toBe("60000");
    expect(result.bulkUsageMl).toBe("722000");
    expect(result.bulkCost).toBe("267140");
  });

  it("treats 500 test runs as bulk-only filling attempts and excludes them from film cost", () => {
    const result = calculatePouchCost({ spec: baseSpec, quantity: "10000", printingMethod: "digital" });
    expect(result.testFillMl).toBe("60000");
    expect(result.bulkUsageMl).toBe("722000");
    expect(result.costComponents.bulk).toBe("267140");
    // 2連 pouch: each longitudinal pitch yields lanes/connected = 2 sellable
    // pouches, so connected production doubles the single-pouch film demand.
    expect(result.film.filmTotal).toBe("337800");
    expect(result.film.shippingTrips).toBe("2");
  });

  it("changes only initial charge for pressure filling", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, fillingMethod: "pressure" },
      quantity: "10000",
      printingMethod: "digital",
    });
    expect(result.initialChargeMl).toBe("8000");
    expect(result.bulkUsageMl).toBe("728000");
  });

  it("calculates bulk per liquid with per-liquid initial charge and test fill", () => {
    const result = calculatePouchCost({
      spec: {
        ...baseSpec,
        connectedChambers: 2,
        chambers: [
          { liquidName: "エッセンスA", fillMl: "10", bulkUnitPrice: "0.37" },
          { liquidName: "ミストB", fillMl: "5", bulkUnitPrice: "0.8" },
        ],
      },
      quantity: "10000",
      printingMethod: "digital",
    });
    // A: 10,000×10×1.1 ＋ 初期2,000 ＋ テスト500×4×10 ＝ 132,000ml × 0.37 ＝ 48,840円
    // B: 10,000×5×1.1 ＋ 初期2,000 ＋ テスト500×4×5 ＝ 67,000ml × 0.80 ＝ 53,600円
    expect(result.liquidCount).toBe(2);
    expect(result.liquids[0].liquidName).toBe("エッセンスA");
    expect(result.liquids[0].usageMl).toBe("132000");
    expect(result.liquids[0].costYen).toBe("48840");
    expect(result.liquids[1].liquidName).toBe("ミストB");
    expect(result.liquids[1].usageMl).toBe("67000");
    expect(result.liquids[1].costYen).toBe("53600");
    expect(result.bulkUsageMl).toBe("199000");
    expect(result.bulkCost).toBe("102440");
    expect(result.totalFillMlPerPouch).toBe("15");
    expect(result.chambers).toHaveLength(2);
    // 생산속도는 최대 실 충전량(병목 10ml) 기준: 80枚/分 → 2연 2,400枚/h
    expect(result.baseProductionSpeedPerMinute).toBe("80");
    expect(result.effectiveProductionSpeed).toBe("2400");
  });

  it("charges one initial charge per liquid when a liquid spans multiple chambers", () => {
    const result = calculatePouchCost({
      spec: {
        ...baseSpec,
        connectedChambers: 4,
        chambers: [
          { liquidName: "A液", fillMl: "10", bulkUnitPrice: "0.37" },
          { liquidName: "A液", fillMl: "8", bulkUnitPrice: "0.37" },
          { liquidName: "B液", fillMl: "5", bulkUnitPrice: "0.8" },
          { liquidName: "B液", fillMl: "5", bulkUnitPrice: "0.8" },
        ],
      },
      quantity: "10000",
      printingMethod: "digital",
    });
    expect(result.liquidCount).toBe(2);
    // A液: 10,000×(10+8)×1.1 ＋ 2,000 ＋ 500×4×10 ＝ 220,000ml
    // B液: 10,000×(5+5)×1.1 ＋ 2,000 ＋ 500×4×5 ＝ 122,000ml
    expect(result.liquids[0].usageMl).toBe("220000");
    expect(result.liquids[1].usageMl).toBe("122000");
    expect(result.totalFillMlPerPouch).toBe("28");
  });

  it("rejects a chamber composition whose length differs from the connected chambers", () => {
    expect(() => calculatePouchCost({
      spec: { ...baseSpec, connectedChambers: 2, chambers: [{ liquidName: "A", fillMl: "3" }] },
      quantity: "10000",
      printingMethod: "digital",
    })).toThrow();
  });
});

describe("digital film", () => {
  it("uses the fill-volume based default production speed", () => {
    expect(defaultProductionSpeedForFillMl(1)).toBe(140);
    expect(defaultProductionSpeedForFillMl(1.99)).toBe(140);
    expect(defaultProductionSpeedForFillMl(2)).toBe(120);
    expect(defaultProductionSpeedForFillMl(2.5)).toBe(120);
    expect(defaultProductionSpeedForFillMl(3)).toBe(100);
    expect(defaultProductionSpeedForFillMl(7)).toBe(100);
    expect(defaultProductionSpeedForFillMl(7.99)).toBe(100);
    expect(defaultProductionSpeedForFillMl(8)).toBe(80);
  });

  it("scales effective production speed by connected chambers regardless of filling lanes", () => {
    const single = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 1 }, quantity: "10000", printingMethod: "digital" });
    const twin = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 2 }, quantity: "10000", printingMethod: "digital" });
    const tripleThreeLanes = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 3, fillingLanes: 3 }, quantity: "10000", printingMethod: "digital" });
    const tripleFourLanes = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 3, fillingLanes: 4 }, quantity: "10000", printingMethod: "digital" });
    const quad = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 4 }, quantity: "10000", printingMethod: "digital" });
    expect(single.baseProductionSpeedPerMinute).toBe("80");
    expect(single.effectiveProductionSpeed).toBe("4800");
    expect(twin.effectiveProductionSpeed).toBe("2400");
    // 機械は3列でも4列でも1回に1個の製品しか作れないため、3連と4連の速度は同じ。
    expect(tripleThreeLanes.effectiveProductionSpeed).toBe("1200");
    expect(tripleFourLanes.effectiveProductionSpeed).toBe("1200");
    expect(tripleThreeLanes.effectiveProductionSpeed).toBe(tripleFourLanes.effectiveProductionSpeed);
    expect(quad.effectiveProductionSpeed).toBe("1200");
    expect(tripleFourLanes.effectiveProductionSpeed).toBe(quad.effectiveProductionSpeed);
    expect(Number(twin.variableProcessingPerPiece)).toBeGreaterThan(Number(single.variableProcessingPerPiece));
    expect(Number(quad.variableProcessingPerPiece)).toBeGreaterThan(Number(twin.variableProcessingPerPiece));
  });

  it("runs the machine for the loss-inclusive quantity when computing production time", () => {
    const result = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 1 }, quantity: "10000", printingMethod: "digital" });
    expect(Number(result.productionRunQuantity)).toBeCloseTo(10000 / 0.9, 6);
    expect(Number(result.productionHours)).toBeCloseTo(10000 / 0.9 / 4800, 6);
    expect(Number(result.inspectionHours)).toBeCloseTo(10000 / 0.9 / 1500, 6);
  });

  it("inspects every chamber so inspection time scales with connected chambers", () => {
    const single = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 1 }, quantity: "10000", printingMethod: "digital" });
    const twin = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 2 }, quantity: "10000", printingMethod: "digital" });
    const triple = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 3, fillingLanes: 3 }, quantity: "10000", printingMethod: "digital" });
    expect(Number(single.inspectionHours)).toBeCloseTo(10000 / 0.9 / 1500, 6);
    expect(Number(twin.inspectionHours)).toBeCloseTo((10000 / 0.9) * 2 / 1500, 6);
    expect(Number(triple.inspectionHours)).toBeCloseTo((10000 / 0.9) * 3 / 1500, 6);
  });

  it("exposes a 1連 filling-cost basis and connected surcharge rates for quotation pricing", () => {
    const single = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 1 }, quantity: "10000", printingMethod: "digital" });
    const twin = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 2 }, quantity: "10000", printingMethod: "digital" });
    const triple = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 3, fillingLanes: 3 }, quantity: "10000", printingMethod: "digital" });
    const quad = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 4 }, quantity: "10000", printingMethod: "digital" });
    const organicSingleFillingPerPiece = (
      Number(single.costPerPieceComponents.bulk)
      + Number(single.costPerPieceComponents.variableProcessing)
      + Number(single.costPerPieceComponents.fixedLot)
    );
    // 구성 요소별 1자리 올림과 1연 기준 원가의 1자리 올림은 최대 0.2엔까지 차이날 수 있다.
    expect(Math.abs(Number(single.singleConnectedFillingCostPerPiece) - organicSingleFillingPerPiece)).toBeLessThanOrEqual(0.3);
    expect(single.connectedFillingSurchargeRate).toBe("0");
    expect(twin.connectedFillingSurchargeRate).toBe("0.2");
    expect(triple.connectedFillingSurchargeRate).toBe("0.8");
    expect(quad.connectedFillingSurchargeRate).toBe("0.8");
  });

  it("requires parallel SKU count so film length is multiplied by the count", () => {
    const result = calculatePouchCost({ spec: { ...baseSpec, skuCount: 2 }, quantity: "10000", printingMethod: "digital" });
    expect(Number(result.film.requiredLengthM)).toBeCloseTo(1677.7777777777778, 10);
    expect(result.film.skuCosts).toHaveLength(2);
    expect(result.film.orderLengthM).toBe("1800");
    expect(result.film.orderAdjustment).toBe("none");
    expect(result.film.shippingTrips).toBe("4");
  });

  it("divides film capacity by connected chambers for sellable pouches", () => {
    const result = calculatePouchCost({
      spec: {
        ...baseSpec,
        sizeKey: "round-60x120",
        connectedChambers: 2,
        skuCount: 1,
      },
      quantity: "50000",
      printingMethod: "digital",
      parameters: { sellerProfitRate: "0" },
    });

    expect(Number(result.film.requiredLengthM)).toBeCloseTo(3500, 8);
    expect(result.film.orderLengthM).toBe("3500");
    expect(result.film.actualQuantity).toBe("50000");
    expect(result.film.pricingQuantity).toBe("50000");
  });
});

describe("commercial calculation", () => {
  it("does not add seller profit again to digital film prices", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, isCustom: true, customWidthMm: "45", customLengthMm: "145" },
      quantity: "7",
      printingMethod: "digital",
    });

    expect(result.sellerProfitRate).toBe("0");
    expect(Number(result.sellerProfitBaseCost)).toBe(0);
    expect(Number(result.sellerProfitCost)).toBe(0);
    expect(Number(result.costComponents.film)).toBeCloseTo(Number(result.film.filmTotal), 8);
    const displayedComponentTotal = Object.values(result.costComponents)
      .reduce((total, value) => total + Number(value), 0);
    expect(displayedComponentTotal).toBeCloseTo(Number(result.costTotal), 8);
    expect(result.audit.componentReconciliationDifference).toBe("0");
  });

  it("adds custom charge once and reconciles components exactly", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, isCustom: true, customWidthMm: "45", customLengthMm: "145" },
      quantity: "7",
      printingMethod: "digital",
    });
    expect(result.customCharge).toBe("220000");
    expect(result.audit.componentReconciliationDifference).toBe("0");
    expect(result.film.orderLengthM).toBe("500");
    expect(result.film.orderAdjustment).toBe("minimum_total_allocation");
  });

  it("calculates approved-only commission from tax-exclusive sales", () => {
    expect(approvedCommission("1000000", "approved").commissionAmount).toBe("200000");
    expect(approvedCommission("1000000", "sent").commissionAmount).toBeNull();
  });
});

describe("multi-SKU film aggregation", () => {
  it("uses size-specific pitch additions", () => {
    expect(sizeMaster["round-50x60"].pitchAddMm).toBe("6");
    expect(sizeMaster["mouthwash-45x145"].pitchAddMm).toBe("6");
  });

  it("keeps identical SKU identifiers independently priced while auto-raising production minimums", () => {
    const normalized = normalizeDigitalFilmOrder(
      [
        { skuCode: "DUP", requiredLengthM: "183.3333333333333333333333333" },
        { skuCode: "DUP", requiredLengthM: "183.3333333333333333333333333" },
      ],
      defaultParameters,
    );
    expect(normalized.adjustment).toBe("minimum_sku_allocation");
    expect(normalized.orders.map((sku) => sku.orderLengthM)).toEqual(["300", "300"]);
  });

  it("bases shipping trips on production-equivalent film length and applies customs per trip", () => {
      const result = calculatePouchCost({
        spec: {
          ...baseSpec,
          sizeKey: "round-50x60",
          connectedChambers: 1,
          skuCount: 2,
      },
      quantity: "10000",
      printingMethod: "digital",
      parameters: { sellerProfitRate: "0" },
    });

    expect(Number(result.film.requiredLengthM)).toBeCloseTo(366.6666666666667, 10);
    expect(Number(result.film.skuCosts[0].requiredLengthM)).toBeCloseTo(183.3333333333333, 10);
    expect(Number(result.film.skuCosts[1].requiredLengthM)).toBeCloseTo(183.3333333333333, 10);
    expect(Number(result.film.requiredLengthM)).toBeCloseTo(366.6666666666667, 10);
    expect(result.film.orderLengthM).toBe("600");
    expect(result.film.orderAdjustment).toBe("minimum_sku_allocation");
    expect(result.film.domesticShipping).toBe("4000");
    expect(result.film.overseasShipping).toBe("32000");
    expect(result.film.customs).toBe("400");
    expect(result.film.filmTotal).toBe("233200");
  });

  it("switches 35mm sizes to 736mm 2x production with 571-740mm pricing above 900m", () => {
    // 必要長 1100m > 900m → 2倍生産: 実発注 = max(500, ceil100(1100/2)) = 600m, 検討 1200m
    // ロス 120m, 有効 1080m, 数量 floor(1080000/66)×4 = 65,454 → 65,000
    // 単価 = 571〜740mm・500m帯 365円/m × 600m = 219,000円（Excel検討1200行と一致）
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "tube-35x60", connectedChambers: 1, skuCount: 1 },
      quantity: "60000",
      printingMethod: "digital",
      parameters: { sellerProfitRate: "0" },
    });
    expect(result.film.orderLengthM).toBe("600");
    expect(result.film.skuCosts[0].multiplier).toBe(2);
    expect(result.film.skuCosts[0].consideredLengthM).toBe("1200");
    expect(result.film.skuCosts[0].appliedBand).toBe("571to740");
    expect(Number(result.film.lossM)).toBeCloseTo(120, 6);
    expect(result.film.pricingQuantity).toBe("65000");
    expect(result.film.unitPrice).toBe("365");
    expect(result.film.filmBaseCost).toBe("219000");
  });

  it("serializes priced film costs for every digital SKU", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "round-50x60", connectedChambers: 1, skuCount: 2 },
      quantity: "10000",
      printingMethod: "digital",
      parameters: { sellerProfitRate: "0" },
    });
    expect(result.film.skuCosts.map((sku) => sku.filmCost)).toEqual(["98400", "98400"]);
    expect(result.film.skuCosts.reduce((total, sku) => total + Number(sku.filmCost), 0)).toBe(Number(result.film.filmBaseCost));
  });

  it("grows a normalized digital order when loss rounding would leave it one piece short", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "tube-35x60", connectedChambers: 1, skuCount: 1 },
      quantity: "25455",
      printingMethod: "digital",
      parameters: { sellerProfitRate: "0" },
    });
    expect(Number(result.film.actualQuantity)).toBeGreaterThanOrEqual(25455);
    expect(result.film.orderLengthM).toBe("600");
  });

  it("keeps 35mm sizes on 356mm single production at or below 900m", () => {
    // 必要長 ≈ 366.7m ≤ 900m → 1倍生産: 最小発注500m（合計最低適用）, 単価 570mm以下 328円/m
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "tube-35x60", connectedChambers: 1, skuCount: 1 },
      quantity: "20000",
      printingMethod: "digital",
      parameters: { sellerProfitRate: "0" },
    });
    expect(result.film.orderLengthM).toBe("500");
    expect(result.film.skuCosts[0].multiplier).toBe(1);
    expect(result.film.skuCosts[0].appliedBand).toBe("lte570");
    expect(result.film.unitPrice).toBe("328");
  });

  it("aggregates rounded SKU order lengths, losses, and priceable quantities", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, skuCount: 2 },
      quantity: "1000",
      printingMethod: "digital",
    });
    expect(result.film.orderLengthM).toBe("600");
    expect(result.film.orderAdjustment).toBe("minimum_sku_allocation");
    expect(result.film.pricingQuantity).toBe("5000");
    expect(result.audit.componentReconciliationDifference).toBe("0");
  });

  it("keeps print color count as reference metadata that does not change film pricing", () => {
    const spec = { ...baseSpec, skuCount: 1 };
    const fourColors = calculatePouchCost({ spec: { ...spec, colorCount: 4 }, quantity: "10000", printingMethod: "digital", parameters: { sellerProfitRate: "0" } });
    const eightColors = calculatePouchCost({ spec: { ...spec, colorCount: 8 }, quantity: "10000", printingMethod: "digital", parameters: { sellerProfitRate: "0" } });
    expect(fourColors.film.filmBaseCost).toBe("295200");
    expect(eightColors.film.filmBaseCost).toBe("295200");
    expect(fourColors.audit.inputJsonSha256).not.toBe(eightColors.audit.inputJsonSha256);
  });

  it("applies the common film unit price and reports fallback mode", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, skuCount: 1 },
      quantity: "10000",
      printingMethod: "digital",
      parameters: { sellerProfitRate: "0" },
    });
    expect(result.audit.digitalFilmPriceMode).toBe("common_fallback");
    expect(result.film.unitPrice).toBe("328");
    expect(result.film.filmBaseCost).toBe("295200");
  });
});

describe("gravure roll integration", () => {
  it("selects the cheapest valid Sasche supplier candidate within the width tolerance", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "round-60x80", connectedChambers: 1, colorCount: 2 },
      quantity: "10000",
      printingMethod: "gravure",
    });

    expect(result.gravurePricingMode).toBe("sasche");
    expect(result.gravure?.pricingMode).toBe("sasche");
    expect(result.sasche?.webWidthMm).toBe(556);
    expect(result.sasche?.laneCount).toBe(1);
    expect(result.sasche?.printTierM).toBe(2000);
    expect(result.film.orderLengthM).toBe("1700");
    expect(result.costComponents.film).toBe(
      (1700 * 160.8 * 1.12).toFixed(0),
    );
    expect(Number(result.copperPlateCost)).toBeGreaterThan(0);
  });

  it("supports Sasche film without printing colors and omits copper plates", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "round-50x80", connectedChambers: 1, colorCount: 0 },
      quantity: "10000",
      printingMethod: "gravure",
    });

    expect(result.gravurePricingMode).toBe("sasche");
    expect(result.gravure?.copperPlateCount).toBe(0);
    expect(result.gravure?.copperPlateUnitPriceYen).toBe("0");
    expect(result.gravure?.copperPlateCostYen).toBe("0");
    expect(result.copperPlateCost).toBe("0");
    expect(Number(result.film.filmTotal)).toBeGreaterThan(0);
  });

  it("does not automatically select a physically short domestic gravure roll", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "tube-35x80", connectedChambers: 1, colorCount: 4 },
      quantity: "80000",
      printingMethod: "gravure",
    });

    expect(result.sasche?.outputLengthM).toBe("3400");
    expect(Number(result.film.requiredLengthM)).toBeLessThanOrEqual(Number(result.film.effectiveLengthM));
  });

  it("replaces only film cost, keeps processing unchanged, and separates copper plates", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "mouthwash-45x145", connectedChambers: 1 },
      quantity: "10000",
      printingMethod: "gravure",
    });

    expect(result.gravurePricingMode).toBe("sasche");
    expect(result.sasche?.webWidthMm).toBe(356);
    expect(result.sasche?.laneCount).toBe(1);
    expect(result.sasche?.printTierM).toBe(2000);
    expect(result.film.orderLengthM).toBe("1700");
    expect(result.film.lossM).toBe("1280.555555555555555555555555555555555556");
    expect(result.film.shippingTrips).toBe("0");
    expect(result.film.overseasShipping).toBe("0");
    expect(result.film.customs).toBe("0");
    const yenRoundedFilmTotal = 268464;
    expect(Number(result.film.filmTotal)).toBe(yenRoundedFilmTotal);
    expect(Number(result.film.filmTotal) % 1).toBe(0);
    expect(Number(result.gravure?.manufacturerMarginCostYen)).toBe(0);
    expect(Number(result.film.overseasShipping)).toBe(0);
    expect(Number(result.copperPlateCost)).toBeGreaterThan(0);
    expect(result.costComponents.copperPlate).toBe(result.copperPlateCost);
    expect(result.sellerProfitRate).toBe("0");
    expect(result.sellerProfitCost).toBe("0");
    expect(result.costComponents.film).toBe(yenRoundedFilmTotal.toString());
    expect(result.costPerPieceComponents.copperPlate).toBe(result.copperPlateCostPerPiece);
    expect(result.audit.componentReconciliationDifference).toBe("0");

    const componentTotal = Object.values(result.costComponents).reduce((total, value) => total + Number(value), 0);
    expect(componentTotal).toBeCloseTo(Number(result.costTotal), 8);
  });

  it("uses SKU-specific color counts when calculating gravure printing cost", () => {
    const sameColors = calculatePouchCost({
      spec: {
        ...baseSpec,
        skuCount: 2,
        skuQuantities: ["5000", "5000"],
        skuFillMlPerChamber: ["30", "30"],
        skuColorCounts: ["4", "4"],
      },
      quantity: "10000",
      printingMethod: "gravure",
    });
    const skuColors = calculatePouchCost({
      spec: {
        ...sameSpec(),
        skuCount: 2,
        skuQuantities: ["5000", "5000"],
        skuFillMlPerChamber: ["30", "30"],
        skuColorCounts: ["2", "6"],
      },
      quantity: "10000",
      printingMethod: "gravure",
    });

    expect(Number(skuColors.gravure?.printingCostYen)).toBeCloseTo(Number(sameColors.gravure?.printingCostYen), 8);
  });

  it("counts copper plates for every SKU color when SKU color counts differ", () => {
    const result = calculatePouchCost({
      spec: {
        ...baseSpec,
        skuCount: 2,
        skuQuantities: ["5000", "5000"],
        skuColorCounts: ["2", "3"],
      },
      quantity: "10000",
      printingMethod: "gravure",
    });

    expect(result.gravure?.copperPlateCount).toBe(5);
    expect(Number(result.copperPlateCost)).toBe(145600);
  });

  it("reports one-pattern delivery length separately from the multi-pattern total", () => {
    const requestSpec: PouchSpec = {
      ...baseSpec,
      sizeKey: "tube-35x80",
      connectedChambers: 1,
      colorCount: 4,
      skuCount: 1,
      skuQuantities: ["500000"],
      skuColorCounts: ["4"],
    };
    const request = {
      spec: requestSpec,
      quantity: "500000",
      printingMethod: "digital" as const,
      parameters: defaultParameters,
      recommendationMode: true,
      targetMargins: ["0.3", "0.25", "0.2"],
    };
    const candidate = calculatePouchCost(request).recommendationCandidates
      ?.find((item) => item.route === "K" && item.gravureRoll?.smallWidthTier);
    expect(candidate).toBeDefined();
    expect(candidate!.gravureRoll?.orderPatternCount).toBe(2);

    const selected = calculatePouchCost({
      ...request,
      selectedCandidateId: candidate!.id,
      selectedCandidateTargetMargins: request.targetMargins,
    });
    expect(selected.orderPatternCount).toBe(2);
    expect(selected.deliverablePatternLengthM).toBe("11000");
    expect(Number(selected.film.effectiveLengthM)).toBe(22000);
    expect(Number(selected.film.orderLengthM)).toBe(24000);
  });
});

function sameSpec() {
  return {
    ...baseSpec,
    skuCount: 2,
    skuQuantities: ["5000", "5000"],
    skuFillMlPerChamber: ["30", "30"],
    skuColorCounts: ["4", "4"],
  };
}
