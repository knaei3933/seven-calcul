import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FilmOrderIntakeAction,
  FilmOrderIntakeActionKind,
  FilmOrderIntakeEntry,
} from "@/lib/film-order-intake";
import DataIntakeClient from "@/app/data-intake/data-intake-client";

const sevenViewer = { id: 1, email: "seven-owner@727.co.jp", name: "Seven", role: "user" as const };
const kaneiViewer = { id: 2, email: "kanei-owner@kanei-trade.co.jp", name: "Kanei", role: "user" as const };
const neutralViewer = { id: 3, email: "admin@example.test", name: "Admin", role: "admin" as const };

function action(
  kind: FilmOrderIntakeActionKind,
  label: string,
  authorized: boolean,
  enabled = authorized,
): FilmOrderIntakeAction {
  return {
    kind,
    label,
    authorized,
    enabled,
    reason: `${kind} planned`,
    releaseStory: "G003",
  };
}

const linkedSeven: FilmOrderIntakeEntry = {
  quotationId: 1,
  quotationNumber: "S7-G002-TABLE",
  productName: "Table Pouch",
  customerName: "Customer A",
  quantity: "10000",
  internalApprovedAt: "2026-11-06T09:00:00.000Z",
  ownerDomain: "seven",
  state: "linked",
  filmOrder: { id: 11, orderNumber: "F-202611-001", status: "receiving_registered" },
  customerDesign: { status: "requested", label: "顧客アップロード依頼済み", requestedAt: null, receivedAt: null },
  makerHandoffStatus: "registered",
  proofStatus: "requested",
  proofRound: 1,
  dualApprovalStatus: "owner_approved",
  poStatus: "not_sent",
  etaDate: null,
  shippedOn: null,
  shipToStatus: "registered",
  actions: [
    action("intake_upload", "データ入稿", true),
      action("proof_round", "校正確認", false),
    action("owner_approval", "金井承認", false, false),
    action("kanei_approval", "金井承認", false),
  ],
};
const linkedKanei: FilmOrderIntakeEntry = {
  ...linkedSeven,
  quotationId: 2,
  quotationNumber: "KT-G002-TABLE",
  ownerDomain: "kanei",
  customerDesign: { status: "pending", label: "入稿方式未選択", requestedAt: null, receivedAt: null },
  filmOrder: { id: 12, orderNumber: "F-202611-002", status: "pending" },
  makerHandoffStatus: "not_registered",
  proofStatus: "pending",
  proofRound: 1,
  dualApprovalStatus: "pending",
  poStatus: "sent",
  etaDate: "2026-11-10",
  shippedOn: null,
  shipToStatus: "registered",
  actions: [
    action("intake_upload", "データ入稿", true),
      action("proof_round", "校正確認", false),
    action("kanei_approval", "金井承認", true, true),
    action("owner_approval", "KT承認", true, true),
    action("purchase_order", "発注", true),
  ],
};
const unresolved: FilmOrderIntakeEntry = {
  ...linkedSeven,
  quotationId: 3,
  quotationNumber: "UNRESOLVED-G002",
  ownerDomain: "unresolved",
  state: "unresolved_owner",
  filmOrder: null,
  makerHandoffStatus: "unavailable",
  proofStatus: "unavailable",
  proofRound: 1,
  dualApprovalStatus: "pending",
  poStatus: "unavailable",
  etaDate: null,
  shippedOn: null,
  shipToStatus: "not_provided",
  actions: [
    action("intake_upload", "データ入稿", false),
    action("owner_approval", "S7承認", false),
    action("kanei_approval", "金井承認", false),
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let currentViewer = sevenViewer;

function payload(entries: FilmOrderIntakeEntry[], page = 1, total = entries.length) {
  return {
    entries,
    total,
    page,
    pageSize: 2,
    pageCount: Math.max(1, Math.ceil(total / 2)),
    hasNext: page < Math.ceil(total / 2),
    hasPrevious: page > 1,
  };
}

beforeEach(() => {
  currentViewer = sevenViewer;
  fetchMock = vi.fn(async () => Response.json(payload([linkedSeven, linkedKanei])));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("G002 data intake table", () => {
  it("renders per-order workflow cards and owner-derived badges", async () => {
    render(<DataIntakeClient viewer={currentViewer} />);
    const table = await screen.findByTestId("intake-table");
    expect(table).toBeInTheDocument();
    expect(screen.getAllByTestId("intake-row")).toHaveLength(2);
    expect(screen.getByText("S7-G002-TABLE")).toBeInTheDocument();
    expect(screen.getByText("KT-G002-TABLE")).toBeInTheDocument();
    const tableView = screen.getByTestId("intake-table");
    expect(within(tableView).getAllByText("入稿受領").length).toBeGreaterThan(0);
    expect(within(tableView).getAllByText("発注済み").length).toBeGreaterThan(0);
    expect(screen.getByTestId("intake-count")).toHaveTextContent("2 件");
  });

  it("applies bounded filters as explicit API query parameters", async () => {
    const user = userEvent.setup();
    render(<DataIntakeClient viewer={currentViewer} />);
    await screen.findByTestId("intake-table");
    await user.type(screen.getByTestId("intake-search"), "S7");
    await user.selectOptions(screen.getByTestId("intake-owner-filter"), "seven");
    await user.selectOptions(screen.getByTestId("intake-state-filter"), "linked");
    await user.selectOptions(screen.getByTestId("intake-maker-filter"), "registered");
    await user.selectOptions(screen.getByTestId("intake-proof-filter"), "requested");
    await user.selectOptions(screen.getByTestId("intake-approval-filter"), "owner_approved");
    await user.selectOptions(screen.getByTestId("intake-po-filter"), "not_sent");
    await user.click(screen.getByTestId("intake-apply"));

    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/data-intake?"),
      { cache: "no-store" },
    ));
    const url = String(fetchMock.mock.lastCall?.[0]);
    const params = new URL(url, "http://localhost").searchParams;
    expect(params.get("page")).toBe("1");
    expect(params.get("pageSize")).toBe("20");
    expect(params.get("search")).toBe("S7");
    expect(params.get("owner")).toBe("seven");
    expect(params.get("intakeState")).toBe("linked");
    expect(params.get("makerHandoff")).toBe("registered");
    expect(params.get("proof")).toBe("requested");
    expect(params.get("dualApproval")).toBe("owner_approved");
    expect(params.get("po")).toBe("not_sent");
  });

  it("uses stable page navigation with bounded page size", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input), "http://localhost").searchParams.get("page"));
      return Response.json(payload(page === 1 ? [linkedSeven, linkedKanei] : [unresolved], page, 3));
    });
    render(<DataIntakeClient viewer={currentViewer} />);
    expect((await screen.findAllByTestId("intake-row")).length).toBe(2);
    expect(screen.getByTestId("intake-pagination")).toHaveTextContent("Page 1 / 2");

    await user.click(screen.getByRole("button", { name: "次へ" }));
    expect(await screen.findByText("UNRESOLVED-G002")).toBeInTheDocument();
    expect(screen.getByTestId("intake-pagination")).toHaveTextContent("Page 2 / 2");
    expect(new URL(String(fetchMock.mock.lastCall?.[0]), "http://localhost").searchParams.get("page")).toBe("2");
  });

  it("shows only the next action for each order", async () => {
    render(<DataIntakeClient viewer={currentViewer} />);
    await screen.findByTestId("intake-table");
    const rows = screen.getAllByTestId("intake-row");
    expect(within(rows[0]!).getByTestId("intake-next-task")).toHaveTextContent("金井承認");
    expect(within(rows[0]!).getByTestId("intake-action-kanei_approval")).toBeDisabled();
    expect(within(rows[0]!).queryByTestId("intake-action-owner_approval")).not.toBeInTheDocument();
    expect(within(rows[0]!).queryByTestId("intake-action-proof_round")).not.toBeInTheDocument();

    expect(within(rows[1]!).getByTestId("intake-next-task")).toHaveTextContent("得意先に依頼");
    expect(within(rows[1]!).getByTestId("intake-action-customer_request")).toBeEnabled();
    expect(within(rows[1]!).queryByTestId("intake-action-purchase_order")).not.toBeInTheDocument();
  });

  it("keeps unresolved rows visible but fail-closed", async () => {
    fetchMock.mockResolvedValue(Response.json(payload([unresolved])));
    render(<DataIntakeClient viewer={currentViewer} />);
    expect(await screen.findByText("UNRESOLVED-G002")).toBeInTheDocument();
    expect(within(screen.getByTestId("intake-table")).getAllByText(/所有未解決/u).length).toBeGreaterThan(0);
    expect(screen.getByTestId("intake-action-intake_upload")).toHaveAttribute("data-authorized", "false");
    expect(screen.getByTestId("intake-action-intake_upload")).toBeDisabled();
    expect(screen.queryByTestId("intake-action-owner_approval")).not.toBeInTheDocument();
    expect(screen.queryByTestId("intake-action-kanei_approval")).not.toBeInTheDocument();
  });
});
