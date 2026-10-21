import { getSqlClient, type SqlClient } from "./db";
import type { CustomerMaster, CustomerMasterInput } from "./quotation-shared";
import type { CustomerOwnerDomain } from "./film-order-access";

interface CustomerRow {
  owner_domain: CustomerOwnerDomain;
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

const CUSTOMER_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS customers (
      owner_domain TEXT NOT NULL,
      customer_code TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      postal_code TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      telephone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_domain, customer_code)
    );
    CREATE INDEX IF NOT EXISTS idx_customers_owner_name ON customers(owner_domain, customer_name);
`;

/** LIKE/ILIKE 와일드카드를 문자 그대로 검색하기 위해 이스케이프한다. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function normalizeOwnerDomain(value: CustomerOwnerDomain): CustomerOwnerDomain {
  return value === "kanei" ? "kanei" : "seven";
}

async function migrateLegacyCustomers(db: SqlClient): Promise<void> {
  if (db.dialect === "sqlite") {
    const columns = await db.all<{ name: string; pk: number }>("PRAGMA table_info(customers)");
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("owner_domain")) {
      await db.exec("ALTER TABLE customers ADD COLUMN owner_domain TEXT NOT NULL DEFAULT 'seven'");
    }
    const primaryKey = columns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    if (primaryKey.join(",") === "owner_domain,customer_code") {
      await db.exec("CREATE INDEX IF NOT EXISTS idx_customers_owner_name ON customers(owner_domain, customer_name)");
      return;
    }
    await db.transaction(async (tx) => {
      await tx.exec("DROP TABLE IF EXISTS customers_scoped");
      await tx.exec(`
        CREATE TABLE customers_scoped (
          owner_domain TEXT NOT NULL,
          customer_code TEXT NOT NULL,
          customer_name TEXT NOT NULL,
          postal_code TEXT NOT NULL DEFAULT '',
          address TEXT NOT NULL DEFAULT '',
          contact TEXT NOT NULL DEFAULT '',
          telephone TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (owner_domain, customer_code)
        )
      `);
      const ownerExpression = names.has("owner_domain")
        ? "CASE WHEN owner_domain = 'kanei' THEN 'kanei' ELSE 'seven' END"
        : "'seven'";
      await tx.exec(`
        INSERT OR IGNORE INTO customers_scoped
          (owner_domain,customer_code,customer_name,postal_code,address,contact,telephone,email,created_at,updated_at)
        SELECT ${ownerExpression},customer_code,customer_name,postal_code,address,contact,telephone,email,created_at,updated_at
        FROM customers
      `);
      await tx.exec("DROP TABLE customers");
      await tx.exec("ALTER TABLE customers_scoped RENAME TO customers");
      await tx.exec("CREATE INDEX IF NOT EXISTS idx_customers_owner_name ON customers(owner_domain, customer_name)");
    });
    return;
  }

  const column = await db.get<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'owner_domain'
  `);
  if (!column) {
    await db.exec("ALTER TABLE customers ADD COLUMN owner_domain TEXT NOT NULL DEFAULT 'seven'");
    await db.exec("UPDATE customers SET owner_domain = 'seven'");
  }
  const primaryKey = await db.get<{ column_name: string }>(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_name = 'customers'
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `);
  if (primaryKey?.column_name !== "owner_domain") {
    await db.exec("ALTER TABLE customers DROP CONSTRAINT customers_pkey");
    await db.exec("ALTER TABLE customers ADD PRIMARY KEY (owner_domain, customer_code)");
  }
  await db.exec("CREATE INDEX IF NOT EXISTS idx_customers_owner_name ON customers(owner_domain, customer_name)");
}

async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("customers");
    const table = db.dialect === "postgres"
      ? await db.get<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'customers'
      `)
      : await db.get<{ name: string }>(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'customers'
      `);
    if (table) await migrateLegacyCustomers(db);
    else await db.exec(CUSTOMER_TABLE_SQL);
    return db;
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
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
    ownerDomain: row.owner_domain === "kanei" ? "kanei" : "seven",
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

export async function saveCustomer(
  ownerDomain: CustomerOwnerDomain,
  value: CustomerMasterInput,
): Promise<CustomerMaster> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO customers
      (owner_domain,customer_code,customer_name,postal_code,address,contact,telephone,email,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_domain, customer_code) DO UPDATE SET
      customer_name=excluded.customer_name,
      postal_code=excluded.postal_code,
      address=excluded.address,
      contact=excluded.contact,
      telephone=excluded.telephone,
      email=excluded.email,
      updated_at=excluded.updated_at
  `, [
    owner,
    value.customerCode,
    value.customerName,
    value.customerPostalCode,
    value.customerAddress,
    value.customerContact,
    value.customerTelephone,
    value.customerEmail,
    now,
    now,
  ]);
  const row = await db.get<CustomerRow>(
    "SELECT * FROM customers WHERE owner_domain = ? AND customer_code = ?",
    [owner, value.customerCode],
  );
  if (!row) throw new Error("customer_save_failed");
  return mapRow(row);
}

export async function getCustomer(ownerDomain: CustomerOwnerDomain, code: string): Promise<CustomerMaster | null> {
  const owner = normalizeOwnerDomain(ownerDomain);
  if (!code.trim()) return null;
  const db = await getDatabase();
  const row = await db.get<CustomerRow>(
    "SELECT * FROM customers WHERE owner_domain = ? AND customer_code = ?",
    [owner, code.trim()],
  );
  return row ? mapRow(row) : null;
}

export async function deleteCustomer(ownerDomain: CustomerOwnerDomain, code: string): Promise<boolean> {
  const owner = normalizeOwnerDomain(ownerDomain);
  if (!code.trim()) return false;
  const db = await getDatabase();
  const result = await db.run(
    "DELETE FROM customers WHERE owner_domain = ? AND customer_code = ?",
    [owner, code.trim()],
  );
  return result.changes > 0;
}

export async function listCustomers(
  query = "",
  limit = 100,
  ownerDomain: CustomerOwnerDomain,
): Promise<CustomerMaster[]> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const db = await getDatabase();
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);
  const search = `%${escapeLikePattern(query.trim())}%`;
  const rows = await db.all<CustomerRow>(`
    SELECT * FROM customers
    WHERE owner_domain = ?
      AND (customer_code LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\'
        OR address LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
    ORDER BY customer_code
    LIMIT ?
  `, [owner, search, search, search, search, safeLimit]);
  return rows.map(mapRow);
}
