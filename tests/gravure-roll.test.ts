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
});
