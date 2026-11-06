import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DataIntakeClient from "@/app/data-intake/data-intake-client";
import type { FilmOrderIntakeEntry } from "@/lib/film-order-intake";

const viewer = { id: 1, email: "seven-owner@727.co.jp", name: "Seven Owner", role: "user" as const };
const entry: FilmOrderIntakeEntry = {
  quotationId: 7,
  quotationNumber: "S7-G003-UI",
  productName: "UI Upload",
  customerName: "Customer A",
  quantity: "1000",
  internalApprovedAt: "2026-11-06T09:00:00.000Z",
  ownerDomain: "seven",
  state: "linked",
  filmOrder: { id: 17, orderNumber: "F-202611-001", status: "ordered" },
  makerHandoffStatus: "not_registered",
  proofStatus: "unavailable",
  proofRound: 1,
  dualApprovalStatus: "pending",
  poStatus: "not_sent",
  actions: [
    { kind: "intake_upload", label: "データ入稿", authorized: true, enabled: true, reason: "G003", releaseStory: "G003" },
    { kind: "owner_approval", label: "S7承認", authorized: true, enabled: false, reason: "G006", releaseStory: "G006" },
  ],
};

function listResponse() {
  const payload = {
    entries: [entry],
    total: 1,
    page: 1,
    pageSize: 20,
    pageCount: 1,
    hasNext: false,
    hasPrevious: false,
  };
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/data-intake?") && !url.includes("/upload-")) return listResponse();
    if (url.endsWith("/docs/data-upload/data-input-guide-1.pdf") || url.endsWith("2.pdf") || url.endsWith("3.pdf")) {
      return new Response(null, { status: 200 });
    }
    if (url === "/api/data-intake/7/upload-session") {
      return { ok: true, json: async () => ({ sessionUri: "http://drive.test/session", fileName: "F_design_v1_customer.ai", maxBytes: 1 }) } as Response;
    }
    if (url === "http://drive.test/session") {
      return { ok: true, json: async () => ({ id: "drive-ai" }) } as Response;
    }
    if (url === "/api/data-intake/7/upload-complete") {
      return { ok: true, json: async () => ({
        quotationId: 7,
        quotationNumber: entry.quotationNumber,
        ownerDomain: "seven",
        order: { id: 17, orderNumber: "F-202611-001", designStatus: "received" },
        files: [{ id: 1, version: 1, driveFileId: "drive-ai" }],
      }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("G003 direct intake upload UI", () => {
  it("enables only the authorized owner upload and performs AI session/Drive PUT/complete", async () => {
    const user = userEvent.setup();
    render(<DataIntakeClient viewer={viewer} />);
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
      expect(screen.getByTestId("intake-count")).toHaveTextContent("1 件");
    }, { timeout: 5000 });
    const uploadButton = await screen.findByTestId("intake-action-intake_upload", {}, { timeout: 5000 });
    expect(uploadButton).toBeEnabled();
    expect(screen.getByTestId("intake-action-owner_approval")).toBeDisabled();
    await user.click(uploadButton);

    const aiInput = screen.getByLabelText("AIデータ（必須）");
    await user.upload(aiInput, new File(["AI"], "customer.ai", { type: "application/postscript" }));
    const checks = screen.getAllByRole("checkbox");
    for (const check of checks) await user.click(check);
    await user.click(screen.getByTestId("intake-upload-submit"));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === "/api/data-intake/7/upload-session" && init?.method === "POST"
    )).toBe(true));
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === "http://drive.test/session" && init?.method === "PUT"
    )).toBe(true);
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === "/api/data-intake/7/upload-complete" && init?.method === "POST"
    )).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).endsWith("/upload-complete"))?.[1]?.body));
    expect(body).toMatchObject({ originalFileName: "customer.ai", expectedFileName: "F_design_v1_customer.ai", fileId: "drive-ai", guideAcknowledged: true });
  });
});
