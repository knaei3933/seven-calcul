import { describe, expect, it } from "vitest";
import { issuerContactForUser } from "@/lib/issuer-contact";

describe("issuer contact", () => {
  it("uses the Shape Pouch contact for Kim without a company line", () => {
    expect(issuerContactForUser({
      email: "kim@kanei-trade.co.jp",
      name: "Kim Admin",
    })).toEqual({
      companyName: "",
      contactName: "Kim Admin",
      email: "shapepouch@package-lab.com",
      telephone: "TEL 050-3613-9673",
    });
  });

  it("keeps standard Kanei contact details for other Kanei users", () => {
    expect(issuerContactForUser({
      email: "other@kanei-trade.co.jp",
      name: "Other",
    })).toEqual({
      companyName: "金井貿易株式会社",
      contactName: "Other",
      email: "other@kanei-trade.co.jp",
      telephone: "TEL 050-3613-9673",
    });
  });
});
