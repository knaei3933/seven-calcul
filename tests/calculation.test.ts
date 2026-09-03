import { describe, expect, it } from "vitest";
import { approvedCommission, calculatePouchCost } from "@/lib/calculation";
import { validateDigitalFilmOrder } from "@/lib/digital-film";
import { defaultParameters } from "@/lib/constants";
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
  skuRequiredLengthsM: ["500"],
};

describe("bulk calculation", () => {
  it("uses sellable pouch quantity, chamber multiplication, test fill, and hopper initial charge", () => {
    const result = calculatePouchCost({ spec: baseSpec, quantity: "10000", printingMethod: "digital" });
    expect(result.chamberCount).toBe("20000");
    expect(result.testFillMl).toBe("60000");
    expect(result.bulkUsageMl).toBe("722000");
    expect(result.bulkCost).toBe("267140");
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
  it("allows every SKU at 300m when the rounded total is at least 500m", () => {
    const validation = validateDigitalFilmOrder(
      [{ skuCode: "A", requiredLengthM: "300" }, { skuCode: "B", requiredLengthM: "300" }],
      defaultParameters,
    );
    expect(validation.valid).toBe(true);
  });

  it("rejects an SKU below 300m and returns structured minimum correction", () => {
    const validation = validateDigitalFilmOrder(
      [{ skuCode: "A", requiredLengthM: "450" }, { skuCode: "B", requiredLengthM: "50" }],
      defaultParameters,
    );
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe("sku_min");
    expect(validation.corrections[0].suggestedLengthsM).toEqual(["450", "300"]);
  });

  it("allocates the minimum total to the largest SKU", () => {
    const validation = validateDigitalFilmOrder(
      [{ skuCode: "A", requiredLengthM: "100" }, { skuCode: "B", requiredLengthM: "100" }],
      defaultParameters,
    );
    expect(validation.corrections[0].suggestedLengthsM).toEqual(["300", "300"]);
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
    expect(result.audit.componentReconciliationDifference).toBe("0");
  });

  it("calculates approved-only commission from tax-exclusive sales", () => {
    expect(approvedCommission("1000000", "approved").commissionAmount).toBe("200000");
    expect(approvedCommission("1000000", "sent").commissionAmount).toBeNull();
  });
});
