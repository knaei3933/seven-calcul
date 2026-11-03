import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "ship-to-migration-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "x";
process.env.ADMIN_NAME = "Seven Store";

const driveMocks = vi.hoisted(() => ({ createSession: vi.fn(), findFiles: vi.fn(), getConfirmedUpload: vi.fn() }));
vi.mock("@/lib/google-drive", () => ({
  customerDesignFolderId: () => "customer-design-folder",
  deliveryDocumentFolderId: () => "delivery-folder-test",
  receivingFolderId: () => "receiving-folder",
  proofFolderId: () => "proof-folder",
  driveConfigured: () => true,
  findDriveFiles: driveMocks.findFiles,
  createResumableSession: driveMocks.createSession,
  browserOriginOf: () => "http://localhost:3000",
  getConfirmedDriveUpload: driveMocks.getConfirmedUpload,
}));

const { getSqlClient } = await import("@/lib/db");
const { FILM_ORDER_STATUSES } = await import("@/lib/film-order-shared");

beforeAll(async () => {
  // 旧スキーマ（複数納品先テーブルが存在しない状態）を再現する
  const db = await getSqlClient("quotations");
  await db.exec(`
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
      supplier_name TEXT NOT NULL DEFAULT '',
      supplier_email TEXT NOT NULL DEFAULT '',
      seven_contact_email TEXT NOT NULL DEFAULT '',
      buyer_domain TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'final_approved',
      po_sent_at TEXT,
      eta_token TEXT,
      eta_expires_at TEXT,
      eta_date TEXT,
      eta_note TEXT,
      eta_updated_at TEXT,
      film_shipped_on TEXT,
      film_carrier TEXT NOT NULL DEFAULT '',
      film_tracking_number TEXT NOT NULL DEFAULT '',
      film_shipment_note TEXT NOT NULL DEFAULT '',
      ship_to_destination_id BIGINT,
      ship_to_status TEXT NOT NULL DEFAULT 'not_provided',
      ship_to_label TEXT NOT NULL DEFAULT '',
      ship_to_company_name TEXT NOT NULL DEFAULT '',
      ship_to_department TEXT NOT NULL DEFAULT '',
      ship_to_contact_name TEXT NOT NULL DEFAULT '',
      ship_to_postal_code TEXT NOT NULL DEFAULT '',
      ship_to_address TEXT NOT NULL DEFAULT '',
      ship_to_building TEXT NOT NULL DEFAULT '',
      ship_to_phone TEXT NOT NULL DEFAULT '',
      ship_to_email TEXT NOT NULL DEFAULT '',
      ship_to_note TEXT NOT NULL DEFAULT '',
      ship_to_requested_at TEXT,
      ship_to_requested_by TEXT NOT NULL DEFAULT '',
      ship_to_registered_at TEXT,
      ship_to_registered_by TEXT NOT NULL DEFAULT '',
      ship_to_saved_to_master BOOLEAN NOT NULL DEFAULT FALSE,
      ship_to_confirmed_at TEXT,
      ship_to_confirmed_by TEXT NOT NULL DEFAULT '',
      production_plan_status TEXT NOT NULL DEFAULT 'not_set',
      production_plan_start_date TEXT,
      production_plan_end_date TEXT,
      production_plan_note TEXT NOT NULL DEFAULT '',
      production_plan_updated_at TEXT,
      production_plan_updated_by TEXT NOT NULL DEFAULT '',
      re_proof_count INTEGER NOT NULL DEFAULT 0,
      ordered_at TEXT,
      receiving_registered_at TEXT,
      proof_registered_at TEXT,
      re_proof_requested_at TEXT,
      final_approved_at TEXT,
      purchase_order_json TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by_email TEXT NOT NULL DEFAULT '',
      updated_by_email TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'approved',
      created_by INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE film_order_schema_migrations (slot TEXT PRIMARY KEY, version TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO film_order_schema_migrations (slot, version, updated_at) VALUES ('film_orders', '2026-10-27-delivery-documents-1', '2026-10-27T00:00:00.000Z');
    INSERT INTO film_orders (
      quotation_id, order_number, customer_code, buyer_domain, purchase_order_json, created_at, updated_at,
      ship_to_status, ship_to_company_name, ship_to_postal_code, ship_to_address, ship_to_phone,
      ship_to_registered_at, ship_to_registered_by, ship_to_confirmed_at, ship_to_confirmed_by
    ) VALUES (
      1, 'F-202610-002', 'FILM-CUSTOMER-001', '727.co.jp', '{}', '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z',
      'confirmed', '旧データ物流株式会社', '582-0017', '大阪府柏原市旧データ1-1-1', '07-0000-0000',
      '2026-10-30T01:00:00.000Z', 'seven@727.co.jp', '2026-10-30T02:00:00.000Z', 'seven@727.co.jp'
    );
  `);
});

it("migrates legacy scalar ship-to columns into the destinations table", async () => {
  expect(FILM_ORDER_STATUSES.length).toBeGreaterThan(0);
  const { listFilmOrders } = await import("@/lib/film-orders");
  await listFilmOrders("seven@727.co.jp");
  const { getSqlClient: getSql } = await import("@/lib/db");
  const db = await getSql("quotations");
  const rows = await db.all<{ order_id: number; company_name: string; confirmed_at: string | null }>(
    "SELECT order_id, company_name, confirmed_at FROM film_order_ship_to_destinations",
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.company_name).toBe("旧データ物流株式会社");
  expect(rows[0]?.confirmed_at).toBe("2026-10-30T02:00:00.000Z");
});

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});
