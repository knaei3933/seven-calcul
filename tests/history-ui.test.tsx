import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HistoryClient from "@/app/history/history-client";
import type { AuthenticatedUser } from "@/lib/auth-store";
import type { QuotationRecord } from "@/lib/quotation-shared";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const currentUser: AuthenticatedUser = {
  id: 2,
  email: "editor@history.test",
  name: "Editor",
  role: "user",
  isActive: true,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  sessionId: 1,
};

function record(id: number, number: string, creator: { id: number; email: string; name: string }): QuotationRecord {
  return {
    id,
    quotationNumber: number,
    status: "draft",
    issueDate: "2026-09-20",
    validUntil: "2026-10-20",
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
    createdAt: "2026-09-20T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    createdBy: creator,
    updatedBy: null,
  };
}

const adminRecord = record(1, "S7-HISTORY-ADMIN", { id: 1, email: "admin@history.test", name: "Admin" });
const ownerRecord = record(2, "S7-HISTORY-OWNER", { id: 2, email: currentUser.email, name: currentUser.name });

describe("quotation history ownership UI", () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(cleanup);

  it("shows creator identity, filters by creator, and disables unauthorized controls", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      const selected = target.includes("creatorId=1") ? [adminRecord] : [adminRecord, ownerRecord];
      return Response.json({ records: selected }, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<HistoryClient currentUser={currentUser} />);

    await screen.findByText("Admin");
    await screen.findByText("admin@history.test");
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("admin@history.test")).toBeInTheDocument();
    expect(screen.getByLabelText("S7-HISTORY-ADMIN の状態")).toBeDisabled();
    const deleteButtons = screen.getAllByRole("button", { name: "削除" });
    expect(deleteButtons[0]).toBeDisabled();
    expect(deleteButtons[1]).toBeEnabled();

    await user.selectOptions(screen.getByTestId("history-creator"), "1");
    await waitFor(() => expect(screen.queryByText("S7-HISTORY-OWNER")).not.toBeInTheDocument());
    expect(screen.getByRole("option", { name: "Editor（editor@history.test）" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("creatorId=1"), { cache: "no-store" });
    vi.unstubAllGlobals();
  });
});
