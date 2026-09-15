import { describe, expect, it } from "vitest";
import { calculatePouchCost } from "@/lib/calculation";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { calculateAutomaticQuotation } from "@/lib/quotation-pricing";
import { D } from "@/lib/decimal";

describe("automatic quotation pricing", () => {
  it("carries a selected gravure candidate's film basis into quotation lines", () => {
    const input = {
      spec: {
        sizeKey: "tube-50x90" as const, fillMlPerChamber: "3", connectedChambers: 1 as const,
        fillingMethod: "hopper" as const, fillingLanes: 4, isCustom: false,
        colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      },
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

    const selected = calculatePouchCost({ ...input, selectedCandidateId: candidate!.id });
    const quote = calculateAutomaticQuotation(selected, "0.3");

    expect(selected.printingMethod).toBe("gravure");
    expect(D(selected.costComponents.film).eq(candidate!.filmTotalYen)).toBe(true);
    expect(D(selected.film.unitPrice).eq(candidate!.includedUnitPricePerM)).toBe(true);
    expect(quote).not.toBeNull();
    expect(quote!.filmCostPerPiece.eq(D(selected.costPerPieceComponents.film))).toBe(true);
    expect(quote!.filmOrderLength.eq(D(candidate!.orderLengthM))).toBe(true);
    expect(quote!.display.filmAmount).toBe("384421");
    expect(quote!.display.filmPouchUnit).toBe("7.68842");
  });
});
