import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotePage from "@/app/quote/quote-client";
import HistoryClient from "@/app/history/history-client";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";
import type { AuthenticatedUser } from "@/lib/auth-store";
import type { QuotationOwnerDomain, QuotationRecord } from "@/lib/quotation-shared";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const kaneiProfile = quotationOwnerProfile("kanei")!;
const sevenProfile = quotationOwnerProfile("seven")!;

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ customers: [] })));
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })));
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("owner-aware quotation issuer branding", () => {
  it("uses Kanei defaults for a Kanei-owned quote", () => {
    render(<QuotePage ownerDomain="kanei" ownerProfile={kaneiProfile} />);
    const issuer = screen.getByTestId("issuer-party");
    expect(issuer).toHaveTextContent(kaneiProfile.legalName);
    expect(issuer).toHaveTextContent(kaneiProfile.englishName);
    expect(issuer).toHaveTextContent(kaneiProfile.address);
    expect(screen.getByTestId("quote-owner-logo")).toHaveAttribute("src", kaneiProfile.logoUrl);
  });

  it("uses Seven defaults for a Seven-owned quote", () => {
    render(<QuotePage ownerDomain="seven" ownerProfile={sevenProfile} />);
    const issuer = screen.getByTestId("issuer-party");
    expect(issuer).toHaveTextContent(sevenProfile.legalName);
    expect(issuer).toHaveTextContent(sevenProfile.englishName);
    expect(issuer).toHaveTextContent(sevenProfile.address);
    expect(screen.getByTestId("quote-owner-logo")).toHaveAttribute("src", sevenProfile.logoUrl);
  });

  it("enforces the owner document identity over stale issuer overrides", async () => {
    sessionStorage.setItem("pouch-active-quotation-revision-v1", JSON.stringify({
      form: {
        issuerName: "手入力発行者株式会社",
        issuerEnglishName: "USER OVERRIDE CO., LTD.",
      },
      sourceVersion: "",
    }));
    render(<QuotePage ownerDomain="kanei" ownerProfile={kaneiProfile} />);
    await waitFor(() => expect(screen.getByText(kaneiProfile.legalName)).toBeInTheDocument());
    expect(screen.getByText(kaneiProfile.englishName)).toBeInTheDocument();
    expect(screen.queryByText("手入力発行者株式会社")).not.toBeInTheDocument();
    expect(screen.queryByText("USER OVERRIDE CO., LTD.")).not.toBeInTheDocument();
  });

  it("blocks branding and issuance when the quote owner is unresolved", () => {
    render(<QuotePage ownerDomain="unresolved" ownerProfile={undefined} />);
    expect(screen.getByTestId("unresolved-quote-owner")).toHaveTextContent("unresolved_quote_owner");
    expect(screen.getByTestId("save-history")).toBeDisabled();
    expect(screen.getByTestId("print-pdf")).toBeDisabled();
  });

  it("selects history document ownership from the quote, not the current viewer", async () => {
    const viewer: AuthenticatedUser = {
      id: 99,
      email: "admin@example.test",
      name: "Cross Viewer",
      role: "admin",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessionId: 1,
    };
    const recordWithOwner = (id: number, ownerDomain: QuotationOwnerDomain): QuotationRecord => ({
      id,
      quotationNumber: `${ownerDomain.toUpperCase()}-OWNER-${id}`,
      ownerDomain,
      status: "draft",
      issueDate: "2026-11-04",
      validUntil: "2026-12-04",
      customerName: "History Test",
      customerContact: "Tester",
      productName: "History Pouch",
      sizeSummary: "50×90mm / 1連",
      quantity: "10000",
      fillingCostPerPiece: "4",
      filmCostPerPiece: "1",
      filmMeterPrice: "200",
      filmOrderLengthM: "500",
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "10",
      subtotal: "100000",
      tax: "10000",
      grandTotal: "110000",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: "manual-entry",
      resultHash: "",
      payload: {},
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      createdBy: viewer,
      updatedBy: null,
      internalApproval: null,
      customerApproval: null,
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      records: [recordWithOwner(1, "kanei"), recordWithOwner(2, "seven")],
    })));
    const user = userEvent.setup();
    render(<HistoryClient currentUser={viewer} />);
    const details = await screen.findAllByRole("button", { name: "詳細" });
    await user.click(details[0]!);
    await user.click(screen.getByRole("button", { name: "詳細データ" }));
    expect(await screen.findByTestId("history-quote-owner")).toHaveTextContent("KT");
    expect(screen.getByTestId("data-report-a4")).toHaveTextContent(kaneiProfile.legalName);
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    await user.click(details[1]!);
    await user.click(screen.getByRole("button", { name: "詳細データ" }));
    expect(await screen.findByTestId("history-quote-owner")).toHaveTextContent("S7");
    expect(screen.getByTestId("data-report-a4")).toHaveTextContent(sevenProfile.legalName);
  });
});
