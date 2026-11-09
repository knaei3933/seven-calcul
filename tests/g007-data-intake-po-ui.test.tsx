import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DataIntakeClient from "@/app/data-intake/data-intake-client";
import type { FilmOrderIntakeEntry } from "@/lib/film-order-intake";

const viewer = { id: 2, email: "kanei@kanei-trade.co.jp", name: "Kanei", role: "admin" as const };
const entry: FilmOrderIntakeEntry = {
  quotationId: 9,
  quotationNumber: "S7-G007-PO-UI",
  productName: "PO UI Pouch",
  customerName: "PO UI Customer",
  quantity: "10000",
  internalApprovedAt: "2026-11-08T00:00:00.000Z",
  ownerDomain: "seven",
  state: "linked",
  filmOrder: { id: 9, orderNumber: "F-202611-009", status: "final_approved" },
  makerHandoffStatus: "registered",
  proofStatus: "approved",
  proofRound: 1,
  dualApprovalStatus: "approved",
  poStatus: "not_sent",
  etaDate: "2026-11-20",
  shippedOn: null,
  shipToStatus: "confirmed",
  actions: [
    { kind: "purchase_order", label: "発注", authorized: true, enabled: true, reason: "発注メールを作成できます。", releaseStory: "G007" },
    { kind: "delivery_note", label: "納品書", authorized: true, enabled: true, reason: "納品書を作成できます。", releaseStory: "G009" },
  ],
};

const preview = {
  to: "maker@example.test",
  route: "order",
  subject: "PO subject",
  body: "PO body",
  editableSubject: "PO subject edited",
  editableBody: "PO body edited",
  etaUrl: "https://example.test/eta",
  purchaseOrderUrl: "https://example.test/po",
};

const draft = {
  recipientName: "株式会社セブン化学",
  senderName: "金井貿易株式会社",
  issueDate: "",
  arrivalEstimateDate: "2026-11-20",
  productName: "PO UI Pouch",
  specification: "PET12 / 476mm",
  quantity: "10000",
  filmLength: "500",
  remarks: "",
};

const calls: Array<{ url: string; init?: RequestInit }> = [];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
}

beforeEach(() => {
  calls.length = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, init });
    if (url.startsWith("/api/data-intake?")) {
      return jsonResponse({ entries: [entry], total: 1, page: 1, pageSize: 20, pageCount: 1, hasNext: false, hasPrevious: false });
    }
    if (url.endsWith("/api/film-orders/9") && method === "POST" && String(init?.body).includes("preview-supplier-po")) {
      return jsonResponse({ order: {}, preview });
    }
    if (url.endsWith("/api/film-orders/9") && method === "POST" && String(init?.body).includes("send-po")) {
      return jsonResponse({ order: { po_sent_at: "2026-11-08T00:00:00.000Z" } });
    }
    if (url.endsWith("/delivery-note-draft") && method === "GET") {
      return jsonResponse({ draft, updatedAt: "2026-11-08T00:00:00.000Z", updatedBy: "kanei" });
    }
    if (url.endsWith("/delivery-note-draft") && method === "POST") {
      return jsonResponse({ draft, updatedAt: "2026-11-08T00:00:00.000Z", updatedBy: "kanei" });
    }
    if (url.endsWith("/delivery-note-pdf") && method === "POST") {
      return new Response(new Blob(["%PDF-ui"], { type: "application/pdf" }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:pdf"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("G007/G009 data-intake completion UI", () => {
  it("opens editable PO mail, sends exact fields, and refreshes the intake table", async () => {
    const user = userEvent.setup();
    render(<DataIntakeClient viewer={viewer} />);
    const row = await screen.findByTestId("intake-row");
    await user.click(within(row).getByTestId("intake-action-purchase_order"));
    await screen.findByTestId("intake-po-send");
    expect(screen.getByLabelText("件名")).toHaveValue("PO subject edited");
    expect(screen.getByLabelText("メール本文")).toHaveValue("PO body edited");
    await user.type(screen.getByLabelText("追加発注指示（任意）"), "500m units");
    await user.click(screen.getByTestId("intake-po-send"));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/api/film-orders/9') && String(call.init?.body).includes('send-po'))).toBe(true));
    const sendCall = calls.find((call) => call.url.endsWith("/api/film-orders/9") && String(call.init?.body).includes("send-po"));
    expect(sendCall?.init?.body).toBe(JSON.stringify({
      action: "send-po",
      mailMode: "confirm",
      origin: "http://localhost:3000",
      supplierOrderNote: "500m units",
      mailSubject: "PO subject edited",
      mailBody: "PO body edited",
    }));
  });

  it("registers and confirms the next ship-to from data-intake", async () => {
    const sevenViewer = { id: 1, email: "seven@727.co.jp", name: "Seven", role: "user" as const };
    const pendingShipEntry: FilmOrderIntakeEntry = {
      ...entry,
      ownerDomain: "seven",
      shipToStatus: "not_provided",
      actions: [
        { kind: "owner_approval", label: "Seven承認", authorized: true, enabled: false, reason: "承認済みです。", releaseStory: "G006" },
        { kind: "purchase_order", label: "発注", authorized: true, enabled: false, reason: "納品先確定後に発注できます。", releaseStory: "G009" },
      ],
    };
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, init });
      if (url.startsWith("/api/data-intake?")) {
        return jsonResponse({ entries: [pendingShipEntry], total: 1, page: 1, pageSize: 20, pageCount: 1, hasNext: false, hasPrevious: false });
      }
      if (url.endsWith("/api/film-orders/9") && method === "GET") {
        return jsonResponse({ order: { shipTo: { status: "not_provided" } } });
      }
      if (url.endsWith("/api/film-orders/9") && method === "POST" && String(init?.body).includes("register-ship-to")) {
        return jsonResponse({ order: { shipToStatus: "registered" } });
      }
      if (url.endsWith("/api/film-orders/9") && method === "POST" && String(init?.body).includes("confirm-ship-to")) {
        return jsonResponse({ order: { shipToStatus: "confirmed" } });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    });
    const user = userEvent.setup();
    render(<DataIntakeClient viewer={sevenViewer} />);
    const row = await screen.findByTestId("intake-row");
    await user.click(within(row).getByTestId("intake-action-ship_to"));
    await screen.findByTestId("intake-ship-to-submit");
    await user.type(screen.getByLabelText("納品先会社名 ★"), "Ship To KK");
    await user.type(screen.getByLabelText("郵便番号 ★"), "650-0001");
    await user.type(screen.getByLabelText("住所 ★"), "Kobe 1-1-1");
    await user.click(screen.getByTestId("intake-ship-to-submit"));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/api/film-orders/9") && String(call.init?.body).includes("confirm-ship-to"))).toBe(true));
    const registerCall = calls.find((call) => call.url.endsWith("/api/film-orders/9") && String(call.init?.body).includes("register-ship-to"));
    expect(JSON.parse(String(registerCall?.init?.body))).toMatchObject({
      action: "register-ship-to",
      shipToCompanyName: "Ship To KK",
      shipToPostalCode: "650-0001",
      shipToAddress: "Kobe 1-1-1",
      saveShipToMaster: true,
    });
  });

  it("loads, saves, and downloads the Kanei-to-Seven delivery note", async () => {
    entry.poStatus = "sent";
    const user = userEvent.setup();
    render(<DataIntakeClient viewer={viewer} />);
    const row = await screen.findByTestId("intake-row");
    await user.click(within(row).getByTestId("intake-action-delivery_note"));
    await screen.findByLabelText("納品先");
    expect(screen.getByLabelText("到着見込")).toHaveValue("2026-11-20");
    await user.click(screen.getByRole("button", { name: "下書き保存" }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/delivery-note-draft') && call.init?.method === 'POST')).toBe(true));
    await user.click(screen.getByRole("button", { name: "納品書PDF出力（A4）" }));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/delivery-note-pdf'))).toBe(true));
    const savedBody = calls.find((call) => call.url.endsWith("/delivery-note-draft") && call.init?.method === "POST")?.init?.body;
    const savedBodyObject = JSON.parse(String(savedBody));
    expect(savedBodyObject).toMatchObject({ recipientName: draft.recipientName, arrivalEstimateDate: draft.arrivalEstimateDate });
    const pdfCall = calls.find((call) => call.url.endsWith("/delivery-note-pdf"));
    const pdfBodyObject = JSON.parse(String(pdfCall?.init?.body));
    expect(pdfBodyObject).toMatchObject({ recipientName: draft.recipientName, arrivalEstimateDate: draft.arrivalEstimateDate });
  });
});
