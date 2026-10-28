import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilmOrdersClient from "@/app/film-orders/film-orders-client";
import type { FilmOrderView } from "@/lib/film-order-shared";

const order = {
  id: 1001,
  order_number: "F-202610-001",
  quotation_id: 101,
  quotation_number: "Q-202610-001",
  product_name: "Self-order Film",
  customer_name: "Kanei Customer",
  printing_method: "digital",
  procurement_route: "Y",
  film_composition: "PET/PE",
  order_length_m: "500",
  web_width_mm: "100",
  pouch_quantity: "10000",
  supplier_name: "",
  supplier_email: "",
  seven_contact_email: "",
  buyer_domain: "727.co.jp",
  po_sent_at: null,
  eta_token: null,
  eta_expires_at: null,
  eta_date: null,
  eta_note: null,
  eta_updated_at: null,
  film_shipped_on: null,
  film_shipped_at: null,
  film_carrier: "",
  film_tracking_number: "",
  film_shipment_note: "",
  film_delivery_document_name: "",
  film_delivery_document_url: "",
  film_delivered_on: null,
  film_delivered_at: null,
  film_delivery_note: "",
  film_received_at: null,
  film_received_note: "",
  film_received_by_email: "",
  ship_to_destination_id: null,
  ship_to_status: "not_provided",
  ship_to_label: "",
  ship_to_company_name: "",
  ship_to_department: "",
  ship_to_contact_name: "",
  ship_to_postal_code: "",
  ship_to_address: "",
  ship_to_building: "",
  ship_to_phone: "",
  ship_to_email: "",
  ship_to_note: "",
  ship_to_registered_at: null,
  ship_to_registered_by: "",
  ship_to_saved_to_master: false,
  ship_to_confirmed_at: null,
  ship_to_confirmed_by: "",
  proof_upload_token: null,
  proof_upload_expires_at: null,
  status: "ordered",
  re_proof_count: 0,
  ordered_at: "2026-10-23T00:00:00.000Z",
  receiving_registered_at: null,
  proof_registered_at: null,
  re_proof_requested_at: null,
  final_approved_at: null,
  customer_design_status: "pending",
  customer_design_requested_at: null,
  customer_design_received_at: null,
  customer_design_confirmed_at: null,
  customer_design_correction_count: 0,
  customer_design_correction_reason: "",
  customer_proof_status: "pending",
  customer_proof_requested_at: null,
  customer_proof_approved_at: null,
  customer_proof_correction_count: 0,
  customer_proof_correction_reason: "",
  notes: "",
  created_at: "2026-10-23T00:00:00.000Z",
  updated_at: "2026-10-23T00:00:00.000Z",
  created_by_email: "buyer@727.co.jp",
  updated_by_email: "buyer@727.co.jp",
  purchaseOrder: null,
  sampleBulk: {
    status: "pending",
    productionBulkUsageMl: "0",
    sampleQuantityMl: null,
    sampleReceivedMl: null,
    sampleAdjustedMl: null,
    adjustmentCount: 0,
    recipientName: "",
    recipientPostalCode: "",
    recipientAddress: "",
    requestedAt: null,
    receivedAt: null,
    confirmedAt: null,
    adjustmentRequestedAt: null,
    requestNote: "",
    receiveNote: "",
    adjustmentReason: "",
  },
  customerDesign: {
    status: "pending",
    requestedAt: null,
    receivedAt: null,
    confirmedAt: null,
    correctionCount: 0,
    correctionReason: "",
    note: "",
  },
  customerProof: {
    status: "pending",
    requestedAt: null,
    approvedAt: null,
    correctionCount: 0,
    correctionReason: "",
  },
  delivery: {
    shippedOn: null,
    shippedAt: null,
    carrier: "",
    trackingNumber: "",
    shipmentNote: "",
    deliveryDocumentName: "",
    deliveryDocumentUrl: "",
    deliveredOn: null,
    deliveredAt: null,
    deliveryNote: "",
    receivedAt: null,
    receivedNote: "",
    receivedByEmail: "",
  },
  shipTo: {
    status: "not_provided",
    destinationId: null,
    label: "",
    companyName: "",
    department: "",
    contactName: "",
    postalCode: "",
    address: "",
    building: "",
    phone: "",
    email: "",
    note: "",
    registeredAt: null,
    registeredBy: "",
    savedToMaster: false,
    confirmedAt: null,
    confirmedBy: "",
  },
  files: [],
  events: [],
} as unknown as FilmOrderView;

describe("film orders Seven-buyer UI", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/film-orders") {
        return Response.json({ orders: [order], created: 0, driveConfigured: false });
      }
      if (url === "/api/film-orders/1001") {
        return Response.json({ order });
      }
      if (url === `/api/film-orders/1001` && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return Response.json({
          order: {
            ...order,
            customer_design_status: "not_required",
            customerDesign: { ...order.customerDesign, status: "not_required" },
            updated_by_email: body.actor,
          },
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("exposes the data-source choice and switches to own-data intake", async () => {
    const user = userEvent.setup();
    render(<FilmOrdersClient userEmail="buyer@727.co.jp" />);

    await screen.findByText("F-202610-001");
    await user.click(screen.getByText("F-202610-001"));

    expect(await screen.findByTestId("customer-design-panel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "顧客にアップロード依頼" })).toBeInTheDocument();
    expect(screen.getByLabelText("設定メモ")).not.toBeRequired();
    await user.click(screen.getByRole("button", { name: "自社データで進める" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/film-orders/1001",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body)).action)
      .toBe("set-customer-design-not-required");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body)).reason)
      .toBe("金井貿易の自社製作データで進行");
  });
});
