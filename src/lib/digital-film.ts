import { D, Decimal, ceilTo, sum } from "./decimal";
import type { CostParameters } from "./types";

export interface FilmSkuOrderInput {
  skuCode: string;
  requiredLengthM: string;
}

export interface FilmSkuOrder {
  skuCode: string;
  requiredLengthM: string;
  orderLengthM: string;
}

export interface DigitalFilmCorrection {
  kind: "raise_each_sku_to_minimum" | "consolidate_skus" | "minimum_viable_allocation";
  suggestedLengthsM: string[];
  message: string;
}

export interface DigitalFilmValidation {
  valid: boolean;
  reason?: "total_min" | "sku_min";
  totalM: string;
  orderLengths: FilmSkuOrder[];
  shortSkus?: string[];
  corrections: DigitalFilmCorrection[];
}

const round100 = (value: Decimal | string | number): Decimal => ceilTo(value.toString(), 100);

export function normalizeDigitalFilmOrder(skus: FilmSkuOrderInput[], params: CostParameters): { orders: FilmSkuOrder[]; adjustment: FilmOrderAdjustment } {
  if (skus.length === 0) throw validationError("digital_film_skus_required");
  const rounded = skus.map((sku) => {
    const required = D(sku.requiredLengthM);
    if (required.lte(0)) throw validationError("digital_film_positive_length_required");
    return { ...sku, requiredLengthM: required.toString(), orderLengthM: round100(required).toString() };
  });
  const minTotal = D(params.digitalFilmMinTotalM);
  const minSku = D(params.digitalFilmMinSkuM);
  const raised = rounded.map((sku) => ({ ...sku, orderLengthM: Decimal.max(D(sku.orderLengthM), minSku).toString() }));
  let adjusted = raised.map((sku) => ({ ...sku }));
  const raisedTotal = sum(adjusted.map((sku) => D(sku.orderLengthM)));
  if (raisedTotal.lt(minTotal)) {
    adjusted = minimumViable(adjusted.map((sku) => D(sku.orderLengthM)), minTotal).map((orderLengthM, index) => ({ ...adjusted[index], orderLengthM: orderLengthM.toString() }));
  }
  const orderLengths = adjusted.map((sku) => D(sku.orderLengthM));
  const total = sum(orderLengths);
  const changed = adjusted.some((sku, index) => !D(sku.orderLengthM).eq(rounded[index].orderLengthM));
  const adjustment: FilmOrderAdjustment = !changed ? "none" : raisedTotal.lt(minTotal) ? "minimum_total_allocation" : "minimum_sku_allocation";
  return { orders: adjusted, adjustment };
}

export type FilmOrderAdjustment = "none" | "minimum_sku_allocation" | "minimum_total_allocation";

export function validateDigitalFilmOrder(skus: FilmSkuOrderInput[], params: CostParameters): DigitalFilmValidation {
  if (skus.length === 0) throw validationError("digital_film_skus_required");

  const orderLengths = skus.map((sku) => {
    const required = D(sku.requiredLengthM);
    if (required.lte(0)) throw validationError("digital_film_positive_length_required");
    return { ...sku, orderLengthM: round100(required).toString() };
  });
  const total = sum(orderLengths.map((sku) => sku.orderLengthM));
  const minTotal = D(params.digitalFilmMinTotalM);
  const minSku = D(params.digitalFilmMinSkuM);
  const shortSkus = orderLengths.filter((sku) => D(sku.orderLengthM).lt(minSku));
  if (total.lt(minTotal)) {
    return { valid: false, reason: "total_min", totalM: total.toString(), orderLengths, corrections: corrections(orderLengths, params, minTotal, minSku) };
  }
  if (shortSkus.length > 0) {
    return { valid: false, reason: "sku_min", totalM: total.toString(), orderLengths, shortSkus: shortSkus.map((sku) => sku.skuCode), corrections: corrections(orderLengths, params, minTotal, minSku) };
  }
  return { valid: true, totalM: total.toString(), orderLengths, corrections: [] };
}

function corrections(orderLengths: FilmSkuOrder[], params: CostParameters, minTotal: Decimal, minSku: Decimal): DigitalFilmCorrection[] {
  const raised = orderLengths.map((sku) => Decimal.max(D(sku.requiredLengthM), minSku));
  const raisedTotal = sum(raised);
  if (raisedTotal.gte(minTotal)) {
    return [{ kind: "raise_each_sku_to_minimum", suggestedLengthsM: raised.map(String), message: "各SKUを300m以上に切り上げます。" }];
  }
  return [
    { kind: "minimum_viable_allocation", suggestedLengthsM: minimumViable(raised, minTotal).map(String), message: "合計500mを満たす最小発注配分案です。" },
    { kind: "consolidate_skus", suggestedLengthsM: [Decimal.max(minTotal, raisedTotal).toString()], message: "SKU統合または再割当てを検討してください。" },
  ];
}

function minimumViable(lengths: Decimal[], minTotal: Decimal): Decimal[] {
  const raised = [...lengths];
  const total = sum(raised);
  if (total.gte(minTotal)) return raised;
  const index = raised.reduce((largest, value, i) => (value.gt(raised[largest]) ? i : largest), 0);
  raised[index] = raised[index].plus(minTotal.minus(total));
  return raised;
}

export function digitalFilmCorrectionApplies(input: FilmSkuOrderInput[], params: CostParameters, suggestedLengthsM: string[]): boolean {
  const normalized = suggestedLengthsM.map((value) => round100(value));
  return normalized.length === input.length && normalized.every((value, index) => value.eq(round100(input[index].requiredLengthM)));
}

export class QuotationValidationError extends Error {
  readonly code: string;
  readonly digitalValidation?: DigitalFilmValidation;
  constructor(code: string, digitalValidation?: DigitalFilmValidation) {
    super(code);
    this.code = code;
    this.digitalValidation = digitalValidation;
    this.name = "QuotationValidationError";
  }
}

const validationError = (code: string): QuotationValidationError => new QuotationValidationError(code);
