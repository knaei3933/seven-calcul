import { describe, expect, it } from "vitest";
import { canonicalize } from "@/lib/canonical-json";

describe("canonical JSON", () => {
  it("emits finite numbers in plain decimal notation", () => {
    expect(canonicalize({ small: 1e-27, large: 1e30 })).toBe(
      '{"large":1000000000000000000000000000000,"small":0.000000000000000000000000001}',
    );
    expect(canonicalize([1e-7, -1.23e21])).toBe(
      '[0.0000001,-1230000000000000000000]',
    );
  });
});
