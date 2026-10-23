import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import contract from "../contracts/portal-api-v1.json" with { type: "json" };

const databaseDirectory = await mkdtemp(join(tmpdir(), "portal-auth-api-"));
const initialDatabaseUrl = process.env.DATABASE_URL;
const initialPortalToken = process.env.PORTAL_SERVICE_TOKEN;

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotation-service-actor.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "portal-customer.sqlite");
process.env.PORTAL_SERVICE_TOKEN = "portal-route-service-token-at-least-32-chars";

const { getPortalIdentityDatabase, verifyPortalUserAndProvisionCustomer } = await import(
  "@/lib/portal/identity-store"
);
const { handlePortalApiRequest } = await import("@/lib/portal/api-service");

const token = process.env.PORTAL_SERVICE_TOKEN;
const authorization = { authorization: `Bearer ${token}` };
let currentTime = new Date("2026-02-01T00:00:00.000Z");
const sentMail: Array<{ to: string; body: string }> = [];

function now(): Date {
  return new Date(currentTime);
}

function request(
  body?: unknown,
  headers: Record<string, string> = authorization,
): Request {
  return new Request("https://admin.test/api/portal/v1/auth/register", {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function registration(email: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyName: "形状ポーチ株式会社",
    contactName: "検証 太郎",
    postalCode: "150-0001",
    address: "東京都渋谷区神宮前 1-1-1",
    telephone: "03-0000-0000",
    email,
    password: "secure-password-123",
    ...overrides,
  };
}

function uniqueEmail(label: string): string {
  return `${label}-${Math.random().toString(16).slice(2)}@example.test`;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function codeFromMail(): string {
  const latest = sentMail.at(-1);
  expect(latest).toBeDefined();
  const match = latest!.body.match(/確認コード: ([A-Za-z0-9_-]+)/);
  expect(match).toBeTruthy();
  return match![1]!;
}

function fieldNames(value: unknown, prefix = ""): Set<string> {
  const names = new Set<string>();
  if (!value || typeof value !== "object" || value instanceof Date) return names;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    names.add(path);
    for (const nested of fieldNames(child, path)) names.add(nested);
  }
  return names;
}

async function registerVerified(label: string): Promise<{ email: string; code: string }> {
  const email = uniqueEmail(label);
  const response = await handlePortalApiRequest(request(registration(email)), "register", {
    now,
    clientFingerprint: crypto.randomUUID().replaceAll("-", "").repeat(2),
    mailSender: async (message) => {
      sentMail.push(message);
      return {};
    },
  });
  expect(response.status).toBe(201);
  return { email, code: codeFromMail() };
}

function fingerprint(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

async function registerWithEmailAndFingerprint(email: string, client: string): Promise<Response> {
  return await handlePortalApiRequest(request(registration(email), {
    ...authorization,
    "x-portal-client-fingerprint": client,
  }), "register", {
    now,
    mailSender: async () => ({}),
  });
}

beforeAll(async () => {
  await getPortalIdentityDatabase();
});

afterAll(async () => {
  const { resetPortalIdentityStoreForTest } = await import("@/lib/portal/identity-store");
  await resetPortalIdentityStoreForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
  if (initialDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = initialDatabaseUrl;
  if (initialPortalToken === undefined) delete process.env.PORTAL_SERVICE_TOKEN;
  else process.env.PORTAL_SERVICE_TOKEN = initialPortalToken;
});

describe("portal v1 auth API", () => {
  it("uses independent durable account and client rate dimensions", async () => {
    const sharedClient = fingerprint("shared-registration-client");
    const emails = Array.from({ length: 5 }, () => uniqueEmail("bucket-email"));
    for (const email of emails) {
      expect((await registerWithEmailAndFingerprint(email, sharedClient)).status).toBe(201);
    }
    const rotated = uniqueEmail("rotated-email");
    const clientLimited = await registerWithEmailAndFingerprint(rotated, sharedClient);
    expect(clientLimited.status).toBe(429);
    expect(await json(clientLimited)).toEqual({ error: "rate_limited" });

    const db = await getPortalIdentityDatabase();
    const clientRow = await db.get<{ count: number }>(
      "SELECT count FROM portal_rate_limits WHERE bucket_key LIKE ?",
      [`portal-register:client:${sharedClient}:%`],
    );
    expect(Number(clientRow?.count)).toBe(6);
    const accountRows = await db.all<{ count: number }>(`
      SELECT count FROM portal_rate_limits
      WHERE bucket_key LIKE 'portal-register:%'
        AND bucket_key NOT LIKE 'portal-register:client:%'
    `);
    expect(accountRows).toHaveLength(6);
    expect(accountRows.map((row) => Number(row.count))).toEqual([1, 1, 1, 1, 1, 1]);

    const target = emails[0]!;
    for (let index = 0; index < 4; index += 1) {
      const response = await registerWithEmailAndFingerprint(
        target,
        fingerprint(`different-client-${index}`),
      );
      expect(response.status).toBe(409);
    }
    const accountLimited = await registerWithEmailAndFingerprint(
      target,
      fingerprint("different-client-final"),
    );
    expect(accountLimited.status).toBe(429);
    const accountRow = await db.get<{ count: number }>(
      "SELECT count FROM portal_rate_limits WHERE bucket_key LIKE ?",
      [`portal-register:${target}:%`],
    );
    expect(Number(accountRow?.count)).toBe(6);

    const dbBefore = await getPortalIdentityDatabase();
    const unknownBefore = Number((await dbBefore.get<{ count: number }>(
      "SELECT count FROM portal_rate_limits WHERE bucket_key LIKE 'portal-register:client:unknown:%'",
    ))?.count ?? 0);
    const arbitraryHeader = await handlePortalApiRequest(
      request(registration(uniqueEmail("arbitrary-header")), {
        ...authorization,
        "x-portal-client-fingerprint": "browser-supplied-arbitrary-value",
      }),
      "register",
      { now, mailSender: async () => ({}) },
    );
    expect(arbitraryHeader.status).toBe(201);
    const unknownAfter = Number((await dbBefore.get<{ count: number }>(
      "SELECT count FROM portal_rate_limits WHERE bucket_key LIKE 'portal-register:client:unknown:%'",
    ))?.count ?? 0);
    expect(unknownAfter).toBe(unknownBefore + 1);
  });

  it("registers, verifies, provisions a new kanei customer, and returns only safe fields", async () => {
    const email = uniqueEmail("success");
    const registered = await handlePortalApiRequest(
      request(registration(email)),
      "register",
      { now, mailSender: async (message) => { sentMail.push(message); return {}; } },
    );
    expect(registered.status).toBe(201);
    const registeredBody = await json(registered);
    expect(registeredBody).toHaveProperty("user");
    expect(JSON.stringify(registeredBody)).not.toContain(codeFromMail());
    expect(Object.keys(registeredBody as object)).toEqual(["user"]);

    const verifyResponse = await handlePortalApiRequest(
      request({ email, code: codeFromMail() }),
      "verify",
      { now },
    );
    expect(verifyResponse.status).toBe(200);
    const body = await json(verifyResponse);
    const user = body.user as Record<string, unknown>;
    expect(user).toMatchObject({ email, ownerDomain: "kanei", isVerified: true, isActive: true });
    expect(String(user.customerCode)).toMatch(/^K-[23456789A-Z]{10}$/);

    const db = await getPortalIdentityDatabase();
    const customer = await db.get<Record<string, unknown>>(`
      SELECT * FROM customers WHERE owner_domain = 'kanei' AND email = ?
    `, [email]);
    expect(customer).toBeTruthy();
    expect(customer!.customer_code).toBe(user.customerCode);
    expect(customer!.owner_domain).toBe("kanei");

    const { getCustomer } = await import("@/lib/customer-store");
    const customerThroughExistingApi = await getCustomer("kanei", String(user.customerCode));
    expect(customerThroughExistingApi).not.toBeNull();
    expect(customerThroughExistingApi).toMatchObject({
      ownerDomain: "kanei",
      customerCode: user.customerCode,
      customerName: "形状ポーチ株式会社",
      customerContact: "検証 太郎",
      customerEmail: email,
    });

    const forbidden = new Set(contract.forbiddenResponseFields);
    for (const field of fieldNames(body)) {
      expect(forbidden.has(field)).toBe(false);
    }
  });

  it("rejects missing and invalid service-token inputs", async () => {
    const missing = await handlePortalApiRequest(
      request({}, {}),
      "verify",
      { now },
    );
    expect(missing.status).toBe(401);
    expect(await json(missing)).toEqual({ error: "unauthorized" });

    const invalidBody = await handlePortalApiRequest(request({}), "verify", { now });
    expect(invalidBody.status).toBe(400);

    const badRequest = await handlePortalApiRequest(
      request({ email: "not-an-email", code: "bad" }, { authorization: "Bearer wrong-token-32-characters-long!!" }),
      "verify",
      { now },
    );
    expect(badRequest.status).toBe(401);
  });

  it("rejects unknown top-level fields and incomplete registration DTOs", async () => {
    const extra = await handlePortalApiRequest(
      request(registration(uniqueEmail("extra"), { pricingSnapshot: { cost: 1 } })),
      "register",
      { now, mailSender: async () => ({}) },
    );
    expect(extra.status).toBe(400);
    expect(await json(extra)).toEqual({ error: "validation_failed" });

    const partial = await handlePortalApiRequest(
      request({ email: uniqueEmail("partial"), password: "secure-password-123" }),
      "register",
      { now, mailSender: async () => ({}) },
    );
    expect(partial.status).toBe(400);
    expect(contract.registration.request.allowlist).not.toContain("pricingSnapshot");
  });

  it("rejects duplicate registration without revealing or reusing an account", async () => {
    const email = uniqueEmail("duplicate");
    const first = await handlePortalApiRequest(request(registration(email)), "register", {
      now,
      mailSender: async () => ({}),
    });
    expect(first.status).toBe(201);
    const second = await handlePortalApiRequest(request(registration(email)), "register", {
      now,
      mailSender: async () => ({}),
    });
    expect(second.status).toBe(409);
    expect(await json(second)).toEqual({ error: "conflict" });
  });

  it("denies unverified login and the designated service actor", async () => {
    const unverified = await registerVerified("unverified");
    const denied = await handlePortalApiRequest(
      request({ email: unverified.email, password: "secure-password-123" }),
      "login",
      { now },
    );
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: "email_unverified" });

    const serviceActor = await handlePortalApiRequest(
      request({ email: "portal-service@system.invalid", password: "anything-here" }),
      "login",
      { now },
    );
    expect(serviceActor.status).toBe(401);
    expect(await json(serviceActor)).toEqual({ error: "unauthorized" });
  });

  it("rejects wrong and expired codes without consuming the valid code", async () => {
    const first = await registerVerified("wrong");
    const wrong = await handlePortalApiRequest(
      request({ email: first.email, code: "wrong-code" }),
      "verify",
      { now },
    );
    expect(wrong.status).toBe(400);
    expect(await json(wrong)).toEqual({ error: "email_verification_failed" });

    const valid = await handlePortalApiRequest(
      request({ email: first.email, code: first.code }),
      "verify",
      { now },
    );
    expect(valid.status).toBe(200);

    const second = await registerVerified("expired");
    currentTime = new Date(currentTime.getTime() + 25 * 60 * 60 * 1000);
    const expired = await handlePortalApiRequest(
      request({ email: second.email, code: second.code }),
      "verify",
      { now },
    );
    expect(expired.status).toBe(400);
    expect(await json(expired)).toEqual({ error: "email_verification_failed" });
  });

  it("enforces the verification attempt cap", async () => {
    const target = await registerVerified("attempt-cap");
    for (let index = 0; index < 5; index += 1) {
      const wrong = await handlePortalApiRequest(
        request({ email: target.email, code: `wrong-${index}` }),
        "verify",
        { now },
      );
      expect(wrong.status).toBe(400);
    }
    const capped = await handlePortalApiRequest(
      request({ email: target.email, code: target.code }),
      "verify",
      { now },
    );
    expect(capped.status).toBe(429);
    expect(await json(capped)).toEqual({ error: "rate_limited" });
  });

  it("rate-limits resend and observes its cooldown", async () => {
    const target = await registerVerified("resend");
    currentTime = new Date(currentTime.getTime() + 1_000);
    const immediate = await handlePortalApiRequest(request({ email: target.email }), "resend", {
      now,
      mailSender: async (message) => { sentMail.push(message); return {}; },
    });
    expect(immediate.status).toBe(429);

    currentTime = new Date(currentTime.getTime() + 60_000);
    const allowed = await handlePortalApiRequest(request({ email: target.email }), "resend", {
      now,
      mailSender: async (message) => { sentMail.push(message); return {}; },
    });
    expect(allowed.status).toBe(200);
    expect(await json(allowed)).toEqual({ accepted: true });
    expect(codeFromMail()).not.toBe(target.code);

    currentTime = new Date(currentTime.getTime() + 1_000);
    const cooldown = await handlePortalApiRequest(request({ email: target.email }), "resend", {
      now,
      mailSender: async (message) => { sentMail.push(message); return {}; },
    });
    expect(cooldown.status).toBe(429);
  });

  it("supports login, own-profile me, and exact-token logout revocation", async () => {
    const target = await registerVerified("session");
    const verified = await handlePortalApiRequest(
      request({ email: target.email, code: target.code }),
      "verify",
      { now },
    );
    expect(verified.status).toBe(200);

    const login = await handlePortalApiRequest(
      request({ email: target.email, password: "secure-password-123" }),
      "login",
      { now },
    );
    expect(login.status).toBe(200);
    const loginBody = await json(login);
    const session = loginBody.session as Record<string, string>;
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const db = await getPortalIdentityDatabase();
    const stored = await db.all<{ token_hash: string }>(
      "SELECT token_hash FROM portal_sessions",
    );
    expect(JSON.stringify(stored)).not.toContain(session.token);

    const me = await handlePortalApiRequest(request(undefined, {
      ...authorization,
      "x-portal-session-token": session.token,
    }), "me", { now });
    const aliasMe = await handlePortalApiRequest(request(undefined, {
      ...authorization,
      "x-portal-session": session.token,
    }), "me", { now });
    expect(aliasMe.status).toBe(401);
    expect(await json(aliasMe)).toEqual({ error: "session_expired" });
    expect(me.status).toBe(200);
    expect(((await json(me)).user as Record<string, unknown>).email).toBe(target.email);

    const logout = await handlePortalApiRequest(request(undefined, {
      ...authorization,
      "x-portal-session-token": session.token,
    }), "logout", { now });
    expect(logout.status).toBe(200);
    const afterLogout = await handlePortalApiRequest(request(undefined, {
      ...authorization,
      "x-portal-session-token": session.token,
    }), "me", { now });
    expect(afterLogout.status).toBe(401);
    expect(await json(afterLogout)).toEqual({ error: "session_expired" });
  });

  it("isolates profiles by opaque session and rejects missing or invalid sessions", async () => {
    const first = await registerVerified("owner-one");
    const second = await registerVerified("owner-two");
    for (const target of [first, second]) {
      const verified = await handlePortalApiRequest(
        request({ email: target.email, code: target.code }),
        "verify",
        { now },
      );
      expect(verified.status).toBe(200);
    }
    const firstLogin = await handlePortalApiRequest(
      request({ email: first.email, password: "secure-password-123" }), "login", { now });
    const secondLogin = await handlePortalApiRequest(
      request({ email: second.email, password: "secure-password-123" }), "login", { now });
    const firstToken = ((await json(firstLogin)).session as Record<string, string>).token;
    const secondToken = ((await json(secondLogin)).session as Record<string, string>).token;

    const firstMe = await handlePortalApiRequest(request(undefined, {
      ...authorization,
      "x-portal-session-token": firstToken,
    }), "me", { now });
    const secondMe = await handlePortalApiRequest(request(undefined, {
      ...authorization,
      "x-portal-session-token": secondToken,
    }), "me", { now });
    expect(((await json(firstMe)).user as Record<string, unknown>).email).toBe(first.email);
    expect(((await json(secondMe)).user as Record<string, unknown>).email).toBe(second.email);

    const missing = await handlePortalApiRequest(request(undefined, authorization), "me", { now });
    const invalid = await handlePortalApiRequest(request(undefined, {
      ...authorization,
      "x-portal-session-token": `${firstToken}invalid`,
    }), "me", { now });
    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it("retries a collision-safe customer code without consuming verification", async () => {
    const target = await registerVerified("code-conflict");
    const db = await getPortalIdentityDatabase();
    await db.run(`
      INSERT INTO customers (
        owner_domain,customer_code,customer_name,postal_code,address,contact,telephone,email,
        created_at,updated_at
      ) VALUES ('kanei','K-CONFLICT1','既存','','','','','',?,?)
    `, [currentTime.toISOString(), currentTime.toISOString()]);

    let calls = 0;
    const result = await verifyPortalUserAndProvisionCustomer(
      { email: target.email, code: target.code, now: currentTime },
      {
        generateCustomerCode: () => {
          calls += 1;
          return calls === 1 ? "K-CONFLICT1" : "K-UNIQUE123";
        },
      },
    );
    expect(calls).toBe(2);
    expect(result.customerCode).toBe("K-UNIQUE123");
    const verification = await db.get<{ consumed_at: string | null }>(`
      SELECT consumed_at FROM portal_email_verifications WHERE email = ?
    `, [target.email]);
    expect(verification!.consumed_at).not.toBeNull();
  });

  it("rolls back customer creation and linking when a post-insert failure occurs", async () => {
    const target = await registerVerified("rollback");
    const db = await getPortalIdentityDatabase();
    await db.exec(`
      CREATE TRIGGER force_portal_link_failure
      AFTER UPDATE ON portal_users
      WHEN NEW.is_verified = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced_portal_link_failure');
      END
    `);
    await expect(verifyPortalUserAndProvisionCustomer({
      email: target.email,
      code: target.code,
      now: currentTime,
    })).rejects.toThrow("forced_portal_link_failure");
    await db.exec("DROP TRIGGER force_portal_link_failure");

    const customer = await db.get<Record<string, unknown>>(
      "SELECT * FROM customers WHERE email = ?",
      [target.email],
    );
    const user = await db.get<Record<string, unknown>>(
      "SELECT is_verified,customer_code FROM portal_users WHERE email = ?",
      [target.email],
    );
    const verification = await db.get<{ attempts: number; consumed_at: string | null }>(`
      SELECT attempts,consumed_at FROM portal_email_verifications WHERE email = ?
    `, [target.email]);
    expect(customer).toBeUndefined();
    expect(Number(user!.is_verified)).toBe(0);
    expect(user!.customer_code).toBe("");
    expect(Number(verification!.attempts)).toBe(0);
    expect(verification!.consumed_at).toBeNull();

    const recovered = await verifyPortalUserAndProvisionCustomer({
      email: target.email,
      code: target.code,
      now: currentTime,
    });
    expect(recovered.isVerified).toBe(true);
  });

  it("gives two verified users distinct customer codes", async () => {
    const first = await registerVerified("unique-one");
    const second = await registerVerified("unique-two");
    const firstUser = await verifyPortalUserAndProvisionCustomer({
      email: first.email,
      code: first.code,
      now: currentTime,
    });
    const secondUser = await verifyPortalUserAndProvisionCustomer({
      email: second.email,
      code: second.code,
      now: currentTime,
    });
    expect(firstUser.customerCode).toMatch(/^K-[23456789A-Z]{10}$/);
    expect(secondUser.customerCode).toMatch(/^K-[23456789A-Z]{10}$/);
    expect(firstUser.customerCode).not.toBe(secondUser.customerCode);
  });

  it("keeps raw confirmation codes out of production responses", async () => {
    const target = await registerVerified("secret-response");
    const registered = await handlePortalApiRequest(request(registration(target.email)), "register", {
      now,
      mailSender: async (message) => { sentMail.push(message); return {}; },
    });
    expect(JSON.stringify(await json(registered))).not.toContain(target.code);
    const verified = await handlePortalApiRequest(
      request({ email: uniqueEmail("secret-unrelated"), code: target.code }),
      "verify",
      { now },
    );
    expect(JSON.stringify(await json(verified))).not.toContain(target.code);
  });
});
