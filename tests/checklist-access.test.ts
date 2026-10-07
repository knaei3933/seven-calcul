import { describe, expect, it } from "vitest";
import { canViewInternalChecklist } from "@/lib/checklist-access";

describe("internal (Kanei Trade) checklist access", () => {
  it("allows Kanei Trade addresses regardless of case or whitespace", () => {
    expect(canViewInternalChecklist("kim@kanei-trade.co.jp")).toBe(true);
    expect(canViewInternalChecklist("  KIM@KANEI-TRADE.CO.JP ")).toBe(true);
    expect(canViewInternalChecklist("new.member@kanei-trade.co.jp")).toBe(true);
  });

  it("rejects other domains and empty values", () => {
    expect(canViewInternalChecklist("gotou@727.co.jp")).toBe(false);
    expect(canViewInternalChecklist("narimiya@727.co.jp")).toBe(false);
    expect(canViewInternalChecklist("fake@kanei-trade.co.jp.evil.example")).toBe(false);
    expect(canViewInternalChecklist("")).toBe(false);
    expect(canViewInternalChecklist(null)).toBe(false);
    expect(canViewInternalChecklist(undefined)).toBe(false);
  });
});
