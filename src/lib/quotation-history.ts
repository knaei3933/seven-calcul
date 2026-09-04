import { D, type Decimal } from "./decimal";
import { DEFAULT_FILM_COMPOSITION } from "./quotation-shared";
import type { QuotationRecord } from "./quotation-shared";

const storedNumber = (value: unknown): Decimal => {
  const numeric = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(numeric) ? D(numeric) : D(0);
};

const editedNumber = (value: unknown): Decimal | null => {
  if (typeof value !== "string" || value.trim() === "") return null;
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) ? D(numeric) : null;
};

const positiveNumber = (value: unknown): Decimal | null => {
  const numeric = editedNumber(value);
  return numeric && numeric.gt(0) ? numeric : null;
};

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.trim() !== "" ? value : fallback;

export function filmCompositionOf(record: QuotationRecord): string {
  return text(record.payload.filmComposition, DEFAULT_FILM_COMPOSITION);
}

export function analyzeQuotation(record: QuotationRecord) {
  const payload = record.payload;
  const quantity = storedNumber(payload.quantity ?? record.quantity);
  const fillingCostUnit = storedNumber(payload.fillingCostPerPiece ?? record.fillingCostPerPiece);
  const filmCostUnit = storedNumber(payload.filmCostPerPiece ?? record.filmCostPerPiece);
  const costUnit = fillingCostUnit.plus(filmCostUnit);

  const targetMargin = positiveNumber(payload.targetMargin ?? record.targetMargin) ?? D(0);
  const marginDivider = D(1).minus(targetMargin.lt(1) ? targetMargin : D(0));
  const targetFillingUnit = fillingCostUnit.div(marginDivider);
  const targetFilmUnit = filmCostUnit.div(marginDivider);

  const fillingUnit = editedNumber(payload.fillingUnitDisplay) ?? targetFillingUnit;
  const filmUnit = editedNumber(payload.filmPouchUnitDisplay) ?? targetFilmUnit;
  const displayedCostUnit = fillingUnit.plus(filmUnit);
  const sellingUnit = editedNumber(payload.pricePerPieceDisplay) ?? displayedCostUnit;
  const profitUnit = sellingUnit.minus(costUnit);
  const profitRate = sellingUnit.gt(0) ? profitUnit.div(sellingUnit).times(100) : D(0);
  const markupRate = costUnit.gt(0) ? profitUnit.div(costUnit).times(100) : D(0);
  const totalRevenue = sellingUnit.times(quantity);
  const totalProfit = profitUnit.times(quantity);

  const beforeAdjustment = sellingUnit.times(quantity);
  const automaticSubtotal = beforeAdjustment.floor();
  const adjustment = editedNumber(payload.adjustmentDisplay) ?? automaticSubtotal.minus(beforeAdjustment);
  const subtotal = editedNumber(payload.subtotalDisplay) ?? automaticSubtotal;
  const taxRate = positiveNumber(payload.taxRatePercent ?? record.taxRatePercent) ?? D(0);
  const tax = editedNumber(payload.taxDisplay) ?? subtotal.times(taxRate.div(100)).toDecimalPlaces(0);
  const grandTotal = editedNumber(payload.grandTotalDisplay) ?? subtotal.plus(tax);

  const storedSellingUnit = storedNumber(record.pricePerPiece);
  const storedCostUnit = storedNumber(record.fillingCostPerPiece).plus(record.filmCostPerPiece);
  const storedProfitUnit = storedSellingUnit.minus(storedCostUnit);
  const storedProfitRate = storedSellingUnit.gt(0) ? storedProfitUnit.div(storedSellingUnit).times(100) : D(0);

  const overrides = [
    "fillingUnitDisplay", "fillingAmountDisplay", "filmUnitDisplay", "filmPouchUnitDisplay",
    "filmAmountDisplay", "adjustmentDisplay", "pricePerPieceDisplay", "subtotalDisplay",
    "taxDisplay", "grandTotalDisplay",
  ].filter((key) => editedNumber(payload[key]) !== null);

  return {
    quantity,
    fillingCostUnit,
    filmCostUnit,
    filmMeterPrice: storedNumber(payload.filmMeterPrice ?? record.filmMeterPrice),
    filmOrderLength: storedNumber(payload.filmOrderLengthM ?? record.filmOrderLengthM),
    costUnit,
    targetMargin,
    targetFillingUnit,
    targetFilmUnit,
    fillingUnit,
    filmUnit,
    fillingAmount: fillingUnit.times(quantity),
    filmAmount: filmUnit.times(quantity),
    sellingUnit,
    profitUnit,
    profitRate,
    markupRate,
    totalRevenue,
    totalProfit,
    adjustment,
    subtotal,
    taxRate,
    tax,
    grandTotal,
    storedSellingUnit,
    storedCostUnit,
    storedProfitUnit,
    storedProfitRate,
    overrideCount: overrides.length,
    overrides,
  };
}
