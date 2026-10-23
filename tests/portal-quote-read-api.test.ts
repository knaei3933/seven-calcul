import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import contract from "../contracts/portal-api-v1.json" with { type: "json" };

const databaseDirectory = await mkdtemp(join(tmpdir(), "portal-quote-read-"));
const previous = {
  adminEmail: process.env.ADMIN_EMAIL,
  adminName: process.env.ADMIN_NAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  databaseUrl: process.env.DATABASE_URL,
  postgresUrl: process.env.POSTGRES_URL,
  portalToken: process.env.PORTAL_SERVICE_TOKEN,
};
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.ADMIN_EMAIL = "admin@portal-quote-read.test";
process.env.ADMIN_PASSWORD = "admin-portal-read-password";
process.env.ADMIN_NAME = "Portal Read Admin";
process.env.PORTAL_SERVICE_TOKEN = "portal-quote-read-service-token-at-least-32";
process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = "false";

const {
  authenticatePortalSession,
  createPortalEmailVerificationWithCooldown,
  createPortalSession,
  createPortalUser,
  getPortalIdentityDatabase,
  verifyPortalUserAndProvisionCustomer,
} = await import("@/lib/portal/identity-store");
const { calculatePortalQuote } = await import("@/lib/portal/quote-calculation");
const { getPortalQuoteDatabaseForTest } = await import("@/lib/portal/quote-calculation-store");
const {
  getPortalQuoteApi,
  listPortalQuotesApi,
} = await import("@/lib/portal/quote-list-api");

const token = process.env.PORTAL_SERVICE_TOKEN;
const authorization = { authorization: `Bearer ${token}` };
let currentTime = new Date("2026-10-23T02:00:00.000Z");
let userSequence = 0;

interface TestUser {
  id: number;
  email: string;
  customerCode: string;
  token: string;
}

function now(): Date {
  return new Date(currentTime);
}

function advanceSeconds(seconds = 1): void {
  currentTime = new Date(currentTime.getTime() + seconds * 1000);
}

function headersFor(user: TestUser): Record<string, string> {
  return {
    ...authorization,
    "x-portal-client-fingerprint": user.id.toString().padStart(64, "0"),
    "x-portal-session-token": user.token,
  };
}

function listRequest(
  user: TestUser,
  query = "",
  requestHeaders: Record<string, string> = headersFor(user),
): Request {
  return new Request(`https://admin.test/api/portal/v1/quotes${query}`, {
    headers: requestHeaders,
  });
}

function detailRequest(
  user: TestUser,
  publicId: string,
  requestHeaders: Record<string, string> = headersFor(user),
): Request {
  return new Request(`https://admin.test/api/portal/v1/quotes/${publicId}`, {
    headers: requestHeaders,
  });
}

interface ListBody {
  quotes: Array<Record<string, unknown>>;
  pagination: { nextCursor: string | null; hasMore: boolean };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function listBody(response: Response): Promise<ListBody> {
  return await response.json() as ListBody;
}

async function createVerifiedUser(label: string, customerCode: string): Promise<TestUser> {
  advanceSeconds();
  const email = `${label}-${++userSequence}-${Math.random().toString(16).slice(2)}@example.test`;
  await createPortalUser({
    email,
    password: "secure-portal-password",
    companyName: `${label}株式会社`,
    contactName: "ポータル太郎",
    customerCode,
    ownerDomain: "kanei",
  });
  const verification = await createPortalEmailVerificationWithCooldown({
    email,
    ttlSeconds: 24 * 60 * 60,
    maxAttempts: 5,
    cooldownSeconds: 1,
    now: now(),
  });
  const verified = await verifyPortalUserAndProvisionCustomer({
    email,
    code: verification.code,
    now: now(),
  });
  advanceSeconds();
  const session = await createPortalSession(verified.id, { now: now() });
  return {
    id: verified.id,
    email,
    customerCode: verified.customerCode,
    token: session.token,
  };
}

function calculationBody(idempotencyKey: string): Record<string, unknown> {
  return {
    idempotencyKey,
    productName: `閲覧テスト ${idempotencyKey}`,
    sizeKey: "round-50x60",
    fillMlPerChamber: "3",
    connectedChambers: 1,
    fillingMethod: "hopper",
    fillingLanes: 4,
    printingMethod: "digital",
    quantity: "10000",
    deliveryDate: "別途相談",
    notes: "ポータル閲覧APIテスト",
  };
}

async function createQuote(user: TestUser, idempotencyKey: string): Promise<Record<string, unknown>> {
  advanceSeconds();
  const response = await calculatePortalQuote(new Request(
    "https://admin.test/api/portal/v1/quotes/calculate",
    {
      method: "POST",
      headers: { ...headersFor(user), "content-type": "application/json" },
      body: JSON.stringify(calculationBody(idempotencyKey)),
    },
  ));
  expect(response.status).toBe(201);
  return await body(response);
}

const projectionAllowlist = new Set([
  ...contract.customerSafeQuoteProjection.allowlist,
  "availability",
] as string[]);
const forbiddenKeys = new Set([
  ...contract.forbiddenResponseFields,
  "id",
  "quotationId",
  "portalUserId",
  "userId",
  "customerId",
  "status",
  "approvalState",
  "internalStatus",
  "staffComments",
] as string[]);

function assertSafeProjection(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeProjection(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(forbiddenKeys.has(key)).toBe(false);
    expect(key).not.toMatch(/(^|_)(id|quotation_id|portal_user_id)$/i);
    assertSafeProjection(child, path ? `${path}.${key}` : key);
  }
}

async function detailPublicId(user: TestUser): Promise<string> {
  const response = await listPortalQuotesApi(listRequest(user, "?limit=1"));
  expect(response.status).toBe(200);
  const value = await body(response);
  const quotes = value.quotes as Array<Record<string, unknown>>;
  return String(quotes[0]!.publicId);
}

let owner: TestUser;
let foreignUser: TestUser;
let unverifiedUser: TestUser;
let newestQuote: Record<string, unknown>;
let newestPublicId: string;

beforeAll(async () => {
  await getPortalIdentityDatabase();
  // In a fresh test database, the service actor occupies quotation-store id 1.
  // Reserve portal_users id 1 with an unused account so actual test IDs do not
  // collide with that unrelated internal actor id when sessions are issued.
  await createPortalUser({
    email: "warmup@example.test",
    password: "secure-portal-password",
    companyName: "準備株式会社",
    contactName: "準備太郎",
    customerCode: "PREADWARMUP",
    ownerDomain: "kanei",
  });
  await createPortalUser({
    email: "warmup-two@example.test",
    password: "secure-portal-password",
    companyName: "準備二株式会社",
    contactName: "準備太郎",
    customerCode: "PREADWARMUP2",
    ownerDomain: "kanei",
  });
  owner = await createVerifiedUser("owner", "PREADOWNER");
  foreignUser = await createVerifiedUser("foreign", "PREADFOREIGN");
  const unverified = await createPortalUser({
    email: `unverified-${Math.random().toString(16).slice(2)}@example.test`,
    password: "secure-portal-password",
    companyName: "未認証株式会社",
    contactName: "未認証太郎",
    customerCode: "PREADUNVERIFIED",
    ownerDomain: "kanei",
  });
  // Portal sessions are normally issued only after verification. Issue this
  // fixture token directly so the API is actually exercised with an
  // authenticated-format but unverified account.
  const unverifiedToken = randomBytes(32).toString("base64url");
  const portalDb = await getPortalIdentityDatabase();
  await portalDb.run(`
    INSERT INTO portal_sessions (
      portal_user_id,token_hash,expires_at,created_ip_hash,created_user_agent,created_at
    ) VALUES (?,?,?,?,?,?)
  `, [
    unverified.id,
    createHash("sha256").update(unverifiedToken).digest("hex"),
    new Date(currentTime.getTime() + 60 * 60 * 1000).toISOString(),
    "127.0.0.1",
    "portal-quote-read-test",
    now().toISOString(),
  ]);
  unverifiedUser = {
    id: unverified.id,
    email: unverified.email,
    customerCode: unverified.customerCode,
    token: unverifiedToken,
  };

  for (let index = 1; index <= 3; index += 1) {
    await createQuote(owner, `read-${index}`);
  }
  await createQuote(foreignUser, `foreign-${Math.random().toString(16).slice(2)}`);
  newestQuote = await createQuote(owner, "read-newest");
  newestPublicId = String(newestQuote.publicId);
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
  if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.databaseUrl;
  if (previous.postgresUrl === undefined) delete process.env.POSTGRES_URL;
  else process.env.POSTGRES_URL = previous.postgresUrl;
  if (previous.adminEmail === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = previous.adminEmail;
  if (previous.adminName === undefined) delete process.env.ADMIN_NAME;
  else process.env.ADMIN_NAME = previous.adminName;
  if (previous.adminPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previous.adminPassword;
  if (previous.portalToken === undefined) delete process.env.PORTAL_SERVICE_TOKEN;
  else process.env.PORTAL_SERVICE_TOKEN = previous.portalToken;
});

describe("portal own-quote read APIs", () => {
  it("requires the service token and a valid verified portal session", async () => {
    const publicId = await detailPublicId(owner);
    const missingServiceList = await listPortalQuotesApi(listRequest(owner, "", {
      "x-portal-session-token": owner.token,
    }));
    const missingSessionList = await listPortalQuotesApi(listRequest(owner, "", authorization));
    const malformedSessionList = await listPortalQuotesApi(listRequest(owner, "", {
      ...authorization,
      "x-portal-session-token": "short",
    }));
    const unverifiedList = await listPortalQuotesApi(listRequest(unverifiedUser));
    const unverifiedDetail = await getPortalQuoteApi(detailRequest(unverifiedUser, publicId), publicId);
    const missingSessionDetail = await getPortalQuoteApi(
      detailRequest(owner, publicId, authorization),
      publicId,
    );

    expect(missingServiceList.status).toBe(401);
    expect(missingSessionList.status).toBe(401);
    expect(malformedSessionList.status).toBe(401);
    expect(unverifiedList.status).toBe(401);
    expect(unverifiedDetail.status).toBe(401);
    expect(missingSessionDetail.status).toBe(401);
    for (const response of [
      missingServiceList,
      missingSessionList,
      malformedSessionList,
      unverifiedList,
      unverifiedDetail,
    ]) {
      expect(await body(response)).toEqual({ error: "unauthorized" });
    }
  });

  it("accepts only the canonical session header for owned quote reads", async () => {
    const user = await createVerifiedUser("read-header", "PREADHEADER");
    const quote = await createQuote(user, "read-header-key");
    const publicId = String(quote.publicId);
    const aliasHeaders = {
      ...authorization,
      "x-portal-session": user.token,
    };

    const aliasList = await listPortalQuotesApi(listRequest(user, "", aliasHeaders));
    const aliasDetail = await getPortalQuoteApi(detailRequest(user, publicId, aliasHeaders), publicId);
    expect(aliasList.status).toBe(401);
    expect(aliasDetail.status).toBe(401);
    expect(await listBody(aliasList)).toEqual({ error: "unauthorized" });
    expect(await body(aliasDetail)).toEqual({ error: "unauthorized" });

    const canonicalList = await listPortalQuotesApi(listRequest(user));
    const canonicalDetail = await getPortalQuoteApi(detailRequest(user, publicId), publicId);
    expect(canonicalList.status).toBe(200);
    expect(canonicalDetail.status).toBe(200);
    expect((await listBody(canonicalList)).quotes).toHaveLength(1);
    expect(await body(canonicalDetail)).toMatchObject({
      quote: {
        publicId,
        productName: quote.productName,
        quantity: quote.quantity,
        displayedGrandTotal: quote.displayedGrandTotal,
      },
    });
  });

  it("returns an empty own list without requiring prior quotes", async () => {
    const emptyOwner = await createVerifiedUser("empty", "PREADEMPTY");
    const response = await listPortalQuotesApi(listRequest(emptyOwner));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      quotes: [],
      pagination: { nextCursor: null, hasMore: false },
    });
  });

  it("returns the owner's newest-first list and follows safe server-side pagination", async () => {
    const first = await listPortalQuotesApi(listRequest(owner, "?limit=2"));
    expect(first.status).toBe(200);
    const firstBody = await listBody(first);
    const quotes = firstBody.quotes as Array<Record<string, unknown>>;
    expect(quotes).toHaveLength(2);
    expect(quotes[0]!.publicId).toBe(newestPublicId);
    expect(firstBody.pagination).toEqual({ hasMore: true, nextCursor: expect.any(String) });
    expect(typeof firstBody.pagination!.nextCursor).toBe("string");

    const cursor = encodeURIComponent(firstBody.pagination.nextCursor!);
    const second = await listPortalQuotesApi(listRequest(owner, `?limit=2&cursor=${cursor}`));
    expect(second.status).toBe(200);
    const secondBody = await listBody(second);
    const secondQuotes = secondBody.quotes as Array<Record<string, unknown>>;
    expect(secondQuotes).toHaveLength(2);
    expect(secondQuotes.some((quote) => quote.publicId === newestPublicId)).toBe(false);
    expect(new Set([...quotes, ...secondQuotes].map((quote) => quote.publicId)).size).toBe(4);
    expect(secondBody.pagination).toEqual({ hasMore: false, nextCursor: null });

    for (const response of await Promise.all([
      listPortalQuotesApi(listRequest(owner, "?limit=0")),
      listPortalQuotesApi(listRequest(owner, "?limit=101")),
      listPortalQuotesApi(listRequest(owner, "?limit=nope")),
      listPortalQuotesApi(listRequest(owner, "?cursor=malformed")),
    ])) {
      expect(response.status).toBe(400);
      expect(await body(response)).toEqual({ error: "validation_failed" });
    }
  });

  it("returns one owner-safe detail and isolates foreign/public ids as not-found", async () => {
    const own = await getPortalQuoteApi(detailRequest(owner, newestPublicId), newestPublicId);
    expect(own.status).toBe(200);
    const ownBody = await body(own);
    const quote = ownBody.quote as Record<string, unknown>;
    expect(quote).toMatchObject({
      publicId: newestPublicId,
      productName: newestQuote.productName,
      quantity: newestQuote.quantity,
      pdfAvailability: "unavailable",
      availability: "active",
    });
    expect(quote).toMatchObject({
      quotationNumber: newestQuote.quotationNumber,
      issueDate: newestQuote.issueDate,
      productName: newestQuote.productName,
      quantity: newestQuote.quantity,
      displayedGrandTotal: newestQuote.displayedGrandTotal,
      notes: newestQuote.notes,
    });

    const foreignOwn = await getPortalQuoteApi(
      detailRequest(foreignUser, newestPublicId),
      newestPublicId,
    );
    expect(foreignOwn.status).toBe(404);
    expect(await body(foreignOwn)).toEqual({ error: "not_found" });
    expect(await getPortalQuoteApi(
      detailRequest(owner, "00000000-0000-4000-8000-000000000000"),
      "00000000-0000-4000-8000-000000000000",
    ).then((response) => response.status)).toBe(404);

    const foreignList = await listPortalQuotesApi(listRequest(foreignUser));
    expect(foreignList.status).toBe(200);
    const foreignQuotes = (await body(foreignList)).quotes as Array<Record<string, unknown>>;
    expect(foreignQuotes).toHaveLength(1);
    expect(foreignQuotes[0]!.publicId).not.toBe(newestPublicId);
  });

  it("exposes only the centralized customer-safe projection", async () => {
    const list = await listPortalQuotesApi(listRequest(owner, "?limit=100"));
    const listBody = await body(list);
    assertSafeProjection(listBody);
    for (const quote of listBody.quotes as Array<Record<string, unknown>>) {
      expect(new Set(Object.keys(quote))).toEqual(projectionAllowlist);
    }
    const detail = await getPortalQuoteApi(detailRequest(owner, newestPublicId), newestPublicId);
    const quote = ((await body(detail)).quote as Record<string, unknown>);
    expect(new Set(Object.keys(quote))).toEqual(projectionAllowlist);
    assertSafeProjection(quote);

    const db = await getPortalQuoteDatabaseForTest();
    const mapping = await db.get<Record<string, unknown>>(
      "SELECT * FROM portal_quote_mappings WHERE public_id = ?",
      [newestPublicId],
    );
    expect(mapping).toMatchObject({
      portal_user_id: owner.id,
      owner_domain: "kanei",
      customer_code: owner.customerCode,
      source: "customer_portal",
    });
    expect(JSON.stringify(quote)).not.toContain("payload_json");
    expect(JSON.stringify(quote)).not.toContain("result_hash");
    expect(JSON.stringify(quote)).not.toContain('"quotation_id"');
    expect(JSON.stringify(quote)).not.toContain('"portal_user_id"');
  });

  it("keeps an expired quote readable and reports only the safe availability wording", async () => {
    const db = await getPortalQuoteDatabaseForTest();
    const publicId = await detailPublicId(owner);
    await db.run("UPDATE quotations SET valid_until = ? WHERE id = (SELECT quotation_id FROM portal_quote_mappings WHERE public_id = ?)", [
      "2026-01-01",
      publicId,
    ]);
    const detail = await getPortalQuoteApi(detailRequest(owner, publicId), publicId);
    expect(detail.status).toBe(200);
    const quote = (await body(detail)).quote as Record<string, unknown>;
    expect(quote.validUntil).toBe("2026-01-01");
    expect(quote.availability).toBe("expired");
    expect(quote).not.toHaveProperty("status");
  });

  it("derives customer PDF availability from persisted canonical PDF bytes", async () => {
    const publicId = await detailPublicId(owner);
    const quotationDb = await (await import("@/lib/db")).getSqlClient("quotations");
    await quotationDb.run(
      "UPDATE quotations SET pdf_data = ? WHERE id = (SELECT quotation_id FROM portal_quote_mappings WHERE public_id = ?)",
      [Buffer.from("%PDF-1.7\ntruthful"), publicId],
    );
    const detail = await getPortalQuoteApi(detailRequest(owner, publicId), publicId);
    const quote = (await body(detail)).quote as Record<string, unknown>;
    expect(quote.pdfAvailability).toBe("available");
    expect(quote.availability).toBe("expired");
    expect(quote).not.toHaveProperty("status");
  });

  it("converts query failures into a generic response without leaking internals", async () => {
    const databaseError = new Error("secret table/column failure");
    const listFailure = await listPortalQuotesApi(listRequest(owner), {
      authenticateSession: (async () => authenticatePortalSession(owner.token, { now: now() })) as unknown as typeof authenticatePortalSession,
      incrementRateLimit: async () => ({ count: 1, windowStartedAt: now().toISOString(), expiresAt: now().toISOString() }),
      listQuotes: async () => {
        throw databaseError;
      },
    });
    const detailFailure = await getPortalQuoteApi(detailRequest(owner, newestPublicId), newestPublicId, {
      authenticateSession: (async () => authenticatePortalSession(owner.token, { now: now() })) as unknown as typeof authenticatePortalSession,
      incrementRateLimit: async () => ({ count: 1, windowStartedAt: now().toISOString(), expiresAt: now().toISOString() }),
      findQuote: async () => {
        throw databaseError;
      },
    });
    expect(listFailure.status).toBe(500);
    expect(detailFailure.status).toBe(500);
    expect(await body(listFailure)).toEqual({ error: "internal_error" });
    expect(await body(detailFailure)).toEqual({ error: "internal_error" });
  });

  it("uses durable rate limits after authentication", async () => {
    const rateDb = await getPortalIdentityDatabase();
    const durableList = await rateDb.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM portal_rate_limits WHERE bucket_key LIKE 'portal-quote-list:%'",
    );
    const durableDetail = await rateDb.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM portal_rate_limits WHERE bucket_key LIKE 'portal-quote-detail:%'",
    );
    expect(Number(durableList?.count)).toBeGreaterThan(0);
    expect(Number(durableDetail?.count)).toBeGreaterThan(0);
    const clientRows = await rateDb.all<{ bucket_key: string }>(`
      SELECT bucket_key FROM portal_rate_limits
      WHERE bucket_key LIKE 'portal-quote-list:%client:%'
        OR bucket_key LIKE 'portal-quote-detail:%client:%'
    `);
    expect(clientRows.length).toBeGreaterThanOrEqual(2);
    let calls = 0;
    const limited = await listPortalQuotesApi(listRequest(owner), {
      authenticateSession: (async () => authenticatePortalSession(owner.token, { now: now() })) as unknown as typeof authenticatePortalSession,
      incrementRateLimit: async () => {
        calls += 1;
        return { count: 61, windowStartedAt: now().toISOString(), expiresAt: now().toISOString() };
      },
    });
    expect(calls).toBe(1);
    expect(limited.status).toBe(429);
    expect(await body(limited)).toEqual({ error: "rate_limited" });
  });

  it("keeps the verified session resolver usable by the API and preserves G004 detail equality", async () => {
    const user = await authenticatePortalSession(owner.token, { now: now() });
    expect(user).toMatchObject({
      id: owner.id,
      customerCode: owner.customerCode,
      ownerDomain: "kanei",
      isVerified: true,
      isActive: true,
    });
    const detail = await getPortalQuoteApi(detailRequest(owner, newestPublicId), newestPublicId);
    const quote = (await body(detail)).quote as Record<string, unknown>;
    expect(quote).toMatchObject({
      publicId: newestPublicId,
      quotationNumber: newestQuote.quotationNumber,
      productName: newestQuote.productName,
      quantity: newestQuote.quantity,
    });
  });
});
