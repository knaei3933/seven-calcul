import { describe, expect, it } from "vitest";
import { formatCurrency, formatNumber } from "@/lib/serialization";

describe("display serialization", () => {
  it("rounds displayed values upward to at most two decimal places", () => {
    expect(formatCurrency("1.234", 4)).toBe("￥1.24");
    expect(formatNumber("12.345", 3)).toBe("12.35");
    expect(formatNumber("12", 4)).toBe("12");
  });
});
