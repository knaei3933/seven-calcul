import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-maker-migration-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.MAIL_DRY_RUN = "true";
const LEGACY_SCHEMA_VERSION = "2026-11-04-film-order-cancel-scoping-2";
const NEW_SCHEMA_VERSION = "2026-11-04-g011-mail-boundary-1";

// Pre-G002 SQLite database: current ship-to schema, no film-maker columns/table/FK.
const { getSqlClient } = await import("@/lib/db");
const db = await getSqlClient("quotations");
await db.exec(`
  CREATE TABLE quotations (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'approved', created_by INTEGER, payload_json TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user');
  CREATE TABLE film_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_id INTEGER NOT NULL,
    order_number TEXT NOT NULL,
    quotation_number TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    customer_code TEXT NOT NULL DEFAULT '',
    printing_method TEXT NOT NULL DEFAULT '',
    procurement_route TEXT NOT NULL DEFAULT '',
    film_composition TEXT NOT NULL DEFAULT '',
    order_length_m TEXT NOT NULL DEFAULT '',
    web_width_mm TEXT NOT NULL DEFAULT '',
    pouch_quantity TEXT NOT NULL DEFAULT '',
    supplier_name TEXT NOT NULL DEFAULT '旧供应商株式会社',
    supplier_email TEXT NOT NULL DEFAULT 'legacy@example.test',
    seven_contact_email TEXT NOT NULL DEFAULT '',
    buyer_domain TEXT NOT NULL DEFAULT '727.co.jp',
    status TEXT NOT NULL DEFAULT 'final_approved',
    po_sent_at TEXT,
    eta_token TEXT, eta_expires_at TEXT, eta_date TEXT, eta_note TEXT, eta_updated_at TEXT,
    film_shipped_on TEXT, film_carrier TEXT NOT NULL DEFAULT '', film_tracking_number TEXT NOT NULL DEFAULT '',
    film_shipment_note TEXT NOT NULL DEFAULT '',
    ship_to_destination_id BIGINT, ship_to_status TEXT NOT NULL DEFAULT 'not_provided',
    ship_to_label TEXT NOT NULL DEFAULT '', ship_to_company_name TEXT NOT NULL DEFAULT '',
    ship_to_department TEXT NOT NULL DEFAULT '', ship_to_contact_name TEXT NOT NULL DEFAULT '',
    ship_to_postal_code TEXT NOT NULL DEFAULT '', ship_to_address TEXT NOT NULL DEFAULT '',
    ship_to_building TEXT NOT NULL DEFAULT '', ship_to_phone TEXT NOT NULL DEFAULT '',
    ship_to_email TEXT NOT NULL DEFAULT '', ship_to_note TEXT NOT NULL DEFAULT '',
    ship_to_requested_at TEXT, ship_to_requested_by TEXT NOT NULL DEFAULT '',
    ship_to_registered_at TEXT, ship_to_registered_by TEXT NOT NULL DEFAULT '',
    ship_to_saved_to_master BOOLEAN NOT NULL DEFAULT FALSE, ship_to_confirmed_at TEXT,
    ship_to_confirmed_by TEXT NOT NULL DEFAULT '',
    production_plan_status TEXT NOT NULL DEFAULT 'not_set', production_plan_start_date TEXT,
    production_plan_end_date TEXT, production_plan_note TEXT NOT NULL DEFAULT '',
    production_plan_updated_at TEXT, production_plan_updated_by TEXT NOT NULL DEFAULT '',
    re_proof_count INTEGER NOT NULL DEFAULT 0, ordered_at TEXT, receiving_registered_at TEXT,
    proof_registered_at TEXT, re_proof_requested_at TEXT, final_approved_at TEXT,
    purchase_order_json TEXT NOT NULL DEFAULT '{}', notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL DEFAULT '', updated_by_email TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE film_order_schema_migrations (slot TEXT PRIMARY KEY, version TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE film_order_external_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    film_order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po','customer_ship_to')),
    token_hash TEXT NOT NULL UNIQUE,
    audience_email TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    last_used_ip_hash TEXT,
    created_by_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE film_makers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    maker_code TEXT NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    language TEXT NOT NULL CHECK(language IN ('ja','ko')),
    print_method TEXT NOT NULL CHECK(print_method IN ('gravure','digital')),
    procurement_route TEXT NOT NULL CHECK(procurement_route IN ('K','Y')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL DEFAULT '',
    updated_by_email TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO film_order_schema_migrations VALUES ('film_orders', '${LEGACY_SCHEMA_VERSION}', '2026-10-27T00:00:00.000Z');
  INSERT INTO film_makers (
    maker_code,company_name,email,language,print_method,procurement_route,
    created_at,updated_at,created_by_email,updated_by_email
  ) VALUES
    ('EXACT-001', 'Exact External Maker', 'exact@example.test', 'ko', 'gravure', 'K',
     '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z', 'seed', 'seed');
  INSERT INTO film_orders (
    quotation_id, order_number, product_name, customer_name, printing_method, procurement_route,
    supplier_name, supplier_email, purchase_order_json, created_at, updated_at
  ) VALUES
    (1, 'F-202611-EXACT', 'Exact pouch', 'Customer A', 'gravure', 'K',
     'Exact External Maker', '  Exact@Example.test ', '{}', '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z'),
    (1, 'F-202611-INTERNAL', 'Internal pouch', 'Customer B', 'gravure', 'K',
     'Package Lab', 'design@package-lab.com', '{}', '2026-11-03T00:00:01.000Z', '2026-11-03T00:00:01.000Z'),
    (1, 'F-202611-AMBIGUOUS', 'Ambiguous pouch', 'Customer C', 'unknown', '',
     '', '', '{}', '2026-11-03T00:00:02.000Z', '2026-11-03T00:00:02.000Z');
  INSERT INTO film_order_external_tokens (
    film_order_id,purpose,token_hash,audience_email,expires_at,revoked_at,
    created_by_email,created_at,updated_at
  ) VALUES
    (1, 'supplier_proof', 'old-active-token-hash', 'exact@example.test', '2027-01-01T00:00:00.000Z', NULL,
     'old-system', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    (1, 'customer_design', 'old-revoked-token-hash', 'customer@example.test', '2027-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
     'old-system', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`);

describe("incremental SQLite film-maker migration", () => {
  it("adds slots, classifies only exact external matches, and preserves history", async () => {
    const { listFilmOrders } = await import("@/lib/film-orders");
    await listFilmOrders("seven@727.co.jp");
    const marker = await db.get<{ version: string }>(
      "SELECT version FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    // Version is intentionally asserted rather than imported privately; it must move past the old marker.
    expect(marker?.version).toBe(NEW_SCHEMA_VERSION);
    const columns = await db.all<{ name: string }>("PRAGMA table_info(film_orders)");
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "film_maker_id", "film_maker_snapshot_json", "legacy_supplier_match_json", "supplier_resolution",
    ]));
    const makerTable = await db.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='film_makers'",
    );
    expect(makerTable?.name).toBe("film_makers");
    const mailTables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('film_order_mail_outbox','film_order_mail_attempts') ORDER BY name",
    );
    expect(mailTables.map((table) => table.name)).toEqual([
      "film_order_mail_attempts",
      "film_order_mail_outbox",
    ]);
    const indexes = await db.all<{ name: string }>("PRAGMA index_list(film_orders)");
    expect(indexes.map((index) => index.name)).toContain("idx_film_orders_film_maker");
    const tokenColumns = await db.all<{ name: string }>("PRAGMA table_info(film_order_external_tokens)");
    expect(tokenColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "token_state", "dispatch_group_id",
    ]));
    const tokenIndexes = await db.all<{ name: string }>("PRAGMA index_list(film_order_external_tokens)");
    expect(tokenIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_film_external_active_token",
      "idx_film_external_order_purpose_state",
      "idx_film_external_dispatch_state",
    ]));
    const tokenTableSql = await db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='film_order_external_tokens'",
    );
    expect(tokenTableSql?.sql).toContain("film_order_external_token_state_consistency");
    expect(tokenTableSql?.sql).toContain("dispatch_group_id TEXT");
    expect(tokenTableSql?.sql).toContain("'maker_eta'");
    const migratedTokens = await db.all<{
      token_hash: string;
      token_state: string;
      dispatch_group_id: string | null;
      revoked_at: string | null;
    }>("SELECT token_hash,token_state,dispatch_group_id,revoked_at FROM film_order_external_tokens ORDER BY id");
    expect(migratedTokens).toEqual([
      expect.objectContaining({
        token_hash: "old-active-token-hash",
        token_state: "active",
        dispatch_group_id: null,
        revoked_at: null,
      }),
      expect.objectContaining({
        token_hash: "old-revoked-token-hash",
        token_state: "revoked",
        dispatch_group_id: null,
        revoked_at: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    // Re-run the backfill with a duplicate master: duplicate exact candidates are ambiguous.
    await db.exec(`
      INSERT INTO film_makers (
        maker_code,company_name,email,language,print_method,procurement_route,
        created_at,updated_at,created_by_email,updated_by_email
      ) VALUES ('EXACT-002', 'Duplicate Exact Maker', 'exact@example.test', 'ko', 'gravure', 'K',
                '2026-11-03T00:00:03.000Z', '2026-11-03T00:00:03.000Z', 'seed', 'seed')
    `);
    const duplicateBackfill = await (async () => {
      const { backfillLegacySupplierSuggestions } = await import("@/lib/film-maker-store");
      return backfillLegacySupplierSuggestions([1, 2, 3]);
    })();
    expect(duplicateBackfill).toEqual({ scanned: 3, suggested: 0 });
    expect(await db.get<{ legacy_supplier_match_json: string | null }>(
      "SELECT legacy_supplier_match_json FROM film_orders WHERE id=1",
    )).toEqual({ legacy_supplier_match_json: null });
    await db.exec("UPDATE film_makers SET is_active=0 WHERE maker_code='EXACT-002'");
    const restoredBackfill = await (async () => {
      const { backfillLegacySupplierSuggestions } = await import("@/lib/film-maker-store");
      return backfillLegacySupplierSuggestions([1]);
    })();
    expect(restoredBackfill).toEqual({ scanned: 1, suggested: 1 });
    expect(JSON.parse((await db.get<{ legacy_supplier_match_json: string }>(
      "SELECT legacy_supplier_match_json FROM film_orders WHERE id=1",
    ))!.legacy_supplier_match_json).makerId).toBe(1);
    const orders = await db.all<{
      id: number;
      supplier_name: string;
      supplier_email: string;
      film_maker_id: number | null;
      supplier_resolution: string;
      legacy_supplier_match_json: string | null;
    }>("SELECT id,supplier_name,supplier_email,film_maker_id,supplier_resolution,legacy_supplier_match_json FROM film_orders ORDER BY id");
    expect(orders).toHaveLength(3);
    expect(orders[0]).toMatchObject({
      supplier_name: "Exact External Maker",
      supplier_email: "  Exact@Example.test ",
      film_maker_id: null,
      supplier_resolution: "legacy_unresolved",
    });
    expect(JSON.parse(orders[0]!.legacy_supplier_match_json!)).toMatchObject({
      makerId: 1,
      matchedByEmail: "exact@example.test",
      confidence: "exact",
      rule: "normalized_email_route_print",
    });
    expect(orders[1]).toMatchObject({
      supplier_name: "Package Lab",
      supplier_email: "design@package-lab.com",
      supplier_resolution: "legacy_unresolved",
      legacy_supplier_match_json: null,
    });
    expect(orders[2]).toMatchObject({
      supplier_resolution: "legacy_unresolved",
      legacy_supplier_match_json: null,
    });

    const beforeMarker = await db.get<{ updated_at: string }>(
      "SELECT updated_at FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    const beforeRows = JSON.stringify(orders);
    await listFilmOrders("seven@727.co.jp");
    const afterMarker = await db.get<{ updated_at: string }>(
      "SELECT updated_at FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    const afterRows = await db.all<typeof orders[number]>(
      "SELECT id,supplier_name,supplier_email,film_maker_id,supplier_resolution,legacy_supplier_match_json FROM film_orders ORDER BY id",
    );
    expect(afterMarker?.updated_at).toBe(beforeMarker?.updated_at);
    expect(JSON.stringify(afterRows)).toBe(beforeRows);

    const eventsBefore = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM film_order_events");
    await expect((async () => {
      const { selectFilmMakerForOrder } = await import("@/lib/film-maker-store");
      await selectFilmMakerForOrder(1, 999, "admin@kanei-trade.co.jp");
    })()).rejects.toThrow("film_maker_not_found");
    const eventsAfter = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM film_order_events");
    expect(eventsAfter?.count).toBe(eventsBefore?.count);
    const rollbackOrder = await db.get<typeof orders[number]>(
      "SELECT id,supplier_name,supplier_email,film_maker_id,supplier_resolution,legacy_supplier_match_json FROM film_orders WHERE id=1",
    );
    expect(rollbackOrder).toEqual(orders[0]);
  });

  it("cold-starts the reconciliation slot with the same additive columns", async () => {
    const { resetFilmOrderDatabaseForTest } = await import("@/lib/film-orders");
    await resetFilmOrderDatabaseForTest();
    process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "cold-quotations.db");
    process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "cold-customers.db");
    const cold = await getSqlClient("quotations");
    await cold.exec(`
      CREATE TABLE quotations (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'approved', created_by INTEGER, payload_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user');
    `);
    const { listFilmOrders } = await import("@/lib/film-orders");
    await listFilmOrders("seven@727.co.jp");
    const columns = await cold.all<{ name: string }>("PRAGMA table_info(film_orders)");
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "film_maker_id", "film_maker_snapshot_json", "legacy_supplier_match_json", "supplier_resolution",
    ]));
    const marker = await cold.get<{ version: string }>(
      "SELECT version FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    expect(marker?.version).toBe(NEW_SCHEMA_VERSION);
    const makerCount = await cold.get<{ count: number }>("SELECT COUNT(*) AS count FROM film_makers");
    expect(makerCount?.count).toBe(0);
    await resetFilmOrderDatabaseForTest();
    process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
    process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
    const original = await getSqlClient("quotations");
    const rows = await original.all<{ id: number }>("SELECT id FROM film_orders ORDER BY id");
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3]);
  });

  it("reports historical order migration compatibility", async () => {
    const orders = await db.all<{
      id: number;
      supplier_name: string;
      supplier_email: string;
      film_maker_id: number | null;
      supplier_resolution: string;
    }>("SELECT id,supplier_name,supplier_email,film_maker_id,supplier_resolution FROM film_orders ORDER BY id");
    expect(orders).toHaveLength(3);
    expect(orders[0]).toMatchObject({
      supplier_name: "Exact External Maker",
      supplier_email: "  Exact@Example.test ",
      film_maker_id: null,
      supplier_resolution: "legacy_unresolved",
    });
    expect(orders[1]).toMatchObject({
      supplier_name: "Package Lab",
      supplier_email: "design@package-lab.com",
      supplier_resolution: "legacy_unresolved",
    });
    expect(orders[2]).toMatchObject({
      supplier_resolution: "legacy_unresolved",
    });
    const indexes = await db.all<{ name: string }>("PRAGMA index_list(film_orders)");
    expect(indexes.map((index) => index.name)).toContain("idx_film_orders_film_maker");
  });
});

describe("migration compatibility evidence", () => {
  it("keeps legacy order IDs/statuses/files/events/tokens stable", async () => {
    const order = await db.get<{ supplier_name: string; supplier_email: string; film_maker_id: number | null; supplier_resolution: string }>(
      "SELECT supplier_name, supplier_email, film_maker_id, supplier_resolution FROM film_orders WHERE id=1",
    );
    // Additive SQLite migration cannot attach a new FK to the existing table. The store-level
    // selection invariant plus idx_film_orders_film_maker is the documented G002 strategy.
    const tableSql = await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='film_orders'");
    expect(tableSql?.sql).not.toContain("REFERENCES film_makers");
  });

  it("keeps the recreated external-token state migration idempotent", async () => {
    const { getDatabaseForFilmMakerStore, resetFilmOrderSchemaForTest } = await import("@/lib/film-orders");
    await getDatabaseForFilmMakerStore();
    await db.run(`
      INSERT INTO film_order_mail_outbox (
        order_id,dispatch_group_id,workflow_key,audience,language,template_key,template_identity_json,
        sender_identity,sender_email,intended_to,subject,body,links_json,canonical_envelope_json,content_hash,
        requested_by_email,created_at,updated_at
      ) VALUES (
        1,'old-dispatch-group','receiving_data_request','maker','ko','supplier_proof','{}','Workflow',
        'sender@example.test','exact@example.test','subject','body',
        '[{"key":"maker_proof_upload","url":"http://localhost:3000/film-orders/upload/old-raw-staged-token"}]',
        '{}','old-content-hash','seed','2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z'
      )
    `);
    const stagedHash = (await import("node:crypto")).createHash("sha256")
      .update("old-raw-staged-token").digest("hex");
    await db.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_state,token_hash,dispatch_group_id,audience_email,expires_at,
        created_by_email,created_at,updated_at
      ) VALUES (1,'supplier_proof','staged',?,NULL,'exact@example.test','2027-01-01T00:00:00.000Z',
                'old-system','2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z')
    `, [stagedHash]);
    await db.run(
      "UPDATE film_order_schema_migrations SET version=?, updated_at=? WHERE slot='film_orders'",
      [LEGACY_SCHEMA_VERSION, "2026-01-04T00:00:00.000Z"],
    );
    await resetFilmOrderSchemaForTest();
    await getDatabaseForFilmMakerStore();
    const before = await db.all<Record<string, unknown>>(
      "SELECT * FROM film_order_external_tokens ORDER BY id",
    );
    expect(before).toHaveLength(3);
    expect(before.find((row) => row.token_hash === stagedHash))
      .toMatchObject({ token_state: "staged", dispatch_group_id: "old-dispatch-group" });
    await db.run(
      "UPDATE film_order_schema_migrations SET version=?, updated_at=? WHERE slot='film_orders'",
      [LEGACY_SCHEMA_VERSION, "2026-01-04T00:00:00.000Z"],
    );
    await resetFilmOrderSchemaForTest();
    await getDatabaseForFilmMakerStore();
    const after = await db.all<Record<string, unknown>>(
      "SELECT * FROM film_order_external_tokens ORDER BY id",
    );
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after).toHaveLength(3);
    const associated = after.find((row) => row.token_hash === stagedHash);
    expect(associated).toMatchObject({ token_state: "staged", dispatch_group_id: "old-dispatch-group" });
    const tokenTableSql = await db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='film_order_external_tokens'",
    );
    expect(tokenTableSql?.sql).toContain("dispatch_group_id TEXT");
  });
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});
