import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getSqlClient, isUniqueViolation, resetSqlClientForTest, type SqlClient } from "@/lib/db";
import { getDatabase, getUserByEmail, updateUser } from "@/lib/auth-store";

export const AGENT_PRINCIPAL_EMAIL = "ai@kanei-trade.co.jp";
export const AGENT_TOKEN_BYTE_LENGTH = 48;
export const AGENT_HASH_ALGORITHM = "sha-256";
export const AGENT_API_SCOPES = [
  "calculate:run",
  "quote:issue",
  "quote:read",
  "email_draft:read",
  "approval_state:read",
  "internal_approval:request",
] as const;

export type AgentScope = (typeof AGENT_API_SCOPES)[number];

export interface AgentCredentialIssued {
  credentialId: string;
  token: string;
  userId: number;
  principalEmail: string;
  name: string;
  scopes: readonly AgentScope[];
  expiresAt: string;
  createdAt: string;
}

export interface RotatedAgentCredential {
  credential: AgentCredentialIssued;
  previousCredentialId: string;
  previousStatus: "revoked" | "rotated";
  previousGraceExpiresAt: string | null;
}

export interface AgentAuthenticationResult {
  credentialId: string;
  userId: number;
  principalEmail: string;
  name: string;
  scopes: readonly AgentScope[];
}

export type AgentAuditOutcome = "allow" | "deny" | "error";

export interface AgentAuditDetails {
  scope?: AgentScope;
  correlationId?: string;
  calculationSha256?: string;
  quotationId?: string;
  quotationNumber?: string;
  candidateId?: string;
  pdfSha256?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type AgentAuditDetailsInput =
  | AgentAuditDetails
  | ((auth: AgentAuthenticationResult) => AgentAuditDetails | Promise<AgentAuditDetails>);

interface AgentCredentialRow {
  id: string;
  user_id: number;
  principal_email: string;
  name: string;
  token_hash: string;
  hash_algorithm: string;
  scopes_json: string;
  status: string;
  issued_at: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_to_credential_id: string | null;
  rotation_grace_expires_at: string | null;
  last_used_at: string | null;
}

export class AgentAuthError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(reason);
    this.name = "AgentAuthError";
    this.status = status;
    this.reason = reason;
  }
}

let schemaReady: Promise<SqlClient> | null = null;

const SHARED_SCHEMA = `
    CREATE TABLE IF NOT EXISTS agent_api_credentials (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      principal_email TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      hash_algorithm TEXT NOT NULL CHECK(hash_algorithm IN ('sha-256')),
      scopes_json TEXT NOT NULL CHECK(length(scopes_json) > 0),
      status TEXT NOT NULL CHECK(status IN ('active','rotated','revoked')),
      issued_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      rotated_to_credential_id TEXT,
      rotation_grace_expires_at TEXT,
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (rotated_to_credential_id)
        REFERENCES agent_api_credentials(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_credentials_user_id
      ON agent_api_credentials(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_credentials_status_expiry
      ON agent_api_credentials(status, expires_at);
    CREATE TABLE IF NOT EXISTS agent_api_rate_limits (
      credential_id TEXT PRIMARY KEY,
      window_started_at TEXT NOT NULL,
      request_count INTEGER NOT NULL CHECK(request_count >= 0),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (credential_id)
        REFERENCES agent_api_credentials(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_audit_events (
      id TEXT PRIMARY KEY,
      credential_id TEXT,
      principal_email TEXT NOT NULL,
      operation TEXT NOT NULL,
      scope TEXT,
      correlation_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('allow','deny','error')),
      reason TEXT NOT NULL,
      calculation_sha256 TEXT,
      quotation_id TEXT,
      quotation_number TEXT,
      candidate_id TEXT,
      pdf_sha256 TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_agent_audit_correlation
      ON agent_audit_events(correlation_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_agent_audit_credential
      ON agent_audit_events(credential_id, occurred_at);
`;

const SQLITE_SCHEMA = `
${SHARED_SCHEMA}
    CREATE TRIGGER IF NOT EXISTS agent_audit_events_no_update
    BEFORE UPDATE ON agent_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'agent_audit_events_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS agent_audit_events_no_delete
    BEFORE DELETE ON agent_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'agent_audit_events_append_only');
    END;
`;

const POSTGRES_SCHEMA = `
${SHARED_SCHEMA}
    CREATE OR REPLACE FUNCTION prevent_agent_audit_mutation()
    RETURNS TRIGGER AS $agent_audit_trigger$
    BEGIN
      RAISE EXCEPTION 'agent_audit_events_append_only';
    END;
    $agent_audit_trigger$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS agent_audit_events_no_update ON agent_audit_events;
    CREATE TRIGGER agent_audit_events_no_update
    BEFORE UPDATE ON agent_audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_agent_audit_mutation();
    DROP TRIGGER IF EXISTS agent_audit_events_no_delete ON agent_audit_events;
    CREATE TRIGGER agent_audit_events_no_delete
    BEFORE DELETE ON agent_audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_agent_audit_mutation();
`;

export function agentAuthSchemas(): { sqlite: string; postgres: string } {
  return { sqlite: SQLITE_SCHEMA, postgres: POSTGRES_SCHEMA };
}

function normalizePrincipal(email: string): string {
  return email.trim().toLowerCase();
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseScopes(value: string): readonly AgentScope[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((scope) => !isAgentScope(scope))) return [];
    return parsed as AgentScope[];
  } catch {
    return [];
  }
}

export function isAgentScope(value: unknown): value is AgentScope {
  return typeof value === "string" && (AGENT_API_SCOPES as readonly string[]).includes(value);
}

function parseScopesInput(scopes: readonly string[]): AgentScope[] {
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) {
    throw new AgentAuthError(400, "invalid_agent_scopes");
  }
  if (scopes.some((scope) => scope === "*")) {
    throw new AgentAuthError(400, "wildcard_scope_rejected");
  }
  if (scopes.some((scope) => !isAgentScope(scope))) {
    throw new AgentAuthError(400, "invalid_agent_scopes");
  }
  const unique = [...new Set(scopes)] as AgentScope[];
  // The privileged approval mutation is opt-in at issuance; all other scopes
  // remain ordinary explicit grants. There is no shortcut that expands this set.
  return AGENT_API_SCOPES.filter((scope) => unique.includes(scope));
}

function isoDate(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AgentAuthError(400, `invalid_${field}`);
  return date.toISOString();
}

async function auditEvent(
  db: SqlClient,
  operation: string,
  outcome: AgentAuditOutcome,
  reason: string,
  credentialId: string | null,
  principalEmail: string,
  details: AgentAuditDetails = {},
): Promise<void> {
  const safeMetadata = JSON.stringify(
    Object.fromEntries(
      Object.entries(details.metadata ?? {}).filter(([, value]) =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
      ),
    ),
  );
  await db.run(`
    INSERT INTO agent_audit_events (
      id,credential_id,principal_email,operation,scope,correlation_id,occurred_at,
      outcome,reason,calculation_sha256,quotation_id,quotation_number,candidate_id,pdf_sha256,metadata_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    randomUUID(),
    credentialId,
    principalEmail,
    operation,
    details.scope ?? null,
    details.correlationId ?? randomUUID(),
    new Date().toISOString(),
    outcome,
    reason,
    details.calculationSha256 ?? null,
    details.quotationId ?? null,
    details.quotationNumber ?? null,
    details.candidateId ?? null,
    details.pdfSha256 ?? null,
    safeMetadata,
  ]);
}

export async function recordAgentAuditEvent(
  operation: string,
  outcome: AgentAuditOutcome,
  reason: string,
  credentialId: string | null,
  principalEmail: string,
  details: AgentAuditDetails = {},
): Promise<void> {
  const db = await agentDatabase();
  await auditEvent(db, operation, outcome, reason, credentialId, principalEmail, details);
}

async function agentDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getDatabase();
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
    return db;
  })();
  return schemaReady;
}

async function insertCredential(
  db: SqlClient,
  input: {
    userId: number;
    principalEmail: string;
    name: string;
    scopes: readonly AgentScope[];
    expiresAt: Date;
  },
): Promise<{ credential: AgentCredentialIssued; tokenHash: string }> {
  const token = randomBytes(AGENT_TOKEN_BYTE_LENGTH).toString("base64url");
  const tokenHash = hashAgentToken(token);
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO agent_api_credentials (
      id,user_id,principal_email,name,token_hash,hash_algorithm,scopes_json,
      status,issued_at,created_at,expires_at
    ) VALUES (?,?,?,?,?,?,?,'active',?,?,?)
  `, [
    id,
    input.userId,
    input.principalEmail,
    input.name,
    tokenHash,
    AGENT_HASH_ALGORITHM,
    JSON.stringify(input.scopes),
    now,
    now,
    input.expiresAt.toISOString(),
  ]);
  return {
    tokenHash,
    credential: {
      credentialId: id,
      token,
      userId: input.userId,
      principalEmail: input.principalEmail,
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt.toISOString(),
      createdAt: now,
    },
  };
}

async function resolvePrincipal(userId?: number): Promise<{
  id: number;
  email: string;
  role: string;
  isActive: boolean;
}> {
  const user = userId === undefined
    ? await getUserByEmail(AGENT_PRINCIPAL_EMAIL)
    : await databaseUser(userId);
  if (!user) throw new AgentAuthError(400, "agent_principal_not_found");
  if (normalizePrincipal(user.email) !== AGENT_PRINCIPAL_EMAIL) {
    throw new AgentAuthError(400, "agent_principal_mismatch");
  }
  if (user.role === "admin") throw new AgentAuthError(400, "agent_principal_admin_rejected");
  if (!user.isActive) throw new AgentAuthError(400, "agent_principal_inactive");
  return user;
}

async function databaseUser(userId: number): Promise<{
  id: number;
  email: string;
  role: string;
  isActive: boolean;
} | null> {
  const db = await agentDatabase();
  const row = await db.get<{ id: number; email: string; role: string; is_active: number }>(
    "SELECT id,email,role,is_active FROM users WHERE id = ?",
    [userId],
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    isActive: Number(row.is_active) === 1,
  };
}

export async function createAgentCredential(input: {
  name: string;
  scopes: readonly string[];
  expiresAt: Date | string;
  userId?: number;
  includeInternalApproval?: boolean;
}): Promise<AgentCredentialIssued> {
  if (input.name.trim().length === 0 || input.name.length > 200) {
    throw new AgentAuthError(400, "invalid_credential_name");
  }
  const expiresAt = isoDate(input.expiresAt, "expires_at");
  if (new Date(expiresAt).getTime() <= Date.now()) {
    throw new AgentAuthError(400, "credential_already_expired");
  }
  let scopes = parseScopesInput(input.scopes);
  if (!input.includeInternalApproval) {
    scopes = scopes.filter((scope) => scope !== "internal_approval:request");
  }
  if (scopes.length === 0) throw new AgentAuthError(400, "invalid_agent_scopes");
  const principal = await resolvePrincipal(input.userId);
  const db = await agentDatabase();
  const issued = await insertCredential(db, {
    userId: principal.id,
    principalEmail: normalizePrincipal(principal.email),
    name: input.name.trim(),
    scopes,
    expiresAt: new Date(expiresAt),
  });
  await auditEvent(
    db,
    "credential.create",
    "allow",
    "credential_created",
    issued.credential.credentialId,
    principal.email,
    { metadata: { scopes: scopes.join(","), expires_at: expiresAt } },
  );
  return issued.credential;
}

export async function rotateAgentCredential(
  credentialId: string,
  options: { expiresAt?: Date | string; graceSeconds?: number } = {},
): Promise<RotatedAgentCredential> {
  const graceSeconds = options.graceSeconds
    ?? Number(process.env.AGENT_ROTATION_GRACE_SECONDS ?? "0");
  if (!Number.isInteger(graceSeconds) || graceSeconds < 0 || graceSeconds > 86_400) {
    throw new AgentAuthError(400, "invalid_rotation_grace");
  }
  return agentDatabase().then(async (db) => db.transaction(async (tx) => {
    const previous = await tx.get<AgentCredentialRow>(
      "SELECT * FROM agent_api_credentials WHERE id = ?",
      [credentialId],
    );
    if (!previous) throw new AgentAuthError(404, "credential_not_found");
    if (previous.status === "revoked") throw new AgentAuthError(409, "credential_revoked");
    if (previous.expires_at <= new Date().toISOString()) {
      throw new AgentAuthError(401, "credential_expired");
    }
    const principal = await resolvePrincipal(Number(previous.user_id));
    if (normalizePrincipal(principal.email) !== previous.principal_email) {
      throw new AgentAuthError(409, "agent_principal_mismatch");
    }
    const oldScopes = parseScopes(previous.scopes_json);
    if (oldScopes.length === 0) throw new AgentAuthError(409, "invalid_stored_scopes");
    const expiresInput = options.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expiresAt = isoDate(expiresInput, "expires_at");
    if (new Date(expiresAt).getTime() <= Date.now()) {
      throw new AgentAuthError(400, "credential_already_expired");
    }
    const issued = await insertCredential(tx, {
      userId: principal.id,
      principalEmail: previous.principal_email,
      name: previous.name,
      scopes: oldScopes,
      expiresAt: new Date(expiresAt),
    });
    const now = new Date();
    const graceExpiresAt = new Date(now.getTime() + graceSeconds * 1000);
    const previousStatus = graceSeconds === 0 ? "revoked" : "rotated";
    await tx.run(`
      UPDATE agent_api_credentials
      SET status = ?, revoked_at = ?, rotated_to_credential_id = ?,
          rotation_grace_expires_at = ?
      WHERE id = ?
    `, [
      previousStatus,
      graceSeconds === 0 ? now.toISOString() : null,
      issued.credential.credentialId,
      graceSeconds === 0 ? null : graceExpiresAt.toISOString(),
      credentialId,
    ]);
    await auditEvent(tx, "credential.rotate", "allow", "credential_rotated", credentialId, previous.principal_email, {
      metadata: {
        new_credential_id: issued.credential.credentialId,
        grace_seconds: graceSeconds,
        previous_status: previousStatus,
      },
    });
    return {
      credential: issued.credential,
      previousCredentialId: credentialId,
      previousStatus,
      previousGraceExpiresAt: graceSeconds === 0 ? null : graceExpiresAt.toISOString(),
    };
  }));
}

export async function revokeAgentCredential(credentialId: string): Promise<void> {
  const db = await agentDatabase();
  const now = new Date().toISOString();
  const result = await db.run(`
    UPDATE agent_api_credentials
    SET status = 'revoked', revoked_at = ?, rotation_grace_expires_at = NULL
    WHERE id = ? AND status != 'revoked'
  `, [now, credentialId]);
  if (result.changes === 0) throw new AgentAuthError(404, "credential_not_found_or_revoked");
  const row = await db.get<{ principal_email: string }>(
    "SELECT principal_email FROM agent_api_credentials WHERE id = ?",
    [credentialId],
  );
  await auditEvent(db, "credential.revoke", "allow", "credential_revoked", credentialId, row?.principal_email ?? AGENT_PRINCIPAL_EMAIL);
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

async function expireGraceIfStale(row: AgentCredentialRow, now: Date): Promise<AgentCredentialRow> {
  if (row.status !== "rotated") return row;
  const stale = !row.rotation_grace_expires_at || row.rotation_grace_expires_at <= now.toISOString();
  if (!stale) return row;
  const db = await agentDatabase();
  await db.run(`
    UPDATE agent_api_credentials
    SET status = 'revoked', revoked_at = ?, rotation_grace_expires_at = NULL
    WHERE id = ? AND status = 'rotated'
  `, [now.toISOString(), row.id]);
  return { ...row, status: "revoked", revoked_at: now.toISOString(), rotation_grace_expires_at: null };
}

async function auditAuthFailure(
  reason: string,
  row: AgentCredentialRow | null,
): Promise<never> {
  const db = await agentDatabase();
  await auditEvent(
    db,
    "authentication",
    "deny",
    reason,
    row?.id ?? null,
    row?.principal_email ?? AGENT_PRINCIPAL_EMAIL,
  );
  throw new AgentAuthError(401, "unauthorized_agent");
}

export async function authenticateAgentBearer(request: Request): Promise<AgentAuthenticationResult> {
  const token = bearerToken(request);
  if (!token) return auditAuthFailure("missing_or_malformed_bearer", null);
  const db = await agentDatabase();
  const digest = hashAgentToken(token);
  let row = await db.get<AgentCredentialRow>(
    "SELECT * FROM agent_api_credentials WHERE token_hash = ?",
    [digest],
  );
  if (!row || row.hash_algorithm !== AGENT_HASH_ALGORITHM || !timingSafeHexEqual(row.token_hash, digest)) {
    return auditAuthFailure("credential_not_found", null);
  }
  row = await expireGraceIfStale(row, new Date());
  if (row.status === "revoked") return auditAuthFailure("credential_revoked", row);
  if (row.status === "rotated" && !row.rotation_grace_expires_at) {
    return auditAuthFailure("rotation_grace_invalid", row);
  }
  if (row.expires_at <= new Date().toISOString()) return auditAuthFailure("credential_expired", row);
  const user = await databaseUser(Number(row.user_id));
  if (!user) return auditAuthFailure("credential_user_not_found", row);
  if (normalizePrincipal(user.email) !== normalizePrincipal(row.principal_email)
    || normalizePrincipal(user.email) !== AGENT_PRINCIPAL_EMAIL) {
    return auditAuthFailure("credential_principal_mismatch", row);
  }
  if (user.role === "admin") return auditAuthFailure("credential_principal_admin_rejected", row);
  if (!user.isActive) return auditAuthFailure("credential_principal_inactive", row);
  const scopes = parseScopes(row.scopes_json);
  if (scopes.length === 0) return auditAuthFailure("invalid_credential_scopes", row);
  const now = new Date().toISOString();
  await db.run("UPDATE agent_api_credentials SET last_used_at = ? WHERE id = ?", [now, row.id]);
  await auditEvent(db, "authentication", "allow", "agent_authenticated", row.id, row.principal_email, {
    metadata: { operation_scope_count: scopes.length },
  });
  return {
    credentialId: row.id,
    userId: user.id,
    principalEmail: user.email,
    name: row.name,
    scopes,
  };
}

export function requireAgentScope(
  authenticated: AgentAuthenticationResult,
  scope: AgentScope,
): void {
  if (!authenticated.scopes.includes(scope)) {
    throw new AgentAuthError(403, "agent_scope_denied");
  }
}

async function consumeAgentRateLimit(
  credentialId: string,
  principalEmail: string,
): Promise<void> {
  const maxRequests = Number(process.env.AGENT_API_RATE_LIMIT ?? "120");
  const windowSeconds = Number(process.env.AGENT_API_RATE_WINDOW_SECONDS ?? "60");
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100_000
    || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86_400) {
    throw new AgentAuthError(500, "invalid_agent_rate_limit_configuration");
  }
  const db = await agentDatabase();
  const now = new Date();
  const windowStartedAt = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  // One conditional upsert keeps concurrent PostgreSQL requests atomic. The
  // SQLite writer is serialized by the connection's transaction lock.
  const rateRow = await db.get<{ request_count: number; window_started_at: string }>(`
    INSERT INTO agent_api_rate_limits (credential_id,window_started_at,request_count,updated_at)
    VALUES (?,?,1,?)
    ON CONFLICT(credential_id) DO UPDATE SET
      window_started_at = CASE
        WHEN agent_api_rate_limits.window_started_at <= ? THEN excluded.window_started_at
        ELSE agent_api_rate_limits.window_started_at
      END,
      request_count = CASE
        WHEN agent_api_rate_limits.window_started_at <= ? THEN 1
        ELSE agent_api_rate_limits.request_count + 1
      END,
      updated_at = excluded.updated_at
    RETURNING request_count, window_started_at
  `, [
    credentialId,
    now.toISOString(),
    now.toISOString(),
    windowStartedAt,
    windowStartedAt,
  ]);
  if (!rateRow) throw new AgentAuthError(500, "agent_rate_limit_update_failed");
  const result = {
    count: Number(rateRow.request_count),
    reset: new Date(new Date(rateRow.window_started_at).getTime() + windowSeconds * 1000),
  };
  if (result.count > maxRequests) {
    await auditEvent(
      db,
      "rate_limit",
      "deny",
      "agent_rate_limited",
      credentialId,
      principalEmail,
      { metadata: { request_count: result.count, limit: maxRequests } },
    );
    throw new AgentAuthError(429, "agent_rate_limited");
  }
}

export interface AgentRequestContext {
  auth: AgentAuthenticationResult;
  correlationId: string;
}

export async function withAgentApi<T>(
  request: Request,
  options: {
    operation: string;
    scope?: AgentScope;
    unauthorizedReason?: string;
    details?: AgentAuditDetailsInput;
  },
  handler: (context: AgentRequestContext) => Promise<T>,
): Promise<{ result: T; response?: never } | { result?: never; response: Response }> {
  let authenticated: AgentAuthenticationResult | null = null;
  const correlationId = randomUUID();
  const detailsFor = async (): Promise<AgentAuditDetails> => {
    if (!authenticated) return {};
    const details = typeof options.details === "function"
      ? await options.details(authenticated)
      : options.details;
    return details ?? {};
  };
  try {
    const auth = authenticated = await authenticateAgentBearer(request);
    const details = await detailsFor();
    if (options.scope) {
      try {
        requireAgentScope(auth, options.scope);
      } catch (error) {
        await recordAgentAuditEvent(
          options.operation,
          "deny",
          "agent_scope_denied",
          auth.credentialId,
          auth.principalEmail,
          { ...details, scope: options.scope, correlationId },
        );
        throw error;
      }
    }
    await consumeAgentRateLimit(auth.credentialId, auth.principalEmail);
    const result = await handler({ auth, correlationId });
    await recordAgentAuditEvent(
      options.operation,
      "allow",
      "operation_completed",
      auth.credentialId,
      auth.principalEmail,
      { ...(await detailsFor()), scope: options.scope, correlationId },
    );
    return { result };
  } catch (error) {
    if (error instanceof AgentAuthError) {
      if (error.reason !== "agent_scope_denied" && error.reason !== "agent_rate_limited"
        && error.reason !== "unauthorized_agent") {
        await recordAgentAuditEvent(
          options.operation,
          "error",
          error.reason,
          authenticated?.credentialId ?? null,
          authenticated?.principalEmail ?? AGENT_PRINCIPAL_EMAIL,
          { ...(await detailsFor()), correlationId },
        );
      }
      if (error.reason === "unauthorized_agent" && options.unauthorizedReason) {
        await recordAgentAuditEvent(
          options.operation,
          "deny",
          options.unauthorizedReason,
          null,
          AGENT_PRINCIPAL_EMAIL,
          { correlationId },
        );
      }
      return {
        response: Response.json(
          { error: error.reason === "unauthorized_agent" && options.unauthorizedReason ? options.unauthorizedReason : error.reason },
          { status: error.status, headers: { "cache-control": "no-store" } },
        ),
      };
    }
    await recordAgentAuditEvent(options.operation, "error", "operation_failed", null, AGENT_PRINCIPAL_EMAIL);
    return {
      response: Response.json(
        { error: "agent_operation_failed" },
        { status: 500, headers: { "cache-control": "no-store" } },
      ),
    };
  }
}

export async function resetAgentAuthForTest(): Promise<void> {
  await resetSqlClientForTest();
  schemaReady = null;
}

export async function agentAuthDatabaseForTest(): Promise<SqlClient> {
  return agentDatabase();
}

export async function ensureAgentPrincipalForTest(input?: {
  password?: string;
  isActive?: boolean;
  role?: "admin" | "user";
}): Promise<{ id: number; email: string }> {
  const { createUser, getUserByEmail } = await import("@/lib/auth-store");
  const email = AGENT_PRINCIPAL_EMAIL;
  const existing = await getUserByEmail(email);
  if (existing) return { id: existing.id, email: existing.email };
  const user = await createUser({
    email,
    name: "Hermes Agent",
    password: input?.password ?? randomBytes(24).toString("base64url"),
    role: input?.role ?? "user",
    isActive: input?.isActive ?? true,
  });
  return { id: user.id, email: user.email };
}

export async function ensureAgentPrincipalRuntime(): Promise<number> {
  const principal = await resolvePrincipal();
  return principal.id;
}

export async function provisionAgentCredential(options?: {
  name?: string;
  scopes?: readonly string[];
  ttlSeconds?: number;
  includeInternalApproval?: boolean;
}): Promise<AgentCredentialIssued> {
  const principal = await getUserByEmail(AGENT_PRINCIPAL_EMAIL);
  if (!principal) throw new AgentAuthError(400, "agent_principal_not_found");
  return createAgentCredential({
    userId: principal.id,
    name: options?.name?.trim() || "Hermes production credential",
    scopes: options?.scopes ?? ["calculate:run"],
    expiresAt: new Date(Date.now() + (options?.ttlSeconds ?? 30 * 24 * 60 * 60) * 1000),
    includeInternalApproval: options?.includeInternalApproval ?? false,
  });
}

export { isUniqueViolation };
