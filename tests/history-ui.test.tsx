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

  it("shows the film quotation alone without the internal profit summary", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/pdf")
        ? Response.json({ error: "pdf_not_found" }, { status: 404 })
        : Response.json({ records: [adminRecord] }, { status: 200 })
    )));
    const user = userEvent.setup();
    render(<HistoryClient currentUser={currentUser} />);

    await screen.findByText("S7-HISTORY-ADMIN");
    await user.click(screen.getAllByRole("button", { name: "詳細" })[0]);
    await user.click(screen.getByTestId("film-quote-tab"));

    expect(screen.getByText(/異形パウチ専用フィルム/)).toBeInTheDocument();
    expect(screen.getAllByText("History Test").length).toBeGreaterThan(0);
    expect(screen.queryByText("最終損益サマリー")).not.toBeInTheDocument();
    expect(screen.getByTestId("detail-print-current")).toHaveTextContent("フィルム見積書PDF");

    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: "詳細データ" }));
    expect(screen.getByTestId("data-report-a4")).toBeVisible();
    expect(screen.getByTestId("data-report-a4")).toHaveTextContent("内部管理用");
    expect(screen.getByTestId("detail-print-current")).toHaveTextContent("詳細データPDF");
    await user.click(screen.getByTestId("detail-print-current"));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    printSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("displays, downloads, and prints only the canonical stored quotation PDF", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x67, 0x30, 0x30, 0x34]);
    const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });
    const objectsByBlobUrl = new Map<string, Blob>();
    const createObjectUrl = vi.fn((blob: Blob) => {
      const url = `blob:stored-pdf-${objectsByBlobUrl.size + 1}`;
      objectsByBlobUrl.set(url, blob);
      return url;
    });
    const revokeObjectUrl = vi.fn();
    const MockURL = class extends URL {};
    (MockURL as typeof URL).createObjectURL = createObjectUrl;
    (MockURL as typeof URL).revokeObjectURL = revokeObjectUrl;
    vi.stubGlobal("URL", MockURL);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => (
      String(input).endsWith("/pdf")
        ? {
          ok: true,
          status: 200,
          headers: new Headers({
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent("S7-HISTORY-ADMIN.pdf")}`,
          }),
          blob: async () => pdfBlob,
        } as Response
        : Response.json({ records: [adminRecord] }, { status: 200 })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    const openedWindow = { opener: window } as unknown as Window;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(openedWindow);
    const user = userEvent.setup();
    render(<HistoryClient currentUser={currentUser} />);

    await screen.findByText("S7-HISTORY-ADMIN");
    await user.click(screen.getAllByRole("button", { name: "詳細" })[0]);
    const iframe = await screen.findByTestId("stored-quotation-pdf");
    const displayUrl = iframe.getAttribute("src") ?? "";
    expect(displayUrl).toMatch(/^blob:stored-pdf-1$/);
    expect(objectsByBlobUrl.get(displayUrl)).toBe(pdfBlob);
    expect(fetchMock).toHaveBeenCalledWith("/api/quotations/1/pdf", { cache: "no-store" });
    expect(screen.queryByRole("article", { name: "見積書A4" })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("detail-download-current"));
    await waitFor(() => expect(createObjectUrl).toHaveBeenCalledTimes(2));
    const downloadUrl = createObjectUrl.mock.results[1]?.value ?? "";
    expect(objectsByBlobUrl.get(downloadUrl)).toBe(pdfBlob);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/pdf"))).toHaveLength(2);

    await user.click(screen.getByTestId("detail-print-current"));
    expect(openSpy).toHaveBeenCalledWith(displayUrl, "_blank");
    expect(openedWindow.opener).toBeNull();
    expect(printSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("article", { name: "見積書A4" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("stored-quotation-pdf-error")).not.toBeInTheDocument();

    cleanup();
    printSpy.mockRestore();
    openSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("reports a blocked popup only when the canonical PDF viewer really is null", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const pdfBlob = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" });
    const MockURL = class extends URL {};
    (MockURL as typeof URL).createObjectURL = vi.fn(() => "blob:blocked-pdf");
    (MockURL as typeof URL).revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", MockURL);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/pdf")
        ? {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/pdf" }),
          blob: async () => pdfBlob,
        } as Response
        : Response.json({ records: [adminRecord] }, { status: 200 })
    )));
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    render(<HistoryClient currentUser={currentUser} />);

    await screen.findByText("S7-HISTORY-ADMIN");
    await user.click(screen.getAllByRole("button", { name: "詳細" })[0]);
    await screen.findByTestId("stored-quotation-pdf");
    await user.click(screen.getByTestId("detail-print-current"));
    await waitFor(() => expect(screen.getByTestId("stored-quotation-pdf-error")).toHaveTextContent(
      "ポップアップがブロックされました。PDFをダウンロードして印刷してください。",
    ));
    expect(openSpy).toHaveBeenCalledWith("blob:blocked-pdf", "_blank");

    cleanup();
    openSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows a missing-PDF error and never renders or prints the divergent A4 fallback", async () => {
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const MockURL = class extends URL {};
    (MockURL as typeof URL).createObjectURL = vi.fn(() => `blob:stored-pdf-${Math.random()}`);
    (MockURL as typeof URL).revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", MockURL);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (
      String(input).endsWith("/pdf")
        ? Response.json({ error: "pdf_not_found" }, { status: 404 })
        : Response.json({ records: [adminRecord] }, { status: 200 })
    )));
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    render(<HistoryClient currentUser={currentUser} />);

    await screen.findByText("S7-HISTORY-ADMIN");
    await user.click(screen.getAllByRole("button", { name: "詳細" })[0]);
    expect(await screen.findByTestId("stored-quotation-pdf-error")).toHaveTextContent(
      "見積書PDFが見つかりません。",
    );
    expect(screen.queryByTestId("stored-quotation-pdf")).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "見積書A4" })).not.toBeInTheDocument();
    expect(screen.getByTestId("detail-download-current")).toBeDisabled();
    expect(screen.getByTestId("detail-print-current")).toBeDisabled();

    printSpy.mockRestore();
    openSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
