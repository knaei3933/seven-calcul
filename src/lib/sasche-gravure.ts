import { D, Decimal } from "./decimal";
import type { GravureRollCostResult } from "./gravure-roll";

const SELLER_MARKUP = "1.12" as const;
const PLATE_MINIMUM = "32000";

export type SascheLane = 1 | 2;
export type SaschePrintTier = 2000 | 4000;

export type SascheCandidate = {
  id: string;
  webWidthMm: number;
  matchedWidthMm: number;
  laneCount: SascheLane;
  printTierM: SaschePrintTier;
  patternCount: number;
  filmLabel: "Y";
  baseApproxLengthM: number;
  outputLengthM: string;
  requiredLengthM: string;
  quantity: string;
  adjustedQuantity: string;
  quantityReductionRatio: string;
  quantityToleranceExceeded: boolean;
  colorCount: number;
  supplierUnitPriceYenPerM: string;
  sellerMarkup: "1.12";
  filmUnitPriceYen: string;
  filmTotalYen: string;
  plateUnitPriceYen: string;
  plateTotalYen: string;
  surplusLengthM: string;
  shortageLengthM: string;
  surplusRatio: string;
  feasible: boolean;
  recommended: boolean;
  comparisonRank: number;
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

function nearestWidthRow(webWidthMm: number) {
  return supplierMatrix
    .map((row) => ({
      row,
      difference: Math.abs(webWidthMm - row.webWidthMm),
      width: row.webWidthMm,
    }))
    .sort((left, right) =>
      left.difference - right.difference || right.width - left.width,
    )[0].row;
}

const QUANTITY_TOLERANCE = 0.15;

function adjustedQuantityForOutput(outputLengthM: Decimal, requiredLengthM: Decimal, quantity: Decimal) {
  const perPieceRequiredLength = quantity.gt(0) ? requiredLengthM.div(quantity) : D(0);
  const maxQuantity = perPieceRequiredLength.gt(0)
    ? outputLengthM.div(perPieceRequiredLength).toDecimalPlaces(0, Decimal.ROUND_FLOOR)
    : D(0);
  return maxQuantity;
}

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

  const matchedWidth = nearestWidthRow(webWidthMm);
  const plateCount = colorCount.toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  const plateUnitBase = plateCount === 0
    ? D(0)
    : D(matchedWidth.plateBase).times(SELLER_MARKUP);
  const plateTotal = plateUnitBase.times(plateCount);
  const plateUnitPrice = plateCount === 0 ? D(0) : plateUnitBase;

  const candidates = supplierMatrix
    .filter((row) => row.webWidthMm === matchedWidth.webWidthMm)
    .map((row): SascheCandidate => {
      const outputLengthM = D(row.approxLengthM);
      const filmUnit = D(row.unitPrice).times(SELLER_MARKUP);
      const filmTotal = outputLengthM.times(filmUnit);
      const perPieceRequiredLength = quantity.gt(0) ? requiredLengthM.div(quantity) : D(0);
      const adjustedQuantity = perPieceRequiredLength.gt(0)
        ? outputLengthM.div(perPieceRequiredLength).toDecimalPlaces(0, Decimal.ROUND_FLOOR)
        : D(0);
      const quantityReductionRatio = quantity.gt(0)
        ? quantity.minus(adjustedQuantity).div(quantity).times(100)
        : D(0);
      const surplus = Decimal.max(outputLengthM.minus(requiredLengthM), D(0));
      const shortage = Decimal.max(requiredLengthM.minus(outputLengthM), D(0));
      const surplusRatio = requiredLengthM.gt(0)
        ? surplus.div(requiredLengthM).times(100)
        : D(0);
      const quantityAcceptable = outputLengthM.gte(requiredLengthM) || quantityReductionRatio.lte(15);
      const id = `Y-${row.webWidthMm}-${row.laneCount}-${row.printTierM}`;
      return {
        id,
        webWidthMm: row.webWidthMm,
        matchedWidthMm: matchedWidth.webWidthMm,
        laneCount: row.laneCount,
        printTierM: row.printTierM,
        patternCount: 1,
        filmLabel: "Y",
        baseApproxLengthM: row.approxLengthM,
        supplierUnitPriceYenPerM: row.unitPrice,
        sellerMarkup: SELLER_MARKUP,
        filmUnitPriceYen: filmUnit.toString(),
        requiredLengthM: requiredLengthM.toString(),
        quantity: quantity.toString(),
        colorCount: plateCount,
        plateUnitPriceYen: plateUnitPrice.toString(),
        plateTotalYen: plateTotal.toString(),
        adjustedQuantity: adjustedQuantity.toString(),
        quantityReductionRatio: quantityReductionRatio.toString(),
        quantityToleranceExceeded: quantityReductionRatio.gt(15),
        outputLengthM: outputLengthM.toString(),
        filmTotalYen: filmTotal.toString(),
        surplusLengthM: surplus.toString(),
        shortageLengthM: shortage.toString(),
        surplusRatio: surplusRatio.toString(),
        feasible: quantityAcceptable,
        recommended: false,
        comparisonRank: 0,
      };
    });

  const acceptableCandidates = candidates.filter((candidate) => candidate.feasible);
  const recommendedCandidate = acceptableCandidates.length > 0
    ? acceptableCandidates.reduce((best, candidate) =>
        D(candidate.filmTotalYen).lt(D(best.filmTotalYen)) ? candidate : best,
      )
    : null;
  for (const candidate of candidates) {
    candidate.recommended = recommendedCandidate?.id === candidate.id;
  }

  return recommendedCandidate;

}

export function buildSascheCandidates({
  webWidthMm,
  requiredLengthM,
  quantity,
  colorCount,
}: {
  webWidthMm: number;
  requiredLengthM: Decimal;
  quantity: Decimal;
  colorCount: Decimal;
}): SascheCandidate[] {
  const selected = selectSascheCandidate({
    webWidthMm,
    requiredLengthM,
    quantity,
    colorCount,
  });
  if (!selected) return [];

  const matchedWidth = nearestWidthRow(webWidthMm);
  const plateCount = colorCount.toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  const plateUnit = plateCount === 0
    ? D(0)
    : D(matchedWidth.plateBase).times(SELLER_MARKUP);
  const plateTotal = plateUnit.times(plateCount);

  const candidates = supplierMatrix
    .filter((row) => row.webWidthMm === matchedWidth.webWidthMm)
    .map((row): SascheCandidate => {
      const outputLengthM = D(row.approxLengthM);
      const filmUnit = D(row.unitPrice).times(SELLER_MARKUP);
      const filmTotal = outputLengthM.times(filmUnit);
      const perPieceRequiredLength = quantity.gt(0) ? requiredLengthM.div(quantity) : D(0);
      const adjustedQuantity = perPieceRequiredLength.gt(0)
        ? outputLengthM.div(perPieceRequiredLength).toDecimalPlaces(0, Decimal.ROUND_FLOOR)
        : D(0);
      const quantityReductionRatio = quantity.gt(0)
        ? quantity.minus(adjustedQuantity).div(quantity).times(100)
        : D(0);
      const surplus = Decimal.max(outputLengthM.minus(requiredLengthM), D(0));
      const shortage = Decimal.max(requiredLengthM.minus(outputLengthM), D(0));
      const surplusRatio = requiredLengthM.gt(0)
        ? surplus.div(requiredLengthM).times(100)
        : D(0);
      const id = `Y-${row.webWidthMm}-${row.laneCount}-${row.printTierM}`;
      return {
        id,
        webWidthMm: row.webWidthMm,
        matchedWidthMm: matchedWidth.webWidthMm,
        laneCount: row.laneCount,
        printTierM: row.printTierM,
        patternCount: 1,
        filmLabel: "Y",
        baseApproxLengthM: row.approxLengthM,
        supplierUnitPriceYenPerM: row.unitPrice,
        sellerMarkup: SELLER_MARKUP,
        filmUnitPriceYen: filmUnit.toString(),
        outputLengthM: outputLengthM.toString(),
        requiredLengthM: requiredLengthM.toString(),
        quantity: quantity.toString(),
        colorCount: plateCount,
        filmTotalYen: filmTotal.toString(),
        plateUnitPriceYen: plateUnit.toString(),
        plateTotalYen: plateTotal.toString(),
        surplusLengthM: surplus.toString(),
        shortageLengthM: shortage.toString(),
        surplusRatio: surplusRatio.toString(),
        adjustedQuantity: adjustedQuantity.toString(),
        quantityReductionRatio: quantityReductionRatio.toString(),
        quantityToleranceExceeded: quantityReductionRatio.gt(15),
        feasible: outputLengthM.gte(requiredLengthM) || quantityReductionRatio.lte(15),
        recommended: selected.id === id,
        comparisonRank: 0,
      };
    });
  return candidates;
}

export function buildSascheGravureRollResult(
  candidate: SascheCandidate,
): GravureRollCostResult {
  const requiredLengthM = D(candidate.requiredLengthM);
  const quantity = D(candidate.quantity);
  const approxLengthM = D(candidate.outputLengthM);
  const lossLengthM = Decimal.max(approxLengthM.minus(requiredLengthM), D(0));
  const filmCostYen = D(candidate.filmTotalYen);
  const customsBaseCostYen = filmCostYen;
  const copperPlateCostYen = D(candidate.plateTotalYen);

  return {
    requiredLengthM: requiredLengthM.toString(),
    filmLabel: "Y",
    orderPatternCount: 1,
    deliverableLengthM: candidate.outputLengthM,
    productionLengthM: candidate.outputLengthM,
    lossLengthM: lossLengthM.toString(),
    materialWidthMm: candidate.matchedWidthMm.toString(),
    finalHeatSealWidthMm: candidate.matchedWidthMm.toString(),
    materialCostYen: "0",
    printingCostYen: "0",
    laminationCostYen: "0",
    filmCostYen: filmCostYen.toString(),
    manufacturerMarginCostYen: "0",
    customsBaseCostYen: filmCostYen.toString(),
    customsCostYen: "0",
    overseasShippingCostYen: "0",
    shippingTrips: 0,
    copperPlateCount: candidate.colorCount,
    copperPlateUnitPriceYen: candidate.plateUnitPriceYen,
    copperPlateCostYen: copperPlateCostYen.toString(),
    totalGravureCostYen: filmCostYen.plus(copperPlateCostYen).toString(),
    smallWidthTier: false,
    smallWidthManufacturerUnitPriceKRWPerM: "0",
    filmCostPerPieceYen: quantity.gt(0) ? filmCostYen.div(quantity).toString() : "0",
    copperPlateCostPerPieceYen: quantity.gt(0) ? copperPlateCostYen.div(quantity).toString() : "0",
    recommendedQuantity: candidate.quantity,
    recommendedQuantityUtilization: approxLengthM.gt(0)
      ? requiredLengthM.div(approxLengthM).toString()
      : "0",
  };
}
