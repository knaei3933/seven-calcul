import { D, Decimal, parseDecimal } from "./decimal";

export function formatCurrency(value: string | number, digits = 2): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "-";
  const displayDigits = Math.min(Math.max(digits, 0), 2);
  const rounded = D(typeof value === "string" && value.trim() === "" ? 0 : parseDecimal(value) ?? number)
    .toDecimalPlaces(displayDigits, Decimal.ROUND_UP).toNumber();
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: displayDigits }).format(rounded);
}

export function formatNumber(value: string | number, digits = 2): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "-";
  const displayDigits = Math.min(Math.max(digits, 0), 2);
  const rounded = D(typeof value === "string" && value.trim() === "" ? 0 : parseDecimal(value) ?? number)
    .toDecimalPlaces(displayDigits, Decimal.ROUND_UP).toNumber();
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: displayDigits }).format(rounded);
}
