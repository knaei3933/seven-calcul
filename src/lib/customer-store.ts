import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CustomerMaster, CustomerMasterInput } from "./quotation-shared";

interface CustomerRow {
  customer_code: string;
  customer_name: string;
  postal_code: string;
  address: string;
  contact: string;
  telephone: string;
  email: string;
  created_at: string;
  updated_at: string;
}

const databasePath = process.env.POUCH_CUSTOMER_DB
  ?? (process.env.VERCEL === "1" ? "/tmp/pouch-customers.db" : resolve(process.cwd(), ".data/customers.db"));
let database: DatabaseSync | null = null;

async function getDatabase(): Promise<DatabaseSync> {
  if (database) return database;
  await mkdir(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      customer_code TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      postal_code TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      telephone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(customer_name);
  `);
  try {
    database.exec("ALTER TABLE customers ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  } catch {
    // 기존 DB에 email 컬럼이 이미 있는 경우는 무시한다.
  }
  return database;
}

const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;

export function validateCustomerInput(value: unknown): CustomerMasterInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const customerCode = text(input.customerCode).trim();
  const customerName = text(input.customerName).trim();
  if (!customerCode || !customerName) return null;
  return {
    customerCode,
    customerName: text(input.customerName),
    customerPostalCode: text(input.customerPostalCode),
    customerAddress: text(input.customerAddress),
    customerContact: text(input.customerContact),
    customerTelephone: text(input.customerTelephone),
    customerEmail: text(input.customerEmail),
  };
}

function mapRow(row: CustomerRow): CustomerMaster {
  return {
    customerCode: row.customer_code,
    customerName: row.customer_name,
    customerPostalCode: row.postal_code,
    customerAddress: row.address,
    customerContact: row.contact,
    customerTelephone: row.telephone,
    customerEmail: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function saveCustomer(value: CustomerMasterInput): Promise<CustomerMaster> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO customers (customer_code,customer_name,postal_code,address,contact,telephone,email,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(customer_code) DO UPDATE SET
      customer_name=excluded.customer_name,
      postal_code=excluded.postal_code,
      address=excluded.address,
      contact=excluded.contact,
      telephone=excluded.telephone,
      email=excluded.email,
      updated_at=excluded.updated_at
  `).run(value.customerCode, value.customerName, value.customerPostalCode, value.customerAddress, value.customerContact, value.customerTelephone, value.customerEmail, now, now);
  const row = db.prepare("SELECT * FROM customers WHERE customer_code = ?").get(value.customerCode) as CustomerRow | undefined;
  if (!row) throw new Error("customer_save_failed");
  return mapRow(row);
}

export async function getCustomer(code: string): Promise<CustomerMaster | null> {
  const db = await getDatabase();
  if (!code.trim()) return null;
  const row = db.prepare("SELECT * FROM customers WHERE customer_code = ?").get(code.trim()) as CustomerRow | undefined;
  return row ? mapRow(row) : null;
}

export async function listCustomers(query = "", limit = 100): Promise<CustomerMaster[]> {
  const db = await getDatabase();
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);
  const search = `%${query.trim()}%`;
  const rows = db.prepare(`
    SELECT * FROM customers
    WHERE customer_code LIKE ? OR customer_name LIKE ? OR address LIKE ? OR email LIKE ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(search, search, search, search, safeLimit) as unknown as CustomerRow[];
  return rows.map(mapRow);
}
