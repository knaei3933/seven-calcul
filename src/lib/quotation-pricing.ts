import type { CostResult } from "./calculation";
import { CONNECTED_FILLING_SURCHARGE } from "./constants";
import { ceilTo, D, Decimal } from "./decimal";

const FILM_METER_PRICE_MIN = D(380);
const FILM_METER_PRICE_MAX = D(480);
// グラビアの客提示フィルムm単価は90〜220円の帯に制限し、
// 帯によって生じる差額は充填・加工単価で補う。
export const GRAVURE_FILM_METER_PRICE_MIN = D(90);
export const GRAVURE_FILM_METER_PRICE_MAX = D(220);
export const COPPER_TARGET_MARGIN = D("0.10");

function recommendedFilmMeterUnit(orderLength: Decimal) {
  if (orderLength.gte(1500)) return D(380);
  if (orderLength.gte(1000)) return D(410);
  if (orderLength.gte(500)) return D(450);
  return D(480);
}

function clampFilmMeterUnit(value: Decimal) {
  return Decimal.min(FILM_METER_PRICE_MAX, Decimal.max(FILM_METER_PRICE_MIN, value));
}

export function clampGravureFilmMeterUnit(value: Decimal) {
  return Decimal.min(GRAVURE_FILM_METER_PRICE_MAX, Decimal.max(GRAVURE_FILM_METER_PRICE_MIN, value));
}

export type AutomaticQuotationTotals = {
  quantity: Decimal;
  margin: Decimal;
  taxRate: Decimal;
  fillingCostPerPiece: Decimal;
  processingCostPerPiece: Decimal;
  bulkCostPerPiece: Decimal;
  copperCostPerPiece: Decimal;
  filmCostPerPiece: Decimal;
  customLotCost: Decimal;
  customQuantity: Decimal;
  customSaleTotal: Decimal;
  customSalePerPiece: Decimal;
  totalCostPerPiece: Decimal;
  copperColorCount: Decimal;
  fillingSellingUnit: Decimal;
  bulkSellingUnit: Decimal;
  copperSellingUnit: Decimal;
  filmSellingUnit: Decimal;
  customUnit: Decimal;
  pricePerPiece: Decimal;
  filmOrderLength: Decimal;
  filmMeterPrice: Decimal;
  roundingAdjustment: Decimal;
  fillingAmount: Decimal;
  bulkAmount: Decimal;
  copperAmount: Decimal;
  subtotal: Decimal;
  tax: Decimal;
  grandTotal: Decimal;
  display: {
    pricePerPiece: string;
    fillingUnit: string;
    fillingAmount: string;
    bulkUnit: string;
    bulkAmount: string;
    copperUnit: string;
    copperAmount: string;
    copperColorCount: string;
    copperColorUnit: string;
    customUnit: string;
    customAmount: string;
    customQuantity: string;
    filmUnit: string;
    filmPouchUnit: string;
    filmAmount: string;
    filmOrderLength: string;
    adjustment: string;
    subtotal: string;
    tax: string;
    grandTotal: string;
  };
};

export function calculateAutomaticQuotation(
  result: CostResult,
  targetMargin: string,
  taxRatePercent = "10",
): AutomaticQuotationTotals | null {
  const quantity = D(result.quantity);
  const margin = D(targetMargin);
  const taxRate = D(taxRatePercent).div(100);
  if (quantity.lte(0) || margin.lte(0) || margin.gte(1) || taxRate.lt(0)) return null;

  const customQuantity = D(1);
  const fillingCostPerPiece = D(result.costPerPieceComponents.bulk)
    .plus(result.costPerPieceComponents.variableProcessing)
    .plus(result.costPerPieceComponents.fixedLot);
  const processingCostPerPiece = D(result.costPerPieceComponents.variableProcessing)
    .plus(result.costPerPieceComponents.fixedLot);
  const bulkCostPerPiece = D(result.costPerPieceComponents.bulk);
  // 見積の充填・加工単価は「1連相当の充填原価」に連結加算率（2連+20%、3連/4連+80%）を
  // 適用した値を基準に計算する。検品の連結室ぶんは原価側（fillingCostPerPiece）に反映する。
  const connectedFillingSurcharge = D(CONNECTED_FILLING_SURCHARGE[result.connectedChambers] ?? "0");
  // 加算率（2連+20%／3連/4連+80%）の倍率を厳密に保つため、
  // 中間基準値は丸めず最終表示単価（小数第1位切り上げ）で丸める。
  // 基本額は 1連基準 × 連結室数（2連なら6+6=12円）、その基本額に加算率を乗じる。
  // 充填・加工はバルクを除いた「1連基準の加工原価 × 連結室数」に加算率を乗じる。
  // バルクは当社販売時のみ別ラインで計上する（客給時は原価0＝ラインなし）。
  const pricingFillingCostPerPiece = result.singleConnectedProcessingCostPerPiece
    ? D(result.singleConnectedProcessingCostPerPiece)
      .times(D(result.connectedChambers))
      .times(D(1).plus(connectedFillingSurcharge))
    : processingCostPerPiece;
  const customLotCost = D(result.customCharge);
  const copperCostPerPiece = D(result.copperPlateCostPerPiece);
  const filmCostPerPiece = D(result.costPerPieceComponents.film);
  const totalCostPerPiece = D(result.totalCostPerPiece);
  const filmOrderLength = D(result.film.orderLengthM);
  const copperColorCount = D(result.gravure?.copperPlateCount ?? 1);

  const fillingSellingUnit = pricingFillingCostPerPiece.div(D(1).minus(margin));
  const bulkSellingUnit = bulkCostPerPiece.div(D(1).minus(margin));
  const copperSellingUnit = copperCostPerPiece.div(D(1).minus(COPPER_TARGET_MARGIN));
  const filmSellingUnit = filmCostPerPiece.div(D(1).minus(margin));
  const customSaleBase = customLotCost.div(customQuantity).div(D(1).minus(margin));
  const customUnit = ceilTo(customSaleBase, 1000);
  const customSaleTotal = customUnit.times(customQuantity);
  const customSalePerPiece = customSaleTotal.div(quantity);

  const pricePerPiece = fillingSellingUnit
    .plus(bulkSellingUnit)
    .plus(copperSellingUnit)
    .plus(filmSellingUnit)
    .plus(customSalePerPiece);
  const subtotalBeforeAdjustment = pricePerPiece.times(quantity);
  const idealSubtotal = subtotalBeforeAdjustment.floor();
  const roundingAdjustment = idealSubtotal.minus(subtotalBeforeAdjustment);
  const tax = idealSubtotal.times(taxRate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const grandTotal = idealSubtotal.plus(tax);

  // 見積単価（充填・加工／フィルムm単価）は小数第1位で切り上げる。
  const roundUnit = (value: Decimal) => value.toDecimalPlaces(1, Decimal.ROUND_UP);
  const targetTotal = pricePerPiece.times(quantity);
  const copperColorUnit = copperColorCount.gt(0)
    ? copperSellingUnit.times(quantity).div(copperColorCount).toDecimalPlaces(0, Decimal.ROUND_CEIL)
    : D(0);
  const copperAmount = copperColorUnit.times(copperColorCount);
  const isGravure = Boolean(result.gravure);

  let fillingUnit: Decimal;
  let filmMeterUnit: Decimal;
  // バルク販売単価＝バルク原価÷(1−利益率)。原価0（客給）なら0のまま表示しない。
  const bulkUnit = roundUnit(bulkSellingUnit);
  const bulkAmount = bulkUnit.times(quantity);
  if (isGravure) {
    const provisionalFillingUnit = pricingFillingCostPerPiece.div(D(1).minus(margin));
    const provisionalFilmAmount = Decimal.max(
      targetTotal.minus(provisionalFillingUnit.times(quantity)).minus(bulkAmount).minus(copperAmount),
      0,
    );
    const residualMeterUnit = filmOrderLength.gt(0)
      ? provisionalFilmAmount.div(filmOrderLength)
      : D(0);
    filmMeterUnit = clampGravureFilmMeterUnit(residualMeterUnit).toDecimalPlaces(1, Decimal.ROUND_UP);
    const bandedFilmAmount = filmMeterUnit.times(filmOrderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    // フィルムm単価を90〜220円の帯へ制限したことで生じた差額は充填・加工で補う。
    fillingUnit = quantity.gt(0)
      ? roundUnit(Decimal.max(targetTotal.minus(bandedFilmAmount).minus(bulkAmount).minus(copperAmount), 0).div(quantity))
      : D(0);
  } else {
    filmMeterUnit = clampFilmMeterUnit(recommendedFilmMeterUnit(filmOrderLength));
    const filmBaseAmount = filmMeterUnit.times(filmOrderLength);
    const remainingFillingAmount = Decimal.max(
      targetTotal.minus(filmBaseAmount).minus(bulkAmount).minus(copperAmount),
      0,
    );
    fillingUnit = quantity.gt(0)
      ? roundUnit(remainingFillingAmount.div(quantity))
      : D(0);
  }

  const filmAmount = filmMeterUnit.times(filmOrderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const fillingAmount = fillingUnit.times(quantity);
  const customAmount = customUnit.times(customQuantity);
  const filmPouchUnit = quantity.gt(0) ? filmAmount.div(quantity) : D(0);
  const lineTotal = fillingAmount.plus(bulkAmount).plus(filmAmount).plus(copperAmount).plus(customAmount);
  const displayedTax = lineTotal.times(taxRate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const displayedGrandTotal = lineTotal.plus(displayedTax);
  const displayedPricePerPiece = quantity.gt(0) ? lineTotal.div(quantity) : D(0);

  return {
    quantity,
    margin,
    taxRate,
    fillingCostPerPiece,
    copperCostPerPiece,
    filmCostPerPiece,
    customLotCost,
    customQuantity,
    customSaleTotal,
    customSalePerPiece,
    totalCostPerPiece,
    copperColorCount,
    fillingSellingUnit,
    bulkSellingUnit,
    processingCostPerPiece,
    bulkCostPerPiece,
    copperSellingUnit,
    filmSellingUnit,
    customUnit,
    pricePerPiece: displayedPricePerPiece,
    filmOrderLength,
    filmMeterPrice: D(result.film.unitPrice),
    roundingAdjustment: lineTotal.minus(subtotalBeforeAdjustment),
    fillingAmount,
    bulkAmount,
    copperAmount,
    subtotal: lineTotal,
    tax: displayedTax,
    grandTotal: displayedGrandTotal,
    display: {
      pricePerPiece: displayedPricePerPiece.toString(),
      fillingUnit: fillingUnit.toString(),
      fillingAmount: fillingAmount.toString(),
      bulkUnit: bulkUnit.toString(),
      bulkAmount: bulkAmount.toString(),
      copperUnit: quantity.gt(0) ? copperAmount.div(quantity).toString() : "0",
      copperAmount: copperAmount.toString(),
      copperColorCount: copperColorCount.toString(),
      copperColorUnit: copperColorUnit.toString(),
      customUnit: customUnit.toString(),
      customAmount: customAmount.toString(),
      customQuantity: customQuantity.toString(),
      filmUnit: filmMeterUnit.toString(),
      filmPouchUnit: filmPouchUnit.toString(),
      filmAmount: filmAmount.toString(),
      filmOrderLength: filmOrderLength.toString(),
      adjustment: "-",
      subtotal: lineTotal.toString(),
      tax: displayedTax.toString(),
      grandTotal: displayedGrandTotal.toString(),
    },
  };
}
