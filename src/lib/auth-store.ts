import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SESSION_COOKIE_NAME = "pouch_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
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

const databasePath = process.env.POUCH_QUOTATION_DB
  ?? (process.env.VERCEL === "1" ? "/tmp/pouch-quotations.db" : resolve(process.cwd(), ".data/quotations.db"));
let database: DatabaseSync | null = null;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

export async function getDatabase(): Promise<DatabaseSync> {
  if (database) return database;
  await mkdir(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
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
  `);
  await seedAdministrator();
  return database;
}

function activeAdminCount(db: DatabaseSync, excludeUserId?: number): number {
  const row = excludeUserId == null
    ? db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get() as { count: number }
    : db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?").get(excludeUserId) as { count: number };
  return Number(row.count);
}

export function validatePassword(password: unknown): password is string {
  return typeof password === "string" && password.length >= 12 && password.length <= 200;
}

export function validateUserName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 200;
}

export function validateRole(role: unknown): role is UserRole {
  return role === "admin" || role === "user";
}

export async function createUser(input: UserInput): Promise<PublicUser> {
  if (!validatePassword(input.password) || !validateUserName(input.name) || !validateRole(input.role)) {
    throw new Error("invalid_user");
  }
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_user");
  const db = await getDatabase();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(input.password);
  try {
    const result = db.prepare(`
      INSERT INTO users (email,name,role,is_active,password_hash,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(email, input.name.trim(), input.role, input.isActive === false ? 0 : 1, passwordHash, now, now);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(result.lastInsertRowid)) as unknown as UserRow;
    return mapUser(row);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new Error("duplicate_email");
    throw error;
  }
}

export async function getUserByEmail(email: string): Promise<PublicUser | null> {
  const db = await getDatabase();
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export async function getUserById(id: number): Promise<PublicUser | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const db = await getDatabase();
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export async function listUsers(): Promise<PublicUser[]> {
  const db = await getDatabase();
  const rows = db.prepare("SELECT * FROM users ORDER BY created_at, id").all() as unknown as UserRow[];
  return rows.map(mapUser);
}

export async function updateUser(
  id: number,
  patch: { name?: string; password?: string; role?: UserRole; isActive?: boolean },
): Promise<PublicUser> {
  const db = await getDatabase();
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!row) throw new Error("user_not_found");
  if (patch.name !== undefined && !validateUserName(patch.name)) throw new Error("invalid_user");
  if (patch.role !== undefined && !validateRole(patch.role)) throw new Error("invalid_user");
  if (patch.isActive !== undefined && typeof patch.isActive !== "boolean") throw new Error("invalid_user");
  if (patch.password !== undefined && !validatePassword(patch.password)) throw new Error("invalid_password");
  const passwordHash = patch.password === undefined ? row.password_hash : await hashPassword(patch.password);
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read after acquiring the write lock so a concurrent role/status change cannot be lost.
    const current = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    if (!current) throw new Error("user_not_found");
    const nextRole = patch.role ?? current.role as UserRole;
    const nextActive = patch.isActive ?? Number(current.is_active) === 1;
    if (nextRole !== "admin" || !nextActive) {
      const otherActiveAdmins = activeAdminCount(db, id);
      if (otherActiveAdmins === 0) throw new Error("last_active_admin");
    }

    db.prepare(`
      UPDATE users
      SET name = ?, role = ?, is_active = ?, password_hash = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.name === undefined ? current.name : patch.name.trim(),
      nextRole,
      nextActive ? 1 : 0,
      passwordHash,
      now,
      id,
    );
    if (patch.password !== undefined || !nextActive) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
  return mapUser(updated);
}

export async function authenticate(email: string, password: string): Promise<PublicUser | null> {
  const db = await getDatabase();
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as UserRow | undefined;
  if (!row || Number(row.is_active) !== 1) return null;
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;
  return mapUser(row);
}

export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const db = await getDatabase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  db.prepare("INSERT INTO sessions (user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?)")
    .run(userId, digest, expiresAt.toISOString(), new Date().toISOString());
  return { token, expiresAt };
}

export async function getSessionUserFromToken(token: string | undefined | null): Promise<AuthenticatedUser | null> {
  if (!token) return null;
  const db = await getDatabase();
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  const row = db.prepare(`
    SELECT sessions.id AS session_id, sessions.expires_at, users.*
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(digest) as (SessionRow & UserRow & { session_id: number }) | undefined;
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString() || Number(row.is_active) !== 1) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }
  return { ...mapUser(row), sessionId: Number(row.session_id) };
}

export async function deleteSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  const db = await getDatabase();
  const digest = createHash("sha256").update(token, "utf8").digest("hex");
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(digest);
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

async function seedAdministrator(): Promise<void> {
  const db = database;
  if (!db) return;
  const email = normalizeEmail(process.env.ADMIN_EMAIL ?? "admin@example.com");
  const password = process.env.ADMIN_PASSWORD ?? "pouch-admin-change-me-2026";
  const name = process.env.ADMIN_NAME?.trim() || "System Administrator";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_admin_email");
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined;
  if (existing) return;
  if (process.env.NODE_ENV === "production" && process.env.ADMIN_PASSWORD === undefined) {
    throw new Error("ADMIN_PASSWORD_required_in_production");
  }
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  db.prepare(`
    INSERT INTO users (email,name,role,is_active,password_hash,created_at,updated_at)
    VALUES (?,?,?,1,?,?,?)
  `).run(email, name, "admin", passwordHash, now, now);
}

export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  } as const;
}

export async function closeDatabaseForTest(): Promise<void> {
  database?.close();
  database = null;
}

export async function ensureAdministratorSeed(): Promise<number> {
  const db = await getDatabase();
  const email = normalizeEmail(process.env.ADMIN_EMAIL ?? "admin@example.com");
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number } | undefined;
  if (!row) throw new Error("administrator_seed_failed");
  return Number(row.id);
}
