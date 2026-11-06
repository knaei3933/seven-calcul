import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

function defaultSendMail(input: Record<string, unknown>) {
  return {
    to: String(process.env.MAIL_RECIPIENT_OVERRIDE || input.to),
    requestedTo: process.env.MAIL_RECIPIENT_OVERRIDE ? String(input.to) : undefined,
    recipientOverridden: Boolean(process.env.MAIL_RECIPIENT_OVERRIDE),
    subject: String(input.subject ?? "subject"),
    dryRun: true,
  };
}

type SendMailMockResult = {
  to: string;
  requestedTo?: string;
  recipientOverridden: boolean;
  subject: string;
  dryRun: boolean;
  messageId?: string;
  error?: string;
};

const sendMailMock = vi.fn<(input: Record<string, unknown>) => Promise<SendMailMockResult>>(
  async (input) => defaultSendMail(input),
);
vi.mock("@/lib/mailer", () => ({ sendMail: (input: Parameters<typeof import("@/lib/mailer").sendMail>[0]) => sendMailMock(input as unknown as Record<string, unknown>) }));
import {
  cancelFilmOrderMail,
  cancelFilmOrderMailForActor,
  confirmFilmOrderMail,
  prepareFilmOrderMail,
  type FilmOrderMailPreview,
  retryFilmOrderMailDispatch,
} from "@/lib/film-order-mail-lifecycle";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-order-mail-lifecycle-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.MAIL_DRY_RUN = "true";
delete process.env.MAIL_RECIPIENT_OVERRIDE;

let orderId = 0;
let resendOrderId = 0;

beforeAll(async () => {
  const { getSqlClient } = await import("@/lib/db");
  const raw = await getSqlClient("quotations");
  await raw.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE IF NOT EXISTS mail_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'approved',
      created_by INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  const { getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
  const db = await getDatabaseForFilmMakerStore();
  const now = new Date().toISOString();
  await db.run("INSERT INTO quotations (status,created_by,payload_json) VALUES ('approved',NULL,?)", [
    JSON.stringify({ customerCode: "LIFE-CUSTOMER", customerEmail: "customer@example.test" }),
  ]);
  const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
  await db.run(`
    INSERT INTO film_makers (maker_code,company_name,contact_name,email,language,print_method,procurement_route,is_active,created_at,updated_at)
    VALUES ('LIFE-KOR-001','Lifecycle Maker','Maker Contact','maker@example.test','ko','gravure','K',1,?,?)
  `, [now, now]);
  const maker = await db.get<{ id: number }>("SELECT id FROM film_makers WHERE maker_code='LIFE-KOR-001'");
  const snapshot = {
    id: Number(maker!.id),
    makerCode: "LIFE-KOR-001",
    companyName: "Lifecycle Maker",
    contactName: "Maker Contact",
    email: "maker@example.test",
    language: "ko",
    printMethod: "gravure",
    procurementRoute: "K",
    isActive: 1,
    selectedAt: now,
    selectedByEmail: "kanei@example.test",
  };
  await db.run(`
    INSERT INTO film_orders (
      quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
      film_composition,order_length_m,web_width_mm,pouch_quantity,supplier_name,supplier_email,seven_contact_email,buyer_domain,
      film_maker_id,film_maker_snapshot_json,supplier_resolution,status,customer_design_status,ship_to_status,
      purchase_order_json,ordered_at,created_at,updated_at
    ) VALUES (?, 'LIFE-001','Q-LIFE-001','Lifecycle pouch','Lifecycle customer','gravure','K','PET/AL/PE','300','400','1000','Lifecycle Maker','maker@example.test','seven@727.co.jp','727.co.jp',?,?, 'master_selected','ordered','not_required','confirmed','{}',?,?,?)
  `, [quotation!.id, maker!.id, JSON.stringify(snapshot), now, now, now]);
  const inserted = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='LIFE-001'");
  orderId = Number(inserted!.id);
  await db.run(`
    INSERT INTO film_order_external_tokens (
      film_order_id,purpose,token_state,token_hash,audience_email,expires_at,created_by_email,created_at,updated_at
    ) VALUES (?, 'supplier_proof','active','existing-active-proof-hash','maker@example.test',?, 'kanei@example.test',?,?)
  `, [orderId, new Date(Date.now() + 86400000).toISOString(), now, now]);

  await db.run("INSERT INTO quotations (status,created_by,payload_json) VALUES ('approved',NULL,?)", [
    JSON.stringify({ customerCode: "LIFE-CUSTOMER", customerEmail: "customer@example.test" }),
  ]);
  const resendQuotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
  await db.run(`
    INSERT INTO film_orders (
      quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
      film_composition,order_length_m,web_width_mm,pouch_quantity,supplier_name,supplier_email,seven_contact_email,buyer_domain,
      film_maker_id,film_maker_snapshot_json,supplier_resolution,status,customer_design_status,ship_to_status,
      purchase_order_json,ordered_at,created_at,updated_at
    ) VALUES (?, 'LIFE-002','Q-LIFE-002','Resend pouch','Lifecycle customer','gravure','K','PET/AL/PE','300','400','1000','Lifecycle Maker','maker@example.test','seven@727.co.jp','727.co.jp',?,?,'master_selected','ordered','not_required','confirmed','{}',?,?,?)
  `, [resendQuotation!.id, maker!.id, JSON.stringify(snapshot), now, now, now]);
  const resendInserted = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='LIFE-002'");
  resendOrderId = Number(resendInserted!.id);

  await db.run("INSERT INTO quotations (status,created_by,payload_json) VALUES ('approved',NULL,'{}')");
  const legacyQuotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
  await db.run(`
    INSERT INTO film_orders (
      quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
      film_composition,order_length_m,web_width_mm,pouch_quantity,supplier_name,supplier_email,seven_contact_email,buyer_domain,
      supplier_resolution,status,customer_design_status,ship_to_status,purchase_order_json,ordered_at,created_at,updated_at
    ) VALUES (?, 'LIFE-LEGACY-001','Q-LIFE-LEGACY','Legacy pouch','Lifecycle customer','gravure','K',
              'PET/AL/PE','300','400','1000','Historical Maker','legacy-external@example.test','seven@727.co.jp','727.co.jp',
              'legacy_unresolved','ordered','not_required','confirmed','{}',?,?,?)
  `, [legacyQuotation!.id, now, now, now]);
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("SQLite film-order mail lifecycle", () => {
  it("prepares drafts and staged tokens without authoritative mutation", async () => {
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const before = await db.get<{ status: string; receiving_registered_at: string | null; updated_at: string }>(
      "SELECT status,receiving_registered_at,updated_at FROM film_orders WHERE id=?", [orderId],
    );
    const filesBefore = await db.all<{ id: number }>("SELECT id FROM film_order_files WHERE order_id=?", [orderId]);
    const preview = await prepareFilmOrderMail({
      orderId,
      action: "register-receiving",
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000",
      aiFileName: "packet.ai",
      aiFileUrl: "https://example.test/packet.ai",
      pdfFileName: "packet.pdf",
      pdfFileUrl: "https://example.test/packet.pdf",
    });
    const after = await db.get<{ status: string; receiving_registered_at: string | null; updated_at: string }>(
      "SELECT status,receiving_registered_at,updated_at FROM film_orders WHERE id=?", [orderId],
    );
    const filesAfter = await db.all<{ id: number }>("SELECT id FROM film_order_files WHERE order_id=?", [orderId]);
    expect(after).toEqual(before);
    expect(filesAfter).toHaveLength(filesBefore.length);
    expect(preview.event).toBe("receiving_data_request");
    expect(preview.envelopes.map((envelope) => envelope.audience)).toEqual(["maker", "seven", "kanei"]);
    expect(preview.envelopes.every((envelope) => /^[0-9a-f]{64}$/u.test(envelope.contentHash))).toBe(true);
    expect(preview.stagedTokens[0]?.url).toContain("/film-orders/upload/");
    const drafts = await db.all<{ envelope_status: string }>(
      "SELECT envelope_status FROM film_order_mail_outbox WHERE dispatch_group_id=?", [preview.dispatchGroupId],
    );
    const tokens = await db.all<{ token_state: string; dispatch_group_id: string | null }>(
      "SELECT token_state,dispatch_group_id FROM film_order_external_tokens WHERE film_order_id=?", [orderId],
    );
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => draft.envelope_status === "draft")).toBe(true);
    expect(tokens.some((token) => token.token_state === "staged")).toBe(true);
    expect(tokens.some((token) => token.token_state === "active")).toBe(true);
  });

  it("blocks unresolved legacy supplier contact until explicit reconciliation, then preserves history", async () => {
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const unresolved = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE order_number='LIFE-LEGACY-001'",
    );
    const unresolvedId = Number(unresolved!.id);
    await expect(prepareFilmOrderMail({
      orderId: unresolvedId,
      action: "register-receiving",
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000",
      aiFileName: "legacy.ai",
      aiFileUrl: "https://example.test/legacy.ai",
      pdfFileName: "legacy.pdf",
      pdfFileUrl: "https://example.test/legacy.pdf",
    })).rejects.toThrow("film_maker_resolution_required");

    const before = await db.get<{
      supplier_name: string;
      supplier_email: string;
      supplier_resolution: string;
      film_maker_id: number | null;
      updated_at: string;
    }>("SELECT supplier_name,supplier_email,supplier_resolution,film_maker_id,updated_at FROM film_orders WHERE id=?", [unresolvedId]);
    const { exemptLegacyOrder } = await import("@/lib/film-maker-store");
    await exemptLegacyOrder(unresolvedId, "既存案件のため対象外", "external_no_match", "admin@kanei-trade.co.jp");
    const after = await db.get<{
      supplier_name: string;
      supplier_email: string;
      supplier_resolution: string;
      film_maker_id: number | null;
      updated_at: string;
    }>("SELECT supplier_name,supplier_email,supplier_resolution,film_maker_id,updated_at FROM film_orders WHERE id=?", [unresolvedId]);
    expect(after).toBeTruthy();
    expect(after!).toEqual({
      ...before,
      supplier_resolution: "legacy_exempt",
      updated_at: after!.updated_at,
    });
    expect(after!.updated_at).not.toBe(before!.updated_at);
    const audit = await db.get<{ type: string; detail: string }>(
      "SELECT type,detail FROM film_order_events WHERE order_id=? ORDER BY id DESC LIMIT 1", [unresolvedId],
    );
    expect(audit).toMatchObject({ type: "legacy_supplier_reconciliation", detail: expect.stringContaining("既存案件のため対象外") });

    await expect(prepareFilmOrderMail({
      orderId: unresolvedId,
      action: "register-receiving",
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000",
      aiFileName: "legacy-exempt.ai",
      aiFileUrl: "https://example.test/legacy-exempt.ai",
      pdfFileName: "legacy-exempt.pdf",
      pdfFileUrl: "https://example.test/legacy-exempt.pdf",
    })).rejects.toThrow("film_maker_resolution_required");
  });

  it("cancels only staged mail state and preserves active links and business state", async () => {
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const preview = await prepareFilmOrderMail({
      orderId,
      action: "register-receiving",
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000",
      aiFileName: "cancel.ai",
      aiFileUrl: "https://example.test/cancel.ai",
      pdfFileName: "cancel.pdf",
      pdfFileUrl: "https://example.test/cancel.pdf",
    });
    const before = await db.get<{ status: string; updated_at: string }>(
      "SELECT status,updated_at FROM film_orders WHERE id=?", [orderId],
    );
    await expect(cancelFilmOrderMailForActor(orderId, preview.dispatchGroupId, "kanei@example.test"))
      .rejects.toThrow("film_order_mail_cancel_forbidden");
    const cancelled = await cancelFilmOrderMailForActor(orderId, preview.dispatchGroupId, "seven@727.co.jp");
    const after = await db.get<{ status: string; updated_at: string }>(
      "SELECT status,updated_at FROM film_orders WHERE id=?", [orderId],
    );
    const statuses = await db.all<{ envelope_status: string }>(
      "SELECT envelope_status FROM film_order_mail_outbox WHERE dispatch_group_id=?", [preview.dispatchGroupId],
    );
    const tokens = await db.all<{ token_state: string; dispatch_group_id: string | null }>(
      "SELECT token_state FROM film_order_external_tokens WHERE film_order_id=?", [orderId],
    );
    const cancelledGroupTokens = tokens.filter((token) => token.dispatch_group_id === preview.dispatchGroupId);
    expect(cancelled).toMatchObject({ skippedCount: 3, authoritativeStateChanged: false });
    expect(before).toEqual(after);
    expect(statuses.every((status) => status.envelope_status === "skipped")).toBe(true);
    expect(cancelledGroupTokens.every((token) => token.token_state !== "staged")).toBe(true);
    expect(tokens.some((token) => token.token_state === "active")).toBe(true);
  });

  it("rejects stale full-envelope hashes atomically before business commit", async () => {
    const preview = await prepareFilmOrderMail({
      orderId,
      action: "register-receiving",
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000",
      aiFileName: "packet2.ai",
      aiFileUrl: "https://example.test/packet2.ai",
      pdfFileName: "packet2.pdf",
      pdfFileUrl: "https://example.test/packet2.pdf",
    });
    await expect(confirmFilmOrderMail(preview, ["stale-hash"])).rejects.toThrow("film_order_mail_hash_mismatch");
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const after = await db.get<{ status: string }>("SELECT status FROM film_orders WHERE id=?", [orderId]);
    const files = await db.all<{ id: number }>("SELECT id FROM film_order_files WHERE order_id=?", [orderId]);
    const tokens = await db.all<{ token_state: string }>(
      "SELECT token_state FROM film_order_external_tokens WHERE film_order_id=?", [orderId],
    );
    expect(after?.status).toBe("ordered");
    expect(files).toHaveLength(0);
    expect(tokens.some((token) => token.token_state === "staged")).toBe(true);
  });

  it("commits transition, activates tokens, promotes envelopes, audits intent, and starts all attempts", async () => {
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const preview = await prepareFilmOrderMail({
      orderId,
      action: "register-receiving",
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000",
      aiFileName: "packet3.ai",
      aiFileUrl: "https://example.test/packet3.ai",
      pdfFileName: "packet3.pdf",
      pdfFileUrl: "https://example.test/packet3.pdf",
    });
    const result = await confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash));
    const order = await db.get<{ status: string; receiving_registered_at: string | null }>(
      "SELECT status,receiving_registered_at FROM film_orders WHERE id=?", [orderId],
    );
    const files = await db.all<{ category: string; file_name: string }>(
      "SELECT category,file_name FROM film_order_files WHERE order_id=?", [orderId],
    );
    const tokens = await db.all<{ purpose: string; token_state: string; token_hash: string; dispatch_group_id: string | null }>(
      "SELECT purpose,token_state,token_hash FROM film_order_external_tokens WHERE film_order_id=?", [orderId],
    );
    const envelopes = await db.all<{ envelope_status: string }>(
      "SELECT envelope_status FROM film_order_mail_outbox WHERE dispatch_group_id=?", [preview.dispatchGroupId],
    );
    const attempts = await db.all<{ status: string }>(
      "SELECT a.status FROM film_order_mail_attempts a JOIN film_order_mail_outbox o ON o.id=a.outbox_id WHERE o.dispatch_group_id=?",
      [preview.dispatchGroupId],
    );
    const audit = await db.all<{ detail: string }>(
      "SELECT detail FROM film_order_events WHERE order_id=? AND type='mail_audit'", [orderId],
    );
    expect(order?.status).toBe("receiving_registered");
    expect(order?.receiving_registered_at).toBeTruthy();
    expect(files.map((file) => `${file.category}:${file.file_name}`)).toEqual(["receiving:packet3.ai", "receiving:packet3.pdf"]);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(result.workflowCompleted).toBe(true);
    expect(result.notificationCompleted).toBe(false);
    expect(tokens.filter((token) => token.purpose === "supplier_proof" && token.token_state === "active")).toHaveLength(1);
    expect(tokens.filter((token) => token.dispatch_group_id === preview.dispatchGroupId && token.token_state === "staged")).toHaveLength(0);
    expect(envelopes.every((envelope) => envelope.envelope_status === "composed")).toBe(true);
    expect(attempts).toHaveLength(3);
    expect(audit.some((event) => event.detail === `dispatch intent ${preview.dispatchGroupId}`)).toBe(true);
  });

  it("confirms the exact persisted preview dispatch and hashes through the action API", async () => {
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const { runFilmOrderAction } = await import("@/lib/film-orders");
    const previewed = await runFilmOrderAction(orderId, "send-proof-notice", {
      origin: "http://localhost:3000",
      mailMode: "preview",
    }, "kanei@kanei-trade.co.jp");
    const preview = previewed.preview as FilmOrderMailPreview;
    const draftGroupsBefore = await db.all<{ dispatch_group_id: string }>(
      "SELECT DISTINCT dispatch_group_id FROM film_order_mail_outbox WHERE order_id=? AND workflow_key='maker_proof_request' AND envelope_status='draft'",
      [orderId],
    );
    expect(draftGroupsBefore.map((row) => row.dispatch_group_id)).toEqual([preview.dispatchGroupId]);

    const confirmed = await runFilmOrderAction(orderId, "send-proof-notice", {
      origin: "http://localhost:3000",
      mailMode: "confirm",
      mailDispatchGroupId: preview.dispatchGroupId,
      mailEnvelopeHashes: preview.envelopes.map((envelope) => envelope.contentHash),
    }, "kanei@kanei-trade.co.jp");
    const draftGroupsAfter = await db.all<{ dispatch_group_id: string }>(
      "SELECT DISTINCT dispatch_group_id FROM film_order_mail_outbox WHERE order_id=? AND workflow_key='maker_proof_request' AND envelope_status='draft'",
      [orderId],
    );
    const promoted = await db.all<{ envelope_status: string }>(
      "SELECT envelope_status FROM film_order_mail_outbox WHERE dispatch_group_id=?",
      [preview.dispatchGroupId],
    );
    expect(confirmed.lifecycle?.dispatchGroupId).toBe(preview.dispatchGroupId);
    expect(draftGroupsAfter).toHaveLength(0);
    expect(promoted).toHaveLength(3);
    expect(promoted.every((row) => row.envelope_status === "composed")).toBe(true);
    expect((await db.get<{ status: string }>("SELECT status FROM film_orders WHERE id=?", [orderId]))?.status)
      .toBe("receiving_registered");
  });

  it("rejects concurrent confirmation and stale order state on SQLite", async () => {
    const [left, right] = await Promise.all([
      prepareFilmOrderMail({
        orderId: resendOrderId,
        action: "register-receiving",
        actorEmail: "seven@727.co.jp",
        origin: "http://localhost:3000",
        aiFileName: "concurrent.ai",
        aiFileUrl: "https://example.test/concurrent.ai",
        pdfFileName: "concurrent.pdf",
        pdfFileUrl: "https://example.test/concurrent.pdf",
      }),
      prepareFilmOrderMail({
        orderId: resendOrderId,
        action: "register-receiving",
        actorEmail: "seven@727.co.jp",
        origin: "http://localhost:3000",
        aiFileName: "concurrent-b.ai",
        aiFileUrl: "https://example.test/concurrent-b.ai",
        pdfFileName: "concurrent-b.pdf",
        pdfFileUrl: "https://example.test/concurrent-b.pdf",
      }),
    ]);
    const attempts = await Promise.allSettled([
      confirmFilmOrderMail(left, left.envelopes.map((envelope) => envelope.contentHash)),
      confirmFilmOrderMail(right, right.envelopes.map((envelope) => envelope.contentHash)),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ message: expect.any(String) });
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const files = await db.all<{ file_name: string }>(
      "SELECT file_name FROM film_order_files WHERE order_id=? ORDER BY id", [resendOrderId],
    );
    expect(files.map((file) => file.file_name)).toEqual(["concurrent.ai", "concurrent.pdf"]);
    const tokens = await db.all<{ token_state: string; dispatch_group_id: string | null }>(
      "SELECT token_state,dispatch_group_id FROM film_order_external_tokens WHERE film_order_id=?", [resendOrderId],
    );
    const losingStaged = tokens.filter((token) => token.token_state === "staged");
    expect(losingStaged).toHaveLength(1);
    expect(losingStaged[0]?.dispatch_group_id).not.toBe("existing-dispatch-group");
  });

  it("scopes concurrent cancellation to one preview and preserves another staged confirmation", async () => {
    // The previous concurrent-confirmation winner already advanced this order. Run
    // this isolated A/B cancellation from the same canonical pre-receiving state.
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    await db.run(`
      UPDATE film_orders
      SET status='ordered', receiving_registered_at=NULL, updated_at=?
      WHERE id=?
    `, [new Date().toISOString(), resendOrderId]);

    const [left, right] = await Promise.all([
      prepareFilmOrderMail({
        orderId: resendOrderId,
        action: "register-receiving",
        actorEmail: "seven@727.co.jp",
        origin: "http://localhost:3000",
        aiFileName: "cancel-left.ai",
        aiFileUrl: "https://example.test/cancel-left.ai",
        pdfFileName: "cancel-left.pdf",
        pdfFileUrl: "https://example.test/cancel-left.pdf",
      }),
      prepareFilmOrderMail({
        orderId: resendOrderId,
        action: "register-receiving",
        actorEmail: "seven@727.co.jp",
        origin: "http://localhost:3000",
        aiFileName: "cancel-right.ai",
        aiFileUrl: "https://example.test/cancel-right.ai",
        pdfFileName: "cancel-right.pdf",
        pdfFileUrl: "https://example.test/cancel-right.pdf",
      }),
    ]);

    const cancelled = await cancelFilmOrderMail(resendOrderId, left.dispatchGroupId);
    expect(cancelled).toMatchObject({ skippedCount: 3, revokedTokenCount: 1, authoritativeStateChanged: false });

    const states = await db.all<{ token_state: string; dispatch_group_id: string | null }>(
      "SELECT token_state,dispatch_group_id FROM film_order_external_tokens WHERE film_order_id=? AND dispatch_group_id IN (?,?)",
      [resendOrderId, left.dispatchGroupId, right.dispatchGroupId],
    );
    expect(states.filter((state) => state.dispatch_group_id === left.dispatchGroupId))
      .toEqual([{ token_state: "revoked", dispatch_group_id: left.dispatchGroupId }]);
    expect(states.filter((state) => state.dispatch_group_id === right.dispatchGroupId))
      .toEqual([{ token_state: "staged", dispatch_group_id: right.dispatchGroupId }]);

    const confirmed = await confirmFilmOrderMail(right, right.envelopes.map((envelope) => envelope.contentHash));
    expect(confirmed.workflowCompleted).toBe(true);
    expect(confirmed.notificationCompleted).toBe(false);
    const afterConfirm = await db.all<{ token_state: string; dispatch_group_id: string | null }>(
      "SELECT token_state,dispatch_group_id FROM film_order_external_tokens WHERE film_order_id=? AND dispatch_group_id IN (?,?)",
      [resendOrderId, left.dispatchGroupId, right.dispatchGroupId],
    );
    expect(afterConfirm.filter((state) => state.dispatch_group_id === left.dispatchGroupId))
      .toEqual([{ token_state: "revoked", dispatch_group_id: left.dispatchGroupId }]);
    expect(afterConfirm.filter((state) => state.dispatch_group_id === right.dispatchGroupId))
      .toEqual([{ token_state: "active", dispatch_group_id: right.dispatchGroupId }]);
    expect((await db.get<{ status: string }>("SELECT status FROM film_orders WHERE id=?", [resendOrderId]))?.status)
      .toBe("receiving_registered");
  });

  it("records deterministic failure and retry attempt history without creating a new order", async () => {
    const preview = await prepareFilmOrderMail({
      orderId: resendOrderId,
      action: "send-proof-notice",
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000",
    });
    sendMailMock.mockImplementation(async (input: Record<string, unknown>) => ({
      to: String(input.to),
      requestedTo: undefined,
      recipientOverridden: false,
      subject: String(input.subject ?? "subject"),
      dryRun: false,
      error: "smtp_credentials_missing",
    }));
    const failed = await confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash));
    expect(failed.outcomes.every((outcome) => outcome.status === "retry_required")).toBe(true);
    sendMailMock.mockImplementation(async (input) => defaultSendMail(input));
    const retry = await retryFilmOrderMailDispatch(resendOrderId, preview.dispatchGroupId, "kanei@kanei-trade.co.jp");
    expect(retry.outcomes.every((outcome) => outcome.status === "skipped")).toBe(true);
    expect(retry.workflowCompleted).toBe(false);
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const orders = await db.all<{ id: number }>("SELECT id FROM film_orders WHERE order_number='LIFE-002'");
    const history = await db.all<{ attempt_count: number; status: string }>(
      `SELECT a.attempt_count,a.status FROM film_order_mail_attempts a
       JOIN film_order_mail_outbox o ON o.id=a.outbox_id
       WHERE o.dispatch_group_id=? ORDER BY o.audience,a.attempt_count`, [preview.dispatchGroupId],
    );
    expect(orders).toHaveLength(1);
    expect(history.filter((attempt) => attempt.attempt_count === 1).every((attempt) => attempt.status === "retry_required")).toBe(true);
    expect(history.filter((attempt) => attempt.attempt_count === 2).every((attempt) => attempt.status === "skipped")).toBe(true);
  });

  it("keeps recipient ownership in outbox while centralized test redirect records actual destination", async () => {
    process.env.MAIL_RECIPIENT_OVERRIDE = "test-redirect@example.test";
    const preview = await prepareFilmOrderMail({
      orderId: resendOrderId,
      action: "rotate-supplier-proof-token",
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000",
    });
    const result = await confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash));
    delete process.env.MAIL_RECIPIENT_OVERRIDE;
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const rows = await db.all<{ o_intended_to: string; a_actual_to: string | null; a_recipient_overridden: number }>(
      `SELECT o.intended_to AS o_intended_to, a.actual_to AS a_actual_to, a.recipient_overridden AS a_recipient_overridden
       FROM film_order_mail_outbox o JOIN film_order_mail_attempts a ON a.outbox_id=o.id
       WHERE o.dispatch_group_id=? AND a.attempt_count=1`, [preview.dispatchGroupId],
    );
    expect(result.outcomes.every((outcome) => outcome.intendedTo !== "test-redirect@example.test")).toBe(true);
    expect(rows).toHaveLength(3);
    expect(result.outcomes.every((outcome) => outcome.actualTo === "test-redirect@example.test" && outcome.recipientOverridden)).toBe(true);
    expect(rows.some((row) => row.o_intended_to === "maker@example.test")).toBe(true);
    expect(rows.every((row) => !["arwg22@gmail.com", "y-supplier@example.jp"].includes(row.o_intended_to))).toBe(true);
  });

  it("uses an effective persisted template override through the same rendering path", async () => {
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const baseline = await prepareFilmOrderMail({
      orderId: resendOrderId,
      action: "send-proof-notice",
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000",
    });
    const templateKey = baseline.envelopes.find((envelope) => envelope.audience === "maker")!.effectiveTemplateIdentity.key;
    await db.run(`
      INSERT INTO mail_settings (id,settings_json,updated_at,updated_by)
      VALUES (1,?,?,'tester')
      ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by
    `, [JSON.stringify({
      version: 1,
      sender: { name: "Workflow Sender", email: "workflow-sender@example.test" },
      globalCc: [],
      recipients: { design: "", seven: "", kaneiApprovals: "", supplierKorean: "", supplierJapanese: "" },
      testMode: { enabled: false, recipient: "" },
      templates: { [templateKey]: { subject: "Override {{orderNumber}} | {{originalSubject}}", body: "{{originalBody}}\nOVERRIDE-RENDER" } },
    }), new Date().toISOString()]);
    const preview = await prepareFilmOrderMail({
      orderId: resendOrderId,
      action: "send-proof-notice",
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000",
    });
    const maker = preview.envelopes.find((envelope) => envelope.audience === "maker");
    expect(maker?.subject).toContain("Override LIFE-002");
    expect(maker?.body).toContain("OVERRIDE-RENDER");
    expect(maker?.body).toContain("전용 페이지에서 AI와 PDF 교정 데이터를 제출해 주십시오.");
    expect(maker?.effectiveTemplateIdentity.source).toBe("override");
    expect(maker?.body).toContain(preview.stagedTokens[0]?.url ?? "");
  });
});
