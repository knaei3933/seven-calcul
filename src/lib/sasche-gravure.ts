import { D, Decimal } from "./decimal";
import type { GravureRollCostResult } from "./gravure-roll";

const GRAVURE_SELLER_MARKUP = "1.12";

export type SascheLane = 1 | 2;
export type SaschePrintTier = 2000 | 4000;

export type SascheCandidate = {
  webWidthMm: number;
  laneCount: SascheLane;
  printTierM: SaschePrintTier;
  approxLengthM: number;
  supplierUnitPriceYenPerM: string;
  plateBaseYen: string;
  requiredLengthM: string;
  quantity: string;
  sellerMarkup: "1.12";
  matchedWidthDifferenceMm: number;
  filmUnitPriceYen: string;
  filmTotalYen: string;
  plateUnitPriceYen: string;
  plateTotalYen: string;
};

const supplierMatrix = [
  { webWidthMm: 356, laneCount: 1, printTierM: 2000, approxLengthM: 1700, unitPrice: "141.00", plateBase: "26000" },
  { webWidthMm: 356, laneCount: 1, printTierM: 4000, approxLengthM: 3500, unitPrice: "107.30", plateBase: "26000" },
  { webWidthMm: 356, laneCount: 2, printTierM: 2000, approxLengthM: 3400, unitPrice: "101.20", plateBase: "32000" },
  { webWidthMm: 356, laneCount: 2, printTierM: 4000, approxLengthM: 7000, unitPrice: "76.80", plateBase: "32000" },
  { webWidthMm: 476, laneCount: 1, printTierM: 2000, approxLengthM: 1700, unitPrice: "141.50", plateBase: "27000" },
  { webWidthMm: 476, laneCount: 1, printTierM: 4000, approxLengthM: 3500, unitPrice: "125.60", plateBase: "27000" },
  { webWidthMm: 476, laneCount: 2, printTierM: 2000, approxLengthM: 3400, unitPrice: "132.00", plateBase: "33000" },
  { webWidthMm: 476, laneCount: 2, printTierM: 4000, approxLengthM: 7000, unitPrice: "99.70", plateBase: "33000" },
  { webWidthMm: 556, laneCount: 1, printTierM: 2000, approxLengthM: 1700, unitPrice: "160.80", plateBase: "28000" },
  { webWidthMm: 556, laneCount: 1, printTierM: 4000, approxLengthM: 3500, unitPrice: "126.30", plateBase: "28000" },
  { webWidthMm: 620, laneCount: 1, printTierM: 2000, approxLengthM: 1700, unitPrice: "176.00", plateBase: "32000" },
  { webWidthMm: 620, laneCount: 1, printTierM: 4000, approxLengthM: 3500, unitPrice: "133.50", plateBase: "32000" },
] as const;

export function selectSascheCandidate({
  webWidthMm,
  requiredLengthM,
  quantity,
  colorCount,
}: {
  webWidthMm: number;
  requiredLengthM: Decimal;
  quantity: Decimal;
  colorCount: Decimal;
}): SascheCandidate | null {
  if (webWidthMm <= 0 || requiredLengthM.lte(0) || quantity.lte(0)) return null;
  if (colorCount.lt(0)) return null;

  const widthCandidates = supplierMatrix
    .map((row) => ({ row, difference: Math.abs(webWidthMm - row.webWidthMm) }))
    .filter((entry) => entry.difference <= 30)
    .sort((left, right) => left.difference - right.difference);

  if (widthCandidates.length === 0) return null;
  const targetDifference = widthCandidates[0].difference;
  const sameWidthRows = widthCandidates
    .filter((entry) => entry.difference === targetDifference)
    .map((entry) => entry.row);

  const plateCount = colorCount.toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  const validCandidates = sameWidthRows
    .filter((row) => D(row.approxLengthM).gte(requiredLengthM))
    .map((row) => {
      const supplierUnit = D(row.unitPrice);
      const filmUnit = supplierUnit.times(GRAVURE_SELLER_MARKUP);
      const filmTotal = D(row.approxLengthM).times(filmUnit);
      const plateUnit = plateCount === 0 ? D(0) : D(row.plateBase).times(GRAVURE_SELLER_MARKUP);
      const plateTotal = plateCount === 0 ? D(0) : plateUnit.times(plateCount);
      return {
        row,
        difference: targetDifference,
        supplierUnit,
        filmUnit,
        filmTotal,
        plateUnit,
        plateTotal,
        comparisonTotal: filmTotal.plus(plateTotal),
      };
    })
    .sort((left, right) => left.comparisonTotal.comparedTo(right.comparisonTotal));

  if (validCandidates.length === 0) return null;
  const selected = validCandidates[0];
  const row = selected.row;

  return {
    webWidthMm: row.webWidthMm,
    laneCount: row.laneCount,
    printTierM: row.printTierM,
    approxLengthM: row.approxLengthM,
    supplierUnitPriceYenPerM: selected.supplierUnit.toString(),
    plateBaseYen: row.plateBase,
    requiredLengthM: requiredLengthM.toString(),
    quantity: quantity.toString(),
    sellerMarkup: GRAVURE_SELLER_MARKUP,
    matchedWidthDifferenceMm: selected.difference,
    filmUnitPriceYen: selected.filmUnit.toString(),
    filmTotalYen: selected.filmTotal.toString(),
    plateUnitPriceYen: selected.plateUnit.toString(),
    plateTotalYen: selected.plateTotal.toString(),
  }

}

export function buildSascheGravureRollResult(
  candidate: SascheCandidate,
): GravureRollCostResult {
  const requiredLengthM = D(candidate.requiredLengthM);
  const quantity = D(candidate.quantity);
  const approxLengthM = D(candidate.approxLengthM);
  const lossLengthM = Decimal.max(approxLengthM.minus(requiredLengthM), D(0));
  const filmCostYen = D(candidate.filmTotalYen);
  const customsBaseCostYen = filmCostYen;
  const copperPlateCostYen = D(candidate.plateTotalYen);

  return {
    requiredLengthM: requiredLengthM.toString(),
    orderPatternCount: 1,
    deliverableLengthM: approxLengthM.toString(),
    productionLengthM: approxLengthM.toString(),
    lossLengthM: lossLengthM.toString(),
    materialWidthMm: candidate.webWidthMm.toString(),
    finalHeatSealWidthMm: candidate.webWidthMm.toString(),
    materialCostYen: "0",
    printingCostYen: "0",
    laminationCostYen: "0",
    filmCostYen: D(candidate.supplierUnitPriceYenPerM).times(approxLengthM).toString(),
    manufacturerMarginCostYen: "0",
    customsBaseCostYen: customsBaseCostYen.toString(),
    customsCostYen: "0",
    overseasShippingCostYen: "0",
    shippingTrips: 0,
    copperPlateCount: D(candidate.plateTotalYen).eq(0)
      ? 0
      : Number(D(candidate.plateTotalYen).div(D(candidate.plateUnitPriceYen)).toFixed(0, Decimal.ROUND_CEIL)),
    copperPlateUnitPriceYen: candidate.plateUnitPriceYen,
    copperPlateCostYen: copperPlateCostYen.toString(),
    totalGravureCostYen: customsBaseCostYen.plus(copperPlateCostYen).toString(),
    smallWidthTier: false,
    smallWidthManufacturerUnitPriceKRWPerM: "0",
    filmCostPerPieceYen: quantity.gt(0) ? customsBaseCostYen.div(quantity).toString() : "0",
    copperPlateCostPerPieceYen: quantity.gt(0) ? copperPlateCostYen.div(quantity).toString() : "0",
    recommendedQuantity: quantity.gt(0)
      ? approxLengthM.div(requiredLengthM.div(quantity)).toDecimalPlaces(0, Decimal.ROUND_FLOOR).toString()
      : "0",
    recommendedQuantityUtilization: approxLengthM.gt(0)
      ? requiredLengthM.div(approxLengthM).toString()
      : "0",
  };
}
