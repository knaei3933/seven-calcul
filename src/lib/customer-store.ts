import { getSqlClient, type SqlClient } from "./db";
import { createHash } from "node:crypto";
import type {
  CustomerDeliveryDestination,
  CustomerDeliveryDestinationInput,
  CustomerMaster,
  CustomerMasterInput,
} from "./quotation-shared";
import type { CustomerOwnerDomain } from "./film-order-access";

interface CustomerRow {
  owner_domain: CustomerOwnerDomain;
  customer_code: string;
  customer_name: string;
  postal_code: string;
  address: string;
  contact: string;
  telephone: string;
  fax: string;
  email: string;
  created_at: string;
  updated_at: string;
}

interface DeliveryDestinationRow {
  id: number;
  owner_domain: CustomerOwnerDomain;
  customer_code: string;
  destination_fingerprint: string;
  label: string;
  company_name: string;
  department: string;
  contact_name: string;
  postal_code: string;
  address: string;
  building: string;
  phone: string;
  email: string;
  note: string;
  is_default: number | boolean;
  use_count: number;
  last_used_at: string | null;
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
      fax TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_domain, customer_code)
    );
    CREATE INDEX IF NOT EXISTS idx_customers_owner_name ON customers(owner_domain, customer_name);
`;

const CUSTOMER_SCHEMA_VERSION = "2026-10-22-owner-scoped-1";

const CUSTOMER_SELECTION_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS customer_selections (
      owner_domain TEXT NOT NULL,
      user_email TEXT NOT NULL,
      customer_code TEXT NOT NULL,
      selection_count INTEGER NOT NULL DEFAULT 0,
      last_selected_at TEXT NOT NULL,
      PRIMARY KEY (owner_domain, user_email, customer_code)
    );
    CREATE INDEX IF NOT EXISTS idx_customer_selections_user
      ON customer_selections(owner_domain, user_email, selection_count DESC, last_selected_at DESC);
`;

const CUSTOMER_SCHEMA_WITH_SELECTIONS_VERSION = "2026-10-22-user-ranked-selections-1";

const DELIVERY_DESTINATION_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS customer_delivery_destinations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_domain TEXT NOT NULL,
      customer_code TEXT NOT NULL,
      destination_fingerprint TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      company_name TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL,
      address TEXT NOT NULL,
      building TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(owner_domain, customer_code, destination_fingerprint),
      FOREIGN KEY (owner_domain, customer_code) REFERENCES customers(owner_domain, customer_code) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_destinations_customer
      ON customer_delivery_destinations(owner_domain, customer_code, is_default DESC, last_used_at DESC);
`;

const CUSTOMER_SCHEMA_WITH_DELIVERY_DESTINATIONS_VERSION = "2026-10-28-customer-fax-1";

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
          fax TEXT NOT NULL DEFAULT '',
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

async function addCustomerFaxColumn(db: SqlClient): Promise<void> {
  if (db.dialect === "sqlite") {
    const columns = await db.all<{ name: string }>("PRAGMA table_info(customers)");
    if (!columns.some((column) => column.name === "fax")) {
      await db.exec("ALTER TABLE customers ADD COLUMN fax TEXT NOT NULL DEFAULT ''");
    }
    return;
  }
  const column = await db.get<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'fax'
  `);
  if (!column) await db.exec("ALTER TABLE customers ADD COLUMN fax TEXT NOT NULL DEFAULT ''");
}

async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("customers");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS customer_schema_migrations (
        slot TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const marker = await db.get<{ version: string }>(
      "SELECT version FROM customer_schema_migrations WHERE slot = ?",
      ["customers"],
    );
    // コールドスタート毎の情報スキーマ照会とDDL検査を省略する。
    if (marker?.version === CUSTOMER_SCHEMA_WITH_DELIVERY_DESTINATIONS_VERSION) return db;
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
    await addCustomerFaxColumn(db);
    await db.exec(CUSTOMER_SELECTION_TABLE_SQL);
    if (db.dialect === "postgres") {
      await db.exec(DELIVERY_DESTINATION_TABLE_SQL.replace(
        "INTEGER PRIMARY KEY AUTOINCREMENT",
        "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
      ));
    } else {
      await db.exec(DELIVERY_DESTINATION_TABLE_SQL);
    }
    await db.run(`
      INSERT INTO customer_schema_migrations (slot,version,updated_at) VALUES (?,?,?)
      ON CONFLICT(slot) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at
    `, ["customers", CUSTOMER_SCHEMA_WITH_DELIVERY_DESTINATIONS_VERSION, new Date().toISOString()]);
    return db;
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

const CUSTOMER_FIELD_LIMITS = {
  customerCode: 64,
  customerName: 200,
  customerPostalCode: 32,
  customerAddress: 500,
  customerContact: 100,
  customerTelephone: 100,
  customerFax: 100,
  customerEmail: 254,
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DELIVERY_DESTINATION_FIELD_LIMITS = {
  label: 120,
  companyName: 200,
  department: 150,
  contactName: 100,
  postalCode: 32,
  address: 500,
  building: 200,
  phone: 100,
  email: 254,
  note: 1000,
} as const;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
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
  const customerFax = optional(input.customerFax, "customerFax") ?? "";
  const customerEmail = optional(input.customerEmail, "customerEmail");
  if (customerPostalCode === null || customerAddress === null || customerContact === null
    || customerTelephone === null || customerFax === null || customerEmail === null) return null;
  if (customerEmail && !EMAIL_PATTERN.test(customerEmail)) return null;
  return {
    customerCode,
    customerName,
    customerPostalCode,
    customerAddress,
    customerContact,
    customerTelephone,
    customerFax,
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
    customerFax: row.fax,
    customerEmail: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeliveryDestination(row: DeliveryDestinationRow): CustomerDeliveryDestination {
  return {
    id: Number(row.id),
    ownerDomain: row.owner_domain === "kanei" ? "kanei" : "seven",
    customerCode: row.customer_code,
    label: row.label,
    companyName: row.company_name,
    department: row.department,
    contactName: row.contact_name,
    postalCode: row.postal_code,
    address: row.address,
    building: row.building,
    phone: row.phone,
    email: row.email,
    note: row.note,
    isDefault: Number(row.is_default) === 1 || row.is_default === true,
    useCount: Number(row.use_count || 0),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function validateDeliveryDestinationInput(value: unknown): CustomerDeliveryDestinationInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const optional = (key: keyof typeof DELIVERY_DESTINATION_FIELD_LIMITS): string | null => {
    const value = text(input[key]);
    return value.length > DELIVERY_DESTINATION_FIELD_LIMITS[key] ? null : value;
  };
  const label = optional("label");
  const companyName = optional("companyName");
  const department = optional("department");
  const contactName = optional("contactName");
  const postalCode = optional("postalCode");
  const address = optional("address");
  const building = optional("building");
  const phone = optional("phone");
  const email = optional("email");
  const note = optional("note");
  if (label === null || companyName === null || department === null || contactName === null
    || postalCode === null || address === null || building === null || phone === null
    || email === null || note === null) return null;
  if (!companyName || !postalCode || !address || !phone) return null;
  if (email && !EMAIL_PATTERN.test(email)) return null;
  return {
    label: label || [companyName, department].filter(Boolean).join(" "),
    companyName,
    department,
    contactName,
    postalCode,
    address,
    building,
    phone,
    email,
    note,
    isDefault: input.isDefault === true,
  };
}

function deliveryDestinationFingerprint(value: CustomerDeliveryDestinationInput): string {
  const normalized = [
    value.companyName,
    value.postalCode,
    value.address,
    value.building,
    value.phone,
  ].join("\n").toLowerCase().replace(/\s+/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}

export async function saveCustomer(
  ownerDomain: CustomerOwnerDomain,
  value: CustomerMasterInput,
): Promise<CustomerMaster> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const customerFax = typeof value.customerFax === "string" ? value.customerFax : "";
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO customers
      (owner_domain,customer_code,customer_name,postal_code,address,contact,telephone,fax,email,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_domain, customer_code) DO UPDATE SET
      customer_name=excluded.customer_name,
      postal_code=excluded.postal_code,
      address=excluded.address,
      contact=excluded.contact,
      telephone=excluded.telephone,
      fax=excluded.fax,
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
    customerFax,
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

export async function listDeliveryDestinations(
  ownerDomain: CustomerOwnerDomain,
  code: string,
): Promise<CustomerDeliveryDestination[]> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const customerCode = code.trim();
  if (!customerCode) return [];
  const db = await getDatabase();
  const rows = await db.all<DeliveryDestinationRow>(`
    SELECT * FROM customer_delivery_destinations
    WHERE owner_domain = ? AND customer_code = ?
    ORDER BY is_default DESC, last_used_at DESC NULLS LAST, use_count DESC, updated_at DESC
  `, [owner, customerCode]);
  return rows.map(mapDeliveryDestination);
}

export async function getDeliveryDestination(
  ownerDomain: CustomerOwnerDomain,
  code: string,
  destinationId: number,
): Promise<CustomerDeliveryDestination | null> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const customerCode = code.trim();
  if (!customerCode || !Number.isInteger(destinationId) || destinationId <= 0) return null;
  const db = await getDatabase();
  const row = await db.get<DeliveryDestinationRow>(`
    SELECT * FROM customer_delivery_destinations
    WHERE owner_domain = ? AND customer_code = ? AND id = ?
  `, [owner, customerCode, destinationId]);
  return row ? mapDeliveryDestination(row) : null;
}

export async function upsertDeliveryDestination(
  ownerDomain: CustomerOwnerDomain,
  code: string,
  input: CustomerDeliveryDestinationInput,
): Promise<CustomerDeliveryDestination> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const customerCode = code.trim();
  if (!customerCode) throw new Error("customer_code_required");
  const db = await getDatabase();
  const customer = await db.get<{ customer_code: string }>(
    "SELECT customer_code FROM customers WHERE owner_domain = ? AND customer_code = ?",
    [owner, customerCode],
  );
  if (!customer) throw new Error("customer_not_found");

  const fingerprint = deliveryDestinationFingerprint(input);
  const now = new Date().toISOString();
  const existing = await db.get<DeliveryDestinationRow>(`
    SELECT * FROM customer_delivery_destinations
    WHERE owner_domain = ? AND customer_code = ? AND destination_fingerprint = ?
  `, [owner, customerCode, fingerprint]);
  const shouldDefault = input.isDefault || !existing && !(await db.get<{ id: number }>(`
    SELECT id FROM customer_delivery_destinations
    WHERE owner_domain = ? AND customer_code = ? AND is_default = TRUE
    LIMIT 1
  `, [owner, customerCode]));

  const destinationId = await db.transaction(async (tx) => {
    if (shouldDefault) {
      await tx.run(
        "UPDATE customer_delivery_destinations SET is_default = FALSE WHERE owner_domain = ? AND customer_code = ?",
        [owner, customerCode],
      );
    }
    if (existing) {
      await tx.run(`
        UPDATE customer_delivery_destinations SET
          label=?, company_name=?, department=?, contact_name=?, postal_code=?, address=?,
          building=?, phone=?, email=?, note=?, is_default=${shouldDefault ? "TRUE" : "FALSE"}, updated_at=?
        WHERE id=?
      `, [
        input.label, input.companyName, input.department, input.contactName, input.postalCode,
        input.address, input.building, input.phone, input.email, input.note,
        now, existing.id,
      ]);
      return existing.id;
    }
    const inserted = await tx.get<{ id: number }>(`
      INSERT INTO customer_delivery_destinations (
        owner_domain,customer_code,destination_fingerprint,label,company_name,department,
        contact_name,postal_code,address,building,phone,email,note,is_default,
        use_count,last_used_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,${shouldDefault ? "TRUE" : "FALSE"},0,NULL,?,?)
      ${tx.dialect === "postgres" ? "RETURNING id" : ""}
    `, [
      owner, customerCode, fingerprint, input.label, input.companyName, input.department,
      input.contactName, input.postalCode, input.address, input.building, input.phone,
      input.email, input.note, now, now,
    ]);
    if (inserted?.id) return Number(inserted.id);
    const created = await tx.get<{ id: number }>(`
      SELECT id FROM customer_delivery_destinations
      WHERE owner_domain = ? AND customer_code = ? AND destination_fingerprint = ?
    `, [owner, customerCode, fingerprint]);
    if (!created) throw new Error("delivery_destination_save_failed");
    return Number(created.id);
  });
  const saved = await getDeliveryDestination(owner, customerCode, destinationId);
  if (!saved) throw new Error("delivery_destination_save_failed");
  return saved;
}

export async function markDeliveryDestinationUsed(
  ownerDomain: CustomerOwnerDomain,
  code: string,
  destinationId: number,
): Promise<CustomerDeliveryDestination | null> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const customerCode = code.trim();
  if (!customerCode || !Number.isInteger(destinationId) || destinationId <= 0) return null;
  const db = await getDatabase();
  const now = new Date().toISOString();
  const result = await db.run(`
    UPDATE customer_delivery_destinations SET
      use_count = use_count + 1, last_used_at = ?
    WHERE owner_domain = ? AND customer_code = ? AND id = ?
  `, [now, owner, customerCode, destinationId]);
  if (result.changes !== 1) return null;
  return getDeliveryDestination(owner, customerCode, destinationId);
}

export async function setDefaultDeliveryDestination(
  ownerDomain: CustomerOwnerDomain,
  code: string,
  destinationId: number,
): Promise<CustomerDeliveryDestination | null> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const customerCode = code.trim();
  if (!customerCode || !Number.isInteger(destinationId) || destinationId <= 0) return null;
  const db = await getDatabase();
  const destination = await getDeliveryDestination(owner, customerCode, destinationId);
  if (!destination) return null;
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE customer_delivery_destinations SET is_default = FALSE WHERE owner_domain = ? AND customer_code = ?",
      [owner, customerCode],
    );
    await tx.run(
      "UPDATE customer_delivery_destinations SET is_default = TRUE, updated_at = ? WHERE id = ?",
      [new Date().toISOString(), destinationId],
    );
  });
  return getDeliveryDestination(owner, customerCode, destinationId);
}

export async function recordCustomerSelection(
  ownerDomain: CustomerOwnerDomain,
  userEmail: string,
  code: string,
): Promise<boolean> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const normalizedEmail = userEmail.trim().toLowerCase();
  const customerCode = code.trim();
  if (!normalizedEmail || !customerCode) return false;
  const db = await getDatabase();
  const customer = await db.get<{ customer_code: string }>(
    "SELECT customer_code FROM customers WHERE owner_domain = ? AND customer_code = ?",
    [owner, customerCode],
  );
  if (!customer) return false;
  await db.run(`
    INSERT INTO customer_selections
      (owner_domain,user_email,customer_code,selection_count,last_selected_at)
    VALUES (?,?,?,1,?)
    ON CONFLICT(owner_domain, user_email, customer_code) DO UPDATE SET
      selection_count = customer_selections.selection_count + 1,
      last_selected_at = excluded.last_selected_at
  `, [owner, normalizedEmail, customerCode, new Date().toISOString()]);
  return true;
}

export async function listCustomers(
  query = "",
  limit = 100,
  ownerDomain: CustomerOwnerDomain,
  userEmail?: string,
): Promise<CustomerMaster[]> {
  const owner = normalizeOwnerDomain(ownerDomain);
  const db = await getDatabase();
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 100, 1), 500);
  const search = `%${escapeLikePattern(query.trim())}%`;
  const normalizedEmail = userEmail?.trim().toLowerCase() ?? "";
  const selectionJoin = normalizedEmail
    ? "LEFT JOIN customer_selections s ON s.owner_domain = c.owner_domain AND s.customer_code = c.customer_code AND s.user_email = ?"
    : "";
  const selectionArguments = normalizedEmail ? [normalizedEmail] : [];
  const selectionOrder = normalizedEmail
    ? "COALESCE(s.selection_count, 0) DESC, COALESCE(s.last_selected_at, '') DESC, c.customer_code ASC"
    : "c.customer_code ASC";
  const rows = await db.all<CustomerRow>(`
    SELECT c.*
    FROM customers c
    ${selectionJoin}
    WHERE c.owner_domain = ?
      AND (c.customer_code LIKE ? ESCAPE '\\' OR c.customer_name LIKE ? ESCAPE '\\'
        OR c.address LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\')
    ORDER BY ${selectionOrder}
    LIMIT ?
  `, [...selectionArguments, owner, search, search, search, search, safeLimit]);
  return rows.map(mapRow);
}
