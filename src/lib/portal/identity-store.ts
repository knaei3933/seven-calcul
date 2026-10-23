import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSqlClient, isUniqueViolation, type SqlClient } from "@/lib/db";
import {
  hashPortalPassword,
  verifyPortalPassword,
} from "@/lib/portal/password";

export type PortalOwnerDomain = "kanei";
export type PortalVerificationPurpose = "email_confirmation";

export interface PortalUserInput {
  email: string;
  password: string;
  companyName: string;
  contactName: string;
  postalCode?: string;
  address?: string;
  telephone?: string;
  customerCode?: string;
  ownerDomain?: PortalOwnerDomain;
}

export interface PublicPortalUser {
  id: number;
  email: string;
  companyName: string;
  contactName: string;
  postalCode: string;
  address: string;
  telephone: string;
  customerCode: string;
  ownerDomain: PortalOwnerDomain;
  isVerified: boolean;
  isActive: boolean;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PortalEmailVerificationIssued {
  code: string;
  expiresAt: string;
  maxAttempts: number;
}

export interface PortalEmailVerificationResult {
  user: PublicPortalUser;
  verificationId: number;
}

export interface PortalSessionIssued {
  token: string;
  expiresAt: string;
}

export interface PortalSessionMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface PortalRateLimitResult {
  count: number;
  windowStartedAt: string;
  expiresAt: string;
}

export class PortalIdentityError extends Error {
  readonly code:
    | "invalid_portal_user"
    | "duplicate_email"
    | "portal_user_not_found"
    | "verification_not_found"
    | "verification_expired"
    | "verification_attempts_exceeded"
    | "invalid_verification_code"
    | "invalid_credentials"
    | "portal_service_login_forbidden"
    | "conflict"
    | "rate_limit_invalid"
    | "rate_limited"
    | "duplicate_customer_code";

  constructor(code: PortalIdentityError["code"]) {
    super(code);
    this.name = "PortalIdentityError";
    this.code = code;
  }
}

export const PORTAL_SERVICE_ACTOR_EMAIL = "portal-service@system.invalid";
const PORTAL_SERVICE_ACTOR_PASSWORD_HASH = "!portal-service-no-login-v1";
const DEFAULT_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_VERIFICATION_ATTEMPTS = 5;
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const PORTAL_SCRYPT_PREFIX = "portal-scrypt$";

interface PortalUserRow extends Record<string, unknown> {
  id: number;
  email: string;
  company_name: string;
  contact_name: string;
  postal_code: string;
  address: string;
  telephone: string;
  customer_code: string;
  owner_domain: string;
  is_verified: number | boolean;
  is_active: number | boolean;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EmailVerificationRow {
  id: number;
  portal_user_id: number;
  code_hash: string;
  expires_at: string;
  attempts: number;
  max_attempts: number;
  consumed_at: string | null;
}

interface PortalSessionRow {
  portal_user_id: number;
  expires_at: string;
}

let schemaReady: Promise<SqlClient> | null = null;

const SQLITE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS portal_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      postal_code TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      telephone TEXT NOT NULL DEFAULT '',
      customer_code TEXT NOT NULL DEFAULT '',
      owner_domain TEXT NOT NULL CHECK(owner_domain IN ('kanei')),
      is_verified INTEGER NOT NULL DEFAULT 0 CHECK(is_verified IN (0,1)),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('email_confirmation')),
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
      consumed_at TEXT,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_portal_verifications_lookup
      ON portal_email_verifications(email, purpose, consumed_at, created_at DESC);
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_ip_hash TEXT NOT NULL DEFAULT '',
      created_user_agent TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT,
      last_seen_ip_hash TEXT,
      last_seen_user_agent TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_user_id ON portal_sessions(portal_user_id);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry ON portal_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS portal_rate_limits (
      bucket_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL CHECK(count > 0),
      window_started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_portal_rate_limits_expiry ON portal_rate_limits(expires_at);
`;

const POSTGRES_SCHEMA = `
    CREATE TABLE IF NOT EXISTS portal_users (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      postal_code TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      telephone TEXT NOT NULL DEFAULT '',
      customer_code TEXT NOT NULL DEFAULT '',
      owner_domain TEXT NOT NULL CHECK(owner_domain IN ('kanei')),
      is_verified SMALLINT NOT NULL DEFAULT 0 CHECK(is_verified IN (0,1)),
      is_active SMALLINT NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS portal_email_verifications (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      portal_user_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('email_confirmation')),
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts > 0),
      consumed_at TEXT,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_portal_verifications_lookup
      ON portal_email_verifications(email, purpose, consumed_at, created_at DESC);
    CREATE TABLE IF NOT EXISTS portal_sessions (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      portal_user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_ip_hash TEXT NOT NULL DEFAULT '',
      created_user_agent TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT,
      last_seen_ip_hash TEXT,
      last_seen_user_agent TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (portal_user_id) REFERENCES portal_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_user_id ON portal_sessions(portal_user_id);
    CREATE INDEX IF NOT EXISTS idx_portal_sessions_expiry ON portal_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS portal_rate_limits (
      bucket_key TEXT PRIMARY KEY,
      count INTEGER NOT NULL CHECK(count > 0),
      window_started_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_portal_rate_limits_expiry ON portal_rate_limits(expires_at);
`;

/** Schemas are kept adjacent so dialect additions must be reviewed together. */
export function portalIdentitySchemas(): { sqlite: string; postgres: string } {
  return { sqlite: SQLITE_SCHEMA, postgres: POSTGRES_SCHEMA };
}

export function normalizePortalEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPortalSessionIp(ipAddress: string | null | undefined): string | null {
  const environment = process.env as Record<string, string | undefined>;
  const configuredPepper = environment.PORTAL_CLIENT_FINGERPRINT_PEPPER?.trim() ?? "";
  const production = environment.NODE_ENV === "production" || environment.VERCEL_ENV === "production";
  if (production && configuredPepper.length < 32) {
    throw new Error("portal_client_fingerprint_pepper_required");
  }
  const value = ipAddress?.trim();
  if (!value) return null;
  return createHmac("sha256", configuredPepper || "shapepouch-local-portal-client-fingerprint-pepper-v1")
    .update(`portal-session-ip:v1:${value}`, "utf8")
    .digest("hex");
}

async function migratePortalSessionIpHashColumns(db: SqlClient): Promise<void> {
  const columns = db.dialect === "sqlite"
    ? await db.all<{ name: string }>("PRAGMA table_info(portal_sessions)")
    : await db.all<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'portal_sessions'
    `);
  const has = (name: string): boolean => columns.some((column) =>
    ("name" in column ? column.name : column.column_name) === name
  );
  for (const suffix of ["created", "last_seen"] as const) {
    const rawColumn = `${suffix}_ip`;
    const hashColumn = `${suffix}_ip_hash`;
    if (!has(rawColumn)) continue;
    await db.transaction(async (tx) => {
      if (!has(hashColumn)) {
        await tx.exec(
          suffix === "created"
            ? `ALTER TABLE portal_sessions ADD COLUMN ${hashColumn} TEXT NOT NULL DEFAULT ''`
            : `ALTER TABLE portal_sessions ADD COLUMN ${hashColumn} TEXT`,
        );
      }
      const legacyRows = await tx.all<{ id: number; [key: string]: unknown }>(`
        SELECT id, ${rawColumn}, ${hashColumn}
        FROM portal_sessions
      `);
      for (const row of legacyRows) {
        const rawValue = String(row[rawColumn] ?? "");
        const existingHash = row[hashColumn];
        if (!rawValue || (typeof existingHash === "string" && existingHash !== "")) continue;
        await tx.run(`
          UPDATE portal_sessions
          SET ${hashColumn} = ?
          WHERE id = ?
        `, [hashPortalSessionIp(rawValue), Number(row.id)]);
      }
      await tx.exec(`ALTER TABLE portal_sessions DROP COLUMN ${rawColumn}`);
    });
  }
}

function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function booleanValue(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

function mapPortalUser(row: PortalUserRow): PublicPortalUser {
  const ownerDomain = row.owner_domain === "kanei" ? "kanei" : null;
  if (!ownerDomain) throw new Error("invalid_portal_owner_domain");
  return {
    id: Number(row.id),
    email: row.email,
    companyName: row.company_name,
    contactName: row.contact_name,
    postalCode: row.postal_code,
    address: row.address,
    telephone: row.telephone,
    customerCode: row.customer_code,
    ownerDomain,
    isVerified: booleanValue(row.is_verified),
    isActive: booleanValue(row.is_active),
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function getPortalIdentityDatabase(): Promise<SqlClient> {
  const initialization = (async () => {
    const db = await getSqlClient("customers");
    // Customer-store owns the customers schema. Reading through its API both
    // initializes that schema and proves the two modules share one store.
    const { getCustomer } = await import("@/lib/customer-store");
    await getCustomer("kanei", "__portal_schema_bootstrap__");
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
    await migratePortalSessionIpHashColumns(db);
    return db;
  })();
  schemaReady = initialization;
  try {
    return await schemaReady;
  } catch (error) {
    if (schemaReady === initialization) schemaReady = null;
    throw error;
  }
}

export async function resetPortalIdentityStoreForTest(): Promise<void> {
  schemaReady = null;
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
}

function validatePortalUserInput(input: PortalUserInput): {
  email: string;
  companyName: string;
  contactName: string;
} {
  const email = normalizePortalEmail(input.email);
  const companyName = input.companyName.trim();
  const contactName = input.contactName.trim();
  if (
    !isEmail(email) || typeof input.password !== "string"
    || input.password.length < 10 || input.password.length > 200
    || companyName.length < 1 || companyName.length > 200
    || contactName.length < 1 || contactName.length > 200
    || (input.customerCode?.length ?? 0) > 100
    || (input.postalCode?.length ?? 0) > 20
    || (input.address?.length ?? 0) > 500
    || (input.telephone?.length ?? 0) > 50
  ) throw new PortalIdentityError("invalid_portal_user");
  return { email, companyName, contactName };
}

export async function createPortalUser(input: PortalUserInput): Promise<PublicPortalUser> {
  const validated = validatePortalUserInput(input);
  const now = new Date().toISOString();
  const passwordHash = await hashPortalPassword(input.password);
  const db = await getPortalIdentityDatabase();
  try {
    await db.run(`
      INSERT INTO portal_users (
        email,password_hash,company_name,contact_name,postal_code,address,telephone,
        customer_code,owner_domain,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `, [
      validated.email,
      passwordHash,
      validated.companyName,
      validated.contactName,
      input.postalCode?.trim() ?? "",
      input.address?.trim() ?? "",
      input.telephone?.trim() ?? "",
      input.customerCode?.trim() ?? "",
      "kanei",
      now,
      now,
    ]);
    const created = await getPortalUserByEmail(validated.email, { database: db });
    if (!created) throw new PortalIdentityError("portal_user_not_found");
    return created;
  } catch (error) {
    if (isUniqueViolation(error)) throw new PortalIdentityError("duplicate_email");
    throw error;
  }
}

export async function getPortalUserByEmail(
  email: string,
  options: { database?: SqlClient } = {},
): Promise<PublicPortalUser | null> {
  const db = options.database ?? await getPortalIdentityDatabase();
  const row = await db.get<PortalUserRow>(
    "SELECT * FROM portal_users WHERE email = ?",
    [normalizePortalEmail(email)],
  );
  return row ? mapPortalUser(row) : null;
}

export async function setPortalUserVerified(
  userId: number,
  options: { now?: Date } = {},
): Promise<PublicPortalUser | null> {
  const now = (options.now ?? new Date()).toISOString();
  const db = await getPortalIdentityDatabase();
  await db.run(`
    UPDATE portal_users
    SET is_verified = 1, verified_at = ?, updated_at = ?
    WHERE id = ?
  `, [now, now, userId]);
  const row = await db.get<PortalUserRow>("SELECT * FROM portal_users WHERE id = ?", [userId]);
  return row ? mapPortalUser(row) : null;
}

export async function deletePortalUser(userId: number): Promise<boolean> {
  const db = await getPortalIdentityDatabase();
  const result = await db.run("DELETE FROM portal_users WHERE id = ?", [userId]);
  return result.changes === 1;
}

export async function authenticatePortalUser(
  email: string,
  password: string,
): Promise<PublicPortalUser | null> {
  const normalized = normalizePortalEmail(email);
  if (normalized === PORTAL_SERVICE_ACTOR_EMAIL) return null;
  const db = await getPortalIdentityDatabase();
  const row = await db.get<PortalUserRow & { password_hash: string }>(
    "SELECT * FROM portal_users WHERE email = ?",
    [normalized],
  );
  if (!row || !(await verifyPortalPassword(password, row.password_hash))) return null;
  const user = mapPortalUser(row);
  if (!user.isActive || !user.isVerified) return null;
  return user;
}

export type PortalLoginState =
  | { status: "authenticated"; user: PublicPortalUser }
  | { status: "unverified" }
  | { status: "invalid" };

export async function authenticatePortalUserWithState(
  email: string,
  password: string,
): Promise<PortalLoginState> {
  const normalized = normalizePortalEmail(email);
  if (normalized === PORTAL_SERVICE_ACTOR_EMAIL) return { status: "invalid" };
  const db = await getPortalIdentityDatabase();
  const row = await db.get<PortalUserRow & { password_hash: string }>(
    "SELECT * FROM portal_users WHERE email = ?",
    [normalized],
  );
  if (!row || !(await verifyPortalPassword(password, row.password_hash))) {
    return { status: "invalid" };
  }
  const user = mapPortalUser(row);
  if (!user.isActive) return { status: "invalid" };
  return user.isVerified ? { status: "authenticated", user } : { status: "unverified" };
}

async function issuePortalEmailVerification(input: {
  email: string;
  purpose?: PortalVerificationPurpose;
  ttlSeconds?: number;
  maxAttempts?: number;
  cooldownSeconds?: number;
  now?: Date;
}): Promise<PortalEmailVerificationIssued> {
  const purpose = input.purpose ?? "email_confirmation";
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_VERIFICATION_TTL_SECONDS;
  const maxAttempts = input.maxAttempts ?? DEFAULT_VERIFICATION_ATTEMPTS;
  const now = input.now ?? new Date();
  const email = normalizePortalEmail(input.email);
  if (
    !isEmail(email) || purpose !== "email_confirmation"
    || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 7 * 24 * 60 * 60
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
  ) throw new PortalIdentityError("invalid_portal_user");

  const db = await getPortalIdentityDatabase();
  const user = await db.get<PortalUserRow>("SELECT * FROM portal_users WHERE email = ?", [email]);
  if (!user) throw new PortalIdentityError("portal_user_not_found");
  if (input.cooldownSeconds !== undefined
    && (!Number.isInteger(input.cooldownSeconds) || input.cooldownSeconds < 1)) {
    throw new PortalIdentityError("rate_limit_invalid");
  }

  const code = randomBytes(6).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  await db.transaction(async (tx) => {
    if (input.cooldownSeconds !== undefined) {
      const latest = await tx.get<{ created_at: string }>(`
        SELECT created_at
        FROM portal_email_verifications
        WHERE email = ? AND purpose = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [email, purpose]);
      if (latest) {
        const availableAt = new Date(latest.created_at).getTime() + input.cooldownSeconds * 1000;
        if (now.getTime() < availableAt) throw new PortalIdentityError("rate_limited");
      }
    }
    await tx.run(`
      UPDATE portal_email_verifications
      SET consumed_at = ?
      WHERE email = ? AND purpose = ? AND consumed_at IS NULL
    `, [now.toISOString(), email, purpose]);
    await tx.run(`
      INSERT INTO portal_email_verifications (
        portal_user_id,email,purpose,code_hash,expires_at,max_attempts,created_at
      ) VALUES (?,?,?,?,?,?,?)
    `, [
      Number(user.id),
      email,
      purpose,
      sha256(code),
      expiresAt,
      maxAttempts,
      now.toISOString(),
    ]);
  });
  return { code, expiresAt, maxAttempts };
}

export async function createPortalEmailVerification(input: {
  email: string;
  purpose?: PortalVerificationPurpose;
  ttlSeconds?: number;
  maxAttempts?: number;
  now?: Date;
}): Promise<PortalEmailVerificationIssued> {
  return issuePortalEmailVerification(input);
}

export function createPortalEmailVerificationWithCooldown(input: {
  email: string;
  purpose?: PortalVerificationPurpose;
  ttlSeconds?: number;
  maxAttempts?: number;
  cooldownSeconds: number;
  now?: Date;
}): Promise<PortalEmailVerificationIssued> {
  return issuePortalEmailVerification(input);
}

const CUSTOMER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generatePortalCustomerCode(): string {
  let value = BigInt(`0x${randomBytes(8).toString("hex")}`);
  let code = "";
  for (let index = 0; index < 10; index += 1) {
    code += CUSTOMER_CODE_ALPHABET[Number(value % 32n)];
    value /= 32n;
  }
  return `K-${code}`;
}

type PortalVerificationOutcome =
  | { status: "invalid"; error: PortalIdentityError }
  | { status: "verified"; result: PublicPortalUser };

export async function verifyPortalUserAndProvisionCustomer(input: {
  email: string;
  code: string;
  ttlSeconds?: number;
  maxAttempts?: number;
  now?: Date;
}, options: {
  generateCustomerCode?: () => string;
} = {}): Promise<PublicPortalUser> {
  const purpose = "email_confirmation";
  const now = input.now ?? new Date();
  const nowText = now.toISOString();
  const email = normalizePortalEmail(input.email);
  const generateCustomerCode = options.generateCustomerCode ?? generatePortalCustomerCode;
  const db = await getPortalIdentityDatabase();

  const attempt = async (): Promise<PortalVerificationOutcome> => await db.transaction(
    async (tx): Promise<PortalVerificationOutcome> => {
      const row = await tx.get<EmailVerificationRow>(`
        SELECT id,portal_user_id,code_hash,expires_at,attempts,max_attempts,consumed_at
        FROM portal_email_verifications
        WHERE email = ? AND purpose = ? AND consumed_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `, [email, purpose]);
      if (!row) throw new PortalIdentityError("verification_not_found");
      if (now >= new Date(row.expires_at)) throw new PortalIdentityError("verification_expired");
      if (Number(row.attempts) >= Number(row.max_attempts)) {
        throw new PortalIdentityError("verification_attempts_exceeded");
      }

      const expected = Buffer.from(row.code_hash, "hex");
      const actual = Buffer.from(sha256(input.code), "hex");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        await tx.run(`
          UPDATE portal_email_verifications
          SET attempts = attempts + 1, last_attempt_at = ?
          WHERE id = ?
        `, [nowText, row.id]);
        return { status: "invalid", error: new PortalIdentityError("invalid_verification_code") };
      }

      let customerCode = "";
      for (let retry = 0; retry < 10; retry += 1) {
        const candidate = generateCustomerCode();
        const existing = await tx.get<{ customer_code: string }>(`
          SELECT customer_code
          FROM customers
          WHERE owner_domain = 'kanei' AND customer_code = ?
        `, [candidate]);
        if (existing) continue;
        customerCode = candidate;
        break;
      }
      if (!customerCode) throw new PortalIdentityError("duplicate_customer_code");

      const userRow = await tx.get<PortalUserRow>(
        "SELECT * FROM portal_users WHERE id = ?",
        [Number(row.portal_user_id)],
      );
      if (!userRow) throw new PortalIdentityError("portal_user_not_found");
      const user = mapPortalUser(userRow);
      if (user.isVerified) throw new PortalIdentityError("conflict");

      await tx.run(`
        INSERT INTO customers (
          owner_domain,customer_code,customer_name,postal_code,address,contact,telephone,
          email,created_at,updated_at
        ) VALUES ('kanei',?,?,?,?,?,?,?,?,?)
      `, [
        customerCode,
        user.companyName,
        user.postalCode,
        user.address,
        user.contactName,
        user.telephone,
        user.email,
        nowText,
        nowText,
      ]);

      const updated = await tx.run(`
        UPDATE portal_users
        SET customer_code = ?, is_verified = 1, is_active = 1, verified_at = ?, updated_at = ?
        WHERE id = ? AND is_verified = 0
      `, [customerCode, nowText, nowText, Number(row.portal_user_id)]);
      if (updated.changes !== 1) throw new PortalIdentityError("conflict");

      const consumed = await tx.run(`
        UPDATE portal_email_verifications
        SET consumed_at = ?, last_attempt_at = ?
        WHERE id = ? AND consumed_at IS NULL
      `, [nowText, nowText, row.id]);
      if (consumed.changes !== 1) throw new PortalIdentityError("verification_not_found");

      const verifiedUser = await tx.get<PortalUserRow>(
        "SELECT * FROM portal_users WHERE id = ?",
        [Number(row.portal_user_id)],
      );
      if (!verifiedUser) throw new PortalIdentityError("portal_user_not_found");
      return { status: "verified", result: mapPortalUser(verifiedUser) };
    },
  );

  for (let retry = 0; retry < 5; retry += 1) {
    try {
      const outcome = await attempt();
      if (outcome.status === "invalid") throw outcome.error;
      return outcome.result;
    } catch (error) {
      if (isUniqueViolation(error) && retry < 4) continue;
      throw error;
    }
  }
  throw new PortalIdentityError("duplicate_customer_code");
}

export async function consumePortalEmailVerification(input: {
  email: string;
  code: string;
  purpose?: PortalVerificationPurpose;
  now?: Date;
}): Promise<PortalEmailVerificationResult> {
  const purpose = input.purpose ?? "email_confirmation";
  const now = input.now ?? new Date();
  const nowText = now.toISOString();
  const email = normalizePortalEmail(input.email);
  const db = await getPortalIdentityDatabase();
  type TransactionResult =
    | { status: "invalid"; error: PortalIdentityError }
    | { status: "success"; result: PortalEmailVerificationResult };
  const transactionResult = await db.transaction(async (tx): Promise<TransactionResult> => {
    const row = await tx.get<EmailVerificationRow & { code_hash: string }>(`
      SELECT id,portal_user_id,code_hash,expires_at,attempts,max_attempts,consumed_at
      FROM portal_email_verifications
      WHERE email = ? AND purpose = ? AND consumed_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `, [email, purpose]);
    if (!row) throw new PortalIdentityError("verification_not_found");
    if (now >= new Date(row.expires_at)) throw new PortalIdentityError("verification_expired");
    if (Number(row.attempts) >= Number(row.max_attempts)) {
      throw new PortalIdentityError("verification_attempts_exceeded");
    }

    const expected = Buffer.from(row.code_hash, "hex");
    const actual = Buffer.from(sha256(input.code), "hex");
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!matches) {
      await tx.run(`
        UPDATE portal_email_verifications
        SET attempts = attempts + 1, last_attempt_at = ?
        WHERE id = ?
      `, [nowText, row.id]);
      return { status: "invalid", error: new PortalIdentityError("invalid_verification_code") };
    }

    await tx.run(`
      UPDATE portal_email_verifications
      SET consumed_at = ?, last_attempt_at = ?
      WHERE id = ? AND consumed_at IS NULL
    `, [nowText, nowText, row.id]);
    await tx.run(`
      UPDATE portal_users
      SET is_verified = 1, verified_at = ?, updated_at = ?
      WHERE id = ? AND is_verified = 0
    `, [nowText, nowText, Number(row.portal_user_id)]);

    const userRow = await tx.get<PortalUserRow>(
      "SELECT * FROM portal_users WHERE id = ?",
      [Number(row.portal_user_id)],
    );
    if (!userRow) throw new PortalIdentityError("portal_user_not_found");
    return {
      status: "success",
      result: { user: mapPortalUser(userRow), verificationId: Number(row.id) },
    };
  });
  if (transactionResult.status === "invalid") throw transactionResult.error;
  return transactionResult.result;
}

export async function ensureQuotationPortalServiceActor(): Promise<number | null> {
  const { getDatabase } = await import("@/lib/auth-store");
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO users (email,name,role,is_active,password_hash,created_at,updated_at)
    VALUES (?,?,?,0,?,?,?)
    ON CONFLICT(email) DO UPDATE SET is_active = 0, updated_at = excluded.updated_at
  `, [
    PORTAL_SERVICE_ACTOR_EMAIL,
    "Portal Service Actor",
    "user",
    PORTAL_SERVICE_ACTOR_PASSWORD_HASH,
    now,
    now,
  ]);
  const actor = await db.get<{ id: number }>(
    "SELECT id FROM users WHERE email = ? AND role = 'user' AND is_active = 0",
    [PORTAL_SERVICE_ACTOR_EMAIL],
  );
  return actor ? Number(actor.id) : null;
}

export async function getPortalServiceActorId(): Promise<number | null> {
  return ensureQuotationPortalServiceActor();
}

function assertTokenValue(token: string): void {
  if (token.length < 32 || token.length > 500) {
    throw new PortalIdentityError("invalid_credentials");
  }
}

export async function createPortalSession(
  userId: number,
  options: {
    ttlSeconds?: number;
    now?: Date;
    metadata?: PortalSessionMetadata;
  } = {},
): Promise<PortalSessionIssued> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const now = options.now ?? new Date();
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 24 * 60 * 60) {
    throw new PortalIdentityError("invalid_credentials");
  }
  if (Number(userId) === await ensureQuotationPortalServiceActor()) {
    throw new PortalIdentityError("portal_service_login_forbidden");
  }
  const db = await getPortalIdentityDatabase();
  const user = await db.get<PortalUserRow>("SELECT * FROM portal_users WHERE id = ?", [userId]);
  if (!user) throw new PortalIdentityError("portal_user_not_found");
  const mapped = mapPortalUser(user);
  if (!mapped.isActive || !mapped.isVerified || mapped.email === PORTAL_SERVICE_ACTOR_EMAIL) {
    throw new PortalIdentityError("portal_service_login_forbidden");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const createdAt = now.toISOString();
  await db.run(`
    INSERT INTO portal_sessions (
      portal_user_id,token_hash,expires_at,created_ip_hash,created_user_agent,created_at
    ) VALUES (?,?,?,?,?,?)
  `, [
    userId,
    sha256(token),
    expiresAt,
    hashPortalSessionIp(options.metadata?.ipAddress)?.slice(0, 100) ?? "",
    options.metadata?.userAgent?.slice(0, 500) ?? "",
    createdAt,
  ]);
  return { token, expiresAt };
}

export async function authenticatePortalSession(
  token: string,
  options: { now?: Date; metadata?: PortalSessionMetadata } = {},
): Promise<PublicPortalUser | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  assertTokenValue(token);
  const now = options.now ?? new Date();
  const nowText = now.toISOString();
  const db = await getPortalIdentityDatabase();
  const row = await db.get<PortalSessionRow>(`
    SELECT sessions.portal_user_id, sessions.expires_at
    FROM portal_sessions AS sessions
    INNER JOIN portal_users AS users ON users.id = sessions.portal_user_id
    WHERE sessions.token_hash = ?
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > ?
      AND users.is_verified = 1
      AND users.is_active = 1
  `, [sha256(token), nowText]);
  if (!row || now >= new Date(row.expires_at)) return null;

  await db.run(`
    UPDATE portal_sessions
    SET last_seen_at = ?, last_seen_ip_hash = ?, last_seen_user_agent = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `, [
    nowText,
    hashPortalSessionIp(options.metadata?.ipAddress),
    options.metadata?.userAgent?.slice(0, 500) ?? null,
    sha256(token),
  ]);
  const user = await getPortalUserById(Number(row.portal_user_id), { database: db });
  return user?.isActive && user.isVerified ? user : null;
}

export async function getPortalUserById(
  userId: number,
  options: { database?: SqlClient } = {},
): Promise<PublicPortalUser | null> {
  const db = options.database ?? await getPortalIdentityDatabase();
  const row = await db.get<PortalUserRow>("SELECT * FROM portal_users WHERE id = ?", [userId]);
  return row ? mapPortalUser(row) : null;
}

export async function revokePortalSession(token: string): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0) return false;
  assertTokenValue(token);
  const db = await getPortalIdentityDatabase();
  const result = await db.run(`
    UPDATE portal_sessions
    SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `, [new Date().toISOString(), sha256(token)]);
  return result.changes === 1;
}

export async function incrementPortalRateLimit(input: {
  key: string;
  limit: number;
  windowSeconds: number;
  now?: Date;
}): Promise<PortalRateLimitResult> {
  const key = input.key.trim();
  const now = input.now ?? new Date();
  const windowSeconds = input.windowSeconds;
  if (
    key.length < 1 || key.length > 300 || !Number.isInteger(input.limit) || input.limit < 1
    || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 24 * 60 * 60
  ) throw new PortalIdentityError("rate_limit_invalid");

  const windowEpoch = Math.floor(now.getTime() / 1000 / windowSeconds);
  const windowStartedAt = new Date(windowEpoch * windowSeconds * 1000).toISOString();
  const expiresAt = new Date((windowEpoch + 1) * windowSeconds * 1000).toISOString();
  const bucketKey = `${key}:${windowEpoch}`;
  const db = await getPortalIdentityDatabase();
  const rows = await db.all<{ count: number; window_started_at: string; expires_at: string }>(`
    INSERT INTO portal_rate_limits (bucket_key,count,window_started_at,expires_at)
    VALUES (?,1,?,?)
    ON CONFLICT(bucket_key) DO UPDATE SET
      count = CASE
        WHEN portal_rate_limits.window_started_at < excluded.window_started_at THEN 1
        ELSE portal_rate_limits.count + 1
      END,
      window_started_at = excluded.window_started_at,
      expires_at = excluded.expires_at
    WHERE portal_rate_limits.window_started_at <= excluded.window_started_at
    RETURNING count, window_started_at, expires_at
  `, [bucketKey, windowStartedAt, expiresAt]);
  const row = rows[0];
  if (!row) throw new Error("portal_rate_limit_update_failed");
  return {
    count: Number(row.count),
    windowStartedAt: row.window_started_at,
    expiresAt: row.expires_at,
  };
}

export function isPortalPasswordHash(hash: string): boolean {
  return hash.startsWith(PORTAL_SCRYPT_PREFIX);
}
