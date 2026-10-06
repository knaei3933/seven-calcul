import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getSqlClient, isUniqueViolation, resetSqlClientForTest, type SqlClient } from "./db";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SESSION_COOKIE_NAME = "pouch_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const ENV_AUTH_MODE = process.env.VERCEL === "1" || process.env.AUTH_MODE === "env";
const SCRYPT_PARAMETERS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const PASSWORD_KEY_LENGTH = 64;

export type UserRole = "admin" | "user";

export interface PublicUser {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedUser extends PublicUser {
  sessionId: number;
}

export interface UserInput {
  email: string;
  name: string;
  password: string;
  role: UserRole;
  isActive?: boolean;
}

interface EnvAdminUser extends PublicUser {
  password: string;
}

function toPublicUser(user: EnvAdminUser): PublicUser {
  const { password: _password, ...publicUser } = user;
  return publicUser;
}

interface UserRow {
  id: number;
  email: string;
  name: string;
  role: string;
  is_active: number;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
}

let schemaReady: Promise<SqlClient> | null = null;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function envAdminUsers(): EnvAdminUser[] {
  const now = new Date(0).toISOString();
  const users: EnvAdminUser[] = [];
  const primaryEmail = normalizeEmail(process.env.ADMIN_EMAIL ?? "admin@example.com");
  users.push({
    id: 1,
    email: primaryEmail,
    name: process.env.ADMIN_NAME?.trim() || "System Administrator",
    role: "admin",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    password: process.env.ADMIN_PASSWORD ?? "pouch-admin-change-me-2026",
  });
  if (process.env.SECOND_ADMIN_EMAIL) {
    users.push({
      id: 2,
      email: normalizeEmail(process.env.SECOND_ADMIN_EMAIL),
      name: process.env.SECOND_ADMIN_NAME?.trim() || "Administrator",
      role: "admin",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      password: process.env.SECOND_ADMIN_PASSWORD ?? "",
    });
  }
  if (process.env.THIRD_ADMIN_EMAIL) {
    users.push({
      id: 3,
      email: normalizeEmail(process.env.THIRD_ADMIN_EMAIL),
      name: process.env.THIRD_ADMIN_NAME?.trim() || "Administrator",
      role: "admin",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      password: process.env.THIRD_ADMIN_PASSWORD ?? "",
    });
  }
  return users.filter((user) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email));
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production" && ENV_AUTH_MODE) {
    throw new Error("AUTH_SECRET_required_in_production");
  }
  return "pouch-development-auth-secret";
}

function signedSessionToken(user: PublicUser, expiresAt: Date): string {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Math.floor(expiresAt.getTime() / 1000),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", authSecret()).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySignedSessionToken(token: string): PublicUser | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;
  const expectedSignature = createHmac("sha256", authSecret()).update(encodedPayload).digest();
  const actualSignature = Buffer.from(signature, "base64url");
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      sub?: unknown; email?: unknown; role?: unknown; exp?: unknown;
    };
    if (
      typeof payload.sub !== "number" || typeof payload.email !== "string"
      || typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()
    ) return null;
    const user = envAdminUsers().find((candidate) => (
      candidate.id === payload.sub
      && candidate.email === payload.email
      && candidate.isActive
    ));
    return user ? toPublicUser(user) : null;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize("NFKC"), salt, PASSWORD_KEY_LENGTH, SCRYPT_PARAMETERS);
  return [
    "scrypt",
    SCRYPT_PARAMETERS.N,
    SCRYPT_PARAMETERS.r,
    SCRYPT_PARAMETERS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, n, r, p, saltText, hashText] = storedHash.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  const parameters = {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  };
  if (!Number.isInteger(parameters.N) || !Number.isInteger(parameters.r) || !Number.isInteger(parameters.p)) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = await scrypt(password.normalize("NFKC"), Buffer.from(saltText, "base64url"), expected.length, parameters);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function mapUser(row: UserRow): PublicUser {
  return {
    id: Number(row.id),
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    isActive: Number(row.is_active) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SQLITE_SCHEMA = `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`;

const POSTGRES_SCHEMA = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')),
      is_active SMALLINT NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`;

export async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
    await seedAdministrator(db);
    return db;
  })();
  return schemaReady;
}

async function seedAdministrator(db: SqlClient): Promise<void> {
  for (const user of envAdminUsers()) {
    if (process.env.NODE_ENV === "production" && !process.env.ADMIN_PASSWORD) {
      throw new Error("ADMIN_PASSWORD_required_in_production");
    }
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(user.password);
    if (ENV_AUTH_MODE) {
      // 環境変数認証では所有者ID 1/2/3 が見積の外部キーとして必須。
      // ID固定で冪等アップサートし、どの環境でも同じ参照先を保証する。
      const existing = await db.get<{ id: number }>(
        "SELECT id FROM users WHERE id = ? AND email = ? AND role = 'admin' AND is_active = 1",
        [user.id, user.email],
      );
      if (existing) continue;
      await db.run(`
        INSERT INTO users (id,email,name,role,is_active,password_hash,created_at,updated_at)
        VALUES (?,?,?,'admin',1,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          email=excluded.email, name=excluded.name, role='admin', is_active=1,
          password_hash=excluded.password_hash, updated_at=excluded.updated_at
      `, [
        user.id, user.email, user.name, passwordHash, now, now,
      ]);
      continue;
    }
    const existing = await db.get<{ id: number }>("SELECT id FROM users WHERE email = ?", [user.email]);
    if (existing) continue;
    await db.run(`
      INSERT INTO users (email,name,role,is_active,password_hash,created_at,updated_at)
      VALUES (?,?,?,1,?,?,?)
    `, [user.email, user.name, "admin", passwordHash, now, now]);
  }
}

async function activeAdminCount(db: SqlClient, excludeUserId?: number): Promise<number> {
  const row = excludeUserId == null
    ? await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1")
    : await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?",
      [excludeUserId],
    );
  return Number(row?.count ?? 0);
}

export function validatePassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 10 && password.length <= 200;
}

export function validateUserName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 200;
}

export function validateRole(role: unknown): role is UserRole {
  return role === "admin" || role === "user";
}

export async function createUser(input: UserInput): Promise<PublicUser> {
  if (ENV_AUTH_MODE) throw new Error("user_management_unavailable");
  if (!validatePassword(input.password) || !validateUserName(input.name) || !validateRole(input.role)) {
    throw new Error("invalid_user");
  }
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_user");
  const db = await getDatabase();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(input.password);
  try {
    await db.run(`
      INSERT INTO users (email,name,role,is_active,password_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `, [email, input.name.trim(), input.role, input.isActive === false ? 0 : 1, passwordHash, now, now]);
    const row = await db.get<UserRow>("SELECT * FROM users WHERE email = ?", [email]);
    if (!row) throw new Error("user_save_failed");
    return mapUser(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("duplicate_email");
    throw error;
  }
}

export async function getUserByEmail(email: string): Promise<PublicUser | null> {
  if (ENV_AUTH_MODE) {
    const normalized = normalizeEmail(email);
    const user = envAdminUsers().find((candidate) => candidate.email === normalized);
    return user ? toPublicUser(user) : null;
  }
  const db = await getDatabase();
  const row = await db.get<UserRow>("SELECT * FROM users WHERE email = ?", [normalizeEmail(email)]);
  return row ? mapUser(row) : null;
}

export async function getUserById(id: number): Promise<PublicUser | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  if (ENV_AUTH_MODE) {
    const user = envAdminUsers().find((candidate) => candidate.id === id);
    return user ? toPublicUser(user) : null;
  }
  const db = await getDatabase();
  const row = await db.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return row ? mapUser(row) : null;
}

export async function listUsers(): Promise<PublicUser[]> {
  if (ENV_AUTH_MODE) return envAdminUsers().map(toPublicUser);
  const db = await getDatabase();
  const rows = await db.all<UserRow>("SELECT * FROM users ORDER BY created_at, id");
  return rows.map(mapUser);
}

export async function updateUser(
  id: number,
  patch: { name?: string; password?: string; role?: UserRole; isActive?: boolean },
): Promise<PublicUser> {
  if (ENV_AUTH_MODE) throw new Error("user_management_unavailable");
  const db = await getDatabase();
  const row = await db.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  if (!row) throw new Error("user_not_found");
  if (patch.name !== undefined && !validateUserName(patch.name)) throw new Error("invalid_user");
  if (patch.role !== undefined && !validateRole(patch.role)) throw new Error("invalid_user");
  if (patch.isActive !== undefined && typeof patch.isActive !== "boolean") throw new Error("invalid_user");
  if (patch.password !== undefined && !validatePassword(patch.password)) throw new Error("invalid_password");
  const passwordHash = patch.password === undefined ? row.password_hash : await hashPassword(patch.password);
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    // Re-read after acquiring the write lock so a concurrent role/status change cannot be lost.
    const current = await tx.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
    if (!current) throw new Error("user_not_found");
    const nextRole = patch.role ?? current.role as UserRole;
    const nextActive = patch.isActive ?? Number(current.is_active) === 1;
    if (nextRole !== "admin" || !nextActive) {
      const otherActiveAdmins = await activeAdminCount(tx, id);
      if (otherActiveAdmins === 0) throw new Error("last_active_admin");
    }

    await tx.run(`
      UPDATE users
      SET name = ?, role = ?, is_active = ?, password_hash = ?, updated_at = ?
      WHERE id = ?
    `, [
      patch.name === undefined ? current.name : patch.name.trim(),
      nextRole,
      nextActive ? 1 : 0,
      passwordHash,
      now,
      id,
    ]);
    if (patch.password !== undefined || !nextActive) {
      await tx.run("DELETE FROM sessions WHERE user_id = ?", [id]);
    }
  });
  const updated = await db.get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  if (!updated) throw new Error("user_not_found");
  return mapUser(updated);
}

export async function authenticate(email: string, password: string): Promise<PublicUser | null> {
  if (ENV_AUTH_MODE) {
    const normalized = normalizeEmail(email);
    const user = envAdminUsers().find((candidate) => candidate.email === normalized && candidate.isActive);
    if (!user) return null;
    const secret = authSecret();
    const expected = createHmac("sha256", secret).update(`${normalized}:${password}`).digest();
    const actual = createHmac("sha256", secret).update(`${user.email}:${user.password}`).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual)
      ? toPublicUser(user)
      : null;
  }
  const db = await getDatabase();
  const row = await db.get<UserRow>("SELECT * FROM users WHERE email = ?", [normalizeEmail(email)]);
  if (!row || Number(row.is_active) !== 1) return null;
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;
  return mapUser(row);
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  if (ENV_AUTH_MODE) {
    const user = envAdminUsers().find((candidate) => candidate.id === userId && candidate.isActive);
    if (!user) throw new Error("user_not_found");
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    return { token: signedSessionToken(toPublicUser(user), expiresAt), expiresAt };
  }
  const db = await getDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  await db.run("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);
  await db.run(
    "INSERT INTO sessions (user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?)",
    [userId, digest, expiresAt.toISOString(), new Date().toISOString()],
  );
  return { token, expiresAt };
}

export async function getSessionUserFromToken(token: string | undefined | null): Promise<AuthenticatedUser | null> {
  if (!token) return null;
  if (ENV_AUTH_MODE) {
    const user = verifySignedSessionToken(token);
    return user ? { ...user, sessionId: 0 } : null;
  }
  const db = await getDatabase();
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  const row = await db.get<SessionRow & UserRow & { session_id: number }>(`
    SELECT sessions.id AS session_id, sessions.expires_at, users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `, [digest]);
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString() || Number(row.is_active) !== 1) {
    await db.run("DELETE FROM sessions WHERE id = ?", [row.session_id]);
    return null;
  }
  return { ...mapUser(row), sessionId: Number(row.session_id) };
}

export async function deleteSession(token: string | undefined | null): Promise<void> {
  if (!token || ENV_AUTH_MODE) return;
  const db = await getDatabase();
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  await db.run("DELETE FROM sessions WHERE token_hash = ?", [digest]);
}

export async function readSessionCookie(request: Request): Promise<string | null> {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

export function isSecureRequest(request: Request): boolean {
  const forwardedProtocol = request.headers.get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProtocol) return forwardedProtocol === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function sessionCookieOptions(maxAge: number, secure = false) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge,
  } as const;
}

export async function closeDatabaseForTest(): Promise<void> {
  await resetSqlClientForTest();
  schemaReady = null;
}

export async function ensureAdministratorSeed(): Promise<number> {
  if (ENV_AUTH_MODE) {
    // Quotation ownership still uses stable IDs 1/2. Open the local SQLite file
    // once so both environment-defined owners exist as valid foreign keys.
    await getDatabase();
    return 1;
  }
  const db = await getDatabase();
  const email = normalizeEmail(process.env.ADMIN_EMAIL ?? "admin@example.com");
  const row = await db.get<{ id: number }>("SELECT id FROM users WHERE email = ?", [email]);
  if (!row) throw new Error("administrator_seed_failed");
  return Number(row.id);
}
