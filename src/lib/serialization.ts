export function formatCurrency(value: string | number, digits = 2): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: digits }).format(number);
}

export function formatNumber(value: string | number, digits = 2): string {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "-";
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(number);
}
