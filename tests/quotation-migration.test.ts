import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-migration-test-"));
const databasePath = join(databaseDirectory, "quotations.db");
process.env.POUCH_QUOTATION_DB = databasePath;
process.env.ADMIN_EMAIL = "legacy-admin@migration.test";
process.env.ADMIN_PASSWORD = "legacy-admin-password";
process.env.ADMIN_NAME = "Legacy Admin";

const preMigration = new DatabaseSync(databasePath);
preMigration.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','user')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO users (email,name,role,is_active,password_hash,created_at,updated_at)
  VALUES ('legacy-admin@migration.test','Legacy Admin','admin',1,'pre-existing','2026-01-01','2026-01-01');
  CREATE TABLE quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    issue_date TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_contact TEXT NOT NULL,
    product_name TEXT NOT NULL,
    size_summary TEXT NOT NULL,
    quantity TEXT NOT NULL,
    filling_cost_per_piece TEXT NOT NULL,
    film_cost_per_piece TEXT NOT NULL,
    film_meter_price TEXT NOT NULL,
    film_order_length_m TEXT NOT NULL,
    target_margin TEXT NOT NULL,
    tax_rate_percent TEXT NOT NULL,
    price_per_piece TEXT NOT NULL,
    subtotal TEXT NOT NULL,
    tax TEXT NOT NULL,
    grand_total TEXT NOT NULL,
    delivery_date TEXT NOT NULL,
    payment_terms TEXT NOT NULL,
    notes TEXT NOT NULL,
    calculation_version TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO quotations (
    quotation_number,status,issue_date,valid_until,customer_name,customer_contact,product_name,size_summary,
    quantity,filling_cost_per_piece,film_cost_per_piece,film_meter_price,film_order_length_m,target_margin,
    tax_rate_percent,price_per_piece,subtotal,tax,grand_total,delivery_date,payment_terms,notes,
    calculation_version,result_hash,payload_json,created_at,updated_at
  ) VALUES (
    'S7-LEGACY-001','draft','2026-01-02','2026-02-02','Legacy Customer','Legacy Contact','Legacy Pouch','60×80mm',
    '1000','4','1','200','500','0.4','10','20','20000','2000','22000','','','','legacy','legacy','{}',
    '2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z'
  );
`);
preMigration.close();

const { getQuotation, listQuotations } = await import("@/lib/quotation-store");

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation ownership migration", () => {
  it("assigns legacy quotations to the seeded administrator and preserves record values", async () => {
    const records = await listQuotations();
    expect(records).toHaveLength(1);
    const legacy = await getQuotation(records[0]!.id);
    expect(legacy?.quotationNumber).toBe("S7-LEGACY-001");
    expect(legacy?.quantity).toBe("1000");
    expect(legacy?.grandTotal).toBe("22000");
    expect(legacy?.createdBy.email).toBe("legacy-admin@migration.test");
    expect(legacy?.createdBy.name).toBe("Legacy Admin");
    expect(legacy?.updatedBy).toBeNull();
  });
});
