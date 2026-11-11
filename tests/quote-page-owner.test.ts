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
  it("uses Seven ownership and the Seven user's mail", async () => {
    userFixture.mockResolvedValueOnce(user("gotou@727.co.jp"));
    const element = await QuoteServerPage() as { props: {
      ownerDomain: ResolvedQuoteOwnerDomain;
      initialQuotationNumber: string;
      issuerContact: { companyName: string; contactName: string; email: string };
    } };
    expect(nextNumber).toHaveBeenCalledWith("seven");
    expect(element.props).toMatchObject({ ownerDomain: "seven", initialQuotationNumber: "S7-TEST-001" });
    expect(element.props.issuerContact).toMatchObject({
      companyName: "株式会社セブン化学",
      contactName: "gotou@727.co.jp",
      email: "gotou@727.co.jp",
    });
  });

  it("keeps Seven ownership but switches Kanei contact mail to shapepouch", async () => {
    userFixture.mockResolvedValueOnce(user("info@kanei-trade.co.jp"));
    const element = await QuoteServerPage() as { props: {
      ownerDomain: ResolvedQuoteOwnerDomain;
      initialQuotationNumber: string;
      issuerContact: { companyName: string; contactName: string; email: string };
    } };
    expect(nextNumber).toHaveBeenCalledWith("seven");
    expect(element.props).toMatchObject({ ownerDomain: "seven", initialQuotationNumber: "S7-TEST-001" });
    expect(element.props.issuerContact).toMatchObject({
      companyName: "株式会社セブン化学",
      contactName: "info@kanei-trade.co.jp",
      email: "shapepouch@package-lab.com",
    });
  });

  it("uses Seven ownership even for an unresolved authenticated domain", async () => {
    const callsBefore = nextNumber.mock.calls.length;
    userFixture.mockResolvedValueOnce(user("info@example.test"));
    const element = await QuoteServerPage() as { props: {
      ownerDomain: ResolvedQuoteOwnerDomain;
      initialQuotationNumber: string;
      issuerContact: { companyName: string; contactName: string; email: string };
    } };
    expect(nextNumber).toHaveBeenCalledTimes(callsBefore + 1);
    expect(element.props).toMatchObject({ ownerDomain: "seven", initialQuotationNumber: "S7-TEST-001" });
    expect(element.props.issuerContact.email).toBe("info@example.test");
    expect(redirect).not.toHaveBeenCalled();
  });
});
