import { describe, expect, it } from "vitest";
import { D, Decimal } from "@/lib/decimal";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { buildPrintCandidates, createPrintCandidateContext } from "@/lib/print-recommendation";
import { calculatePouchCost } from "@/lib/calculation";
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
  it("returns deterministic D/K/Y candidates capped at nine", () => {
    const first = buildPrintCandidates(context());
    const second = buildPrintCandidates(context());
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(9);
    expect(first.map((candidate) => candidate.id)).toEqual(second.map((candidate) => candidate.id));
    expect(first.some((candidate) => candidate.route === "D")).toBe(true);
    expect(first.some((candidate) => candidate.route === "K")).toBe(true);
    expect(first.some((candidate) => candidate.route === "Y")).toBe(true);
    expect(first.filter((candidate) => candidate.recommended)).toHaveLength(1);
  });

  it("includes a digital 1,000m aggregate price-break candidate for a smaller requirement", () => {
    const candidates = buildPrintCandidates(context(baseSpec, "20000"));
    const digital = candidates.filter((candidate) => candidate.route === "D");
    expect(digital.some((candidate) => candidate.priceBreak)).toBe(true);
  });

  it("recommends the practical near-quantity Y candidate", () => {
    const candidates = buildPrintCandidates(context());
    const recommended = candidates.find((candidate) => candidate.recommended)!;
    expect(recommended.route).toBe("Y");
    expect(recommended.orderLengthM).toBe("3400");
    expect(recommended.adjustedQuantity).toBe("142325");
    expect(D(recommended.filmTotalYen).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString()).toBe("385370");
    expect(D(recommended.surplusRatio).lte(D("15"))).toBe(true);

    const farBreak = candidates.find((candidate) => candidate.orderLengthM === "7000");
    expect(farBreak).toBeDefined();
    expect(D(farBreak!.surplusRatio).gt(D("15"))).toBe(true);
    expect(farBreak!.recommended).toBe(false);
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
    const candidates = buildPrintCandidates(context(baseSpec, "150000"));
    const lane1 = candidates.find((item) => item.route === "Y" && item.sasche?.laneCount === 1);
    const lane2 = candidates.find((item) => item.route === "Y" && item.sasche?.laneCount === 2);
    expect(Number(lane1!.sasche!.plateUnitPriceYen)).toBeCloseTo(26000 * 1.12, 8);
    expect(Number(lane2!.sasche!.plateUnitPriceYen)).toBeCloseTo(32000 * 1.12, 8);
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
