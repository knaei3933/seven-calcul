import { describe, expect, it } from "vitest";
import {
  buildFilmOrderNotifications,
  expectedFilmOrderNotificationAudiences,
  FILM_ORDER_LINK_ALLOWLISTS,
  FILM_ORDER_NOTIFICATION_EVENTS,
  filmOrderNotificationEnvelopeHash,
  validateFilmOrderNotification,
  type FilmOrderNotificationEnvelope,
  type FilmOrderNotificationEvent,
  type FilmOrderNotificationInput,
  type FilmOrderNotificationLink,
} from "@/lib/film-order-notifications";

const links: FilmOrderNotificationLink[] = [
  { key: "maker_receiving_packet", url: "https://example.test/packet/abc", label: "制作データ" },
  { key: "maker_proof_upload", url: "https://example.test/proof/token", label: "校正提出" },
  { key: "maker_purchase_order", url: "https://example.test/po/token", label: "発注" },
  { key: "maker_eta_report", url: "https://example.test/eta/token", label: "ETA" },
  { key: "kanei_order_management", url: "https://example.test/kanei/order", label: "管理" },
  { key: "seven_order_summary", url: "https://example.test/seven/order", label: "サマリー" },
  { key: "customer_design_upload", url: "https://example.test/customer/design", label: "デザイン" },
  { key: "customer_proof_review", url: "https://example.test/customer/proof", label: "校正確認" },
];

const baseInput: FilmOrderNotificationInput = {
  orderId: 41,
  dispatchGroupId: "dispatch-g004-001",
  orderNumber: "F-202611-G004",
  productName: "Three-side seal pouch",
  productSpecification: "PET12/AL7/LLDPE60, 180mm x 260mm, 500m, gravure",
  workflowStage: "data_intake",
  recipients: {
    maker: "maker@example.test",
    seven: "seven@727.co.jp",
    kanei: "kanei@kanei-trade.co.jp",
    customer: "customer@example.test",
  },
  senderIdentity: {
    maker: "Kanei Trade Film Workflow",
    seven: "Kanei Trade Film Workflow",
    kanei: "Film Workflow System",
    customer: "Kanei Trade",
  },
  senderEmail: "workflow-sender@example.test",
  cc: { kanei: ["qa@kanei-trade.co.jp"] },
  maker: {
    companyName: "Hanjin Film",
    contactName: "Kim Maker",
    email: "secret@hanjin.example",
    language: "ko",
  },
  customerName: "Food Company",
  quotationNumber: "Q-202611-041",
  purchaseOrderNumber: "PO-INTERNAL-041",
  internalCostSummary: "cost 123,456 JPY",
  deadlineAt: "2026-11-10T00:00:00.000Z",
  links,
  attachments: [
    { fileName: "FO_C_03.ai", category: "receiving", version: 3, contentType: "application/postscript" },
    { fileName: "FO_C_03.pdf", category: "receiving", version: 3, contentType: "application/pdf" },
  ],
  customerReceivingInputRequired: true,
};

function eventInput(event: FilmOrderNotificationEvent): FilmOrderNotificationInput {
  const stages: Record<FilmOrderNotificationEvent, FilmOrderNotificationInput["workflowStage"]> = {
    receiving_data_request: "maker_requested",
    maker_proof_request: "data_intake",
    proof_received: "customer_review",
    re_proof_request: "correction",
    customer_proof_review: "customer_review",
    customer_proof_decision: "approved",
    final_approval: "final_approvals",
    supplier_purchase_order: "final_approvals",
    eta_update: "po",
    shipment_report: "eta",
    delivery_report: "shipment",
    receipt_completion: "delivery",
    ship_to_request: "customer_review",
    ship_to_registered: "customer_review",
    customer_design_upload: "contract_accepted",
    customer_design_correction: "customer_review",
    customer_design_received: "contract_accepted",
    production_plan_request: "po",
    link_resend: "po",
  };
  return { ...baseInput, workflowStage: stages[event] };
}

describe("film order notification projections", () => {
  it("covers every workflow event with the PRD audience matrix and required links", () => {
    const expectedMatrix: Record<FilmOrderNotificationEvent, FilmOrderNotificationEnvelope["audience"][]> = {
      receiving_data_request: ["maker", "seven", "kanei", "customer"],
      maker_proof_request: ["maker", "seven", "kanei"],
      proof_received: ["seven", "kanei"],
      re_proof_request: ["maker", "seven", "kanei"],
      customer_proof_review: ["customer", "seven", "kanei"],
      customer_proof_decision: ["customer", "seven", "kanei"],
      final_approval: ["maker", "seven", "kanei"],
      supplier_purchase_order: ["maker", "seven", "kanei"],
      eta_update: ["maker", "seven", "kanei"],
      shipment_report: ["maker", "seven", "kanei", "customer"],
      delivery_report: ["maker", "seven", "kanei", "customer"],
      receipt_completion: ["maker", "seven", "kanei", "customer"],
      ship_to_request: ["customer", "seven", "kanei"],
      ship_to_registered: ["customer", "seven", "kanei"],
      customer_design_upload: ["customer", "seven", "kanei"],
      customer_design_correction: ["customer", "seven", "kanei"],
      customer_design_received: ["seven", "kanei"],
      production_plan_request: ["seven"],
      link_resend: ["maker", "seven", "kanei"],
    };

    expect(FILM_ORDER_NOTIFICATION_EVENTS).toHaveLength(19);
    for (const event of FILM_ORDER_NOTIFICATION_EVENTS) {
      expect(expectedFilmOrderNotificationAudiences(event, event === "receiving_data_request"
        ? { customerReceivingInputRequired: true }
        : {})).toEqual(expectedMatrix[event]);
      const result = buildFilmOrderNotifications(event, eventInput(event));
      expect(result.ok, `${event}: ${result.ok ? "" : JSON.stringify(result.errors)}`).toBe(true);
      if (!result.ok) continue;
      expect(result.envelopes.map((envelope) => envelope.audience)).toEqual(expectedMatrix[event]);
      for (const envelope of result.envelopes) {
        const allowed = new Set(FILM_ORDER_LINK_ALLOWLISTS[envelope.audience]);
        expect(envelope.links.every((link) => allowed.has(link.key))).toBe(true);
        expect(envelope.subject).toContain(envelope.orderNumber);
        expect(envelope.body).toContain(envelope.productSpecification);
        expect(envelope.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
  });

  it("does not send customer receiving data request unless customer input is explicitly required", () => {
    const result = buildFilmOrderNotifications("receiving_data_request", {
      ...baseInput,
      customerReceivingInputRequired: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelopes.map((envelope) => envelope.audience)).not.toContain("customer");
  });

  it("sends the optional customer ETA projection only when customer action or expectation is required", () => {
    const withoutCustomer = buildFilmOrderNotifications("eta_update", baseInput);
    const withCustomer = buildFilmOrderNotifications("eta_update", {
      ...baseInput,
      customerEtaActionRequired: true,
    });
    expect(withoutCustomer.ok).toBe(true);
    expect(withCustomer.ok).toBe(true);
    if (withoutCustomer.ok) {
      expect(withoutCustomer.envelopes.map((envelope) => envelope.audience)).not.toContain("customer");
    }
    if (withCustomer.ok) {
      const customer = withCustomer.envelopes.find((envelope) => envelope.audience === "customer")!;
      expect(customer.purpose.kind).toBe("informational");
      expect(JSON.stringify(customer)).not.toContain("Hanjin Film");
      expect(JSON.stringify(customer)).not.toContain("PO-INTERNAL-041");
    }
  });

  it("supports audience-scoped link resend and requires its customer action link", () => {
    const result = buildFilmOrderNotifications("link_resend", {
      ...baseInput,
      linkResendAudiences: ["customer"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelopes.map((envelope) => envelope.audience)).toEqual(["customer"]);
      expect(result.envelopes[0]!.purpose.kind).toBe("action");
      expect(result.envelopes[0]!.links.map((link) => link.key)).toEqual(expect.arrayContaining(["customer_proof_review"]));
    }
  });

  it("renders Korean and Japanese makers from explicit master language without changing state copies", () => {
    const korean = buildFilmOrderNotifications("maker_proof_request", baseInput);
    const japanese = buildFilmOrderNotifications("maker_proof_request", {
      ...baseInput,
      maker: { ...baseInput.maker!, language: "ja" },
    });
    expect(korean.ok).toBe(true);
    expect(japanese.ok).toBe(true);
    if (korean.ok && japanese.ok) {
      const koreanMaker = korean.envelopes.find((envelope) => envelope.audience === "maker")!;
      const japaneseMaker = japanese.envelopes.find((envelope) => envelope.audience === "maker")!;
      expect(koreanMaker.language).toBe("ko");
      expect(koreanMaker.body).toContain("전용 페이지");
      expect(japaneseMaker.language).toBe("ja");
      expect(japaneseMaker.body).toContain("専用ページ");
      const seven = korean.envelopes.find((envelope) => envelope.audience === "seven")!;
      expect(seven.language).toBe("ja");
    }
  });

  it("filters maker identity/contact, internal costs, internal PO, and unsafe links from Seven/customer output", () => {
    const result = buildFilmOrderNotifications("shipment_report", eventInput("shipment_report"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const seven = result.envelopes.find((envelope) => envelope.audience === "seven")!;
    const customer = result.envelopes.find((envelope) => envelope.audience === "customer")!;
    for (const envelope of [seven, customer]) {
      const serialized = JSON.stringify(envelope);
      expect(serialized).not.toContain("Hanjin Film");
      expect(serialized).not.toContain("Kim Maker");
      expect(serialized).not.toContain("secret@hanjin.example");
      expect(serialized).not.toContain("cost 123,456 JPY");
      expect(envelope.links.map((link) => link.key)).toEqual(
        envelope.links.map((link) => link.key),
      );
      for (const forbidden of ["maker_receiving_packet", "maker_proof_upload", "maker_purchase_order", "maker_eta_report", "kanei_order_management"]) {
        expect(envelope.links.map((link) => link.key)).not.toContain(forbidden);
      }
    }
    expect(JSON.stringify(customer)).not.toContain("PO-INTERNAL-041");
    expect(JSON.stringify(seven)).not.toContain("cost 123,456 JPY");
  });

  it("returns one structured issue for every failed ten-point requirement without interpolating blanks", () => {
    const result = buildFilmOrderNotifications("maker_proof_request", {
      ...baseInput,
      orderNumber: "",
      productName: "",
      productSpecification: "",
      workflowStage: "not_a_stage" as FilmOrderNotificationInput["workflowStage"],
      senderIdentity: { maker: "" },
        senderEmail: "workflow-sender@example.test",
      maker: { ...baseInput.maker!, language: "fr" as NonNullable<FilmOrderNotificationInput["maker"]>["language"] },
      recipients: { maker: "not-an-email" },
      links: [],
      deadlineAt: undefined,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const points = new Set(result.errors.map((issue) => issue.point));
    for (const point of [
      "sender_identity", "recipient", "order_number", "product_spec",
      "workflow_stage", "required_link", "language",
    ] as const) {
      expect(points.has(point), point).toBe(true);
    }
    expect(result.envelopes).toEqual([]);
    expect(JSON.stringify(result.errors)).not.toContain("： ");
  });

  it("interpolates compatible overrides before validation and rejects incomplete final output", () => {
    const compatible = buildFilmOrderNotifications("maker_proof_request", {
      ...baseInput,
      overrides: {
        film_proof_request: {
          subject: "OVER-RIDE [교정 데이터 제출 요청] {{orderNumber}} {{productName}}",
          body: [
            "전용 페이지에서 AI와 PDF 교정 데이터를 제출해 주십시오.",
            "発注番号：{{orderNumber}}",
            "品名：{{productName}}",
            "仕様：{{productSpecification}}",
            "現在のワークフロー段階：{{workflowStage}}",
            "다음 단계：{{nextStep}}",
            "制作データ：{{makerReceivingPacketUrl}}",
            "提出ページ：{{makerProofUploadUrl}}",
            "宛先：{{recipient}}",
          ].join("\n"),
        },
      },
    });
    expect(compatible.ok, compatible.ok ? "" : JSON.stringify(compatible.errors)).toBe(true);
    if (compatible.ok) {
      const maker = compatible.envelopes.find((envelope) => envelope.audience === "maker")!;
      expect(maker.effectiveTemplateIdentity).toEqual({
        key: "film_order.maker_proof_request.maker",
        source: "override",
        bindingFingerprint: "default",
        compatibilityKey: "film_proof_request",
      });
      expect(maker.subject).toContain("OVER-RIDE [교정 데이터 제출 요청] F-202611-G004 Three-side seal pouch");
      expect(maker.body).toContain("提出ページ：https://example.test/proof/token");
    }

    const incomplete = buildFilmOrderNotifications("maker_proof_request", {
      ...baseInput,
      overrides: {
        film_proof_request: {
          subject: "incomplete {{orderNumber}}",
          body: "body-only {{nonBlank}}",
        },
      },
    });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) {
      expect(incomplete.errors.some((issue) => issue.point === "action_or_purpose")).toBe(true);
      expect(incomplete.errors.some((issue) => issue.point === "required_link")).toBe(true);
      expect(JSON.stringify(incomplete.errors)).not.toContain("{{nonBlank}}");
    }
  });

  it("rejects an override that removes the purpose marker from the subject", () => {
    const result = buildFilmOrderNotifications("maker_proof_request", {
      ...baseInput,
      overrides: {
        film_proof_request: {
          subject: "no purpose {{orderNumber}} {{productName}}",
          body: [
            "専用ページからAIとPDFの校正データを提出してください。",
            "発注番号：{{orderNumber}}",
            "品名：{{productName}}",
            "仕様：{{productSpecification}}",
            "現在のワークフロー段階：{{workflowStage}}",
            "次のステップ：提出後に顧客校正確認へ進みます。",
            "制作データ：{{makerReceivingPacketUrl}}",
            "提出ページ：{{makerProofUploadUrl}}",
            "宛先：{{recipient}}",
          ].join("\n"),
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.filter((issue) => issue.point === "purpose").map((issue) => issue.code))
        .toEqual(["notification_purpose_missing"]);
    }
  });

  it("rejects an override that injects a forbidden or untyped link into a restricted audience", () => {
    const result = buildFilmOrderNotifications("customer_proof_review", {
      ...baseInput,
      overrides: {
        "film_order.customer_proof_review.customer": {
          subject: "悪意あるリンク {{orderNumber}} {{productName}}",
          body: [
            "校正データを確認してください。",
            "発注番号：{{orderNumber}}",
            "品名：{{productName}}",
            "仕様：{{productSpecification}}",
            "現在のワークフロー段階：{{workflowStage}}",
            "次のステップ：確認後に承認します。",
            "内部リンク：https://example.test/proof/token",
            "宛先：{{recipient}}",
          ].join("\n"),
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((issue) => issue.code === "untyped_link_forbidden")).toBe(true);
  });

  it("rejects malformed, oversized, untrusted-scheme, and cross-audience link keys", () => {
    const base = buildFilmOrderNotifications("eta_update", eventInput("eta_update"));
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const maker = base.envelopes.find((envelope) => envelope.audience === "maker")!;
    const malformed = validateFilmOrderNotification({
      ...maker,
      links: [{ key: "maker_eta_report", url: "javascript:alert(1)" }],
      body: maker.body.replace(maker.links[0]!.url, "javascript:alert(1)"),
    });
    expect(malformed.ok).toBe(false);
    expect(malformed.issues.some((issue) => issue.code === "link_url_invalid")).toBe(true);

    const oversizedUrl = `https://example.test/${"a".repeat(2048)}`;
    const oversized = validateFilmOrderNotification({
      ...maker,
      links: [{ key: "maker_eta_report", url: oversizedUrl }],
      body: maker.body.replace(maker.links[0]!.url, oversizedUrl),
    });
    expect(oversized.ok).toBe(false);
    expect(oversized.issues.some((issue) => issue.code === "link_url_invalid")).toBe(true);

    const crossAudience = validateFilmOrderNotification({
      ...maker,
      links: [...maker.links, { key: "kanei_order_management", url: "https://example.test/kanei" }],
    });
    expect(crossAudience.ok).toBe(false);
    expect(crossAudience.issues.some((issue) => issue.code === "link_audience_forbidden")).toBe(true);
  });

  it("computes a canonical hash that is stable across key order and sensitive to every mail identity field", () => {
    const result = buildFilmOrderNotifications("maker_proof_request", baseInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const envelope = result.envelopes[0]!;
    expect(filmOrderNotificationEnvelopeHash(envelope)).toBe(envelope.contentHash);
    const same = buildFilmOrderNotifications("maker_proof_request", baseInput);
    expect(same.ok).toBe(true);
    if (same.ok) expect(same.envelopes[0]!.contentHash).toBe(envelope.contentHash);

    const changedSubject = buildFilmOrderNotifications("maker_proof_request", {
      ...baseInput,
      overrides: {
        "film_order.maker_proof_request.maker": { subject: `mutation [${envelope.subject.slice(1)}` },
      },
    });
    expect(changedSubject.ok).toBe(true);
    if (changedSubject.ok) {
      const changedEnvelope = changedSubject.envelopes[0]!;
      expect(changedEnvelope.subject).toContain("mutation");
      expect(changedEnvelope.contentHash).not.toBe(envelope.contentHash);
    }
    const changedCc = buildFilmOrderNotifications("maker_proof_request", {
      ...baseInput,
      cc: { maker: ["another@example.test"] },
    });
    expect(changedCc.ok).toBe(true);
    if (changedCc.ok) expect(changedCc.envelopes[0]!.contentHash).not.toBe(envelope.contentHash);
  });
});
