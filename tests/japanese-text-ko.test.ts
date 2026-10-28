import { describe, expect, it } from "vitest";
import { japaneseDisplayNameKo, japaneseDisplayNameKoWithSource, registeredJapaneseDisplayNameKo } from "@/lib/japanese-text-ko";

describe("Japanese display-name localization for Korean partners", () => {
  it("uses registered Korean names when available", () => {
    expect(japaneseDisplayNameKo("レディエイドルプリカント")).toBe("레디에이돌 프리칸트");
    expect(japaneseDisplayNameKo("株式会社フォーライフ")).toBe("주식회사 포라이프");
  });

  it("keeps the source text alongside a best-effort Korean reading", () => {
    expect(japaneseDisplayNameKoWithSource("レディエイドルプリカント"))
      .toBe("레디에이돌 프리칸트（원문: レディエイドルプリカント）");
    expect(japaneseDisplayNameKoWithSource("テストパウチ")).toContain("원문: テストパウチ");
  });

  it("does not put an unregistered best-effort reading into subjects", () => {
    expect(registeredJapaneseDisplayNameKo("トークン検証パウチ")).toBe("トークン検証パウチ");
    expect(registeredJapaneseDisplayNameKo("테스트 파우치")).toBe("테스트 파우치");
  });

  it("returns Korean text unchanged", () => {
    expect(japaneseDisplayNameKoWithSource("테스트 파우치")).toBe("테스트 파우치");
  });
});
