import DecimalConstructor from "decimal.js";

const Decimal = DecimalConstructor.clone({ precision: 40, rounding: DecimalConstructor.ROUND_HALF_UP });

export { Decimal };
export type Decimal = DecimalConstructor;

export const D = (value: DecimalValueInput): Decimal =>
  value instanceof Decimal ? value : new Decimal(value ?? 0);

export const parseDecimal = (value: unknown): Decimal | null => {
  if (value instanceof Decimal) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
};

export const sum = (values: DecimalValueInput[]): Decimal =>
  values.reduce<Decimal>((total, value) => total.plus(D(value)), D(0));

export const ceilTo = (value: DecimalValueInput, unit: DecimalValueInput): Decimal => {
  const amount = D(value);
  const step = D(unit);
  if (step.lte(0)) throw new Error("Ceiling unit must be positive");
  if (amount.lt(0)) throw new Error("Ceiling amount must not be negative");
  return amount.div(step).ceil().times(step);
};

export const roundTo2 = (value: DecimalValueInput): string => D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString();

export const maxD = (...values: DecimalValueInput[]): Decimal => values.reduce<Decimal>((a, b) => Decimal.max(a, D(b)), D(0));
export const eq = (a: DecimalValueInput, b: DecimalValueInput): boolean => D(a).eq(D(b));

type DecimalValueInput = string | number | DecimalConstructor.Instance | null | undefined;
