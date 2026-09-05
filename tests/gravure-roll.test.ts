import { describe, expect, it } from "vitest";
import { calculateGravureRollCostKRW, defaultGravureRollParameters, calculateGravureRollCost } from "@/lib/gravure-roll";

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
    expect(Number(jpy.copperPlateCostYen)).toBeCloseTo(Number(krw.copperPlateCostKRW) * 100 / 850, 4);
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
    expect(result.customsCostYen).toBe("6600");
    expect(Number(result.filmCostPerPieceYen)).toBeCloseTo(
      (Number(result.filmCostYen) * 1.2 + 6600 + 121000) / 10000,
      8,
    );
    expect(Number(result.totalGravureCostYen)).toBeCloseTo(
      Number(result.filmCostYen) * 1.2 + 6600 + 121000 + Number(result.copperPlateCostYen),
      8,
    );
  });
});
