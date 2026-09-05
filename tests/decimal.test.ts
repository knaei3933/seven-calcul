import { describe, expect, it } from "vitest";
import { parseDecimal } from "@/lib/decimal";

describe("safe decimal parsing", () => {
  it("accepts finite decimal input and rejects invalid numeric strings", () => {
    expect(parseDecimal("12.34")?.toString()).toBe("12.34");
    expect(parseDecimal(0)?.toNumber()).toBe(0);
    expect(parseDecimal("0x10")).toBeNull();
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal(Number.NaN)).toBeNull();
    expect(parseDecimal(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseDecimal(null)).toBeNull();
    expect(parseDecimal(undefined)).toBeNull();
  });
});
