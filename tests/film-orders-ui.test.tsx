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
  customer_code: "FILM-CUSTOMER-001",
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
    destinations: [],
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
      if (url === "/api/film-orders/1001/ship-to-destinations") {
        return Response.json({ destinations: [], basicDestination: null });
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

  it("supports registering multiple delivery destinations", async () => {
    const user = userEvent.setup();
    render(<FilmOrdersClient userEmail="buyer@727.co.jp" />);

    await screen.findByText("F-202610-001");
    await user.click(screen.getByText("F-202610-001"));

    await user.click(screen.getByRole("tab", { name: "納品先" }));
    expect(await screen.findByTestId("ship-to-panel")).toBeInTheDocument();
    expect(await screen.findByTestId("ship-to-entry-list")).toBeInTheDocument();

    await user.click(screen.getByTestId("ship-to-add-manual"));
    expect(screen.getByText("納品先 1（新規入力）")).toBeInTheDocument();
    expect(screen.queryByText("この納品先を顧客住所録に保存")).not.toBeInTheDocument();
    expect(screen.getByText("登録内容は顧客住所録に自動保存され、次回から選択できます。")).toBeInTheDocument();
    await user.click(screen.getByTestId("ship-to-add-manual"));
    expect(screen.getByText("納品先 2（新規入力）")).toBeInTheDocument();

    const companyInputs = screen.getAllByLabelText("会社名 ★");
    const postalInputs = screen.getAllByLabelText("郵便番号 ★");
    const addressInputs = screen.getAllByLabelText("住所 ★");
    const phoneInputs = screen.getAllByLabelText("電話番号 ★");
    expect(companyInputs).toHaveLength(2);
    await user.type(companyInputs[0]!, "第一物流株式会社");
    await user.type(postalInputs[0]!, "550-0001");
    await user.type(addressInputs[0]!, "大阪府大阪市テスト1-1-1");
    await user.type(phoneInputs[0]!, "06-0000-0001");
    await user.type(companyInputs[1]!, "第二物流株式会社");
    await user.type(postalInputs[1]!, "550-0002");
    await user.type(addressInputs[1]!, "大阪府大阪市テスト2-2-2");
    await user.type(phoneInputs[1]!, "06-0000-0002");

    await user.click(screen.getByRole("button", { name: "納品先を登録（2件）" }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/film-orders/1001",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const postCalls = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(postCalls.at(-1)?.[1]?.body));
    expect(body.action).toBe("register-ship-to");
    expect(body.destinations).toHaveLength(2);
    expect(body.destinations[0].shipToCompanyName).toBe("第一物流株式会社");
    expect(body.destinations[1].shipToCompanyName).toBe("第二物流株式会社");
  });

  it("adds saved destinations from the customer address book list", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/film-orders") {
        return Response.json({ orders: [order], created: 0, driveConfigured: false });
      }
      if (url === "/api/film-orders/1001") {
        if (init?.method === "POST") {
          return Response.json({ order });
        }
        return Response.json({ order });
      }
      if (url === "/api/film-orders/1001/ship-to-destinations") {
        return Response.json({
          basicDestination: {
            companyName: "初回登録商事株式会社",
            department: "",
            contactName: "基本太郎",
            postalCode: "582-0017",
            address: "大阪府柏原市基本情報1-1-1",
            building: "",
            phone: "07-0000-0000",
            email: "basic@example.test",
          },
          destinations: [
            {
              id: 11,
              label: "本社倉庫",
              companyName: "住所録物流株式会社",
              department: "第一部",
              contactName: "田中太郎",
              postalCode: "550-0011",
              address: "大阪府大阪市住所録1-1-1",
              building: "第1倉庫",
              phone: "06-1111-1111",
              email: "warehouse11@example.test",
              isDefault: true,
            },
            {
              id: 12,
              label: "九州倉庫",
              companyName: "住所録物流株式会社",
              department: "",
              contactName: "",
              postalCode: "812-0012",
              address: "福岡県福岡市住所録2-2-2",
              building: "",
              phone: "092-222-2222",
              email: "",
              isDefault: false,
            },
          ],
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }));

    render(<FilmOrdersClient userEmail="buyer@727.co.jp" />);
    await screen.findByText("F-202610-001");
    await user.click(screen.getByText("F-202610-001"));
    await user.click(screen.getByRole("tab", { name: "納品先" }));

    const masterList = await screen.findByTestId("ship-to-master-list");
    expect(masterList).toBeInTheDocument();
    expect(screen.getAllByText("顧客基本情報（初回登録時の住所）").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/本社倉庫/).length).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: /九州倉庫/ })).toBeInTheDocument();

    // 顧客基本情報（初回登録時の住所）が既定の初期エントリになっている
    expect(screen.getByText("納品先 1（顧客基本情報）")).toBeInTheDocument();

    // 九州倉庫を選んで追加
    await user.click(screen.getByRole("radio", { name: /九州倉庫/ }));
    await user.click(screen.getByTestId("ship-to-add-from-master"));
    expect(screen.getByText("納品先 2（住所録）")).toBeInTheDocument();

    // 追加済みバッジと重複追加防止
    expect(screen.getAllByText("追加済み")).toHaveLength(2);
    expect(screen.getByTestId("ship-to-add-from-master")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "納品先を登録（2件）" }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/film-orders/1001",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const postCalls2 = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(postCalls2.at(-1)?.[1]?.body));
    expect(body.action).toBe("register-ship-to");
    expect(body.destinations).toEqual([
      { customerBasic: true },
      { destinationId: 12 },
    ]);
  });
});
