import { describe, expect, it } from "vitest";
import { D } from "@/lib/decimal";
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

function context(spec: PouchSpec = baseSpec, quantity = "150000") {
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

  it("ranks primarily by film cost per proposed pouch", () => {
    const candidates = buildPrintCandidates(context());
    const costs = candidates.map((candidate) => D(candidate.filmCostPerPieceYen));
    for (let index = 1; index < costs.length; index += 1) {
      expect(costs[index].gte(costs[index - 1])).toBe(true);
    }
  });

  it("preserves a selected digital candidate order length", () => {
    const candidates = buildPrintCandidates(context());
    const candidate = candidates.find((item) => item.route === "D");
    expect(candidate).toBeDefined();
    const result = calculatePouchCost({
      spec: baseSpec,
      quantity: "150000",
      printingMethod: "gravure",
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      recommendationMode: true,
      selectedCandidateId: candidate!.id,
    });
    expect(D(result.film.orderLengthM).eq(candidate!.orderLengthM)).toBe(true);
    expect(D(result.costComponents.film).eq(candidate!.filmTotalYen)).toBe(true);
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
      quantity: "150000",
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
