import { describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@/lib/auth-store";
import type { ResolvedQuoteOwnerDomain } from "@/lib/quote-owner-profiles";

const userFixture = vi.fn();
const nextNumber = vi.fn(async (ownerDomain: ResolvedQuoteOwnerDomain) => `${ownerDomain === "kanei" ? "KT" : "S7"}-TEST-001`);
const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
let userId = 0;

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/page-auth", () => ({ requirePageUser: () => userFixture() }));
vi.mock("@/lib/quotation-store", () => ({ getNextQuotationNumber: nextNumber }));
vi.mock("@/lib/approver-display-name", () => ({ approverDisplayName: (user: PublicUser) => user.name }));
const QuoteServerPage = (await import("@/app/quote/page")).default;

function user(email: string, role: "admin" | "user" = "user"): PublicUser {
  return {
    id: ++userId,
    email,
    name: email,
    role,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("quote page owner routing", () => {
  it("uses Seven and S7 for Seven Chemical users", async () => {
    userFixture.mockResolvedValueOnce(user("gotou@727.co.jp"));
    const element = await QuoteServerPage() as { props: { ownerDomain: ResolvedQuoteOwnerDomain; initialQuotationNumber: string } };
    expect(nextNumber).toHaveBeenCalledWith("seven");
    expect(element.props).toMatchObject({ ownerDomain: "seven", initialQuotationNumber: "S7-TEST-001" });
  });

  it("uses Kanei and KT for Kanei Trade users", async () => {
    userFixture.mockResolvedValueOnce(user("info@kanei-trade.co.jp"));
    const element = await QuoteServerPage() as { props: { ownerDomain: ResolvedQuoteOwnerDomain; initialQuotationNumber: string } };
    expect(nextNumber).toHaveBeenCalledWith("kanei");
    expect(element.props).toMatchObject({ ownerDomain: "kanei", initialQuotationNumber: "KT-TEST-001" });
  });

  it("fails closed for an unresolved company domain", async () => {
    const callsBefore = nextNumber.mock.calls.length;
    userFixture.mockResolvedValueOnce(user("info@example.test"));
    await expect(QuoteServerPage()).rejects.toThrow("NEXT_REDIRECT:/history");
    expect(nextNumber).toHaveBeenCalledTimes(callsBefore);
    expect(redirect).toHaveBeenCalledWith("/history");
  });
});
