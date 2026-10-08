import { getSqlClient, type SqlClient } from "./db";
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

let schemaReady: Promise<SqlClient> | null = null;

const SQLITE_SCHEMA = `
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
`;

const POSTGRES_SCHEMA = `
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
`;

async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("customers");
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
    if (db.dialect === "sqlite") {
      try {
        await db.exec("ALTER TABLE customers ADD COLUMN email TEXT NOT NULL DEFAULT ''");
      } catch {
        // 기존 DB에 email 컬럼이 이미 있는 경우는 무시한다.
      }
    }
    return db;
  })();
  return schemaReady;
}

const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;

const CUSTOMER_FIELD_LIMITS = {
  customerCode: 64,
  customerName: 200,
  customerPostalCode: 32,
  customerAddress: 500,
  customerContact: 100,
  customerTelephone: 100,
  customerEmail: 254,
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** LIKE/ILIKE 와일드카드를 문자 그대로 검색하기 위해 이스케이프한다. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function validateCustomerInput(value: unknown): CustomerMasterInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const customerCode = text(input.customerCode).trim();
  const customerName = text(input.customerName).trim();
  if (!customerCode || !customerName) return null;
  if (customerCode.length > CUSTOMER_FIELD_LIMITS.customerCode
    || customerName.length > CUSTOMER_FIELD_LIMITS.customerName) return null;
  const optional = (raw: unknown, key: keyof typeof CUSTOMER_FIELD_LIMITS): string | null => {
    const trimmed = text(raw).trim();
    return trimmed.length > CUSTOMER_FIELD_LIMITS[key] ? null : trimmed;
  };
  const customerPostalCode = optional(input.customerPostalCode, "customerPostalCode");
  const customerAddress = optional(input.customerAddress, "customerAddress");
  const customerContact = optional(input.customerContact, "customerContact");
  const customerTelephone = optional(input.customerTelephone, "customerTelephone");
  const customerEmail = optional(input.customerEmail, "customerEmail");
  if (customerPostalCode === null || customerAddress === null || customerContact === null
    || customerTelephone === null || customerEmail === null) return null;
  if (customerEmail && !EMAIL_PATTERN.test(customerEmail)) return null;
  return {
    customerCode,
    customerName,
    customerPostalCode,
    customerAddress,
    customerContact,
    customerTelephone,
    customerEmail,
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
  await db.run(`
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
  `, [value.customerCode, value.customerName, value.customerPostalCode, value.customerAddress, value.customerContact, value.customerTelephone, value.customerEmail, now, now]);
  const row = await db.get<CustomerRow>("SELECT * FROM customers WHERE customer_code = ?", [value.customerCode]);
  if (!row) throw new Error("customer_save_failed");
  return mapRow(row);
}

export async function getCustomer(code: string): Promise<CustomerMaster | null> {
  const db = await getDatabase();
  if (!code.trim()) return null;
  const row = await db.get<CustomerRow>("SELECT * FROM customers WHERE customer_code = ?", [code.trim()]);
  return row ? mapRow(row) : null;
}

export async function deleteCustomer(code: string): Promise<boolean> {
  const db = await getDatabase();
  if (!code.trim()) return false;
  const result = await db.run("DELETE FROM customers WHERE customer_code = ?", [code.trim()]);
  return result.changes > 0;
}

export async function listCustomers(query = "", limit = 100): Promise<CustomerMaster[]> {
  const db = await getDatabase();
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);
  const search = `%${escapeLikePattern(query.trim())}%`;
  const rows = await db.all<CustomerRow>(`
    SELECT * FROM customers
    WHERE customer_code LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
    ORDER BY updated_at DESC LIMIT ?
  `, [search, search, search, search, safeLimit]);
  return rows.map(mapRow);
}
