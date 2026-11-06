// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerApprovalClient from "@/app/quote-approvals/[token]/approval-client";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";

const owner = quotationOwnerProfile("kanei")!;

function approvalPayload() {
  return {
    quotation: {
      quotationNumber: "KT-APPROVAL-BRAND-001",
      customerName: "Approval Customer",
      productName: "Approval Pouch",
      sizeSummary: "50×90mm / 1連",
      quantity: "1000",
      grandTotal: "11000",
      validUntil: "2099-12-31",
      status: "sent",
      approvedAt: null,
      customerApprovalRecorded: false,
      owner,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(approvalPayload())));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("customer approval page branding", () => {
  it("renders logo, company, contact, footer, and approval labels from quote owner", async () => {
    render(<CustomerApprovalClient token="token" />);
    await waitFor(() => expect(screen.getByTestId("approval-owner-brand")).toBeInTheDocument());
    expect(screen.getByTestId("approval-owner-logo")).toHaveAttribute("src", owner.logoUrl);
    expect(screen.getByTestId("approval-owner-brand")).toHaveTextContent(owner.legalName);
    expect(screen.getByTestId("approval-owner-brand")).toHaveTextContent(owner.brandLabel);
    expect(screen.getByTestId("approval-owner-intro")).toHaveTextContent("金井貿易");
    expect(screen.getByRole("button", { name: owner.approvalActionLabel })).toBeInTheDocument();
    expect(screen.getByTestId("approval-owner-footer")).toHaveTextContent(owner.address);
    expect(screen.getByTestId("approval-owner-footer")).toHaveTextContent(owner.defaultContactEmail);
    expect(screen.getByTestId("approval-owner-footer")).toHaveTextContent("金井貿易");
  });
});
