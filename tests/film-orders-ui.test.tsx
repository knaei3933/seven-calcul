import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

  it("limits customer design request to Kanei and lets Seven use own data", async () => {
    const user = userEvent.setup();
    render(<FilmOrdersClient userEmail="buyer@727.co.jp" />);

    await screen.findByText("F-202610-001");
    await user.click(screen.getByText("F-202610-001"));

    expect(await screen.findByTestId("customer-design-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "得意先にアップロード依頼" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("設定メモ")).not.toBeRequired();
    await user.click(screen.getByRole("button", { name: "自社データで進める" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/film-orders/1001",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const ownDataPosts = vi.mocked(fetch).mock.calls.filter(([url, init]) =>
      url === "/api/film-orders/1001" && init?.method === "POST"
    );
    expect(JSON.parse(String(ownDataPosts.at(-1)?.[1]?.body)).action)
      .toBe("set-customer-design-not-required");
    expect(JSON.parse(String(ownDataPosts.at(-1)?.[1]?.body)).reason)
      .toBe("金井貿易側の自社製作データで進行");
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
    expect(screen.queryByText("この納品先を得意先住所録に保存")).not.toBeInTheDocument();
    expect(screen.getByText("登録内容は得意先住所録に自動保存され、次回から選択できます。")).toBeInTheDocument();
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
    const postCalls = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/film-orders/1001" && init?.method === "POST");
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
    expect(screen.getAllByText("得意先基本情報（初回登録時の住所）").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/本社倉庫/).length).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: /九州倉庫/ })).toBeInTheDocument();

    // 得意先基本情報（初回登録時の住所）が既定の初期エントリになっている
    expect(screen.getByText("納品先 1（得意先基本情報）")).toBeInTheDocument();

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

describe("film maker selection integration", () => {
  beforeEach(() => {
    const finalOrder = {
      ...order,
      status: "final_approved",
      po_sent_at: null,
      procurement_route: "K",
      printing_method: "gravure",
      film_maker_id: null,
      film_maker_snapshot_json: null,
      supplier_resolution: "legacy_unresolved",
      productionPlan: { status: "not_set", startDate: null, endDate: null, note: "", updatedAt: null, updatedBy: "" },
      delivery: { ...order.delivery, documents: [] },
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/film-makers/selection")) {
        return Response.json({ selections: [{
          id: 42,
          makerCode: "KOR-GRA-001",
          companyName: "外部フィルムメーカー",
          language: "ko",
        }] });
      }
      if (url === "/api/film-orders") {
        return Response.json({ orders: [finalOrder], created: 0, driveConfigured: false });
      }
      if (url === "/api/film-orders/1001" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.action).toBe("select-film-maker");
        const selected = {
          ...finalOrder,
          film_maker_id: 42,
          supplier_resolution: "master_selected",
          film_maker_snapshot_json: JSON.stringify({
            id: 42,
            makerCode: "KOR-GRA-001",
            companyName: "外部フィルムメーカー",
            email: "maker@example.test",
          }),
          productionPlan: { status: "not_set", startDate: null, endDate: null, note: "", updatedAt: null, updatedBy: "" },
          delivery: { ...order.delivery, documents: [] },
        };
        return Response.json({ order: selected });
      }
      if (url === "/api/film-orders/1001") {
        return Response.json({ order: finalOrder });
      }
      if (url === "/api/film-orders/1001/ship-to-destinations") {
        return Response.json({ destinations: [], basicDestination: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });

  it("lets Kanei workflow select a contact-free master projection and records the snapshot", async () => {
    const user = userEvent.setup();
    render(<FilmOrdersClient userEmail="workflow@kanei-trade.co.jp" />);
    await screen.findByText("F-202610-001");
    await user.click(screen.getByText("F-202610-001"));
    const select = await screen.findByTestId("film-maker-select");
    expect(select).toHaveTextContent("外部フィルムメーカー");
    await user.selectOptions(select, "42");
    await waitFor(() => expect(screen.getByTestId("film-maker-snapshot")).toHaveTextContent("外部フィルムメーカー"));
    const postCalls = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(postCalls.at(-1)?.[1]?.body))).toEqual({
      action: "select-film-maker",
      makerId: 42,
      origin: "http://localhost:3000",
    });
  });
});

describe("G007 role-aware workflow UI", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const lifecycleBase = {
    ...order,
    status: "final_approved" as const,
    ordered_at: "2026-10-20T00:00:00.000Z",
    receiving_registered_at: "2026-10-21T00:00:00.000Z",
    proof_registered_at: "2026-10-22T00:00:00.000Z",
    final_approved_at: "2026-10-23T00:00:00.000Z",
    customer_design_status: "confirmed" as const,
    customerDesign: { ...order.customerDesign, status: "confirmed" },
    customer_proof_status: "approved" as const,
    customerProof: {
      ...order.customerProof,
      status: "approved",
      supplierApprovalStatus: "approved" as const,
      supplierApprovalAt: "2026-10-22T01:00:00.000Z",
      buyerApprovalStatus: "approved" as const,
      buyerApprovalAt: "2026-10-23T00:00:00.000Z",
    },
    supplier_approval_status: "approved" as const,
    buyer_approval_status: "approved" as const,
    po_sent_at: null,
    ship_to_status: "confirmed" as const,
    shipTo: { ...order.shipTo, status: "confirmed" },
    procurement_route: "K",
    printing_method: "gravure",
    film_maker_id: 42,
    film_maker_snapshot_json: JSON.stringify({
      id: 42,
      makerCode: "KOR-GRA-001",
      companyName: "外部フィルムメーカー",
      email: "maker@example.test",
      language: "ko",
      isActive: true,
      procurementRoute: "K",
      printMethod: "gravure",
    }),
    supplier_resolution: "master_selected" as const,
    supplier_name: "外部フィルムメーカー",
    supplier_email: "maker@example.test",
    files: [
      { ...order.files, id: 1, category: "receiving", file_name: "art.ai", url: "https://example.test/art.ai", version: 1 },
      { ...order.files, id: 2, category: "receiving", file_name: "art.pdf", url: "https://example.test/art.pdf", version: 1 },
    ],
    productionPlan: { status: "not_set", startDate: null, endDate: null, note: "", updatedAt: null, updatedBy: "" },
    delivery: { ...order.delivery, documents: [] },
  };

  const previewEnvelope = {
    audience: "maker",
    intendedTo: "maker@example.test",
    cc: ["seven@example.test"],
    language: "ko",
    subject: "発注確認",
    body: "本文です。",
    links: [{ key: "supplier_po", url: "https://example.test/po?token=abc", label: "発注書" }],
    attachments: [{ fileName: "art.ai", category: "receiving", version: 1 }],
    contentHash: "hash-maker",
    effectiveTemplateIdentity: { key: "supplier_purchase_order:maker", source: "default" },
  };
  const preview = {
    dispatchGroupId: "film-mail-test",
    envelopes: [previewEnvelope],
    stagedTokens: [],
    warnings: ["mail_test_mode_enabled", "mail_environment_recipient_override_enabled"],
  };

  function resetUi() {
    cleanup();
    vi.unstubAllGlobals();
  }

  function stubLifecycle({
    actor,
    confirmOutcome = "sent",
  }: {
    actor: string;
    confirmOutcome?: "sent" | "failed" | "unknown" | "retry_required";
  }) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method;
      if (url === "/api/film-orders/mail-routing") {
        return Response.json({ enabled: true, recipient: "test@example.test" });
      }
      if (url === "/api/film-orders") {
        return Response.json({ orders: [lifecycleBase], created: 0, driveConfigured: false });
      }
      if (url === "/api/film-orders/1001" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        if (body.mailMode === "confirm") {
          return Response.json({
            order: { ...lifecycleBase, po_sent_at: "2026-10-23T02:00:00.000Z", updated_at: "2026-10-23T02:00:00.000Z" },
            lifecycle: {
              dispatchGroupId: preview.dispatchGroupId,
              workflowCompleted: true,
              notificationCompleted: confirmOutcome === "sent",
              outcomes: [{
                audience: "maker", attemptCount: 1, status: confirmOutcome, intendedTo: "maker@example.test",
                actualTo: confirmOutcome === "sent" ? "maker@example.test" : null,
                recipientOverridden: true, smtpMessageId: confirmOutcome === "sent" ? "smtp-1" : null,
                errorCode: confirmOutcome === "sent" ? null : "smtp-down", subject: "発注確認", body: "本文です。",
              }],
            },
          });
        }
        return Response.json({
          order: lifecycleBase,
          preview,
        });
      }
      if (url === "/api/film-orders/1001/mail-outbox") {
        return Response.json({ envelopes: [{
          id: 801,
          dispatchGroupId: "film-mail-old",
          workflowKey: "supplier_purchase_order",
          audience: "maker",
          language: "ko",
          envelopeStatus: "composed",
          createdAt: "2026-10-23T00:00:00.000Z",
          updatedAt: "2026-10-23T00:00:00.000Z",
          attempts: [
            { id: 1, attemptCount: 1, status: "failed", createdAt: "2026-10-23T00:00:00.000Z", attemptStartedAt: "2026-10-23T00:00:00.000Z", attemptFinishedAt: "2026-10-23T00:01:00.000Z" },
            { id: 2, attemptCount: 2, status: confirmOutcome, createdAt: "2026-10-23T00:02:00.000Z", attemptStartedAt: "2026-10-23T00:02:00.000Z", attemptFinishedAt: null },
          ],
        }] });
      }
      if (url === `/api/film-orders/1001/mail-dispatch` && method === "POST") {
        const body = JSON.parse(String(init?.body));
        if (body.operation === "cancel") {
          return Response.json({ skippedCount: 1, revokedTokenCount: 0, authoritativeStateChanged: false, order: lifecycleBase });
        }
        return Response.json({ outcomes: [], workflowCompleted: false, notificationCompleted: false, order: lifecycleBase });
      }
      if (url === "/api/film-orders/1001") {
        return Response.json({ order: lifecycleBase });
      }
      if (url === "/api/film-orders/1001/ship-to-destinations") {
        return Response.json({ destinations: [], basicDestination: null });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }));
    return actor;
  }

  it("shows a stable guarded panel with exact actor labels and disabled reasons", async () => {
    resetUi();
    stubLifecycle({ actor: "buyer@727.co.jp" });
    render(<FilmOrdersClient userEmail="buyer@727.co.jp" />);
    await screen.findByTestId("film-order-card-1001");
    await userEvent.setup().click(screen.getAllByTestId("film-order-card-1001")[0]!.firstElementChild!);

    const panel = await screen.findByTestId("workflow-action-panel-1001");
    expect(panel).toHaveTextContent("セブン化学");
    expect(panel).toHaveTextContent("金井貿易側");
    expect(screen.queryByTestId("film-maker-selection")).not.toBeInTheDocument();
    expect(screen.queryByText("メーカー")).not.toBeInTheDocument();
    expect(screen.getByTestId("workflow-stage-1001")).toHaveTextContent("最終承認処理中");
    expect(screen.getByTestId("workflow-stage-track-1001")).toHaveTextContent("フィルムメーカー発注済み");

    for (const action of ["mark-ordered", "register-receiving", "approve", "confirm-film-receipt", "send-po", "resend-supplier-links"]) {
      expect(screen.getByTestId(`workflow-action-${action}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("workflow-action-send-po")).toHaveTextContent("この操作を実行できる権限がありません。");
    expect(screen.getByRole("button", { name: "発注メールを送る" })).toBeDisabled();
  });

  it("keeps Seven maker-free while Kanei sees contact-free selection and fixed snapshot", async () => {
    resetUi();
    stubLifecycle({ actor: "workflow@kanei-trade.co.jp" });
    render(<FilmOrdersClient userEmail="workflow@kanei-trade.co.jp" />);
    await screen.findByTestId("film-order-card-1001");
    await userEvent.setup().click(screen.getAllByTestId("film-order-card-1001")[0]!.firstElementChild!);
    await screen.findByTestId("film-maker-selection");
    expect(screen.getByTestId("film-maker-resolution")).toHaveTextContent("選択済み（スナップショット固定）");
    expect(screen.getByTestId("film-maker-snapshot")).toHaveTextContent("外部フィルムメーカー");
    expect(screen.getByTestId("film-maker-snapshot")).not.toHaveTextContent("maker@example.test");
    expect(screen.getByTestId("film-maker-select")).toBeDisabled();

    cleanup();
    stubLifecycle({ actor: "buyer@727.co.jp" });
    render(<FilmOrdersClient userEmail="buyer@727.co.jp" />);
    await screen.findByTestId("film-order-card-1001");
    await userEvent.setup().click(screen.getAllByTestId("film-order-card-1001")[0]!.firstElementChild!);
    expect(screen.queryByTestId("film-maker-selection")).not.toBeInTheDocument();
    expect(screen.queryByText("maker@example.test")).not.toBeInTheDocument();
  });

  it("previews first, preserves test warning, sends exact hashes, and shows outcomes", async () => {
    resetUi();
    const user = userEvent.setup();
    stubLifecycle({ actor: "workflow@kanei-trade.co.jp" });
    render(<FilmOrdersClient userEmail="workflow@kanei-trade.co.jp" />);
    await screen.findByTestId("film-order-card-1001");
    await user.click(screen.getAllByTestId("film-order-card-1001")[0]!.firstElementChild!);

    await user.click(await screen.findByRole("button", { name: "発注メールを送る" }));
    const previewPosts = vi.mocked(fetch).mock.calls.filter(([, init]) =>
      init?.method === "POST" && JSON.parse(String(init.body)).mailMode === "preview"
    );
    expect(previewPosts).toHaveLength(1);
    expect(JSON.parse(String(previewPosts[0]?.[1]?.body)).action).toBe("send-po");

    const dialog = screen.getByRole("dialog", { name: "発注メールを送る" });
    const modalWarnings = within(dialog).getByTestId("mail-preview-warnings");
    expect(modalWarnings).toHaveTextContent("保存済みメール設定のテストモードが有効です。");
    expect(modalWarnings).toHaveTextContent("環境変数 MAIL_RECIPIENT_OVERRIDE が有効です。");
    expect(dialog).toHaveTextContent("maker@example.test");
    expect(dialog).toHaveTextContent("seven@example.test");
    expect(screen.getByTestId("workflow-mail-envelope")).toHaveAttribute("data-language", "ko");
    expect(dialog).toHaveTextContent("hash-maker");
    expect(dialog).toHaveTextContent("art.ai");
    expect(dialog).toHaveTextContent("テストモード ON");
    expect(dialog).toHaveTextContent("フィルムメーカー発注済みへ進めます。");

    await user.click(screen.getByTestId("workflow-mail-confirm"));
    const confirmPost = vi.mocked(fetch).mock.calls.find(([, init]) =>
      init?.method === "POST" && JSON.parse(String(init.body)).mailMode === "confirm"
    );
    const confirmBody = JSON.parse(String(confirmPost?.[1]?.body));
    expect(confirmBody.action).toBe("send-po");
    expect(confirmBody.mailDispatchGroupId).toBe("film-mail-test");
    expect(confirmBody.mailEnvelopeHashes).toEqual(["hash-maker"]);
    expect(await screen.findByTestId("mail-outcomes-1001")).toHaveTextContent("送信済み");
    expect(screen.getByTestId("workflow-notification-split")).toHaveTextContent("業務状態：完了");
    expect(screen.getByTestId("workflow-notification-split")).toHaveTextContent("通知状態：全宛先送信済み");
    expect(screen.getByTestId("mail-attempt-status")).toHaveTextContent("送信済み");
  });

  it("cancel calls dispatch API and explicitly leaves business state unchanged", async () => {
    resetUi();
    const user = userEvent.setup();
    stubLifecycle({ actor: "workflow@kanei-trade.co.jp" });
    render(<FilmOrdersClient userEmail="workflow@kanei-trade.co.jp" />);
    await screen.findByTestId("film-order-card-1001");
    await user.click(screen.getAllByTestId("film-order-card-1001")[0]!.firstElementChild!);
    await user.click(await screen.findByRole("button", { name: "発注メールを送る" }));
    await user.click(screen.getByRole("button", { name: "送信を取り消す" }));

    const cancelPost = await waitFor(() => vi.mocked(fetch).mock.calls.find(([, init]) =>
      init?.method === "POST" && String(init.body).includes("cancel")
    ));
    expect(JSON.parse(String(cancelPost?.[1]?.body))).toEqual({
      operation: "cancel",
      dispatchGroupId: "film-mail-test",
    });
    expect(await screen.findByText("メール送信を取り消しました。業務状態は変更されていません。")).toBeInTheDocument();
  });

  it("renders failed, unknown and retry-required attempts and exposes retry only to Kanei", async () => {
    resetUi();
    stubLifecycle({ actor: "workflow@kanei-trade.co.jp", confirmOutcome: "unknown" });
    const user = userEvent.setup();
    render(<FilmOrdersClient userEmail="workflow@kanei-trade.co.jp" />);
    await screen.findByTestId("film-order-card-1001");
    await user.click(screen.getAllByTestId("film-order-card-1001")[0]!.firstElementChild!);
    await user.click(await screen.findByRole("tab", { name: "通知" }));

    const outbox = await screen.findByTestId("mail-outbox-1001");
    expect(outbox).toHaveTextContent("送信失敗");
    expect(outbox).toHaveTextContent("結果不明");
    expect(screen.getByRole("button", { name: "永続化済み送信を再試行" })).toBeEnabled();
    expect(screen.getAllByTestId("mail-attempt-status").some((item) => item.textContent === "結果不明")).toBe(true);

    cleanup();
    stubLifecycle({ actor: "buyer@727.co.jp", confirmOutcome: "unknown" });
    render(<FilmOrdersClient userEmail="buyer@727.co.jp" />);
    await screen.findByTestId("film-order-card-1001");
    await userEvent.setup().click(screen.getAllByTestId("film-order-card-1001")[0]!.firstElementChild!);
    await screen.findByRole("tab", { name: "通知" }).then((tab) => userEvent.setup().click(tab));
    expect(await screen.findByTestId("mail-outbox-1001")).not.toHaveTextContent("本文です。");
    expect(screen.queryByRole("button", { name: "永続化済み送信を再試行" })).not.toBeInTheDocument();
  });
});
