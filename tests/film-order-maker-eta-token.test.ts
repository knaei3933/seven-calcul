// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-maker-eta-token-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.FILM_EXTERNAL_TOKEN_SECRET = "film-maker-eta-token-test-secret-32bytes";
process.env.MAIL_DRY_RUN = "true";

let orderId = 0;
let legacyEtaToken = "";

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
  const { buildEtaToken, getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
  const db = await getDatabaseForFilmMakerStore();
  await db.run("INSERT INTO quotations (status,created_by,payload_json) VALUES ('approved',NULL,'{}')");
  const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO film_orders (
      quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,
      procurement_route,status,purchase_order_json,supplier_email,created_at,updated_at
    ) VALUES (?, 'ETA-001','Q-ETA-001','ETA pouch','ETA customer','gravure','K','final_approved','{}','eta-maker@example.test',?,?)
  `, [quotation!.id, now, now]);
  const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='ETA-001'");
  orderId = Number(order!.id);
  const legacy = buildEtaToken(orderId, 14);
  legacyEtaToken = legacy.token;
  await db.run("UPDATE film_orders SET eta_token=?, eta_expires_at=? WHERE id=?", [
    legacyEtaToken,
    new Date(legacy.expiresAt).toISOString(),
    orderId,
  ]);
  // Force the token-hardening migration path on the next cold start.
  await db.run("UPDATE film_order_schema_migrations SET version='2026-11-04-film-order-mail-lifecycle-1' WHERE slot='film_orders'");
  const { resetFilmOrderDatabaseForTest } = await import("@/lib/film-orders");
  await resetFilmOrderDatabaseForTest();
  await getDatabaseForFilmMakerStore();
});

afterAll(async () => {
  const { resetFilmOrderDatabaseForTest, getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await resetFilmOrderDatabaseForTest();
  await getDatabaseForFilmMakerStore();
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("maker_eta typed token hardening", () => {
  it("migrates a valid legacy ETA token once with hash, audience, actor, and expiry metadata", async () => {
    const { getDatabaseForFilmMakerStore, getFilmOrderForEta } = await import("@/lib/film-orders");
    const db = await getDatabaseForFilmMakerStore();
    const rows = await db.all<{
      purpose: string;
      token_state: string;
      audience_email: string | null;
      created_by_email: string;
      revoked_at: string | null;
      last_used_at: string | null;
    }>("SELECT purpose,token_state,audience_email,created_by_email,revoked_at,last_used_at FROM film_order_external_tokens WHERE film_order_id=?", [orderId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      purpose: "maker_eta",
      token_state: "active",
      audience_email: "eta-maker@example.test",
      created_by_email: "legacy-migration",
      revoked_at: null,
      last_used_at: null,
    });
    await expect(getFilmOrderForEta(legacyEtaToken, {
      headers: { get: (name) => name.toLowerCase() === "x-forwarded-for" ? "192.0.2.10" : null },
    })).resolves.toMatchObject({ id: orderId });
    const migrated = await db.get<{ last_used_at: string | null; last_used_ip_hash: string | null }>(
      "SELECT last_used_at,last_used_ip_hash FROM film_order_external_tokens WHERE film_order_id=? AND purpose='maker_eta'",
      [orderId],
    );
    expect(migrated?.last_used_at).toBeTruthy();
    expect(migrated?.last_used_ip_hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("derives a dispatch-group association for a legacy staged token from its draft envelope", async () => {
    const { filmExternalTokenForTest, getDatabaseForFilmMakerStore, resetFilmOrderDatabaseForTest } =
      await import("@/lib/film-orders");
    const before = await getDatabaseForFilmMakerStore();
    const legacyToken = filmExternalTokenForTest(orderId, "maker_eta", Date.now() + 86_400_000, "legacy-association");
    const { createHash } = await import("node:crypto");
    const tokenHash = createHash("sha256").update(legacyToken).digest("hex");
    const now = new Date().toISOString();
    await before.run(`
      INSERT INTO film_order_mail_outbox (
        order_id,dispatch_group_id,workflow_key,audience,language,template_key,template_identity_json,
        sender_identity,sender_email,intended_to,cc_json,subject,body,links_json,attachments_json,
        canonical_envelope_json,content_hash,envelope_status,requested_by_email,created_at,updated_at
      ) VALUES (?, 'legacy-dispatch-group','eta_update','maker','ko','film_eta_update',?,
        'Kanei','workflow-sender@example.test','eta-maker@example.test','[]','legacy','legacy',?, '[]', '{}', ?,
        'draft','kanei@kanei-trade.co.jp',?,?)
    `, [
      orderId,
      JSON.stringify({ key: "film_eta_update", source: "default", compatibilityKey: null, bindingFingerprint: "legacy" }),
      JSON.stringify([{ key: "maker_eta_report", url: `https://example.test/eta/${encodeURIComponent(legacyToken)}` }]),
      tokenHash,
      now,
      now,
    ]);
    await before.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,token_state,audience_email,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?, 'maker_eta',?,'staged','eta-maker@example.test',?,'legacy-migration',?,?)
    `, [orderId, tokenHash, new Date(Date.now() + 86_400_000).toISOString(), now, now]);
    await before.run("UPDATE film_order_schema_migrations SET version='2026-11-04-film-order-mail-lifecycle-1' WHERE slot='film_orders'");
    await resetFilmOrderDatabaseForTest();
    const db = await getDatabaseForFilmMakerStore();
    const associated = await db.get<{ dispatch_group_id: string; token_state: string }>(
      "SELECT dispatch_group_id,token_state FROM film_order_external_tokens WHERE token_hash=?",
      [tokenHash],
    );
    expect(associated).toEqual({ dispatch_group_id: "legacy-dispatch-group", token_state: "staged" });
  });

  it("keeps one active token while staged confirmation candidates coexist and cancel preserves the active link", async () => {
    const {
      filmExternalTokenHashForTest,
      issueStagedFilmOrderExternalToken,
      getDatabaseForFilmMakerStore,
      promoteStagedFilmOrderExternalTokens,
    } = await import("@/lib/film-orders");
    const { cancelFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    const db = await getDatabaseForFilmMakerStore();
    const first = await issueStagedFilmOrderExternalToken(db, orderId, "maker_eta", "kanei@kanei-trade.co.jp", {
      audienceEmail: "eta-maker@example.test",
      dispatchGroupId: "cancel-dispatch-a",
      ttlDays: 7,
    });
    const states = await db.all<{ token_state: string; dispatch_group_id: string | null }>(
      "SELECT token_state,dispatch_group_id FROM film_order_external_tokens WHERE film_order_id=? AND purpose='maker_eta' ORDER BY id",
      [orderId],
    );
    expect(states.filter((row) => row.token_state === "active")).toHaveLength(1);
    expect(states.filter((row) => row.token_state === "staged" && row.dispatch_group_id === "cancel-dispatch-a")).toHaveLength(1);
    await promoteStagedFilmOrderExternalTokens(db, orderId, [first.tokenHash]);
    const etaStates = await db.all<{ token_state: string; token_hash: string }>(
      "SELECT token_state,token_hash FROM film_order_external_tokens WHERE film_order_id=? AND purpose='maker_eta' ORDER BY id",
      [orderId],
    );
    expect(etaStates.filter((row) => row.token_state === "active")).toHaveLength(1);
    expect(etaStates.filter((row) => row.token_state === "staged")).toHaveLength(1);
    await expect(cancelFilmOrderMail(orderId, `cancel-${first.tokenHash.slice(0, 12)}`))
      .rejects.toThrow("film_order_mail_confirm_conflict");
    const afterCancel = await db.all<{ token_state: string; token_hash: string; dispatch_group_id: string | null }>(
      "SELECT token_state,token_hash,dispatch_group_id FROM film_order_external_tokens WHERE film_order_id=? AND purpose='maker_eta'",
      [orderId],
    );
    expect(afterCancel.filter((row) => row.token_state === "active")).toHaveLength(1);
    expect(afterCancel.some((row) => row.token_hash === filmExternalTokenHashForTest(first.token) && row.token_state === "active")).toBe(true);
  });

  it("activates the selected staged token, rejects cross-purpose/cross-order tokens, and records revocation", async () => {
    const {
      filmExternalTokenForTest,
      getDatabaseForFilmMakerStore,
      getFilmOrderForEta,
      issueStagedFilmOrderExternalToken,
      promoteStagedFilmOrderExternalTokens,
    } = await import("@/lib/film-orders");
    const db = await getDatabaseForFilmMakerStore();
    const staged = await issueStagedFilmOrderExternalToken(db, orderId, "maker_eta", "kanei@kanei-trade.co.jp", {
      audienceEmail: "eta-maker@example.test",
      dispatchGroupId: "confirm-dispatch-a",
      ttlDays: 7,
    });
    await promoteStagedFilmOrderExternalTokens(db, orderId, [staged.tokenHash]);
    await expect(getFilmOrderForEta(staged.token)).resolves.toMatchObject({ id: orderId });

    const proof = filmExternalTokenForTest(orderId, "supplier_proof", Date.now() + 86_400_000, "purpose-guard");
    await expect(getFilmOrderForEta(proof)).resolves.toBeNull();
    const otherOrder = filmExternalTokenForTest(orderId + 1, "maker_eta", Date.now() + 86_400_000, "order-guard");
    await expect(getFilmOrderForEta(otherOrder)).resolves.toBeNull();

    const now = new Date().toISOString();
    await db.run(
      "UPDATE film_order_external_tokens SET token_state='revoked', revoked_at=?, updated_at=? WHERE film_order_id=? AND purpose='maker_eta' AND token_state='active'",
      [now, now, orderId],
    );
    await expect(getFilmOrderForEta(staged.token)).resolves.toBeNull();
    const revoked = await db.get<{ token_state: string; revoked_at: string | null }>(
      "SELECT token_state,revoked_at FROM film_order_external_tokens WHERE film_order_id=? AND purpose='maker_eta' ORDER BY id DESC",
      [orderId],
    );
    expect(revoked).toMatchObject({ token_state: "revoked" });
    expect(revoked?.revoked_at).toBe(now);
  });
});
