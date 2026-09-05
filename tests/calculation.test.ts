import { describe, expect, it } from "vitest";
import { approvedCommission, calculatePouchCost } from "@/lib/calculation";
import { defaultParameters, sizeMaster } from "@/lib/constants";
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
    const result = calculatePouchCost({ spec: baseSpec, quantity: "10000", printingMethod: "digital" });
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
    expect(result.film.filmTotal).toBe("182200");
    expect(result.film.shippingTrips).toBe("1");
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
});

describe("digital film", () => {
  it("scales effective production speed by connected chambers (lanes÷連結)", () => {
    const single = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 1 }, quantity: "10000", printingMethod: "digital" });
    const twin = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 2 }, quantity: "10000", printingMethod: "digital" });
    const quad = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 4 }, quantity: "10000", printingMethod: "digital" });
    expect(single.effectiveProductionSpeed).toBe("6000");
    expect(twin.effectiveProductionSpeed).toBe("3000");
    expect(quad.effectiveProductionSpeed).toBe("1500");
    expect(Number(twin.variableProcessingPerPiece)).toBeGreaterThan(Number(single.variableProcessingPerPiece));
    expect(Number(quad.variableProcessingPerPiece)).toBeGreaterThan(Number(twin.variableProcessingPerPiece));
  });

  it("runs the machine for the loss-inclusive quantity when computing production time", () => {
    const result = calculatePouchCost({ spec: { ...baseSpec, connectedChambers: 1 }, quantity: "10000", printingMethod: "digital" });
    expect(Number(result.productionRunQuantity)).toBeCloseTo(10000 / 0.9, 6);
    expect(Number(result.productionHours)).toBeCloseTo(10000 / 0.9 / 6000, 6);
    expect(Number(result.inspectionHours)).toBeCloseTo(10000 / 0.9 / 1500, 6);
  });

  it("requires parallel SKU count so film length is multiplied by the count", () => {
    const result = calculatePouchCost({ spec: { ...baseSpec, skuCount: 2 }, quantity: "10000", printingMethod: "digital" });
    expect(Number(result.film.requiredLengthM)).toBeCloseTo(838.8888888888889, 10);
    expect(result.film.skuCosts).toHaveLength(2);
    expect(result.film.orderLengthM).toBe("1000");
    expect(result.film.orderAdjustment).toBe("none");
    expect(result.film.shippingTrips).toBe("2");
  });
});

describe("commercial calculation", () => {
  it("adds custom charge once and reconciles components exactly", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, isCustom: true, customWidthMm: "45", customLengthMm: "145" },
      quantity: "7",
      printingMethod: "digital",
    });
    expect(result.customCharge).toBe("400000");
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

  it("keeps 35mm sizes on 356mm single production at or below 900m", () => {
    // 必要長 ≈ 366.7m ≤ 900m → 1倍生産: 最小発注500m（合計最低適用）, 単価 570mm以下 328円/m
    const result = calculatePouchCost({
      spec: { ...baseSpec, sizeKey: "tube-35x60", connectedChambers: 1, skuCount: 1 },
      quantity: "20000",
      printingMethod: "digital",
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
    expect(result.film.pricingQuantity).toBe("11000");
    expect(result.audit.componentReconciliationDifference).toBe("0");
  });

  it("keeps print color count as reference metadata that does not change film pricing", () => {
    const spec = { ...baseSpec, skuCount: 1 };
    const fourColors = calculatePouchCost({ spec: { ...spec, colorCount: 4 }, quantity: "10000", printingMethod: "digital" });
    const eightColors = calculatePouchCost({ spec: { ...spec, colorCount: 8 }, quantity: "10000", printingMethod: "digital" });
    expect(fourColors.film.filmBaseCost).toBe("164000");
    expect(eightColors.film.filmBaseCost).toBe("164000");
    expect(fourColors.audit.inputJsonSha256).not.toBe(eightColors.audit.inputJsonSha256);
  });

  it("applies the common film unit price and reports fallback mode", () => {
    const result = calculatePouchCost({
      spec: { ...baseSpec, skuCount: 1 },
      quantity: "10000",
      printingMethod: "digital",
    });
    expect(result.audit.digitalFilmPriceMode).toBe("common_fallback");
    expect(result.film.unitPrice).toBe("328");
    expect(result.film.filmBaseCost).toBe("164000");
  });
});

describe("gravure roll integration", () => {
  it("replaces only film cost, keeps processing unchanged, and separates copper plates", () => {
    const result = calculatePouchCost({
      spec: baseSpec,
      quantity: "10000",
      printingMethod: "gravure",
    });

    expect(result.orderPatternCount).toBe(1);
    expect(result.deliverablePatternLengthM).toBe("5500");
    expect(result.film.orderLengthM).toBe("6000");
    expect(result.film.lossM).toBe("500");
    expect(result.film.filmTotal).toBe(result.gravure?.filmCostYen);
    expect(Number(result.copperPlateCost)).toBeGreaterThan(0);
    expect(result.costComponents.copperPlate).toBe(result.copperPlateCost);
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
