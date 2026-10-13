import { D } from "./decimal";

/** JSON.stringify switches to exponent notation outside safe-number formatting. */
function plainDecimal(value: string | number): string {
  return D(value).toFixed();
}

function normalizeDecimalStrings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDecimalStrings);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      return plainDecimal(value);
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeDecimalStrings(nested)]),
  );
}

function normalizeAndSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeAndSort);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, normalizeAndSort(nested)]),
  );
}

/** Canonical JSON: recursively code-unit-sorted object keys and normalized decimal strings. */
export function canonicalize(value: unknown): string {
  return serializeCanonical(normalizeAndSort(normalizeDecimalStrings(value)));
}

function serializeCanonical(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? plainDecimal(value) : "null";
  if (typeof value === "boolean" || value === null) return String(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  if (!value) return "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${serializeCanonical(nested)}`)
    .join(",")}}`;
}
