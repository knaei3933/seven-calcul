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
  it("returns a deterministic route-balanced candidate list capped at three", () => {
    const first = buildPrintCandidates(context());
    const second = buildPrintCandidates(context());
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(3);
    expect(first.map((candidate) => candidate.id)).toEqual(second.map((candidate) => candidate.id));
    expect(first.some((candidate) => candidate.route === "D")).toBe(true);
    expect(first.some((candidate) => candidate.route === "Y")).toBe(true);
    expect(first.filter((candidate) => candidate.recommended)).toHaveLength(1);
    expect(first[0].recommended).toBe(true);
  });

  it("guarantees digital and gravure representatives before shortage references across quantities", () => {
    for (const quantity of ["20000", "50000", "133000"]) {
      const displayed = buildPrintCandidates(context(baseSpec, quantity));
      const repeat = buildPrintCandidates(context(baseSpec, quantity));
      expect(displayed.length).toBeGreaterThan(0);
      expect(displayed.length).toBeLessThanOrEqual(3);
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

  it("shows the fulfilling minimum and the small-lot shortage reference", () => {
    const candidates = buildPrintCandidates(context(baseSpec, "20000"));
    const recommended = candidates.find((candidate) => candidate.recommended)!;
    const shortageReference = candidates.find((candidate) => !candidate.isFulfilling)!;
    const fulfilling = candidates.filter((candidate) => (
      Number(candidate.adjustedQuantity) >= 20000
    ));
    expect(candidates).toHaveLength(3);
    expect(recommended.route).toBe("D");
    expect(recommended.orderLengthM).toBe("600");
    expect(recommended.capacityQuantity).toBe("24186");
    expect(recommended.isExactQuantity).toBe(true);
    expect(recommended.adjustedQuantity).toBe("20000");
    expect(shortageReference.orderLengthM).toBe("500");
    expect(shortageReference.capacityQuantity).toBe("19534");
    expect(shortageReference.adjustedQuantity).toBe("19000");
    expect(shortageReference.shortagePieces).toBe("1000");
    expect(shortageReference.recommended).toBe(false);
    expect(fulfilling.some((candidate) => candidate.orderLengthM === "600")).toBe(true);
  });

  it("uses real deliverable capacity and keeps the shortage comparison selectable", () => {
    const rawCandidates = buildPrintCandidates(context(baseSpec, "20000"));
    const rawFiveHundred = rawCandidates.find((candidate) => candidate.route === "D" && candidate.orderLengthM === "500");
    const rawSixHundred = rawCandidates.find((candidate) => candidate.route === "D" && candidate.orderLengthM === "600" && candidate.isExactQuantity);
    expect(rawFiveHundred?.capacityQuantity).toBe("19534");
    expect(rawFiveHundred?.adjustedQuantity).toBe("19000");
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
    expect(displayed.some((candidate) => candidate.orderLengthM === "500" && !candidate.recommended)).toBe(true);
    const shortestFulfilling = displayed.find((candidate) => candidate.orderLengthM === "600");
    expect(shortestFulfilling?.recommended).toBe(true);
    expect(D(shortestFulfilling!.incrementalFilmTotalYen!).toNumber()).toBe(51000);
    expect(D(shortestFulfilling!.incrementalQuantity!).toNumber()).toBe(0);
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
    expect(Number(korea!.allInTotalCostYen)).toBeCloseTo(1280489.71, 1);
    expect(korea!.adjustedQuantity).toBe("206000");

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
      ?.find((item) => item.route === "D" && !item.isFulfilling);
    expect(candidate).toBeDefined();
    const { filmOrders: _filmOrders, ...candidateWithoutReplayMetadata } = candidate!;

    const result = calculateSelectedCandidateCore(candidateWithoutReplayMetadata, input);

    expect(result.selectedCandidateId).toBeUndefined();
    expect(result.quantity).toBe(candidate!.adjustedQuantity);
    expect(result.film.skuCosts[0]?.quantity).toBe(candidate!.adjustedQuantity);
  });
});
