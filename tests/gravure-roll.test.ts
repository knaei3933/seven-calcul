import { describe, expect, it } from "vitest";
import { calculateGravureRollCostKRW, defaultGravureRollParameters, calculateGravureRollCost } from "@/lib/gravure-roll";
import { Decimal } from "@/lib/decimal";

const baseInput = {
  requiredLengthM: "5500",
  materialWidthMm: "740",
  colors: 3,
};

describe("gravure roll calculation", () => {
  it("uses one 6000m production lot for a 5500m order", () => {
    const result = calculateGravureRollCostKRW(baseInput);
    expect(result.orderPatternCount).toBe(1);
    expect(result.deliverableLengthM).toBe("5500");
    expect(result.productionLengthM).toBe("6000");
    expect(result.lossLengthM).toBe("500");
    expect(result.finalHeatSealWidthMm).toBe("750");
  });

  it("rounds required length up to 5500m order patterns", () => {
    const result = calculateGravureRollCostKRW({ ...baseInput, requiredLengthM: "5600" });
    expect(result.orderPatternCount).toBe(2);
    expect(result.deliverableLengthM).toBe("11000");
    expect(result.productionLengthM).toBe("12000");
  });

  it("separates film and new copper plate costs", () => {
    const result = calculateGravureRollCostKRW(baseInput);
    expect(Number(result.filmCostKRW)).toBeGreaterThan(0);
    expect(Number(result.copperPlateCostKRW)).toBeGreaterThan(0);
    expect(result.totalGravureCostKRW).toBe(
      (Number(result.filmCostKRW) + Number(result.copperPlateCostKRW)).toString(),
    );
  });

  it("converts external KRW formula to JPY at 100 yen = 850 KRW", () => {
    const krw = calculateGravureRollCostKRW(baseInput);
    const jpy = calculateGravureRollCost({
      ...baseInput,
      quantity: "10000",
      parameters: defaultGravureRollParameters(),
    });
    expect(Number(jpy.filmCostYen)).toBeCloseTo(Number(krw.filmCostKRW) * 100 / 850, 4);
    expect(Number(jpy.copperPlateCostYen)).toBe(
      Number(Decimal.max("32000", Math.ceil(Number(krw.copperPlateCostKRW) * 100 / 850))),
    );
  });

  it("applies a ¥32,000 copper plate minimum and rounds up fractions", () => {
    const belowMinimum = calculateGravureRollCost({
      ...baseInput,
      colors: 1,
      quantity: "10000",
      parameters: defaultGravureRollParameters(),
    });
    const aboveMinimum = calculateGravureRollCost({
      ...baseInput,
      quantity: "10000",
      parameters: defaultGravureRollParameters(),
    });

    expect(belowMinimum.copperPlateCostYen).toBe("32000");
    expect(aboveMinimum.copperPlateCostYen).toBe("62259");
    expect(Number(aboveMinimum.copperPlateCostYen) % 1).toBe(0);
  });

  it("includes overseas shipping at 500m units and ¥11,000 per trip", () => {
    const result = calculateGravureRollCost({
      ...baseInput,
      quantity: "10000",
      parameters: defaultGravureRollParameters(),
    });

    expect(result.shippingTrips).toBe(11);
    expect(result.overseasShippingCostYen).toBe("121000");
    expect(Number(result.manufacturerMarginCostYen)).toBeCloseTo(Number(result.filmCostYen) * 0.2, 8);
    expect(Number(result.customsCostYen)).toBeCloseTo(Number(result.customsBaseCostYen) * 0.05, 8);
    expect(Number(result.filmCostPerPieceYen)).toBeCloseTo(
      (Number(result.filmCostYen) * 1.2 * 1.05 + 121000) / 10000,
      8,
    );
    expect(Number(result.totalGravureCostYen)).toBeCloseTo(
      Number(result.filmCostYen) * 1.2 * 1.05 + 121000 + Number(result.copperPlateCostYen),
      8,
    );
  });

  it("uses a 12,000m lot and fixed KRW 410/m for pouch widths up to 50mm", () => {
    const result = calculateGravureRollCost({
      requiredLengthM: "11000",
      materialWidthMm: "500",
      pouchWidthMm: "50",
      colors: 4,
      quantity: "10000",
      parameters: defaultGravureRollParameters(),
    });

    expect(result.smallWidthTier).toBe(true);
    expect(result.orderPatternCount).toBe(1);
    expect(result.deliverableLengthM).toBe("11000");
    expect(result.productionLengthM).toBe("12000");
    expect(result.lossLengthM).toBe("1000");
    expect(result.materialCostYen).toBe("0");
    expect(result.printingCostYen).toBe("0");
    expect(result.laminationCostYen).toBe("0");
    expect(result.manufacturerMarginCostYen).toBe("0");
    expect(Number(result.filmCostYen)).toBeCloseTo(410 * 12000 * 100 / 850, 8);
    expect(result.shippingTrips).toBe(22);
  });
});
