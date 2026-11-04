import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LegacyReconciliationClient from "@/app/film-makers/legacy-reconciliation-client";

const orders = [
  {
    orderId: 101,
    orderNumber: "F-202611-EXACT",
    productName: "Exact pouch",
    customerName: "Customer A",
    supplierName: "Historical External Maker",
    supplierEmail: "Historical@Example.test",
    procurementRoute: "K",
    printMethod: "gravure",
    resolution: "legacy_unresolved" as const,
    classification: "external_exact" as const,
    suggestedMaker: {
      makerId: 42,
      makerCode: "EXACT-001",
      companyName: "Current External Maker",
      email: "historical@example.test",
      language: "ko" as const,
      printMethod: "gravure" as const,
      procurementRoute: "K" as const,
      matchedByEmail: "historical@example.test",
      confidence: "exact" as const,
      rule: "normalized_email_route_print" as const,
    },
  },
  {
    orderId: 102,
    orderNumber: "F-202611-INTERNAL",
    productName: "Internal pouch",
    customerName: "Customer B",
    supplierName: "Package Lab",
    supplierEmail: "design@package-lab.com",
    procurementRoute: "K",
    printMethod: "gravure",
    resolution: "legacy_unresolved" as const,
    classification: "internal" as const,
    suggestedMaker: null,
  },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/film-makers/legacy-reconciliation" && init?.method !== "POST") {
      return Response.json({ orders });
    }
    if (url === "/api/film-makers/legacy-reconciliation" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { action: string; orderId?: number };
      if (body.action === "select") {
        return Response.json({ orders: orders.filter((order) => order.orderId !== body.orderId) });
      }
      if (body.action === "exempt") {
        return Response.json({ orders: orders.filter((order) => order.orderId !== body.orderId) });
      }
      return Response.json({ orders });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("legacy supplier reconciliation UI", () => {
  it("is a Kanei-admin surface with exact suggestions, explicit flows, and preserved history", async () => {
    const user = userEvent.setup();
    render(<LegacyReconciliationClient adminEmail="admin@kanei-trade.co.jp" />);

    await screen.findByText("F-202611-EXACT");
    expect(screen.getByTestId("legacy-supplier-101")).toHaveTextContent("Historical External Maker");
    expect(screen.getByTestId("legacy-supplier-101")).toHaveTextContent("Historical@Example.test");
    expect(screen.getByTestId("legacy-classification-101")).toHaveTextContent("外部・完全一致候補");
    expect(screen.getByTestId("legacy-suggestion-101")).toHaveTextContent("Current External Maker");
    expect(screen.getByTestId("legacy-suggestion-101")).toHaveTextContent("historical@example.test");
    expect(screen.getByTestId("legacy-classification-102")).toHaveTextContent("社内アドレス/社名");
    expect(screen.getByTestId("legacy-select-102")).toBeDisabled();
    expect(screen.getByTestId("legacy-exempt-102")).toBeDisabled();

    await user.click(screen.getByTestId("legacy-select-101"));
    await waitFor(() => expect(screen.queryByTestId("legacy-order-101")).not.toBeInTheDocument());
    const selectCall = vi.mocked(fetch).mock.calls.find(([, init]) =>
      init?.method === "POST" && JSON.parse(String(init.body)).action === "select",
    );
    expect(JSON.parse(String(selectCall?.[1]?.body))).toEqual({ action: "select", orderId: 101, makerId: 42 });

    await user.type(screen.getByLabelText("除外理由（F-202611-INTERNAL）"), "既存案件対象外");
    await user.click(screen.getByTestId("legacy-exempt-102"));
    await waitFor(() => expect(screen.queryByTestId("legacy-order-102")).not.toBeInTheDocument());
    const exemptCall = vi.mocked(fetch).mock.calls.find(([, init]) =>
      init?.method === "POST" && JSON.parse(String(init.body)).action === "exempt",
    );
    expect(JSON.parse(String(exemptCall?.[1]?.body))).toEqual({
      action: "exempt",
      orderId: 102,
      classification: "internal",
      reason: "既存案件対象外",
    });
  });
});
