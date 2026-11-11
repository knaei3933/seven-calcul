import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { translateSqlToPostgres } from "@/lib/db/sql-translation";

const databaseDirectory = await mkdtemp(join(tmpdir(), "agent-credential-auth-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.ADMIN_EMAIL = "admin@agent-auth.test";
process.env.ADMIN_PASSWORD = "admin-agent-auth-password";
process.env.ADMIN_NAME = "Agent Auth Admin";
delete process.env.DATABASE_URL;

const {
  AGENT_API_SCOPES,
  AGENT_HASH_ALGORITHM,
  AGENT_PRINCIPAL_EMAIL,
  agentAuthDatabaseForTest,
  agentAuthSchemas,
  authenticateAgentBearer,
  createAgentCredential,
  ensureAgentPrincipalForTest,
  requireAgentScope,
  resetAgentAuthForTest,
  revokeAgentCredential,
  rotateAgentCredential,
  withAgentApi,
} = await import("@/lib/agent-auth-store");
const { POST: login } = await import("@/app/api/auth/login/route");
const { GET: userSession } = await import("@/app/api/auth/session/route");
const { GET: agentStatus } = await import("@/app/api/agent/v1/status/route");
const { POST: humanCalculate } = await import("@/app/api/calculate/route");
const { GET: humanQuotations } = await import("@/app/api/quotations/route");
const { GET: portalMe } = await import("@/app/api/portal/v1/me/route");
const { GET: portalQuotes } = await import("@/app/api/portal/v1/quotes/route");
const { createUser, closeDatabaseForTest } = await import("@/lib/auth-store");

const originalRateLimit = process.env.AGENT_API_RATE_LIMIT;
const originalRateWindow = process.env.AGENT_API_RATE_WINDOW_SECONDS;
const originalRotationGrace = process.env.AGENT_ROTATION_GRACE_SECONDS;

afterEach(() => {
  if (originalRateLimit === undefined) delete process.env.AGENT_API_RATE_LIMIT;
  else process.env.AGENT_API_RATE_LIMIT = originalRateLimit;
  if (originalRateWindow === undefined) delete process.env.AGENT_API_RATE_WINDOW_SECONDS;
  else process.env.AGENT_API_RATE_WINDOW_SECONDS = originalRateWindow;
  if (originalRotationGrace === undefined) delete process.env.AGENT_ROTATION_GRACE_SECONDS;
  else process.env.AGENT_ROTATION_GRACE_SECONDS = originalRotationGrace;
});

afterAll(async () => {
  await resetAgentAuthForTest();
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function agentRequest(init: RequestInit = {}, token?: string): Request {
  return new Request("https://app.test/api/agent/v1/status", {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function credentialRows(): Promise<Record<string, unknown>[]> {
  const db = await agentAuthDatabaseForTest();
  return db.all<Record<string, unknown>>("SELECT * FROM agent_api_credentials");
}

async function auditRows(operation?: string): Promise<Record<string, unknown>[]> {
  const db = await agentAuthDatabaseForTest();
  return db.all<Record<string, unknown>>(
    operation
      ? "SELECT * FROM agent_audit_events WHERE operation = ? ORDER BY occurred_at, id"
      : "SELECT * FROM agent_audit_events ORDER BY occurred_at, id",
    operation ? [operation] : undefined,
  );
}

describe("Hermes scoped credential and durable audit", () => {
  it("generates one-time 48-byte randomness and stores only its SHA-256 digest", async () => {
    const principal = await ensureAgentPrincipalForTest({ password: "hermes-principal-password" });
    expect(principal.email).toBe(AGENT_PRINCIPAL_EMAIL);
    const issued = await createAgentCredential({
      name: "lifecycle-token",
      scopes: ["calculate:run", "quote:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const randomBytes = Buffer.from(issued.token, "base64url");
    expect(randomBytes.length).toBe(48);
    expect(issued.principalEmail).toBe(AGENT_PRINCIPAL_EMAIL);
    expect(Object.keys(issued)).not.toContain("tokenHash");
    const rows = await credentialRows();
    const row = rows.find((candidate) => candidate.id === issued.credentialId);
    expect(row).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    expect(row?.hash_algorithm).toBe(AGENT_HASH_ALGORITHM);
    expect(row?.token_hash).toBe(createHash("sha256").update(issued.token, "utf8").digest("hex"));
    expect(JSON.parse(String(row?.scopes_json))).toEqual(["calculate:run", "quote:read"]);
    expect(row?.status).toBe("active");
    expect(row?.revoked_at).toBeNull();
    expect(row?.last_used_at).toBeNull();
  });

  it("binds issuance to the exact active non-admin Hermes principal", async () => {
    const admin = await createUser({
      email: "other-admin@agent-auth.test",
      name: "Other Admin",
      password: "other-admin-password",
      role: "admin",
    });
    const inactive = await createUser({
      email: "inactive-person@agent-auth.test",
      name: "Inactive Person",
      password: "inactive-person-password",
      role: "user",
      isActive: false,
    });
    await expect(createAgentCredential({
      name: "wrong principal",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
      userId: admin.id,
    })).rejects.toThrow("agent_principal_mismatch");
    await expect(createAgentCredential({
      name: "inactive principal",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
      userId: inactive.id,
    })).rejects.toThrow("agent_principal_mismatch");
  });

  it("enforces every exact scope and rejects wildcards and extras", async () => {
    const allScopes = await createAgentCredential({
      name: "all-scopes",
      scopes: [...AGENT_API_SCOPES],
      expiresAt: new Date(Date.now() + 60_000),
      includeInternalApproval: true,
    });
    for (const granted of AGENT_API_SCOPES) {
      const allGrant = {
        credentialId: allScopes.credentialId,
        userId: allScopes.userId,
        principalEmail: allScopes.principalEmail,
        name: allScopes.name,
        scopes: allScopes.scopes,
      };
      expect(() => requireAgentScope(allGrant, granted)).not.toThrow();
      for (const denied of AGENT_API_SCOPES.filter((scope) => scope !== granted)) {
        const isolated = { ...allScopes, scopes: [granted] };
        expect(() => requireAgentScope(isolated, denied)).toThrow("agent_scope_denied");
      }
    }
    await expect(createAgentCredential({
      name: "wildcard",
      scopes: ["*"],
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow("wildcard_scope_rejected");
    await expect(createAgentCredential({
      name: "unknown",
      scopes: ["email:send"],
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow("invalid_agent_scopes");
    const internalOnly = await createAgentCredential({
      name: "internal opt-in missing",
      scopes: [...AGENT_API_SCOPES],
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(internalOnly.scopes).not.toContain("internal_approval:request");
  });

  it("accepts a valid credential at the minimal status route and audits success", async () => {
    process.env.AGENT_API_RATE_LIMIT = "100";
    const issued = await createAgentCredential({
      name: "status-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await agentStatus(agentRequest({}, issued.token));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      status: "ok",
      credential: {
        id: issued.credentialId,
        principal: AGENT_PRINCIPAL_EMAIL,
        scopes: ["calculate:run"],
      },
    });
    expect(JSON.stringify(payload)).not.toContain(issued.token);
    const events = await auditRows("credential.status");
    expect(events.at(-1)).toMatchObject({ outcome: "allow", reason: "operation_completed" });
  });

  it("rejects missing, malformed, expired, revoked, wrong-principal, inactive, and admin bindings", async () => {
    const issued = await createAgentCredential({
      name: "failure-matrix",
      scopes: ["quote:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const auth = await authenticateAgentBearer(agentRequest({}, issued.token));
    expect(auth.credentialId).toBe(issued.credentialId);
    const db = await agentAuthDatabaseForTest();

    await expect(authenticateAgentBearer(new Request("https://app.test")))
      .rejects.toThrow("unauthorized_agent");
    await expect(authenticateAgentBearer(agentRequest({}, issued.token.slice(0, 30))))
      .rejects.toThrow("unauthorized_agent");
    await expect(authenticateAgentBearer(agentRequest({}, `!${issued.token.slice(1)}`)))
      .rejects.toThrow("unauthorized_agent");
    await expect(authenticateAgentBearer(agentRequest({}, "a".repeat(43))))
      .rejects.toThrow("unauthorized_agent");

    await db.run("UPDATE agent_api_credentials SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1_000).toISOString(),
      issued.credentialId,
    ]);
    await expect(authenticateAgentBearer(agentRequest({}, issued.token)))
      .rejects.toThrow("unauthorized_agent");
    const expiredReasons = (await auditRows("authentication")).map((event) => event.reason);
    expect(expiredReasons).toContain("credential_expired");

    await db.run("UPDATE agent_api_credentials SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() + 60_000).toISOString(),
      issued.credentialId,
    ]);
    await revokeAgentCredential(issued.credentialId);
    await expect(authenticateAgentBearer(agentRequest({}, issued.token)))
      .rejects.toThrow("unauthorized_agent");
    expect((await auditRows("authentication")).map((event) => event.reason))
      .toContain("credential_revoked");

    const principalCred = await createAgentCredential({
      name: "principal binding",
      scopes: ["quote:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const other = await createUser({
      email: "not-hermes@agent-auth.test",
      name: "Not Hermes",
      password: "not-hermes-password",
      role: "user",
    });
    await db.run("UPDATE agent_api_credentials SET user_id = ?, principal_email = ? WHERE id = ?", [
      other.id,
      other.email,
      principalCred.credentialId,
    ]);
    await expect(authenticateAgentBearer(agentRequest({}, principalCred.token)))
      .rejects.toThrow("unauthorized_agent");

    const principalRow = await db.get<{ id: number }>("SELECT id FROM users WHERE email = ?", [
      AGENT_PRINCIPAL_EMAIL,
    ]);
    await db.run("UPDATE agent_api_credentials SET user_id = ?, principal_email = ? WHERE id = ?", [
      Number(principalRow?.id),
      AGENT_PRINCIPAL_EMAIL,
      principalCred.credentialId,
    ]);
    await db.run("UPDATE users SET role = 'admin' WHERE email = ?", [AGENT_PRINCIPAL_EMAIL]);
    await expect(authenticateAgentBearer(agentRequest({}, principalCred.token)))
      .rejects.toThrow("unauthorized_agent");
    await db.run("UPDATE users SET role = 'user', is_active = 0 WHERE email = ?", [AGENT_PRINCIPAL_EMAIL]);
    await expect(authenticateAgentBearer(agentRequest({}, principalCred.token)))
      .rejects.toThrow("unauthorized_agent");
    await db.run("UPDATE users SET is_active = 1 WHERE email = ?", [AGENT_PRINCIPAL_EMAIL]);
    const reasons = (await auditRows("authentication")).map((event) => String(event.reason));
    expect(reasons).toEqual(expect.arrayContaining([
      "missing_or_malformed_bearer",
      "credential_not_found",
      "credential_expired",
      "credential_revoked",
      "credential_principal_mismatch",
      "credential_principal_admin_rejected",
      "credential_principal_inactive",
    ]));
  });

  it("rotates with no default grace, exposes only the new plaintext, and supports bounded grace", async () => {
    const issued = await createAgentCredential({
      name: "rotate-token",
      scopes: ["quote:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const rotated = await rotateAgentCredential(issued.credentialId, {
      expiresAt: new Date(Date.now() + 120_000),
    });
    expect(rotated.previousStatus).toBe("revoked");
    expect(rotated.previousGraceExpiresAt).toBeNull();
    expect(rotated.credential.token).not.toBe(issued.token);
    await expect(authenticateAgentBearer(agentRequest({}, issued.token)))
      .rejects.toThrow("unauthorized_agent");
    await expect(authenticateAgentBearer(agentRequest({}, rotated.credential.token)))
      .resolves.toMatchObject({ credentialId: rotated.credential.credentialId });

    const grace = await createAgentCredential({
      name: "bounded-grace",
      scopes: ["quote:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    process.env.AGENT_ROTATION_GRACE_SECONDS = "60";
    const withGrace = await rotateAgentCredential(grace.credentialId, {
      graceSeconds: 60,
      expiresAt: new Date(Date.now() + 120_000),
    });
    await expect(authenticateAgentBearer(agentRequest({}, grace.token)))
      .resolves.toMatchObject({ credentialId: grace.credentialId });
    const db = await agentAuthDatabaseForTest();
    await db.run("UPDATE agent_api_credentials SET rotation_grace_expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1_000).toISOString(),
      grace.credentialId,
    ]);
    await expect(authenticateAgentBearer(agentRequest({}, grace.token)))
      .rejects.toThrow("unauthorized_agent");
    expect(withGrace.previousStatus).toBe("rotated");
  });

  it("enforces durable per-credential limits and audits the denial", async () => {
    process.env.AGENT_API_RATE_LIMIT = "1";
    process.env.AGENT_API_RATE_WINDOW_SECONDS = "60";
    const issued = await createAgentCredential({
      name: "rate-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const first = await withAgentApi(
      agentRequest({}, issued.token),
      { operation: "credential.status", scope: "calculate:run" },
      async () => "first",
    );
    expect(first.result).toBe("first");
    const second = await withAgentApi(
      agentRequest({}, issued.token),
      { operation: "credential.status", scope: "calculate:run" },
      async () => "second",
    );
    expect(second.response?.status).toBe(429);
    await expect(second.response?.json()).resolves.toEqual({ error: "agent_rate_limited" });
    const db = await agentAuthDatabaseForTest();
    const limit = await db.get<Record<string, unknown>>(
      "SELECT * FROM agent_api_rate_limits WHERE credential_id = ?",
      [issued.credentialId],
    );
    expect(Number(limit?.request_count)).toBe(2);
    const rateEvents = await auditRows("rate_limit");
    expect(rateEvents.at(-1)).toMatchObject({
      credential_id: issued.credentialId,
      outcome: "deny",
      reason: "agent_rate_limited",
    });
  });

  it("rejects scope denial at the API boundary and records credential attribution", async () => {
    const issued = await createAgentCredential({
      name: "scope-boundary",
      scopes: ["quote:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const outcome = await withAgentApi(
      agentRequest({}, issued.token),
      { operation: "calculate.run", scope: "calculate:run" },
      async () => "not reached",
    );
    expect(outcome.response?.status).toBe(403);
    await expect(outcome.response?.json()).resolves.toEqual({ error: "agent_scope_denied" });
    const events = await auditRows("calculate.run");
    expect(events.at(-1)).toMatchObject({
      credential_id: issued.credentialId,
      principal_email: AGENT_PRINCIPAL_EMAIL,
      outcome: "deny",
      reason: "agent_scope_denied",
      scope: "calculate:run",
    });
  });

  it("keeps agent bearer tokens outside ordinary user-session and portal APIs", async () => {
    const issued = await createAgentCredential({
      name: "boundary-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const loginResponse = await login(new Request("https://app.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@agent-auth.test",
        password: "admin-agent-auth-password",
      }),
    }));
    const humanSession = loginResponse.headers.get("set-cookie")?.match(/pouch_session=([^;]+)/)?.[1];
    expect(humanSession).toBeDefined();
    await expect(userSession(new Request("https://app.test/api/auth/session", {
      headers: { authorization: `Bearer ${issued.token}` },
    }))).resolves.toMatchObject({ status: 401 });
    await expect(userSession(new Request("https://app.test/api/auth/session", {
      headers: { cookie: `pouch_session=${humanSession}`, authorization: `Bearer ${issued.token}` },
    }))).resolves.toMatchObject({ status: 200 });

    const calculate = await humanCalculate(new Request("https://app.test/api/calculate", {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(calculate.status).toBe(401);
    const quotations = await humanQuotations(new Request("https://app.test/api/quotations", {
      headers: { authorization: `Bearer ${issued.token}` },
    }));
    expect(quotations.status).toBe(401);
    await expect(portalMe(new Request("https://app.test/api/portal/v1/me", {
      headers: { authorization: `Bearer ${issued.token}` },
    }))).resolves.toMatchObject({ status: 401 });
    await expect(portalQuotes(new Request("https://app.test/api/portal/v1/quotes", {
      headers: { authorization: `Bearer ${issued.token}` },
    }))).resolves.toMatchObject({ status: 401 });
  });

  it("records hygiene-safe lifecycle/auth/operation events and structurally blocks mutation", async () => {
    const issued = await createAgentCredential({
      name: "audit-token",
      scopes: ["approval_state:read"],
      expiresAt: new Date(Date.now() + 60_000),
      includeInternalApproval: true,
    });
    await agentStatus(agentRequest({}, issued.token));
    const events = await auditRows();
    expect(events.map((event) => String(event.operation))).toEqual(expect.arrayContaining([
      "authentication",
      "credential.create",
      "credential.status",
    ]));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("password");
    const credentialEvents = events.filter((event) => event.credential_id === issued.credentialId);
    for (const event of credentialEvents) {
      expect(event.principal_email).toBe(AGENT_PRINCIPAL_EMAIL);
      expect(event.correlation_id).toBeDefined();
      expect(event.occurred_at).toBeDefined();
      expect(event.outcome).toEqual(expect.stringMatching(/^(allow|deny|error)$/));
      expect(event.reason).toBeDefined();
    }
    const first = events[0];
    const db = await agentAuthDatabaseForTest();
    await expect(db.run("UPDATE agent_audit_events SET reason = ? WHERE id = ?", [
      "modified", first.id,
    ])).rejects.toThrow("agent_audit_events_append_only");
    await expect(db.run("DELETE FROM agent_audit_events WHERE id = ?", [first.id]))
      .rejects.toThrow("agent_audit_events_append_only");
    const unchanged = await db.get<Record<string, unknown>>(
      "SELECT reason FROM agent_audit_events WHERE id = ?",
      [first.id],
    );
    expect(unchanged?.reason).toBe(first.reason);
  });

  it("keeps credential and audit schemas SQLite/PostgreSQL compatible", async () => {
    const schemas = agentAuthSchemas();
    expect(schemas.sqlite).toContain("CREATE TABLE IF NOT EXISTS agent_api_credentials");
    expect(schemas.sqlite).toContain("CREATE TABLE IF NOT EXISTS agent_audit_events");
    expect(schemas.sqlite).toContain("RAISE(ABORT");
    expect(schemas.postgres).toContain("CREATE TABLE IF NOT EXISTS agent_api_credentials");
    expect(schemas.postgres).toContain("CREATE TABLE IF NOT EXISTS agent_audit_events");
    expect(schemas.postgres).toContain("EXECUTE FUNCTION prevent_agent_audit_mutation()");
    expect(schemas.sqlite).not.toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
    const translatedCreate = translateSqlToPostgres(
      "SELECT * FROM agent_api_credentials WHERE token_hash = ? AND expires_at > ?",
    );
    expect(translatedCreate).toBe(
      "SELECT * FROM agent_api_credentials WHERE token_hash = $1 AND expires_at > $2",
    );
  });
});
