import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
import {
  buildFilmOrderNotifications,
  filmOrderNotificationEnvelopeHash,
  type FilmOrderNotificationEvent,
  type FilmOrderNotificationInput,
} from "@/lib/film-order-notifications";

const databaseUrl = process.env.POUCH_TEST_DATABASE_URL;

const databaseDirectory = await mkdtemp(join(tmpdir(), "postgres-integration-"));
if (databaseUrl) {
  process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "unused.sqlite");
  process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "unused-customers.sqlite");
  process.env.DATABASE_URL = databaseUrl;
  process.env.ADMIN_EMAIL = "pg-admin@integration.test";
  process.env.ADMIN_PASSWORD = "pg-admin-password";
  process.env.ADMIN_NAME = "PG Admin";
}

// POUCH_TEST_DATABASE_URL が設定されている環境（ローカル検証・CI）でのみ実行する。
describe.skipIf(!databaseUrl)("PostgreSQL-backed stores", () => {
  let pool: Pool;

  beforeAll(async () => {
    const { Pool: PgPool } = await import("pg");
    pool = new PgPool({ connectionString: databaseUrl });
    await pool.query(`
      DROP TABLE IF EXISTS quotation_checklists CASCADE;
      DROP TABLE IF EXISTS quotations CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS customers CASCADE;
      DROP TABLE IF EXISTS customer_delivery_destinations CASCADE;
      DROP TABLE IF EXISTS customer_selections CASCADE;
      DROP TABLE IF EXISTS customer_schema_migrations CASCADE;
      DROP TABLE IF EXISTS film_order_files CASCADE;
      DROP TABLE IF EXISTS film_order_events CASCADE;
      DROP TABLE IF EXISTS film_order_external_tokens CASCADE;
      DROP TABLE IF EXISTS film_order_ship_to_destinations CASCADE;
      DROP TABLE IF EXISTS film_order_mail_attempts CASCADE;
      DROP TABLE IF EXISTS film_order_mail_outbox CASCADE;
      DROP TABLE IF EXISTS film_orders CASCADE;
      DROP TABLE IF EXISTS film_makers CASCADE;
      DROP TABLE IF EXISTS film_order_schema_migrations CASCADE;
      DO $$
      BEGIN
        IF to_regclass('gravure_y_supplier_prices') IS NOT NULL THEN
          TRUNCATE TABLE gravure_y_supplier_prices;
        END IF;
      END
      $$;
    `);
  });

  afterAll(async () => {
    const { closeDatabaseForTest } = await import("@/lib/auth-store");
    await closeDatabaseForTest();
    await pool.end();
    await rm(databaseDirectory, { recursive: true, force: true });
  });

  const baseInput: QuotationRecordInput = {
    quotationNumber: "S7-PG-INTEGRITY-001",
    status: "draft",
    issueDate: "2026-10-06",
    validUntil: "2026-11-06",
    customerName: "PostgreSQL顧客",
    customerContact: "担当",
    productName: "PGテストパウチ",
    sizeSummary: "50×90mm / 1連",
    quantity: "10000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "1",
    filmMeterPrice: "200",
    filmOrderLengthM: "500",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "100000",
    tax: "10000",
    grandTotal: "110000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "manual-entry",
    resultHash: "",
    payload: { revision: 1 },
  };

  it("stores users, quotations, checklists, and customers in PostgreSQL", { timeout: 120_000 }, async () => {
    const { ensureAdministratorSeed, createUser, authenticate } = await import("@/lib/auth-store");
    const administratorId = await ensureAdministratorSeed();
    expect(Number.isInteger(administratorId)).toBe(true);

    const owner = await createUser({
      email: "owner@727.co.jp",
      name: "PG Owner",
      password: "owner-password-123",
      role: "user",
    });
    const other = await createUser({
      email: "other@pg.test",
      name: "PG Other",
      password: "other-password-123",
      role: "user",
    });
    await expect(createUser({
      email: "OWNER@727.CO.JP",
      name: "Duplicate",
      password: "duplicate-password",
      role: "user",
    })).rejects.toThrow("duplicate_email");
    expect(await authenticate("owner@727.co.jp", "owner-password-123")).toMatchObject({ id: owner.id });

    const { saveQuotation, getQuotation, listQuotations, QuotationActionForbiddenError } = await import("@/lib/quotation-store");
    const saved = await saveQuotation(baseInput, owner.id, "user");
    expect(saved.quotationNumber).toBe(baseInput.quotationNumber);
    expect(saved.payload).toEqual({ revision: 1 });
    expect(saved.createdBy.email).toBe("owner@727.co.jp");
    expect(saved.ownerDomain).toBe("seven");

    await expect(saveQuotation({ ...baseInput, quantity: "999" }, other.id, "user"))
      .rejects.toBeInstanceOf(QuotationActionForbiddenError);

    const searched = await listQuotations({ q: "postgresql", limit: 10 });
    expect(searched.some((record) => record.id === saved.id)).toBe(true);
    expect(await getQuotation(saved.id)).not.toBeNull();

    const { updateQuotationStatus } = await import("@/lib/quotation-store");
    await expect(updateQuotationStatus(saved.id, "approved", other.id))
      .rejects.toBeInstanceOf(QuotationActionForbiddenError);
    const approved = await updateQuotationStatus(saved.id, "approved", owner.id);
    expect(approved?.status).toBe("approved");

    const { createChecklistsForQuotation, getChecklistsForQuotation, updateChecklistItem } = await import("@/lib/quotation-store");
    const { calculatePouchCost } = await import("@/lib/calculation");
    const { buildCalculationChecklistSnapshot } = await import("@/lib/calculation-checklist");
    const calculated = calculatePouchCost({
      spec: {
        sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      },
      quantity: "10000", printingMethod: "digital",
    });
    const snapshot = buildCalculationChecklistSnapshot(calculated, {
      quotationNumber: approved!.quotationNumber,
      customerName: approved!.customerName,
      printingMethod: "digital",
      sourceHash: "source-hash",
      resultHash: "result-hash",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      skus: [{ name: "PG充填物", quantity: "10000", fillMl: "3", colorCount: "4" }],
    });
    const checklists = await createChecklistsForQuotation(approved!, snapshot);
    expect(checklists.map((entry) => entry.audience)).toEqual(["CUSTOMER", "INTERNAL_QA"]);
    const reloaded = await getChecklistsForQuotation(approved!.id);
    expect(reloaded).toHaveLength(2);
    const customerChecklist = reloaded.find((entry) => entry.audience === "CUSTOMER");
    expect(customerChecklist).toBeDefined();
    const updatedChecklist = await updateChecklistItem(approved!.id, "CUSTOMER", "film.total", true, "PG担当");
    expect(updatedChecklist!.acceptedCount).toBeGreaterThan(0);

    const { saveCustomer, getCustomer, listCustomers } = await import("@/lib/customer-store");
    const customer = await saveCustomer("kanei", {
      customerCode: "PG-001",
      customerName: "PostgreSQL顧客マスタ",
      customerPostalCode: "1000001",
      customerAddress: "東京都",
      customerContact: "PG担当",
      customerTelephone: "03-0000-0000",
      customerEmail: "customer@pg.test",
    });
    expect(customer.customerCode).toBe("PG-001");
    expect(await getCustomer("seven", "pg-001")).toBeNull();
    const customers = await listCustomers("postgresql", 100, "kanei");
    expect(customers).toHaveLength(1);

    const { getDatabaseForTest } = await import("@/lib/quotation-store");
    const db = await getDatabaseForTest();
    expect(db.dialect).toBe("postgres");
    await expect(db.run("DELETE FROM users WHERE id = ?", [owner.id]))
      .rejects.toThrow(/foreign key/iu);
  });

  it("records the gravure migration and serializes overlapping master writes", { timeout: 120_000 }, async () => {
    const {
      createGravureYMasterRow,
      getGravureMigrationVersion,
      validateGravureYMasterInput,
    } = await import("@/lib/gravure-price-store");
    expect(await getGravureMigrationVersion()).toBe(1);

    const input = validateGravureYMasterInput({
      webWidthMm: 356,
      laneCount: 1,
      printTierM: 2000,
      approxOutputLengthM: "1700",
      supplierUnitPriceYenPerM: "141.00",
      plateBaseYenPerColor: "26000",
      sellerMarkup: "1.12",
      effectiveFrom: "2026-10-01",
      memo: "pg-overlap",
    });
    const admin = { actor: "pg-admin@kanei-trade.co.jp" };
    await createGravureYMasterRow(input, admin.actor);
    await expect(createGravureYMasterRow(input, admin.actor)).rejects.toThrow(/overlap/i);
  });

  it("migrates the film-maker master and enforces the order foreign key", { timeout: 120_000 }, async () => {
    const { listFilmOrders } = await import("@/lib/film-orders");
    await listFilmOrders("pg-admin@kanei-trade.co.jp");
    const { getSqlClient } = await import("@/lib/db");
    const db = await getSqlClient("quotations");
    const orderColumns = await db.all<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='film_orders'
    `);
    expect(orderColumns.map((column) => column.column_name)).toEqual(expect.arrayContaining([
      "film_maker_id", "film_maker_snapshot_json", "legacy_supplier_match_json", "supplier_resolution",
    ]));
    const marker = await db.get<{ version: string }>(
      "SELECT version FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    expect(marker?.version).toBe("2026-11-06-extensible-proof-rounds-1");
    const quotation = await db.get<{ id: number }>("SELECT id FROM quotations WHERE quotation_number='S7-PG-INTEGRITY-001'");
    await db.exec(`
      INSERT INTO film_orders (
        quotation_id, order_number, quotation_number, product_name, customer_name,
        printing_method, procurement_route, status, purchase_order_json, created_at, updated_at
      ) VALUES (
        ${quotation!.id}, 'F-202611-PG-001', 'S7-PG-FILM-001', 'PGパウチ', 'PG顧客',
        'gravure', 'K', 'pending', '{}', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z'
      )
    `);
    const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='F-202611-PG-001'");
    const { createFilmMaker, filmOrderMakerResolution, selectFilmMakerForOrder } = await import("@/lib/film-maker-store");
    const maker = await createFilmMaker({
      makerCode: "PG-KOR-GRA-001",
      companyName: "PostgreSQLフィルムメーカー",
      email: "pg-maker@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "pg-admin@kanei-trade.co.jp");
    expect((await filmOrderMakerResolution(order!.id)).resolution).toBe("legacy_unresolved");
    await db.run(`
      INSERT INTO film_orders (
        quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
        supplier_name,supplier_email,status,purchase_order_json,created_at,updated_at
      ) VALUES (?, 'F-202611-PG-LEGACY-EXACT','S7-PG-FILM-LEGACY','PG legacy pouch','PG customer','gravure','K',
                'PostgreSQLフィルムメーカー','PG-MAKER@EXAMPLE.TEST','pending','{}',?,?)
    `, [quotation!.id, '2026-11-04T00:00:01.000Z', '2026-11-04T00:00:01.000Z']);
    await db.run(`
      INSERT INTO film_orders (
        quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
        supplier_name,supplier_email,status,purchase_order_json,created_at,updated_at
      ) VALUES (?, 'F-202611-PG-LEGACY-INTERNAL','S7-PG-FILM-LEGACY-2','PG internal pouch','PG customer','gravure','K',
                'Package Lab','design@package-lab.com','pending','{}',?,?)
    `, [quotation!.id, '2026-11-04T00:00:02.000Z', '2026-11-04T00:00:02.000Z']);
    const legacyExact = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE order_number='F-202611-PG-LEGACY-EXACT'",
    );
    const legacyInternal = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE order_number='F-202611-PG-LEGACY-INTERNAL'",
    );
    const { backfillLegacySupplierSuggestions, exemptLegacyOrder, listLegacyReconciliations } = await import("@/lib/film-maker-store");
    expect(await backfillLegacySupplierSuggestions([Number(legacyExact!.id), Number(legacyInternal!.id)]))
      .toEqual({ scanned: 2, suggested: 1 });
    const reconciliations = await listLegacyReconciliations();
    expect(reconciliations.find((entry) => entry.orderId === Number(legacyExact!.id))).toMatchObject({
      supplierEmail: "PG-MAKER@EXAMPLE.TEST",
      classification: "external_exact",
      suggestedMaker: { makerId: maker.id, matchedByEmail: "pg-maker@example.test" },
    });
    expect(reconciliations.find((entry) => entry.orderId === Number(legacyInternal!.id))?.classification).toBe("internal");
    await exemptLegacyOrder(
      Number(legacyInternal!.id),
      "PostgreSQL explicit historical exemption",
      "internal",
      "pg-admin@kanei-trade.co.jp",
    );
    expect((await listLegacyReconciliations()).some((entry) => entry.orderId === Number(legacyInternal!.id))).toBe(false);
    const preservedInternal = await db.get<{
      supplier_name: string;
      supplier_email: string;
      supplier_resolution: string;
    }>("SELECT supplier_name,supplier_email,supplier_resolution FROM film_orders WHERE id=?", [legacyInternal!.id]);
    expect(preservedInternal).toEqual({
      supplier_name: "Package Lab",
      supplier_email: "design@package-lab.com",
      supplier_resolution: "legacy_exempt",
    });
    await selectFilmMakerForOrder(order!.id, maker.id, "pg-workflow@kanei-trade.co.jp");
    expect(await filmOrderMakerResolution(order!.id)).toMatchObject({
      resolution: "master_selected",
      makerId: maker.id,
      snapshot: { email: "pg-maker@example.test" },
    });
    const foreignKey = await db.get<{ constraint_name: string }>(
      "SELECT constraint_name FROM information_schema.table_constraints WHERE table_name='film_orders' AND constraint_name='film_orders_film_maker_id_fkey'",
    );
    expect(foreignKey?.constraint_name).toBe("film_orders_film_maker_id_fkey");
    await expect(db.run("DELETE FROM film_makers WHERE id=?", [maker.id])).rejects.toThrow(/foreign key/iu);
  });

  it("incrementally upgrades PostgreSQL to the reconciliation slot without assigning makers", { timeout: 120_000 }, async () => {
    const { getSqlClient } = await import("@/lib/db");
    const db = await getSqlClient("quotations");
    const quotation = await db.get<{ id: number }>("SELECT id FROM quotations WHERE quotation_number='S7-PG-INTEGRITY-001'");
    await db.run(`
      INSERT INTO film_orders (
        quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
        supplier_name,supplier_email,status,purchase_order_json,created_at,updated_at
      ) VALUES (?, 'F-202611-PG-INCREMENTAL','S7-PG-FILM-INCR','PG incremental pouch','PG customer','gravure','K',
                'PostgreSQLフィルムメーカー','PG-Maker@Example.TEST','pending','{}',?,?)
    `, [quotation!.id, '2026-11-04T00:00:03.000Z', '2026-11-04T00:00:03.000Z']);
    const before = await db.get<{ id: number; supplier_name: string; supplier_email: string }>(
      "SELECT id,supplier_name,supplier_email FROM film_orders WHERE order_number='F-202611-PG-INCREMENTAL'",
    );
    const beforeOrderIds = (await db.all<{ id: number }>("SELECT id FROM film_orders ORDER BY id")).map((row) => row.id);

    // Reconstruct the immediately previous additive slot: no suggestion column and old marker.
    await db.exec("ALTER TABLE film_orders DROP COLUMN legacy_supplier_match_json");
    await db.run(
      "UPDATE film_order_schema_migrations SET version=?, updated_at=? WHERE slot='film_orders'",
      ["2026-11-04-film-order-cancel-scoping-2", "2026-11-04T00:00:00.000Z"],
    );
    const { resetFilmOrderSchemaForTest } = await import("@/lib/film-orders");
    await resetFilmOrderSchemaForTest();
    const { listFilmOrders } = await import("@/lib/film-orders");
    await listFilmOrders("pg-admin@kanei-trade.co.jp");
    const marker = await db.get<{ version: string }>(
      "SELECT version FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    expect(marker?.version).toBe("2026-11-06-extensible-proof-rounds-1");
    const columns = await db.all<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='film_orders'
    `);
    expect(columns.map((column) => column.column_name)).toContain("legacy_supplier_match_json");
    const afterOrderIds = (await db.all<{ id: number }>("SELECT id FROM film_orders ORDER BY id")).map((row) => row.id);
    expect(afterOrderIds).toEqual(beforeOrderIds);
    const legacyOrder = await db.get<{
      id: number;
      supplier_name: string;
      supplier_email: string;
      film_maker_id: number | null;
      supplier_resolution: string;
      legacy_supplier_match_json: string;
    }>(`
      SELECT id,supplier_name,supplier_email,film_maker_id,supplier_resolution,legacy_supplier_match_json
      FROM film_orders WHERE id=?
    `, [before!.id]);
    expect(legacyOrder).toMatchObject({
      id: before!.id,
      supplier_name: before!.supplier_name,
      supplier_email: before!.supplier_email,
      film_maker_id: null,
      supplier_resolution: "legacy_unresolved",
    });
    expect(JSON.parse(legacyOrder!.legacy_supplier_match_json)).toMatchObject({
      makerId: expect.any(Number),
      matchedByEmail: "pg-maker@example.test",
      confidence: "exact",
      rule: "normalized_email_route_print",
    });
    const firstMarker = await db.get<{ updated_at: string }>(
      "SELECT updated_at FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    await listFilmOrders("pg-admin@kanei-trade.co.jp");
    const secondMarker = await db.get<{ updated_at: string }>(
      "SELECT updated_at FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    expect(secondMarker?.updated_at).toBe(firstMarker?.updated_at);
  });

  it("upgrades a true pre-feature PostgreSQL external-token schema to lifecycle columns", { timeout: 120_000 }, async () => {
    const { getSqlClient, resetSqlClientForTest } = await import("@/lib/db");
    const { resetFilmOrderSchemaForTest, buildEtaToken, getDatabaseForFilmMakerStore, listFilmOrders } = await import("@/lib/film-orders");
    const db = await getSqlClient("quotations");
    const order = (await listFilmOrders("pg-admin@kanei-trade.co.jp"))
      .find((entry) => entry.order_number === "F-202611-PG-001")!;
    const rawToken = buildEtaToken(order.id, 14).token;
    const { createHash } = await import("node:crypto");
    const proofHash = createHash("sha256").update("old-proof-token").digest("hex");
    await pool.query(`
      DROP TABLE film_order_external_tokens CASCADE;
      CREATE TABLE film_order_external_tokens (
        id INTEGER PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
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
    `);
    await db.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,audience_email,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?, 'supplier_proof', ?, 'pg-maker@example.test', '2027-01-01T00:00:00.000Z', 'old-system', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `, [order.id, proofHash]);
    await db.run("UPDATE film_orders SET eta_token=?, eta_expires_at='2027-01-01T00:00:00.000Z' WHERE id=?", [rawToken, order.id]);

    await db.exec(`
      UPDATE film_order_schema_migrations
      SET version='2026-11-04-film-order-cancel-scoping-2', updated_at='2026-01-02T00:00:00.000Z'
      WHERE slot='film_orders'
    `);
    await resetFilmOrderSchemaForTest();
    const migratedDb = await getSqlClient("quotations");
    await getDatabaseForFilmMakerStore();

    const columns = await db.all<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='film_order_external_tokens'
      ORDER BY ordinal_position
    `);
    void migratedDb;
    const names = columns.map((column) => column.column_name);
    expect(names).toEqual(expect.arrayContaining(["token_state", "dispatch_group_id"]));
    const constraints = await db.all<{ constraint_name: string }>(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_schema=current_schema() AND table_name='film_order_external_tokens'
    `);
    const constraintNames = constraints.map((constraint) => constraint.constraint_name);
    expect(constraintNames).toContain("film_order_external_tokens_purpose_check");
    expect(constraintNames).toContain("film_order_external_token_state_consistency");
    const rows = await db.all<{ purpose: string; token_state: string; token_hash: string; dispatch_group_id: string | null }>(
      "SELECT purpose,token_state,token_hash,dispatch_group_id FROM film_order_external_tokens ORDER BY id",
    );
    expect(rows.some((row) => row.purpose === "supplier_proof" && row.token_state === "active" && row.token_hash === proofHash)).toBe(true);
    expect(rows.some((row) => row.purpose === "maker_eta" && row.token_hash === createHash("sha256").update(rawToken).digest("hex"))).toBe(true);
    const indexes = await db.all<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname=current_schema() AND tablename='film_order_external_tokens'
    `);
    const indexNames = indexes.map((index) => index.indexname);
    expect(indexNames).toEqual(expect.arrayContaining([
      "idx_film_external_active_token",
      "idx_film_external_order_purpose_state",
      "idx_film_external_dispatch_state",
    ]));

    const firstMarker = await migratedDb.get<{ updated_at: string }>(
      "SELECT updated_at FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    await resetFilmOrderSchemaForTest();
    const reopenedDb = await getSqlClient("quotations");
    await getDatabaseForFilmMakerStore();
    const secondMarker = await reopenedDb.get<{ updated_at: string }>(
      "SELECT updated_at FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    expect(secondMarker?.updated_at).toBe(firstMarker?.updated_at);
    const rowCount = await reopenedDb.get<{ count: string }>("SELECT COUNT(*) AS count FROM film_order_external_tokens");
    expect(Number(rowCount?.count)).toBe(2);
  });

  it("serializes concurrent ship-to confirmations with affected-row checks", { timeout: 120_000 }, async () => {
    const { listFilmOrders, runFilmOrderAction } = await import("@/lib/film-orders");
    const { getSqlClient } = await import("@/lib/db");
    const db = await getSqlClient("quotations");
    const orders = await listFilmOrders("pg-owner@727.co.jp");
    const order = orders.find((entry) => entry.order_number === "F-202611-PG-001");
    expect(order).toBeTruthy();
    await db.run("UPDATE film_orders SET customer_code='PG-001' WHERE id=?", [order!.id]);
    const registered = await runFilmOrderAction(order!.id, "register-ship-to", {
      destinations: [{
        shipToCompanyName: "PostgreSQL物流株式会社",
        shipToPostalCode: "100-0001",
        shipToAddress: "東京都テスト1-1-1",
        shipToPhone: "03-0000-0000",
        saveShipToMaster: false,
      }],
    }, "pg-owner@727.co.jp");
    expect(registered.order.shipTo.status).toBe("registered");

    const attempts = await Promise.allSettled([
      runFilmOrderAction(order!.id, "confirm-ship-to", {}, "pg-owner@727.co.jp"),
      runFilmOrderAction(order!.id, "confirm-ship-to", {}, "pg-workflow@kanei-trade.co.jp"),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const confirmed = await listFilmOrders("pg-owner@727.co.jp");
    const reloaded = confirmed.find((entry) => entry.id === order!.id)!;
    expect(reloaded.shipTo.status).toBe("confirmed");
    expect(reloaded.shipTo.destinations.every((destination) => destination.confirmedAt)).toBe(true);
  });

  it("locks and optimistically rejects concurrent PostgreSQL maker selection", { timeout: 120_000 }, async () => {
    const { getSqlClient } = await import("@/lib/db");
    const { getDatabaseForFilmMakerStore } = await import("@/lib/film-orders");
    const { createFilmMaker, selectFilmMakerForOrder, filmOrderMakerResolution } = await import("@/lib/film-maker-store");
    const db = await getSqlClient("quotations");
    await getDatabaseForFilmMakerStore();
    const quotation = await db.get<{ id: number }>(
      "SELECT id FROM quotations WHERE quotation_number='S7-PG-INTEGRITY-001'",
    );
    const maker = await createFilmMaker({
      makerCode: "PG-CONCURRENT-KOR-001",
      companyName: "PostgreSQL Concurrent Maker",
      email: "pg-concurrent-maker@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "pg-admin@kanei-trade.co.jp");
    await db.run(`
      INSERT INTO film_orders (
        quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,
        procurement_route,status,supplier_resolution,purchase_order_json,created_at,updated_at
      ) VALUES (?, 'F-202611-PG-MAKER-CONCURRENT', 'S7-PG-FILM-CONCURRENT', 'PG concurrency pouch',
                'PG customer', 'gravure', 'K', 'ordered', 'legacy_unresolved', '{}', ?, ?
      )
    `, [
      quotation!.id,
      "2026-11-04T00:00:04.000Z",
      "2026-11-04T00:00:04.000Z",
    ]);
    const order = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE order_number='F-202611-PG-MAKER-CONCURRENT'",
    );
    const results = await Promise.allSettled([
      selectFilmMakerForOrder(Number(order!.id), maker.id, "pg-first@kanei-trade.co.jp"),
      selectFilmMakerForOrder(Number(order!.id), maker.id, "pg-second@kanei-trade.co.jp"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect((rejected[0].reason as Error).message).toBe("film_maker_selection_conflict");
    }
    const winnerActor = fulfilled[0]?.status === "fulfilled"
      ? fulfilled[0].value.snapshot.selectedByEmail
      : "";
    const selected = await filmOrderMakerResolution(Number(order!.id));
    expect(selected).toMatchObject({
      resolution: "master_selected",
      makerId: maker.id,
      snapshot: { email: "pg-concurrent-maker@example.test" },
    });
    const events = await db.all<{ actor_email: string }>(
      "SELECT actor_email FROM film_order_events WHERE order_id=? AND type='film_maker'",
      [order!.id],
    );
    expect(events.map((event) => event.actor_email)).toEqual([winnerActor]);
  });

  it("enforces one active maker_eta token with bounded staged coexistence and state consistency", { timeout: 120_000 }, async () => {
    const { getSqlClient } = await import("@/lib/db");
    const db = await getSqlClient("quotations");
    const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='F-202611-PG-001'");
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const constraint = await db.get<{ constraint_def: string }>(`
      SELECT pg_get_constraintdef(oid) AS "constraint_def"
      FROM pg_constraint
      WHERE conrelid='film_order_external_tokens'::regclass
        AND conname='film_order_external_token_state_consistency'
    `);
    expect(constraint?.constraint_def).toContain("token_state = 'revoked'::text");
    const dispatchColumn = await db.get<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='film_order_external_tokens' AND column_name='dispatch_group_id'
    `);
    expect(dispatchColumn?.column_name).toBe("dispatch_group_id");
    await db.run(
      "UPDATE film_order_external_tokens SET token_state='revoked', revoked_at=? WHERE film_order_id=? AND purpose='maker_eta' AND token_state='active'",
      [now, order!.id],
    );
    await db.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,token_state,dispatch_group_id,audience_email,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?,'maker_eta','pg-maker-eta-active','active','pg-existing-active','pg-maker@example.test',?,'pg-workflow@kanei-trade.co.jp',?,?)
    `, [order!.id, future, now, now]);
    await db.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,token_state,dispatch_group_id,audience_email,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?,'maker_eta','pg-maker-eta-staged','staged','pg-cancel-group-b','pg-maker@example.test',?,'pg-workflow@kanei-trade.co.jp',?,?)
    `, [order!.id, future, now, now]);
    const states = await db.all<{ token_state: string }>(
      "SELECT token_state FROM film_order_external_tokens WHERE film_order_id=? AND purpose='maker_eta' ORDER BY id",
      [order!.id],
    );
    expect(states.map((state) => state.token_state)).toEqual(["revoked", "active", "staged"]);
    await expect(db.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,token_state,dispatch_group_id,audience_email,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?,'maker_eta','pg-maker-eta-second-active','active','pg-other-group','pg-maker@example.test',?,'pg-workflow@kanei-trade.co.jp',?,?)
    `, [order!.id, future, now, now])).rejects.toThrow(/active|unique/iu);
    await expect(db.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,token_state,dispatch_group_id,audience_email,expires_at,revoked_at,created_by_email,created_at,updated_at
      ) VALUES (?,'maker_eta','pg-maker-eta-inconsistent','active','pg-inconsistent','pg-maker@example.test',?,?, 'pg-workflow@kanei-trade.co.jp',?,?)
    `, [order!.id, future, now, now, now])).rejects.toThrow(/state_consistency|check/iu);
  });

  it("persists mail outbox envelopes with audience-safe reads and immutable attempts", { timeout: 120_000 }, async () => {
    const { listFilmOrders } = await import("@/lib/film-orders");
    const { getSqlClient } = await import("@/lib/db");
    const db = await getSqlClient("quotations");
    const order = (await listFilmOrders("pg-admin@kanei-trade.co.jp"))
      .find((entry) => entry.order_number === "F-202611-PG-001");
    const { filmOrderMakerResolution } = await import("@/lib/film-maker-store");
    const resolution = await filmOrderMakerResolution(order!.id);
    expect(resolution).toMatchObject({
      resolution: "master_selected",
      snapshot: { email: "pg-maker@example.test", language: "ko" },
    });

    const links = [
      { key: "maker_receiving_packet", url: "https://pg.example/packet", label: "packet" },
      { key: "maker_proof_upload", url: "https://pg.example/proof", label: "proof" },
      { key: "maker_purchase_order", url: "https://pg.example/po", label: "po" },
      { key: "maker_eta_report", url: "https://pg.example/eta", label: "eta" },
      { key: "kanei_order_management", url: "https://pg.example/kanei", label: "kanei" },
      { key: "seven_order_summary", url: "https://pg.example/seven", label: "seven" },
      { key: "customer_proof_review", url: "https://pg.example/customer/proof", label: "customer proof" },
    ] as const;
    const notificationInput: FilmOrderNotificationInput = {
      orderId: order!.id,
      dispatchGroupId: "group-g004-pg",
      orderNumber: order!.order_number,
      productName: order!.product_name,
      productSpecification: "PG PET/AL/PE, 160mm, 300m, gravure",
      workflowStage: "final_approvals",
      recipients: {
        maker: resolution.snapshot!.email,
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
      maker: {
        companyName: resolution.snapshot!.companyName,
        email: resolution.snapshot!.email,
        language: "ko",
      },
      purchaseOrderNumber: "PO-PG-INTERNAL",
      internalCostSummary: "cost 123456 JPY",
      links,
    };
    function envelopes(event: FilmOrderNotificationEvent) {
      const result = buildFilmOrderNotifications(event, notificationInput);
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      return result.envelopes;
    }

    const marker = await db.get<{ version: string }>(
      "SELECT version FROM film_order_schema_migrations WHERE slot='film_orders'",
    );
    expect(marker?.version).toBe("2026-11-06-extensible-proof-rounds-1");
    const { persistFilmOrderMailEnvelopes, listFilmOrderMailOutboxForKanei, listFilmOrderMailOutboxForAudience } =
      await import("@/lib/film-order-mail-outbox");
    const persisted = await persistFilmOrderMailEnvelopes(envelopes("supplier_purchase_order"), {
      requestedByEmail: "operator@kanei-trade.co.jp",
      envelopeStatus: "composed",
    });
    expect(persisted.map((record) => record.audience)).toEqual(["maker", "seven", "kanei"]);
    const outboxId = persisted[0]!.id;
    const kaneiView = await listFilmOrderMailOutboxForKanei(order!.id, "operator@kanei-trade.co.jp");
    expect(kaneiView.filter((record) => record.dispatchGroupId === "group-g004-pg")).toHaveLength(3);
    const seven = (await listFilmOrderMailOutboxForAudience(order!.id, "seven", "seven@727.co.jp", "seven@727.co.jp"))[0]!;
    const serializedSeven = JSON.stringify(seven);
    expect(serializedSeven).not.toContain("body");
    expect(serializedSeven).not.toContain("https://pg.example/proof");
    expect(serializedSeven).not.toContain("PostgreSQLフィルムメーカー");
    expect((await listFilmOrderMailOutboxForAudience(order!.id, "customer", "customer@example.test"))).toEqual([]);
    await expect(listFilmOrderMailOutboxForKanei(order!.id, "seven@727.co.jp")).rejects.toThrow("film_order_mail_outbox_forbidden");

    const { startFilmOrderMailAttempt, recordFilmOrderMailAttemptOutcome, recoverStaleFilmOrderMailSendingAttempts } =
      await import("@/lib/film-order-mail-outbox");
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
      smtpMessageId: "pg-smtp-1",
    });
    expect(sent.status).toBe("sent");
    await expect(startFilmOrderMailAttempt({
      outboxId,
      requestedByEmail: "successful-attempt-forbidden@kanei-trade.co.jp",
    })).rejects.toThrow("film_order_mail_retry_not_available");
    await pool.query("UPDATE film_order_mail_attempts SET status='retry_required', error_code='smtp_denied' WHERE outbox_id=$1 AND attempt_count=1", [outboxId]);

    const second = await startFilmOrderMailAttempt({
      outboxId,
      requestedByEmail: "retry-operator@kanei-trade.co.jp",
    });
    expect(second.attemptCount).toBe(2);
    const staleBefore = new Date(Date.now() - 1_000).toISOString();
    await pool.query("UPDATE film_order_mail_attempts SET attempt_started_at=$1 WHERE id=$2", [
      staleBefore,
      second.id,
    ]);
    const recovered = await recoverStaleFilmOrderMailSendingAttempts(staleBefore);
    expect(recovered.map((attempt) => attempt.status)).toEqual(["unknown"]);
    expect(await recoverStaleFilmOrderMailSendingAttempts(staleBefore)).toEqual([]);
    const safeAttempts = (await listFilmOrderMailOutboxForAudience(order!.id, "maker", "pg-maker@example.test", "pg-maker@example.test"))[0]!.attempts;
    expect(JSON.stringify(safeAttempts)).not.toContain("actualTo");
    expect(JSON.stringify(safeAttempts)).not.toContain("smtpMessageId");
    expect(safeAttempts.map((attempt) => attempt.attemptCount)).toEqual([1, 2]);
    expect(safeAttempts.map((attempt) => attempt.status)).toEqual(["retry_required", "unknown"]);
  });

  it("rejects stale outbox hashes without changing attempt history", { timeout: 120_000 }, async () => {
    const { listFilmOrders } = await import("@/lib/film-orders");
    const { getSqlClient } = await import("@/lib/db");
    const { filmOrderMakerResolution } = await import("@/lib/film-maker-store");
    const db = await getSqlClient("quotations");
    const { persistFilmOrderMailEnvelopes } = await import("@/lib/film-order-mail-outbox");
    const order = (await listFilmOrders("pg-admin@kanei-trade.co.jp"))
      .find((entry) => entry.order_number === "F-202611-PG-001")!;
    const resolution = await filmOrderMakerResolution(order.id);
    const links = [
      { key: "maker_eta_report", url: "https://pg.example/eta-hash" },
      { key: "seven_order_summary", url: "https://pg.example/seven-hash" },
      { key: "kanei_order_management", url: "https://pg.example/kanei-hash" },
    ] as const;
    const result = buildFilmOrderNotifications("eta_update", {
      orderId: order.id,
      dispatchGroupId: "group-g004-pg-hash-source",
      orderNumber: order.order_number,
      productName: order.product_name,
      productSpecification: "PG PET/AL/PE, hash test",
      workflowStage: "po",
      recipients: {
        maker: resolution.snapshot!.email,
        seven: "seven@727.co.jp",
        kanei: "kanei@kanei-trade.co.jp",
      },
      senderIdentity: {
        maker: "Kanei Trade Film Workflow",
        seven: "Kanei Trade Film Workflow",
        kanei: "Film Workflow System",
      },
      senderEmail: "workflow-sender@example.test",
      maker: {
        companyName: resolution.snapshot!.companyName,
        email: resolution.snapshot!.email,
        language: "ko",
      },
      links,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mutated = result.envelopes.map((envelope, index) => index === 0
      ? { ...envelope, dispatchGroupId: "group-g004-pg-hash", contentHash: filmOrderNotificationEnvelopeHash(envelope) }
      : { ...envelope, dispatchGroupId: "group-g004-pg-hash" });
    await expect(persistFilmOrderMailEnvelopes(mutated, {
      requestedByEmail: "operator@kanei-trade.co.jp",
    })).rejects.toThrow("invalid_film_order_mail_envelope");
    const attempts = await db.all<{ attempt_count: number; status: string }>(`
      SELECT attempt_count, status FROM film_order_mail_attempts
      JOIN film_order_mail_outbox ON film_order_mail_outbox.id=film_order_mail_attempts.outbox_id
      WHERE film_order_mail_outbox.dispatch_group_id='group-g004-pg'
      ORDER BY film_order_mail_attempts.outbox_id, attempt_count
    `);
    expect(attempts.some((attempt) => attempt.status === "retry_required")).toBe(true);
    expect(attempts.some((attempt) => attempt.status === "unknown")).toBe(true);
  });

  it("runs SQLite-equivalent prepare/cancel/concurrent-confirm lifecycle on PostgreSQL", { timeout: 120_000 }, async () => {
    const { getSqlClient } = await import("@/lib/db");
    const db = await getSqlClient("quotations");
    const now = new Date().toISOString();
    await pool.query(`
      INSERT INTO quotations (
        created_by,quotation_number,status,issue_date,valid_until,customer_name,customer_contact,product_name,size_summary,quantity,
        filling_cost_per_piece,film_cost_per_piece,film_meter_price,film_order_length_m,target_margin,tax_rate_percent,
        price_per_piece,subtotal,tax,grand_total,delivery_date,payment_terms,notes,calculation_version,result_hash,payload_json,created_at,updated_at
      ) VALUES ($3,'Q-PG-LIFE-001','approved','2026-11-04','2026-12-04','PG customer','contact','PG lifecycle pouch','400x300mm','1000','1','1','100','300','0.3','10','10','10000','1000','11000','','','','manual-entry','hash',$1,$2,$2)
    `, [JSON.stringify({ customerCode: "PG-LIFE-CUSTOMER", customerEmail: "pg-life-customer@example.test" }), now, 1]);
    const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
    const maker = await db.get<{ id: number; email: string }>(
      "SELECT id,email FROM film_makers WHERE email='pg-maker@example.test' LIMIT 1",
    );
    const snapshot = {
      id: Number(maker!.id), makerCode: "PG-LIFE-001", companyName: "PG Film", contactName: "PG Contact",
      email: maker!.email, language: "ko" as const, printMethod: "gravure" as const,
      procurementRoute: "K" as const, isActive: true, selectedAt: now, selectedByEmail: "pg-admin@kanei-trade.co.jp",
    };
    await db.run(`
      INSERT INTO film_orders (
        quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
        film_composition,order_length_m,web_width_mm,pouch_quantity,supplier_name,supplier_email,seven_contact_email,
        film_maker_id,film_maker_snapshot_json,supplier_resolution,status,customer_design_status,ship_to_status,
        purchase_order_json,ordered_at,created_at,updated_at
      ) VALUES (?, 'F-202611-PG-LIFE-001','Q-PG-LIFE-001','PG lifecycle pouch','PG customer','gravure','K','PET/AL/PE','300','400','1000','PG Film',?, 'seven@727.co.jp',?,?,'master_selected','ordered','not_required','confirmed','{}',?,?,?)
    `, [quotation!.id, maker!.email, maker!.id, JSON.stringify(snapshot), now, now, now]);
    const order = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE order_number='F-202611-PG-LIFE-001'",
    );
    const orderId = Number(order!.id);
    const command = {
      orderId,
      action: "register-receiving" as const,
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000" as const,
      aiFileName: "pg-packet.ai",
      aiFileUrl: "https://pg.example/packet.ai",
      pdfFileName: "pg-packet.pdf",
      pdfFileUrl: "https://pg.example/packet.pdf",
    };
    const { cancelFilmOrderMail, confirmFilmOrderMail, prepareFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    process.env.MAIL_DRY_RUN = "true";
    const before = await db.get<{ status: string; receiving_registered_at: string | null; updated_at: string }>(
      "SELECT status,receiving_registered_at,updated_at FROM film_orders WHERE id=?", [orderId],
    );
    const preview = await prepareFilmOrderMail(command);
    const afterNoCommit = await db.get<{ status: string; receiving_registered_at: string | null; updated_at: string }>(
      "SELECT status,receiving_registered_at,updated_at FROM film_orders WHERE id=?", [orderId],
    );
    expect(afterNoCommit).toEqual(before);
    expect(preview.envelopes.map((envelope) => envelope.audience)).toEqual(["maker", "seven", "kanei"]);
    const cancelled = await cancelFilmOrderMail(orderId, preview.dispatchGroupId);
    expect(cancelled.authoritativeStateChanged).toBe(false);

    const [left, right] = await Promise.all([
      prepareFilmOrderMail({ ...command, aiFileName: "pg-left.ai", aiFileUrl: "https://pg.example/left.ai", pdfFileName: "pg-left.pdf", pdfFileUrl: "https://pg.example/left.pdf" }),
      prepareFilmOrderMail({ ...command, aiFileName: "pg-right.ai", aiFileUrl: "https://pg.example/right.ai", pdfFileName: "pg-right.pdf", pdfFileUrl: "https://pg.example/right.pdf" }),
    ]);
    const attempts = await Promise.allSettled([
      confirmFilmOrderMail(left, left.envelopes.map((envelope) => envelope.contentHash)),
      confirmFilmOrderMail(right, right.envelopes.map((envelope) => envelope.contentHash)),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const committed = await db.get<{ status: string; receiving_registered_at: string | null }>(
      "SELECT status,receiving_registered_at FROM film_orders WHERE id=?", [orderId],
    );
    const files = await db.all<{ file_name: string }>(
      "SELECT file_name FROM film_order_files WHERE order_id=? ORDER BY id", [orderId],
    );
    const tokens = await db.all<{ token_state: string; dispatch_group_id: string | null }>(
      "SELECT token_state,dispatch_group_id FROM film_order_external_tokens WHERE film_order_id=?", [orderId],
    );
    expect(committed?.status).toBe("receiving_registered");
    expect(committed?.receiving_registered_at).toBeTruthy();
    expect(files).toHaveLength(2);
    expect(files.every((file) => ["pg-left.ai", "pg-left.pdf", "pg-right.ai", "pg-right.pdf"].includes(file.file_name))).toBe(true);
    expect(tokens.filter((token) => token.token_state === "active")).toHaveLength(1);
    expect(tokens.filter((token) => token.token_state === "staged")).toHaveLength(1);

    // Prove cancellation is preview-scoped on PostgreSQL as well.
    await db.run(`
      UPDATE film_orders
      SET status='ordered', receiving_registered_at=NULL, updated_at=?
      WHERE id=?
    `, [new Date().toISOString(), orderId]);
    const [cancelLeft, cancelRight] = await Promise.all([
      prepareFilmOrderMail({ ...command, aiFileName: "pg-cancel-left.ai", aiFileUrl: "https://pg.example/cancel-left.ai", pdfFileName: "pg-cancel-left.pdf", pdfFileUrl: "https://pg.example/cancel-left.pdf" }),
      prepareFilmOrderMail({ ...command, aiFileName: "pg-cancel-right.ai", aiFileUrl: "https://pg.example/cancel-right.ai", pdfFileName: "pg-cancel-right.pdf", pdfFileUrl: "https://pg.example/cancel-right.pdf" }),
    ]);
    const scopedCancel = await cancelFilmOrderMail(orderId, cancelLeft.dispatchGroupId);
    expect(scopedCancel).toMatchObject({ skippedCount: 3, revokedTokenCount: 1 });
    const assertScopedTokenState = async (dispatchGroupId: string, tokenState: string) => {
      const rows = await db.all<{ token_state: string; dispatch_group_id: string }>(`
        SELECT token_state,dispatch_group_id FROM film_order_external_tokens
        WHERE film_order_id=? AND dispatch_group_id=?
      `, [orderId, dispatchGroupId]);
      expect(rows).toEqual([{ token_state: tokenState, dispatch_group_id: dispatchGroupId }]);
    };
    await assertScopedTokenState(cancelLeft.dispatchGroupId, "revoked");
    await assertScopedTokenState(cancelRight.dispatchGroupId, "staged");
    const scopedConfirm = await confirmFilmOrderMail(cancelRight, cancelRight.envelopes.map((envelope) => envelope.contentHash));
    expect(scopedConfirm.workflowCompleted).toBe(true);
    await assertScopedTokenState(cancelLeft.dispatchGroupId, "revoked");
    await assertScopedTokenState(cancelRight.dispatchGroupId, "active");
    delete process.env.MAIL_DRY_RUN;
  });
});
