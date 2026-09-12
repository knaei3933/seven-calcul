import { describe, expect, it } from "vitest";
import { D, Decimal } from "@/lib/decimal";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { buildPrintCandidates, createPrintCandidateContext } from "@/lib/print-recommendation";
import { calculatePouchCost } from "@/lib/calculation";
import { buildSascheCandidates } from "@/lib/sasche-gravure";
import type { PouchSpec } from "@/lib/types";

const baseSpec: PouchSpec = {
  sizeKey: "tube-35x80",
  fillMlPerChamber: "3",
  connectedChambers: 1,
  fillingMethod: "hopper",
  fillingLanes: 4,
  isCustom: false,
  colorCount: 2,
  bulkUnitPrice: "0",
  skuCount: 1,
};

function context(spec: PouchSpec = baseSpec, quantity = "133000") {
  return createPrintCandidateContext({
    spec,
    quantity,
    parameters: defaultParameters,
    gravureParameters: defaultGravureRollParameters(),
  });
}

describe("print recommendation engine", () => {
  it("returns a deterministic route-balanced candidate list capped at four", () => {
    const first = buildPrintCandidates(context());
    const second = buildPrintCandidates(context());
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(4);
    expect(first.map((candidate) => candidate.id)).toEqual(second.map((candidate) => candidate.id));
    expect(first.some((candidate) => candidate.route === "D")).toBe(true);
    expect(first.some((candidate) => candidate.route === "K")).toBe(true);
    expect(first.some((candidate) => candidate.route === "Y")).toBe(true);
    expect(first.filter((candidate) => candidate.recommended)).toHaveLength(1);
    expect(first[0].recommended).toBe(true);
  });

  it("keeps fulfilling candidates and omits under-quantity digital fallbacks", () => {
    const candidates = buildPrintCandidates(context(baseSpec, "20000"));
    const fulfilling = candidates.filter((candidate) => (
      Number(candidate.adjustedQuantity) >= 20000
    ));
    expect(fulfilling.length).toBeGreaterThan(0);
    expect(fulfilling.some((candidate) => candidate.orderLengthM === "1000")).toBe(true);
    expect(candidates.some((candidate) => candidate.orderLengthM === "500")).toBe(false);
  });

  it("recommends the smallest practical candidate that satisfies the original quantity", () => {
    const candidates = buildPrintCandidates(context());
    const recommended = candidates.find((candidate) => candidate.recommended)!;
    expect(recommended.route).toBe("Y");
    expect(recommended.orderLengthM).toBe("3400");
    expect(recommended.adjustedQuantity).toBe("142325");
    expect(D(recommended.filmTotalYen).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString()).toBe("385370");
    expect(D(recommended.surplusRatio).lte(D("15"))).toBe(true);

    const smallerOrder = buildPrintCandidates(context(baseSpec, "20000"));
    const smallestFulfilling = smallerOrder
      .filter((candidate) => Number(candidate.adjustedQuantity) >= 20000)
      .sort((left, right) => Number(left.adjustedQuantity) - Number(right.adjustedQuantity))[0];
    expect(smallestFulfilling.route).toBe("D");
    expect(smallestFulfilling.orderLengthM).toBe("1000");
    expect(smallestFulfilling.recommended).toBe(true);
  });

  it("preserves a selected digital candidate order length", () => {
    const candidates = buildPrintCandidates(context());
    const candidate = candidates.find((item) => item.route === "D");
    expect(candidate).toBeDefined();
    const result = calculatePouchCost({
      spec: baseSpec,
      quantity: "133000",
      printingMethod: "gravure",
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      recommendationMode: true,
      selectedCandidateId: candidate!.id,
    });
    expect(D(result.film.orderLengthM).eq(candidate!.orderLengthM)).toBe(true);
    expect(D(result.costComponents.film).eq(candidate!.filmTotalYen)).toBe(true);
  });

  it("prices Y copper plates from each candidate row, not only the matched-width base row", () => {
    const candidates = buildSascheCandidates({
      webWidthMm: 356,
      requiredLengthM: D("3174.9999999999995"),
      quantity: D("133000"),
      colorCount: D(2),
    });
    const lane1 = candidates.find((item) => item.laneCount === 1);
    const lane2 = candidates.find((item) => item.laneCount === 2);
    expect(lane1).toBeDefined();
    expect(lane2).toBeDefined();
    expect(Number(lane1!.plateUnitPriceYen)).toBeCloseTo(26000 * 1.12, 8);
    expect(Number(lane2!.plateUnitPriceYen)).toBeCloseTo(32000 * 1.12, 8);
  });

  it("keeps K pattern quantities aligned to the film pattern without 1,000-piece rounding", () => {
    const candidates = buildPrintCandidates(context());
    const korean = candidates.filter((candidate) => candidate.route === "K");
    expect(korean.length).toBeGreaterThan(0);
    expect(korean.every((candidate) => D(candidate.adjustedQuantity).mod(1000).eq(0) === false
      || D(candidate.requiredLengthM).div(5500).isInteger())).toBe(true);
  });

  it("computes a selected candidate result without changing the caller input quantity", () => {
    const input = {
      spec: baseSpec,
      quantity: "133000",
      printingMethod: "gravure" as const,
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      recommendationMode: true,
    };
    const original = calculatePouchCost(input);
    const candidate = original.recommendationCandidates?.[0];
    expect(candidate).toBeDefined();
    const selected = calculatePouchCost({ ...input, selectedCandidateId: candidate!.id });
    expect(selected.quantity).toBe(candidate!.adjustedQuantity);
    expect(selected.printingMethod).toBe(candidate!.printingMethod);
    expect(selected.selectedCandidateId).toBe(candidate!.id);
  });
});
