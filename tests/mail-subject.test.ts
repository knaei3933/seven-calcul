import { describe, expect, it } from "vitest";
import { withRecipientSubjectPrefix } from "@/lib/mail-subject";

describe("recipient subject prefix", () => {
  it("uses Seven labels by recipient domain and body locale", () => {
    expect(withRecipientSubjectPrefix({
      to: "buyer@727.co.jp",
      subject: "テスト",
      body: "日本語本文",
    })).toBe("[セブン化学]テスト");
    expect(withRecipientSubjectPrefix({
      to: "buyer@727.co.jp",
      subject: "테스트",
      body: "한국어 본문",
    })).toBe("[세븐화학]테스트");
  });

  it("uses Kanei labels and Korean supplier labels", () => {
    expect(withRecipientSubjectPrefix({
      to: "design@package-lab.com",
      subject: "テスト",
      body: "日本語本文",
    })).toBe("[金井貿易]テスト");
    expect(withRecipientSubjectPrefix({
      to: "supplier@example.co.kr",
      subject: "제작 요청",
      body: "한국어 본문",
    })).toBe("[세중산업/이패키지]제작 요청");
  });

  it("does not duplicate the same prefix", () => {
    expect(withRecipientSubjectPrefix({
      to: "customer@example.test",
      subject: "[お客様]テスト",
      body: "日本語本文",
    })).toBe("[お客様]テスト");
  });
});
