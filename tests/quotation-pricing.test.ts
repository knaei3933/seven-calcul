import { describe, expect, it } from "vitest";
import { calculatePouchCost } from "@/lib/calculation";
import { CONNECTED_FILLING_SURCHARGE, defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { calculateAutomaticQuotation, clampGravureFilmMeterUnit, COPPER_TARGET_MARGIN } from "@/lib/quotation-pricing";
import { D, Decimal } from "@/lib/decimal";
import type { PouchSpec } from "@/lib/types";

describe("automatic quotation pricing", () => {
  it("clamps gravure film meter unit into the 90-220 yen band", () => {
    expect(clampGravureFilmMeterUnit(D("50")).toString()).toBe("90");
    expect(clampGravureFilmMeterUnit(D("150")).toString()).toBe("150");
    expect(clampGravureFilmMeterUnit(D("300")).toString()).toBe("220");
  });

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
    expect(quote!.display.filmUnit).toBe("220");
    expect(quote!.display.filmAmount).toBe("374000");
    expect(quote!.display.filmPouchUnit).toBe("7.48");
    expect(quote!.copperCostPerPiece.eq(D(selected.copperPlateCostPerPiece))).toBe(true);
    expect(quote!.copperSellingUnit.eq(
      D(selected.copperPlateCostPerPiece).div(D(1).minus(COPPER_TARGET_MARGIN)),
    )).toBe(true);
  });

  it("prices connected filling at +20% (2連) and +80% (3連/4連) over the 1連 basis", () => {
    const spec = (connected: 1 | 2 | 3 | 4, lanes = 4): PouchSpec => ({
      sizeKey: "round-50x60",
      fillMlPerChamber: "3",
      connectedChambers: connected,
      fillingMethod: "hopper",
      fillingLanes: lanes,
      isCustom: false,
      colorCount: 4,
      bulkUnitPrice: "0",
      skuCount: 1,
    });
    const run = (connected: 1 | 2 | 3 | 4, lanes = 4) => calculatePouchCost({
      spec: spec(connected, lanes),
      quantity: "10000",
      printingMethod: "digital",
    });
    const single = run(1);
    const twin = run(2);
    const triple = run(3, 3);
    const quad = run(4);
    const margin = "0.4";
    const q1 = calculateAutomaticQuotation(single, margin)!;
    const q2 = calculateAutomaticQuotation(twin, margin)!;
    const q3 = calculateAutomaticQuotation(triple, margin)!;
    const q4 = calculateAutomaticQuotation(quad, margin)!;

    const singleBasis = D(single.singleConnectedFillingCostPerPiece);
    const expectedUnit = (connected: 1 | 2 | 3 | 4, surcharge: string) => singleBasis
      .times(D(connected))
      .times(D(1).plus(D(surcharge)))
      .div(D(1).minus(D(margin)));
    expect(q2.fillingSellingUnit.eq(expectedUnit(2, CONNECTED_FILLING_SURCHARGE[2]))).toBe(true);
    expect(q3.fillingSellingUnit.eq(expectedUnit(3, CONNECTED_FILLING_SURCHARGE[3]))).toBe(true);
    expect(q4.fillingSellingUnit.eq(expectedUnit(4, CONNECTED_FILLING_SURCHARGE[4]))).toBe(true);
    // 1連基準単価6円なら、2連=(6+6)×1.2=14.4円、3連=(6×3)×1.8=32.4円、4連=(6×4)×1.8=43.2円。
    expect(q2.fillingSellingUnit.div(q1.fillingSellingUnit).toNumber()).toBeCloseTo(2.4, 10);
    expect(q3.fillingSellingUnit.div(q1.fillingSellingUnit).toNumber()).toBeCloseTo(5.4, 10);
    expect(q4.fillingSellingUnit.div(q1.fillingSellingUnit).toNumber()).toBeCloseTo(7.2, 10);
    // 原価側は検品室数と速度低下を反映して1連より大きくなる。
    expect(Number(twin.costPerPieceComponents.variableProcessing)).toBeGreaterThan(Number(single.costPerPieceComponents.variableProcessing));
    expect(Number(triple.costPerPieceComponents.variableProcessing)).toBeGreaterThan(Number(twin.costPerPieceComponents.variableProcessing));
  });

  it("rounds filling and film quotation unit prices up to one decimal (2連 60×120 10ml case)", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "round-60x120",
        fillMlPerChamber: "10",
        connectedChambers: 2,
        fillingMethod: "hopper",
        fillingLanes: 4,
        isCustom: false,
        colorCount: 4,
        bulkUnitPrice: "0",
        skuCount: 1,
      },
      quantity: "10000",
      printingMethod: "digital",
    });
    const quote = calculateAutomaticQuotation(result, "0.4")!;
    // デジタルはフィルムm単価（800m帯=450円/m）を先に確定し、
    // 目標合計からの残額を充填・加工単価へ配分して小数第1位へ切り上げる。
    expect(quote.filmOrderLength.eq(D("800"))).toBe(true);
    expect(quote.display.filmUnit).toBe("450");
    expect(quote.display.filmAmount).toBe("360000");
    expect(quote.display.fillingUnit).toBe("36.1");
    expect(quote.fillingAmount.eq(D("36.1").times("10000"))).toBe(true);
  });

  it("separates the bulk line when bulk is sold and hides it when customer-supplied", () => {
    const spec = (bulkUnitPrice: string) => ({
      sizeKey: "round-60x120" as const,
      fillMlPerChamber: "10",
      connectedChambers: 2 as const,
      fillingMethod: "hopper" as const,
      fillingLanes: 4,
      isCustom: false,
      colorCount: 4,
      bulkUnitPrice,
      skuCount: 1,
    });
    const sold = calculateAutomaticQuotation(calculatePouchCost({
      spec: spec("0.37"), quantity: "10000", printingMethod: "digital",
    }), "0.4")!;
    // バルク販売単価＝バルク原価÷(1−0.4)、小数第1位切り上げ。
    expect(sold.bulkCostPerPiece.gt(0)).toBe(true);
    expect(sold.display.bulkUnit).toBe(D(sold.bulkCostPerPiece).div("0.6").toDecimalPlaces(1, Decimal.ROUND_UP).toString());
    expect(sold.display.bulkAmount).toBe(D(sold.display.bulkUnit).times("10000").toString());
    // ライン構成：充填・加工＋バルク＋フィルムが小計と一致（別ライン化の検証）。
    expect(sold.subtotal.minus(sold.fillingAmount).minus(sold.bulkAmount).minus(D(sold.display.filmAmount)).toNumber()).toBe(0);

    const supplied = calculateAutomaticQuotation(calculatePouchCost({
      spec: spec("0"), quantity: "10000", printingMethod: "digital",
    }), "0.4")!;
    expect(supplied.bulkCostPerPiece.toNumber()).toBe(0);
    expect(supplied.display.bulkUnit).toBe("0");
    expect(supplied.display.bulkAmount).toBe("0");
  });
});
