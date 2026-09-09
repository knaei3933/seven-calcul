import type { CostResult } from "./calculation";
import { ceilTo, D, Decimal } from "./decimal";

const FILM_METER_PRICE_MIN = D(380);
const FILM_METER_PRICE_MAX = D(480);

function recommendedFilmMeterUnit(orderLength: Decimal) {
  if (orderLength.gte(1500)) return D(380);
  if (orderLength.gte(1000)) return D(410);
  if (orderLength.gte(500)) return D(450);
  return D(480);
}

function clampFilmMeterUnit(value: Decimal) {
  return Decimal.min(FILM_METER_PRICE_MAX, Decimal.max(FILM_METER_PRICE_MIN, value));
}

export type AutomaticQuotationTotals = {
  quantity: Decimal;
  margin: Decimal;
  taxRate: Decimal;
  fillingCostPerPiece: Decimal;
  copperCostPerPiece: Decimal;
  filmCostPerPiece: Decimal;
  customLotCost: Decimal;
  customQuantity: Decimal;
  customSaleTotal: Decimal;
  customSalePerPiece: Decimal;
  totalCostPerPiece: Decimal;
  copperColorCount: Decimal;
  fillingSellingUnit: Decimal;
  copperSellingUnit: Decimal;
  filmSellingUnit: Decimal;
  customUnit: Decimal;
  pricePerPiece: Decimal;
  filmOrderLength: Decimal;
  filmMeterPrice: Decimal;
  roundingAdjustment: Decimal;
  fillingAmount: Decimal;
  copperAmount: Decimal;
  subtotal: Decimal;
  tax: Decimal;
  grandTotal: Decimal;
  display: {
    pricePerPiece: string;
    fillingUnit: string;
    fillingAmount: string;
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
  const customLotCost = D(result.customCharge);
  const copperCostPerPiece = D(result.copperPlateCostPerPiece);
  const filmCostPerPiece = D(result.costPerPieceComponents.film);
  const totalCostPerPiece = D(result.totalCostPerPiece);
  const filmOrderLength = D(result.film.orderLengthM);
  const copperColorCount = D(result.gravure?.copperPlateCount ?? 1);

  const fillingSellingUnit = fillingCostPerPiece.div(D(1).minus(margin));
  const copperSellingUnit = copperCostPerPiece.div(D(1).minus(margin));
  const filmSellingUnit = filmCostPerPiece.div(D(1).minus(margin));
  const customSaleBase = customLotCost.div(customQuantity).div(D(1).minus(margin));
  const customUnit = ceilTo(customSaleBase, 1000);
  const customSaleTotal = customUnit.times(customQuantity);
  const customSalePerPiece = customSaleTotal.div(quantity);

  const pricePerPiece = fillingSellingUnit
    .plus(copperSellingUnit)
    .plus(filmSellingUnit)
    .plus(customSalePerPiece);
  const subtotalBeforeAdjustment = pricePerPiece.times(quantity);
  const idealSubtotal = subtotalBeforeAdjustment.floor();
  const roundingAdjustment = idealSubtotal.minus(subtotalBeforeAdjustment);
  const tax = idealSubtotal.times(taxRate).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  const grandTotal = idealSubtotal.plus(tax);

  const roundUnit = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_UP);
  const targetTotal = pricePerPiece.times(quantity);
  const copperColorUnit = copperColorCount.gt(0)
    ? copperSellingUnit.times(quantity).div(copperColorCount).toDecimalPlaces(0, Decimal.ROUND_CEIL)
    : D(0);
  const copperAmount = copperColorUnit.times(copperColorCount);
  const isGravure = Boolean(result.gravure);

  let fillingUnit: Decimal;
  let filmMeterUnit: Decimal;
  if (isGravure) {
    fillingUnit = roundUnit(fillingCostPerPiece.div(D(1).minus(margin)));
    const residualFilmAmount = Decimal.max(
      targetTotal.minus(fillingUnit.times(quantity)).minus(copperAmount),
      0,
    );
    filmMeterUnit = filmOrderLength.gt(0)
      ? residualFilmAmount.div(filmOrderLength).toDecimalPlaces(2, Decimal.ROUND_UP)
      : D(0);
  } else {
    filmMeterUnit = clampFilmMeterUnit(recommendedFilmMeterUnit(filmOrderLength));
    const filmBaseAmount = filmMeterUnit.times(filmOrderLength);
    const remainingFillingAmount = Decimal.max(
      targetTotal.minus(filmBaseAmount).minus(copperAmount),
      0,
    );
    fillingUnit = quantity.gt(0)
      ? roundUnit(remainingFillingAmount.div(quantity))
      : D(0);
  }

  const filmAmount = filmMeterUnit.times(filmOrderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (filmOrderLength.gt(0)) filmMeterUnit = filmAmount.div(filmOrderLength);
  const fillingAmount = fillingUnit.times(quantity);
  const customAmount = customUnit.times(customQuantity);
  const filmPouchUnit = quantity.gt(0) ? filmAmount.div(quantity) : D(0);
  const lineTotal = fillingAmount.plus(filmAmount).plus(copperAmount).plus(customAmount);
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
    copperSellingUnit,
    filmSellingUnit,
    customUnit,
    pricePerPiece,
    filmOrderLength,
    filmMeterPrice: D(result.film.unitPrice),
    roundingAdjustment,
    fillingAmount: fillingSellingUnit.times(quantity),
    copperAmount: copperSellingUnit.times(quantity),
    subtotal: lineTotal,
    tax: displayedTax,
    grandTotal: displayedGrandTotal,
    display: {
      pricePerPiece: displayedPricePerPiece.toString(),
      fillingUnit: fillingUnit.toString(),
      fillingAmount: fillingAmount.toString(),
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
