import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFilmOrderNotifications,
  filmOrderNotificationEnvelopeHash,
  type FilmOrderNotificationEnvelope,
  type FilmOrderNotificationInput,
} from "@/lib/film-order-notifications";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-order-mail-outbox-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.MAIL_DRY_RUN = "true";

const links = [
  { key: "maker_receiving_packet", url: "https://example.test/pg/packet", label: "packet" },
  { key: "maker_proof_upload", url: "https://example.test/pg/proof", label: "proof" },
  { key: "maker_purchase_order", url: "https://example.test/pg/po", label: "po" },
  { key: "maker_eta_report", url: "https://example.test/pg/eta", label: "eta" },
  { key: "kanei_order_management", url: "https://example.test/pg/kanei", label: "kanei" },
  { key: "seven_order_summary", url: "https://example.test/pg/seven", label: "seven" },
  { key: "customer_proof_review", url: "https://example.test/pg/customer/proof", label: "customer proof" },
] as const;

const notificationInput: FilmOrderNotificationInput = {
  orderId: 0,
  dispatchGroupId: "group-g004-sqlite",
  orderNumber: "F-202611-OUTBOX",
  productName: "Outbox pouch",
  productSpecification: "PET/AL/PE, 160mm, 300m, gravure",
  workflowStage: "final_approvals",
  recipients: {
    maker: "pg-maker@example.test",
    seven: "seven@727.co.jp",
    kanei: "kanei@kanei-trade.co.jp",
    customer: "pg-customer@example.test",
  },
  senderIdentity: {
    maker: "Kanei Trade Film Workflow",
    seven: "Kanei Trade Film Workflow",
    kanei: "Film Workflow System",
    customer: "Kanei Trade",
  },
  senderEmail: "workflow-sender@example.test",
  maker: { companyName: "PG Film", language: "ko" },
  links,
};

let orderId = 0;
let outboxId = 0;

beforeAll(async () => {
  const { getSqlClient } = await import("@/lib/db");
  const raw = await getSqlClient("quotations");
  await raw.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user'
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
  await db.run(`
    INSERT INTO quotations (status, created_by, payload_json) VALUES ('approved', NULL, '{}')
  `);
  const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
  await db.run(`
    INSERT INTO film_orders (
      quotation_id, order_number, quotation_number, product_name, customer_name,
      printing_method, procurement_route, status, purchase_order_json, created_at, updated_at
    ) VALUES (?, 'F-202611-OUTBOX', 'Q-OUTBOX', 'Outbox pouch', 'PG customer', 'gravure', 'K', 'final_approved', '{}', ?, ?)
  `, [quotation!.id, new Date().toISOString(), new Date().toISOString()]);
  const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='F-202611-OUTBOX'");
  orderId = Number(order!.id);
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function envelopesForEvent(event: FilmOrderNotificationEnvelope["workflowKey"]): FilmOrderNotificationEnvelope[] {
  const result = buildFilmOrderNotifications(event, { ...notificationInput, orderId });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.envelopes;
}

describe("SQLite film-order mail outbox", () => {
  it("creates immutable outbox tables with indexes and advances the migration marker", async () => {
    const { getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
    const db = await getDatabaseForFilmMakerStore();
    const marker = await db.get<{ version: string }>(
      "SELECT version FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    expect(marker?.version).toBe("2026-11-06-extensible-proof-rounds-1");
    const outboxColumns = await db.all<{ name: string }>("PRAGMA table_info(film_order_mail_outbox)");
    const attemptColumns = await db.all<{ name: string }>("PRAGMA table_info(film_order_mail_attempts)");
    expect(outboxColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "order_id", "dispatch_group_id", "workflow_key", "audience", "language", "template_key",
      "sender_identity", "intended_to", "cc_json", "subject", "body", "links_json",
      "attachments_json", "content_hash", "envelope_status", "requested_by_email",
      "created_at", "updated_at",
    ]));
    expect(attemptColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "outbox_id", "attempt_count", "status", "requested_by_email", "intended_to", "actual_to",
      "recipient_overridden", "smtp_message_id", "error_code", "created_at",
      "attempt_started_at", "attempt_finished_at",
    ]));
    const indexes = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('film_order_mail_outbox','film_order_mail_attempts')",
    );
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_film_mail_outbox_group_envelope",
      "idx_film_mail_outbox_order_created",
      "idx_film_mail_outbox_order_workflow_status",
      "idx_film_mail_outbox_group_audience",
      "idx_film_mail_attempt_count",
      "idx_film_mail_attempt_outbox_status",
      "idx_film_mail_attempt_sending_recovery",
    ]));
  });

  it("persists one composed dispatch group and reconstructs all projections", async () => {
    const { persistFilmOrderMailEnvelopes, listFilmOrderMailOutboxForKanei, listFilmOrderMailOutboxForAudience } =
      await import("@/lib/film-order-mail-outbox");
    const envelopes = envelopesForEvent("supplier_purchase_order");
    const persisted = await persistFilmOrderMailEnvelopes(envelopes, {
      requestedByEmail: "operator@kanei-trade.co.jp",
      envelopeStatus: "composed",
    });
    expect(persisted.map((record) => record.audience)).toEqual(["maker", "seven", "kanei"]);
    expect(new Set(persisted.map((record) => record.dispatchGroupId))).toEqual(new Set(["group-g004-sqlite"]));
    outboxId = persisted[0]!.id;

    const kaneiView = await listFilmOrderMailOutboxForKanei(orderId, "operator@kanei-trade.co.jp");
    const group = kaneiView.filter((record) => record.dispatchGroupId === "group-g004-sqlite");
    expect(group).toHaveLength(3);
    expect(group.map((record) => record.audience)).toEqual(["maker", "seven", "kanei"]);
    expect(group.every((record) => record.subject && record.body && record.contentHash)).toBe(true);

    const sevenView = await listFilmOrderMailOutboxForAudience(orderId, "seven", "seven@727.co.jp", "seven@727.co.jp");
    const serialized = JSON.stringify(sevenView);
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("links_json");
    expect(serialized).not.toContain("https://example.test/pg/proof");
    expect(sevenView.every((record) => record.audience === "seven")).toBe(true);

    const customerView = await listFilmOrderMailOutboxForAudience(orderId, "customer", "customer@example.test");
    expect(customerView).toEqual([]);
    await expect(listFilmOrderMailOutboxForAudience(orderId, "seven", "seven@727.co.jp", "seven@727.co.jp")).resolves.toHaveLength(1);
    await expect(listFilmOrderMailOutboxForKanei(orderId, "seven@727.co.jp")).rejects.toThrow("film_order_mail_outbox_forbidden");
    await expect(listFilmOrderMailOutboxForAudience(orderId, "maker", "seven@727.co.jp")).rejects.toThrow("film_order_mail_outbox_forbidden");
    await expect(listFilmOrderMailOutboxForAudience(orderId, "maker", "pg-maker@example.test", "pg-maker@example.test")).resolves.toHaveLength(1);
  });

  it("persists drafts, promotes exactly the draft group, and rejects duplicate dispatch identities", async () => {
    const {
      persistFilmOrderMailEnvelopes,
      promoteFilmOrderMailDrafts,
      skipFilmOrderMailDrafts,
    } = await import("@/lib/film-order-mail-outbox");
    const envelopes = envelopesForEvent("customer_proof_review")
      .map((envelope) => ({ ...envelope, dispatchGroupId: "draft-g004-sqlite", contentHash: filmOrderNotificationEnvelopeHash({
        ...envelope,
        dispatchGroupId: "draft-g004-sqlite",
      }) }));
    const persisted = await persistFilmOrderMailEnvelopes(envelopes, {
      requestedByEmail: "operator@kanei-trade.co.jp",
      envelopeStatus: "draft",
    });
    expect(persisted.every((record) => record.envelopeStatus === "draft")).toBe(true);
    expect(await promoteFilmOrderMailDrafts("draft-g004-sqlite", { expectedCount: 3 })).toBe(3);
    expect(await promoteFilmOrderMailDrafts("draft-g004-sqlite", { expectedCount: 0 })).toBe(0);

    const cancel = envelopesForEvent("link_resend")
      .map((envelope) => ({ ...envelope, dispatchGroupId: "cancel-g004-sqlite", contentHash: filmOrderNotificationEnvelopeHash({
        ...envelope,
        dispatchGroupId: "cancel-g004-sqlite",
      }) }));
    await persistFilmOrderMailEnvelopes(cancel, {
      requestedByEmail: "operator@kanei-trade.co.jp",
      envelopeStatus: "draft",
    });
    expect(await skipFilmOrderMailDrafts("cancel-g004-sqlite", { expectedCount: 3 })).toBe(3);

    await expect(persistFilmOrderMailEnvelopes(envelopes, {
      requestedByEmail: "operator@kanei-trade.co.jp",
      envelopeStatus: "draft",
    })).rejects.toThrow("duplicate_film_order_mail_envelope");
  });

  it("records immutable attempts, preserves retry history, and recovers stale sending as unknown", async () => {
    const {
      getFilmOrderMailOutbox,
      startFilmOrderMailAttempt,
      recordFilmOrderMailAttemptOutcome,
      recordFilmOrderMailSkippedAttempt,
      recoverStaleFilmOrderMailSendingAttempts,
      listFilmOrderMailOutboxForAudience,
    } = await import("@/lib/film-order-mail-outbox");
    const first = await startFilmOrderMailAttempt({
      outboxId,
      requestedByEmail: "dispatcher@kanei-trade.co.jp",
      actualTo: "test-redirect@example.test",
      recipientOverridden: true,
    });
    expect(first).toMatchObject({
      attemptCount: 1,
      status: "sending",
      intendedTo: "pg-maker@example.test",
      actualTo: "test-redirect@example.test",
      recipientOverridden: true,
    });
    const sent = await recordFilmOrderMailAttemptOutcome({
      outboxId,
      attemptCount: 1,
      status: "sent",
      smtpMessageId: "smtp-initial",
    });
    expect(sent).toMatchObject({ status: "sent", attemptFinishedAt: expect.any(String) });
    await expect(startFilmOrderMailAttempt({
      outboxId,
      requestedByEmail: "successful-attempt-forbidden@kanei-trade.co.jp",
    })).rejects.toThrow("film_order_mail_retry_not_available");

    const { getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
    const db = await getDatabaseForFilmMakerStore();
    await db.run("UPDATE film_order_mail_attempts SET status='retry_required', error_code='smtp_denied' WHERE outbox_id=? AND attempt_count=1", [outboxId]);
    const staleBefore = new Date(Date.now() - 1_000).toISOString();
    const second = await startFilmOrderMailAttempt({
      outboxId,
      requestedByEmail: "retry-operator@kanei-trade.co.jp",
    });
    expect(second.attemptCount).toBe(2);
    await db.run(
      "UPDATE film_order_mail_attempts SET attempt_started_at=? WHERE id=?",
      [staleBefore, second.id],
    );
    const recovered = await recoverStaleFilmOrderMailSendingAttempts(staleBefore);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: second.id, attemptCount: 2, status: "unknown" });
    expect(await recoverStaleFilmOrderMailSendingAttempts(staleBefore)).toHaveLength(0);

    const skipped = await recordFilmOrderMailSkippedAttempt({
      outboxId,
      requestedByEmail: "dry-run@kanei-trade.co.jp",
      errorCode: "dry_run",
    });
    expect(skipped).toMatchObject({ attemptCount: 3, status: "skipped" });
    const envelope = await getFilmOrderMailOutbox(outboxId);
    expect(envelope?.envelopeStatus).toBe("composed");

    const sevenAttempts = (await listFilmOrderMailOutboxForAudience(orderId, "seven", "seven@727.co.jp", "seven@727.co.jp"))[0]!.attempts;
    expect(sevenAttempts.every((attempt) => !("actualTo" in attempt) && !("smtpMessageId" in attempt))).toBe(true);
  });

  it("records terminal failed attempts separately from retry-required attempts", async () => {
    const { persistFilmOrderMailEnvelopes, startFilmOrderMailAttempt, recordFilmOrderMailAttemptOutcome } =
      await import("@/lib/film-order-mail-outbox");
    const dispatchGroupId = "failed-g006-sqlite";
    const envelopes = envelopesForEvent("link_resend").map((envelope) => ({
      ...envelope,
      dispatchGroupId,
      contentHash: filmOrderNotificationEnvelopeHash({
        ...envelope,
        dispatchGroupId,
      }),
    }));
    const persisted = await persistFilmOrderMailEnvelopes(envelopes, {
      requestedByEmail: "operator@kanei-trade.co.jp",
      envelopeStatus: "composed",
    });
    const started = await startFilmOrderMailAttempt({
      outboxId: persisted[0]!.id,
      requestedByEmail: "dispatcher@kanei-trade.co.jp",
    });
    const failed = await recordFilmOrderMailAttemptOutcome({
      outboxId: persisted[0]!.id,
      attemptCount: started.attemptCount,
      status: "failed",
      errorCode: "smtp_connect_failed",
    });

    expect(started).toMatchObject({ attemptCount: 1, status: "sending" });
    expect(failed).toMatchObject({
      attemptCount: 1,
      status: "failed",
      errorCode: "smtp_connect_failed",
      attemptFinishedAt: expect.any(String),
    });
    await expect(recordFilmOrderMailAttemptOutcome({
      outboxId: persisted[0]!.id,
      attemptCount: started.attemptCount,
      status: "sent",
    })).rejects.toThrow("film_order_mail_attempt_already_final");
  });

  it("rejects persistence when a final envelope is mutated without recomputing the hash", async () => {
    const { persistFilmOrderMailEnvelopes, FilmOrderMailOutboxValidationError } = await import("@/lib/film-order-mail-outbox");
    const envelopes = envelopesForEvent("eta_update").map((envelope, index) => index === 0
      ? { ...envelope, subject: `${envelope.subject} mutation` }
      : envelope);
    await expect(persistFilmOrderMailEnvelopes(envelopes, {
      requestedByEmail: "operator@kanei-trade.co.jp",
    })).rejects.toThrow(FilmOrderMailOutboxValidationError);
  });
});

