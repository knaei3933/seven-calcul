import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.fn(async (input: Record<string, unknown>) => ({
  to: String(input.to),
  recipientOverridden: false,
  subject: String(input.subject ?? ""),
  dryRun: true,
  messageId: "retry-test-message",
}));
vi.mock("@/lib/mailer", () => ({ sendMail: (input: Parameters<typeof import("@/lib/mailer").sendMail>[0]) => sendMailMock(input as unknown as Record<string, unknown>) }));

const databaseDirectory = await mkdtemp(join(tmpdir(), "g011-review-blockers-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.MAIL_DRY_RUN = "true";
delete process.env.MAIL_RECIPIENT_OVERRIDE;

const { getSqlClient } = await import("@/lib/db");
const raw = await getSqlClient("quotations");
await raw.exec(`
  CREATE TABLE quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'approved',
    created_by INTEGER,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
`);
let orderId = 0;
let retryOutboxId = 0;

beforeAll(async () => {
  const { getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
  const db = await getDatabaseForFilmMakerStore();
  await db.run("INSERT INTO quotations (status,payload_json) VALUES ('approved',?)", [
    JSON.stringify({ customerCode: "G011-CUSTOMER", customerEmail: "g011-customer@example.test" }),
  ]);
  const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO film_orders (
      quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
      film_composition,order_length_m,web_width_mm,pouch_quantity,supplier_name,supplier_email,seven_contact_email,buyer_domain,
      supplier_resolution,status,customer_design_status,ship_to_status,purchase_order_json,ordered_at,created_at,updated_at
    ) VALUES (?, 'G011-001','Q-G011-001','Review pouch','Review customer','digital','Y','PET','300','400','1000','','','seven@727.co.jp','727.co.jp',
              'legacy_unresolved','ordered','not_required','confirmed','{}',?,?,?)
  `, [quotation!.id, now, now, now]);
  const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='G011-001'");
  orderId = Number(order!.id);
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function envelopesForEvent(event: Parameters<typeof import("@/lib/film-order-notifications").buildFilmOrderNotifications>[0]) {
  return async (cc: readonly string[] = []) => {
    const { buildFilmOrderNotifications } = await import("@/lib/film-order-notifications");
    const result = buildFilmOrderNotifications(event, {
      orderId,
      dispatchGroupId: `g011-retry-${event}`,
      orderNumber: "G011-001",
      productName: "Review pouch",
      productSpecification: "PET, 400mm, 300m, digital",
      workflowStage: "po",
      recipients: { maker: "same-route-ko@example.test", seven: "seven@727.co.jp", kanei: "kanei@kanei-trade.co.jp" },
      senderIdentity: { maker: "Workflow", seven: "Workflow", kanei: "Workflow" },
      senderEmail: "workflow-sender@example.test",
      maker: { companyName: "Same Route Korean Maker", email: "same-route-ko@example.test", language: "ko" },
      cc: { maker: cc },
      links: [
        { key: "maker_purchase_order", url: "https://example.test/po" },
        { key: "maker_eta_report", url: "https://example.test/eta" },
        { key: "seven_order_summary", url: "https://example.test/seven" },
        { key: "kanei_order_management", url: "https://example.test/kanei" },
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.envelopes;
  };
}

describe("G011 final review blockers", () => {
  it("rejects malicious forwarded origins and accepts only explicit deployment origins", async () => {
    const { isAllowedFilmOrderExternalOrigin } = await import("@/lib/film-order-origin");
    const defaultOrigin = process.env.FILM_DEFAULT_EXTERNAL_LINK_ORIGIN;
    expect(isAllowedFilmOrderExternalOrigin(defaultOrigin)).toBe(true);
    expect(isAllowedFilmOrderExternalOrigin("https://evil.example.test")).toBe(false);
    expect(isAllowedFilmOrderExternalOrigin("https://seven-calcul.vercel.app")).toBe(false);
    expect(isAllowedFilmOrderExternalOrigin("https://deployed.example.test/path")).toBe(false);
  });

  it("rejects internal runtime suppliers and selects a same-route maker whose master language differs from route inference", async () => {
    const { runFilmOrderAction } = await import("@/lib/film-orders");
    await expect(runFilmOrderAction(orderId, "set-supplier", {
      supplierName: "Kanei Trade",
      supplierEmail: "ops@kanei-trade.co.jp",
      reason: "must never contact internal staff",
    }, "kanei@kanei-trade.co.jp")).rejects.toThrow("internal_film_maker_rejected");
    const { createFilmMaker, selectFilmMakerForOrder } = await import("@/lib/film-maker-store");
    const maker = await createFilmMaker({
      makerCode: "G011-Y-KO",
      companyName: "Same Route Korean Maker",
      email: "same-route-ko@example.test",
      language: "ko",
      printMethod: "digital",
      procurementRoute: "Y",
    }, "kanei@kanei-trade.co.jp");
    const selected = await selectFilmMakerForOrder(orderId, maker.id, "kanei@kanei-trade.co.jp");
    expect(selected.snapshot).toMatchObject({ language: "ko", procurementRoute: "Y", printMethod: "digital" });
    const { buildFilmOrderNotifications } = await import("@/lib/film-order-notifications");
    const result = buildFilmOrderNotifications("maker_proof_request", {
      orderId,
      dispatchGroupId: "g011-language",
      orderNumber: "G011-001",
      productName: "Review pouch",
      productSpecification: "digital",
      workflowStage: "maker_requested",
      recipients: { maker: maker.email, seven: "seven@727.co.jp", kanei: "kanei@kanei-trade.co.jp" },
      senderIdentity: { maker: "Workflow", seven: "Workflow", kanei: "Workflow" },
      senderEmail: "workflow-sender@example.test",
      maker: { companyName: maker.companyName, email: maker.email, language: maker.language },
      links: [
        { key: "maker_proof_upload", url: "https://example.test/upload" },
        { key: "maker_receiving_packet", url: "https://example.test/packet" },
        { key: "seven_order_summary", url: "https://example.test/seven" },
        { key: "kanei_order_management", url: "https://example.test/kanei" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.envelopes[0]?.language).toBe("ko");
  });

  it("rejects offline customer approval without evidence and reason", async () => {
    const { prepareFilmOrderMail, confirmFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    const { getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
    const db = await getDatabaseForFilmMakerStore();
    await db.run(`
      UPDATE film_orders SET status='receiving_registered', customer_proof_status='pending', updated_at=?
      WHERE id=?
    `, [new Date().toISOString(), orderId]);
    const command = {
      orderId,
      action: "register-proof" as const,
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000" as const,
      proofFileName: "g011-proof.ai",
      proofFileUrl: "https://example.test/g011-proof.ai",
    };
    const preview = await prepareFilmOrderMail({ ...command, proofPdfFileName: "g011-proof.pdf", proofPdfFileUrl: "https://example.test/g011-proof.pdf" });
    await confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash));
    await db.run(`
      UPDATE film_orders SET status='proof_registered', customer_proof_status='pending', updated_at=?
      WHERE id=?
    `, [new Date().toISOString(), orderId]);
    const approvalCommand = { ...command, action: "record-customer-proof-approval" as const, approverName: "Approver", offlineEvidence: "email reply", offlineReason: "audited offline review" };
    const approvalPreview = await prepareFilmOrderMail(approvalCommand);
    approvalPreview.command = { ...approvalPreview.command, offlineEvidence: "", offlineReason: "" };
    await expect(confirmFilmOrderMail(approvalPreview, approvalPreview.envelopes.map((envelope) => envelope.contentHash))).rejects.toThrow("customer_proof_evidence_required");
    approvalPreview.command = approvalCommand;
    await confirmFilmOrderMail(approvalPreview, approvalPreview.envelopes.map((envelope) => envelope.contentHash));
    const approvalAudit = await db.get<{ detail: string }>(
      "SELECT detail FROM film_order_events WHERE order_id=? AND type='customer_proof' ORDER BY id DESC LIMIT 1",
      [orderId],
    );
    expect(approvalAudit?.detail).toContain("email reply");
    expect(approvalAudit?.detail).toContain("audited offline review");
  });

  it("retries only failed groups while preserving successful audiences and non-empty CC", async () => {
    const { persistFilmOrderMailEnvelopes, startFilmOrderMailAttempt, recordFilmOrderMailAttemptOutcome, getFilmOrderMailOutbox, verifyFilmOrderMailEnvelope } = await import("@/lib/film-order-mail-outbox");
    const envelopes = await envelopesForEvent("supplier_purchase_order")(["audit-cc@example.test"]);
    const persisted = await persistFilmOrderMailEnvelopes(envelopes, { requestedByEmail: "kanei@kanei-trade.co.jp", envelopeStatus: "composed" });
    retryOutboxId = persisted.find((record) => record.audience === "maker")!.id;
    const failedAttempt = await startFilmOrderMailAttempt({ outboxId: retryOutboxId, requestedByEmail: "operator@kanei-trade.co.jp" });
    await recordFilmOrderMailAttemptOutcome({ outboxId: retryOutboxId, attemptCount: failedAttempt.attemptCount, status: "retry_required", errorCode: "smtp_temporary" });
    const successful = persisted.find((record) => record.audience === "seven")!;
    const successAttempt = await startFilmOrderMailAttempt({ outboxId: successful.id, requestedByEmail: "operator@kanei-trade.co.jp" });
    await recordFilmOrderMailAttemptOutcome({ outboxId: successful.id, attemptCount: successAttempt.attemptCount, status: "sent", smtpMessageId: "success" });
    const envelope = await getFilmOrderMailOutbox(retryOutboxId);
    expect(envelope?.cc).toEqual(["audit-cc@example.test"]);
    expect(() => verifyFilmOrderMailEnvelope(envelope!)).not.toThrow();
    const { retryFilmOrderMailDispatch } = await import("@/lib/film-order-mail-lifecycle");
    sendMailMock.mockClear();
    const result = await retryFilmOrderMailDispatch(orderId, envelopes[0]!.dispatchGroupId, "operator@kanei-trade.co.jp");
    const makerRetry = result.outcomes.find((outcome) => outcome.audience === "maker");
    const sevenPreserved = result.outcomes.find((outcome) => outcome.audience === "seven");
    expect(makerRetry).toMatchObject({ attemptCount: 2, status: "skipped" });
    expect(sevenPreserved).toMatchObject({ attemptCount: 1, status: "sent" });
    const successfulInput = sendMailMock.mock.calls.filter((call) => call[0].to === "seven@727.co.jp");
    expect(successfulInput).toHaveLength(0);
    expect(sendMailMock.mock.calls.find((call) => call[0].to === "same-route-ko@example.test")?.[0].cc).toEqual(["audit-cc@example.test"]);
    expect(sendMailMock.mock.calls.find((call) => call[0].to === "same-route-ko@example.test")?.[0].senderEmail).toBe("workflow-sender@example.test");
  });

  it("fails closed on corrupted persisted outbox JSON and reports stale sending as unknown on order load", async () => {
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    await db.run("UPDATE film_order_mail_outbox SET cc_json='{not-json}' WHERE id=?", [retryOutboxId]);
    const { getFilmOrderMailOutbox } = await import("@/lib/film-order-mail-outbox");
    await expect(getFilmOrderMailOutbox(retryOutboxId)).rejects.toThrow("film_order_mail_outbox_corrupted:cc_json");
    const { getFilmOrderMailOutbox: restoreRead } = await import("@/lib/film-order-mail-outbox");
    await db.run("UPDATE film_order_mail_outbox SET cc_json='[]' WHERE id=?", [retryOutboxId]);
    const restored = await restoreRead(retryOutboxId);
    const { startFilmOrderMailAttempt } = await import("@/lib/film-order-mail-outbox");
    await db.run("UPDATE film_order_mail_attempts SET status='retry_required' WHERE outbox_id=? AND attempt_count=2", [restored!.id]);
    const stale = await startFilmOrderMailAttempt({ outboxId: restored!.id, requestedByEmail: "operator@kanei-trade.co.jp" });
    const staleTime = new Date(Date.now() - 3 * 60_000).toISOString();
    await db.run("UPDATE film_order_mail_attempts SET attempt_started_at=? WHERE id=?", [staleTime, stale.id]);
    await (await import("@/lib/film-orders")).getFilmOrder(orderId);
    const attempt = await db.get<{ status: string }>("SELECT status FROM film_order_mail_attempts WHERE id=?", [stale.id]);
    expect(attempt?.status).toBe("unknown");
  });

  it("rejects cancellation after concurrent confirmation promoted the draft", async () => {
    const { prepareFilmOrderMail, confirmFilmOrderMail, cancelFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    await db.run("UPDATE film_orders SET status='ordered' WHERE id=?", [orderId]);
    const command = {
      orderId,
      action: "request-customer-design-upload" as const,
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000" as const,
    };
    const preview = await prepareFilmOrderMail(command);
    await confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash));
    await expect(cancelFilmOrderMail(orderId, preview.dispatchGroupId)).rejects.toThrow("film_order_mail_confirm_conflict");
  });

  it("projects Seven preview without maker contact data and selects latest attachment versions deterministically", async () => {
    const { serializeFilmOrderActionForActor } = await import("@/lib/film-order-disclosure");
    const { buildFilmOrderNotifications } = await import("@/lib/film-order-notifications");
    const built = buildFilmOrderNotifications("customer_design_upload", {
      orderId,
      dispatchGroupId: "g011-seven-preview",
      orderNumber: "G011-001",
      productName: "Review pouch",
      productSpecification: "digital",
      workflowStage: "maker_requested",
      recipients: { maker: "same-route-ko@example.test", seven: "seven@727.co.jp", customer: "g011-customer@example.test", kanei: "kanei@kanei-trade.co.jp" },
      senderIdentity: { maker: "Workflow", seven: "Workflow", customer: "Workflow", kanei: "Workflow" },
      senderEmail: "workflow-sender@example.test",
      maker: { companyName: "Same Route Korean Maker", email: "same-route-ko@example.test", language: "ko" },
      links: [
        { key: "customer_design_upload", url: "https://example.test/customer" },
        { key: "seven_order_summary", url: "https://seven-safe.example.test/summary" },
        { key: "kanei_order_management", url: "https://kanei.example.test/summary" },
      ],
      attachments: [
        { fileName: "proof-v1.ai", category: "proof", version: 1 },
        { fileName: "proof-v10.pdf", category: "proof", version: 10 },
        { fileName: "proof-v2.pdf", category: "proof", version: 2 },
      ],
    });
    expect(built.ok).toBe(true);
    const serialized = serializeFilmOrderActionForActor({
      preview: {
        dispatchGroupId: "g011-seven-preview",
        event: "customer_design_upload",
        envelopes: built.ok ? built.envelopes : [],
        stagedTokenHashes: ["token-hash"],
        warnings: ["mail_test_mode_enabled"],
      },
    }, "seven@727.co.jp");
    const preview = serialized.preview as { envelopes: Array<{ audience: string; links: Array<{ key: string }>; body: string }>; stagedTokenHashes: string[]; warnings: string[] };
    expect(preview.envelopes.every((envelope) => envelope.audience === "seven")).toBe(true);
    expect(preview.envelopes.every((envelope) => envelope.links.every((link) => link.key === "seven_order_summary"))).toBe(true);
    expect(JSON.stringify(preview)).not.toContain("same-route-ko@example.test");
    expect(JSON.stringify(preview)).not.toContain("https://kanei.example.test/summary");
    expect(preview.stagedTokenHashes).toEqual(["token-hash"]);
    expect(preview.warnings).toContain("mail_test_mode_enabled");
  });
});
