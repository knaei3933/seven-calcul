import { describe, expect, it } from "vitest";
import { D, Decimal } from "@/lib/decimal";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { buildPrintCandidates, createPrintCandidateContext } from "@/lib/print-recommendation";
import { calculatePouchCost, calculateSelectedCandidateCore } from "@/lib/calculation";
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
  it("returns a deterministic route-balanced candidate list capped at six", () => {
    const first = buildPrintCandidates(context());
    const second = buildPrintCandidates(context());
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(6);
    expect(first.map((candidate) => candidate.id)).toEqual(second.map((candidate) => candidate.id));
    expect(first.some((candidate) => candidate.route === "D")).toBe(true);
    expect(first.some((candidate) => candidate.route === "Y")).toBe(true);
    expect(first.filter((candidate) => candidate.recommended)).toHaveLength(1);
  });

  it("guarantees digital and gravure representatives before shortage references across quantities", () => {
    for (const quantity of ["20000", "50000", "133000"]) {
      const displayed = buildPrintCandidates(context(baseSpec, quantity));
      const repeat = buildPrintCandidates(context(baseSpec, quantity));
      expect(displayed.length).toBeGreaterThan(0);
      expect(displayed.length).toBeLessThanOrEqual(6);
      expect(displayed.map((candidate) => candidate.id)).toEqual(repeat.map((candidate) => candidate.id));

      const digitalIndex = displayed.findIndex((candidate) => candidate.route === "D");
      const gravureIndex = displayed.findIndex((candidate) => candidate.printingMethod === "gravure");
      expect(digitalIndex).toBeGreaterThanOrEqual(0);
      expect(gravureIndex).toBeGreaterThanOrEqual(0);

      const duplicateShortageIndex = displayed.findIndex((candidate, index) => (
        !candidate.isFulfilling && index !== digitalIndex && index !== gravureIndex
      ));
      if (duplicateShortageIndex >= 0) {
        expect(digitalIndex).toBeLessThan(duplicateShortageIndex);
        expect(gravureIndex).toBeLessThan(duplicateShortageIndex);
      }
    }
  });

  it("shows fulfilling plans and both relevant near-target domestic references", () => {
    const nearTargetSpec: PouchSpec = {
      ...baseSpec,
      colorCount: 4,
      skuCount: 1,
      skuQuantities: ["150000"],
      skuColorCounts: ["4"],
    };
    const candidates = buildPrintCandidates(context(nearTargetSpec, "150000"));
    const recommended = candidates.find((candidate) => candidate.recommended)!;
    expect(candidates).toHaveLength(5);
    expect(recommended.route).toBe("K");
    expect(recommended.orderLengthM).toBe("6000");
    expect(recommended.capacityQuantity).toBe("230232");
    expect(recommended.isExactQuantity).toBe(true);
    expect(recommended.adjustedQuantity).toBe("150000");
    // 3,500m is closest to the requested quantity; 3,400m is the lower-cost
    // domestic pattern inside the same negotiation window.
    expect(candidates.filter((candidate) => candidate.route === "Y" && !candidate.isFulfilling)
      .map((candidate) => candidate.orderLengthM)).toEqual(["3500", "3400"]);
    for (const candidate of candidates.filter((item) => !item.isFulfilling)) {
      expect(candidate.selectionTag).toBe("目標数近似・不足参考");
      expect(Number(candidate.shortagePieces) / 150000).toBeLessThanOrEqual(0.15);
    }
  });

  it("uses real deliverable capacity and keeps the shortage comparison selectable", () => {
    const rawCandidates = buildPrintCandidates(context(baseSpec, "20000"));
    const rawSixHundred = rawCandidates.find((candidate) => candidate.route === "D" && candidate.orderLengthM === "600" && candidate.isExactQuantity);
    expect(rawSixHundred?.capacityQuantity).toBe("24186");
    const exactSixHundred = rawCandidates.find((candidate) => candidate.route === "D" && candidate.orderLengthM === "600" && candidate.isExactQuantity);
    expect(exactSixHundred?.adjustedQuantity).toBe("20000");

    const digitalContext = createPrintCandidateContext({
      spec: baseSpec,
      quantity: "20000",
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      printingMethod: "digital",
      basisFilmOrderLengthM: "500",
      basisFilmTotalYen: "182200",
    });
    const displayed = buildPrintCandidates(digitalContext);
    const shortestFulfilling = displayed.find((candidate) => candidate.orderLengthM === "600");
    expect(shortestFulfilling?.recommended).toBe(true);
    expect(D(shortestFulfilling!.incrementalFilmTotalYen!).toNumber()).toBe(51000);
    expect(D(shortestFulfilling!.incrementalQuantity!).toNumber()).toBe(0);
  });

  it("generates digital shortage alternatives only at structural order boundaries", () => {
    const spec: PouchSpec = {
      ...baseSpec,
      sizeKey: "round-60x80",
      colorCount: 4,
      skuCount: 1,
      skuQuantities: ["50000"],
      skuColorCounts: ["4"],
    };
    const candidates = buildPrintCandidates(context(spec, "50000"));
    const digital = candidates.filter((candidate) => candidate.route === "D");

    expect(digital.map((candidate) => candidate.orderLengthM)).toEqual(["1200", "1000"]);
    expect(digital.some((candidate) => candidate.orderLengthM === "1100")).toBe(false);
    expect(digital.some((candidate) => candidate.orderLengthM === "1300")).toBe(false);
    const basis = digital.find((candidate) => candidate.isFulfilling);
    const boundaryShortage = digital.find((candidate) => !candidate.isFulfilling);
    expect(basis?.orderLengthM).toBe("1200");
    expect(boundaryShortage?.orderLengthM).toBe("1000");
    expect(boundaryShortage?.priceBreak).toBe(true);
  });

  it("recommends exact customer quantity candidates first", () => {
    const candidates = buildPrintCandidates(context());
    const recommended = candidates.find((candidate) => candidate.recommended)!;
    expect(recommended.route).toBe("Y");
    expect(recommended.orderLengthM).toBe("3400");
    expect(recommended.capacityQuantity).toBe("142325");
    expect(recommended.isExactQuantity).toBe(true);
    expect(recommended.adjustedQuantity).toBe("133000");
    expect(recommended.capacityPlanningDifference).toBe("9325");
    expect(D(recommended.filmTotalYen).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toString()).toBe("385370");
    expect(D(recommended.surplusRatio).lte(D("15"))).toBe(true);

    const smallerOrder = buildPrintCandidates(context(baseSpec, "20000"));
    const smallestFulfilling = smallerOrder
      .filter((candidate) => Number(candidate.adjustedQuantity) >= 20000)
      .sort((left, right) => Number(left.adjustedQuantity) - Number(right.adjustedQuantity))[0];
    expect(smallestFulfilling.route).toBe("D");
    expect(smallestFulfilling.orderLengthM).toBe("600");
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

  it("calculates a selected candidate at its 1,000-piece planning quantity", () => {
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

    expect(D(selected.film.filmTotal).eq(D(candidate!.filmTotalYen))).toBe(true);
  });

  it("uses selected candidate margins for a gravure result while keeping the digital original basis", () => {
    const digitalMargins = ["0.3", "0.35", "0.4"];
    const gravureMargins = ["0.2", "0.25", "0.3"];
    const input = {
      spec: baseSpec,
      quantity: "50000",
      printingMethod: "digital" as const,
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      targetMargins: ["0.4", "0.35", "0.3"],
      recommendationMode: true,
    };
    const original = calculatePouchCost(input);
    const candidate = original.recommendationCandidates?.find((item) => item.route === "Y");
    expect(candidate).toBeDefined();

    const selected = calculatePouchCost({
      ...input,
      selectedCandidateId: candidate!.id,
      selectedCandidateTargetMargins: gravureMargins,
    });

    expect(selected.printingMethod).toBe("gravure");
    expect(original.sellingPrices.map((price) => price.margin)).toEqual(digitalMargins);
    expect(selected.sellingPrices.map((price) => price.margin)).toEqual(gravureMargins);
  });

  it("attaches exact server-calculated all-in economics to displayed D/K/Y candidates", () => {
    const spec: PouchSpec = {
      ...baseSpec,
      sizeKey: "tube-50x90",
      skuQuantities: ["50000"],
      skuColorCounts: ["4"],
    };
    const input = {
      spec,
      quantity: "50000",
      printingMethod: "digital" as const,
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      recommendationMode: true,
    };
    const original = calculatePouchCost(input);
    const candidates = original.recommendationCandidates ?? [];

    const digital = candidates.find((candidate) => candidate.route === "D");
    const domestic = candidates.find((candidate) => candidate.route === "Y");
    const korea = candidates.find((candidate) => candidate.route === "K");
    expect(digital).toBeDefined();
    expect(domestic).toBeDefined();
    expect(korea).toBeDefined();

    expect(Number(original.costTotal)).toBeCloseTo(572670.7, 3);
    expect(digital!.copperPlateTotalYen).toBe("0");
    expect(Number(digital!.allInDeltaYen)).toBeCloseTo(
      Number(digital!.allInTotalCostYen) - Number(original.costTotal),
      8,
    );
    expect(domestic!.filmTotalYen).toBe("269416");
    expect(domestic!.copperPlateTotalYen).toBe("120960");
    expect(Number(domestic!.allInTotalCostYen)).toBeCloseTo(549646.7, 3);
    expect(Number(domestic!.allInDeltaYen)).toBeCloseTo(-23024, 8);
    expect(Number(korea!.allInTotalCostYen)).toBeCloseTo(856512.7, 1);
    expect(korea!.adjustedQuantity).toBe("50000");
    expect(korea!.capacityQuantity).toBe("206249");

    for (const candidate of candidates) {
      const selected = calculatePouchCost({ ...input, selectedCandidateId: candidate.id });
      expect(selected.quantity).toBe(candidate.adjustedQuantity);
      expect(selected.copperPlateCost).toBe(candidate.copperPlateTotalYen);
      expect(selected.costTotal).toBe(candidate.allInTotalCostYen);
      expect(selected.totalCostPerPiece).toBe(candidate.allInCostPerPieceYen);
    }
  });

  it("uses adjusted candidate input when replay metadata is absent", () => {
    const input = {
      spec: {
        ...baseSpec,
        sizeKey: "tube-50x90" as const,
        skuQuantities: ["50000"],
        skuColorCounts: ["4"],
      },
      quantity: "50000",
      printingMethod: "digital" as const,
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      recommendationMode: true,
    };
    const candidate = calculatePouchCost(input).recommendationCandidates
      ?.find((item) => item.route === "D");
    expect(candidate).toBeDefined();
    const { filmOrders: _filmOrders, ...candidateWithoutReplayMetadata } = candidate!;

    const result = calculateSelectedCandidateCore(candidateWithoutReplayMetadata, input);

    expect(result.selectedCandidateId).toBeUndefined();
    expect(result.quantity).toBe(candidate!.adjustedQuantity);
    expect(result.film.skuCosts[0]?.quantity).toBe(candidate!.adjustedQuantity);
  });

  it("orders domestic Y rolls independently for each SKU", () => {
    const spec: PouchSpec = {
      ...baseSpec,
      sizeKey: "tube-50x90",
      skuCount: 2,
      skuQuantities: ["25000", "25000"],
      skuFillMlPerChamber: ["3", "3"],
      skuColorCounts: ["4", "4"],
    };
    const input = {
      spec,
      quantity: "50000",
      printingMethod: "digital" as const,
      parameters: defaultParameters,
      gravureParameters: defaultGravureRollParameters(),
      recommendationMode: true,
    };
    const original = calculatePouchCost(input);
    const candidate = original.recommendationCandidates?.find((item) => (
      item.route === "Y" && item.orderLengthM === "3400"
    ));
    expect(candidate).toBeDefined();
    expect(candidate!.materialText).toContain("SKUごと 1700m+1700m");
    expect(candidate!.adjustedSkuQuantities).toEqual(["25000", "25000"]);
    expect(candidate!.sasche?.skuOutputLengthsM).toEqual(["1700", "1700"]);

    const selected = calculatePouchCost({
      ...input,
      selectedCandidateId: candidate!.id,
    });
    expect(selected.film.orderLengthM).toBe("3400");
    expect(D(selected.film.filmTotal).eq(D(candidate!.filmTotalYen))).toBe(true);
  });
});
