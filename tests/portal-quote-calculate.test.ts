import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import contract from "../contracts/portal-api-v1.json" with { type: "json" };
import type { SqlClient } from "@/lib/db";

const databaseDirectory = await mkdtemp(join(tmpdir(), "portal-quote-calculate-"));
const previous = {
  adminEmail: process.env.ADMIN_EMAIL,
  adminName: process.env.ADMIN_NAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  databaseUrl: process.env.DATABASE_URL,
  gravure: process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED,
  postgresUrl: process.env.POSTGRES_URL,
  portalToken: process.env.PORTAL_SERVICE_TOKEN,
};
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.ADMIN_EMAIL = "admin@portal-quote.test";
process.env.ADMIN_PASSWORD = "admin-portal-password";
process.env.ADMIN_NAME = "Portal Admin";
process.env.PORTAL_SERVICE_TOKEN = "portal-quote-service-token-at-least-32-chars";
process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = "true";

const {
  createPortalEmailVerificationWithCooldown,
  createPortalSession,
  createPortalUser,
  getPortalIdentityDatabase,
  getPortalServiceActorId,
  verifyPortalUserAndProvisionCustomer,
} = await import("@/lib/portal/identity-store");
const {
  createPortalQuoteWithMapping,
  getPortalQuoteDatabaseForTest,
  PortalQuoteIdempotencyConflictError,
  resetPortalQuoteStoreForTest,
} = await import("@/lib/portal/quote-calculation-store");
const { calculatePortalQuote } = await import("@/lib/portal/quote-calculation");
const { calculatePouchCost } = await import("@/lib/calculation");
const { upsertFilmPrice } = await import("@/lib/film-price-store");

const token = process.env.PORTAL_SERVICE_TOKEN;
const authorization = { authorization: `Bearer ${token}` };
let currentTime = new Date("2026-10-23T01:23:45.000Z");
const users: Array<{ id: number; email: string; customerCode: string; token: string }> = [];
let userSequence = 0;

function now(): Date {
  return new Date(currentTime);
}

function nextTime(seconds = 1): void {
  currentTime = new Date(currentTime.getTime() + seconds * 1000);
}

function requestBody(overrides: Record<string, unknown> = {}, remove: string[] = []): Record<string, unknown> {
  const value: Record<string, unknown> = {
    idempotencyKey: `digital-${users.length}-${Math.random().toString(16).slice(2)}`,
    productName: "ポータル見積パウチ",
    sizeKey: "round-50x60",
    fillMlPerChamber: "3",
    connectedChambers: 1,
    fillingMethod: "hopper",
    fillingLanes: 4,
    printingMethod: "digital",
    quantity: "10000",
    deliveryDate: "別途相談",
    notes: "ポータルからの見積り",
    ...overrides,
  };
  for (const key of remove) delete value[key];
  return value;
}

function request(body: unknown, remove: string[] = [], headers: Record<string, string> = authorization): Request {
  return new Request("https://admin.test/api/portal/v1/quotes/calculate", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authRequest(user: { token: string }, body: unknown, remove: string[] = []): Request {
  return request(body, remove, authFor(user));
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function createVerifiedUser(label: string, customerCode: string): Promise<{ id: number; email: string; customerCode: string; token: string }> {
  const email = `${label}-${++userSequence}-${Math.random().toString(16).slice(2)}@example.test`;
  const password = "secure-portal-password";
  const created = await createPortalUser({
    email,
    password,
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
  const verified = await verifyPortalUserAndProvisionCustomer({ email, code: verification.code, now: now() });
  const session = await createPortalSession(verified.id, { now: now() });
  const user = { id: verified.id, email, customerCode: verified.customerCode, token: session.token };
  users.push(user);
  void created;
  return user;
}

function authFor(user: { id?: number; token: string }): Record<string, string> {
  return {
    ...authorization,
    "x-portal-client-fingerprint": String(user.id ?? 0).padStart(64, "0"),
    "x-portal-session-token": user.token,
  };
}

async function counts(): Promise<{ quotations: number; mappings: number }> {
  const db = await getPortalQuoteDatabaseForTest();
  const quotationRow = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quotations WHERE customer_name LIKE '%株式会社'");
  const mappingRow = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM portal_quote_mappings");
  return { quotations: Number(quotationRow?.count ?? 0), mappings: Number(mappingRow?.count ?? 0) };
}

function assertCustomerSafe(body: Record<string, unknown>): void {
  const allowed = contract.customerSafeQuoteProjection.allowlist as readonly string[];
  expect(Object.keys(body).every((key) => allowed.includes(key))).toBe(true);
  expect(body.publicId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.quotationNumber).toMatch(/^KT-202610-\d{3}$/);
  expect(body.issueDate).toBe("2026-10-23");
  expect(body.validUntil).toBe("2026-11-22");
  expect(body.pdfAvailability).toBe("unavailable");
  expect(Number(body.displayedGrandTotal)).toBe(Number(body.displayedSubtotal) + Number(body.displayedTax));
  const forbiddenKeys = new Set(contract.forbiddenResponseFields);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      expect(forbiddenKeys.has(key)).toBe(false);
      visit(child);
    }
  };
  visit(body);
  const serialized = JSON.stringify(body);
  for (const forbidden of ["payloadJson", "resultHash", "internalQuotationId", "targetMargin", "successFee"]) {
    expect(serialized).not.toContain(`"${forbidden}"`);
  }
}

beforeAll(async () => {
  await getPortalIdentityDatabase();
});

afterAll(async () => {
  await resetPortalQuoteStoreForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
  if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.databaseUrl;
  if (previous.postgresUrl === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = previous.postgresUrl;
  if (previous.adminEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previous.adminEmail;
  if (previous.adminName === undefined) delete process.env.ADMIN_NAME; else process.env.ADMIN_NAME = previous.adminName;
  if (previous.adminPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previous.adminPassword;
  if (previous.portalToken === undefined) delete process.env.PORTAL_SERVICE_TOKEN; else process.env.PORTAL_SERVICE_TOKEN = previous.portalToken;
  if (previous.gravure === undefined) delete process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED; else process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = previous.gravure;
});

describe("portal quote calculation G004", () => {
  it("rejects missing, malformed, and wrong service tokens before creating quotes", async () => {
    const user = await createVerifiedUser("token-denied", "PTOKEN");
    const before = await counts();
    for (const headers of [{} as Record<string, string>, { authorization: "Basic no" }, { authorization: `Bearer wrong-${token}` }]) {
      const response = await calculatePortalQuote(request(requestBody({}, ["idempotencyKey"]), [], headers));
      expect(response.status).toBe(401);
      expect(await json(response)).toEqual({ error: "unauthorized" });
    }
    void user;
    expect(await counts()).toEqual(before);
  });

  it("rejects invalid and unverified portal sessions", async () => {
    const invalid = await calculatePortalQuote(request(requestBody(), [], {
      ...authorization,
      "x-portal-session-token": "invalid-session-token-value-0123456789",
    }));
    expect(invalid.status).toBe(401);
    const email = `unverified-${Math.random().toString(16).slice(2)}@example.test`;
    await createPortalUser({
      email,
      password: "secure-portal-password",
      companyName: "未認証株式会社",
      contactName: "未認証",
      customerCode: "PUNVERIFIED",
      ownerDomain: "kanei",
    });
    await expect(createPortalSession((await (await import("@/lib/portal/identity-store")).getPortalUserByEmail(email))!.id, { now: now() }))
      .rejects.toThrow("portal_service_login_forbidden");
    const before = await counts();
    expect(await counts()).toEqual(before);
  });

  it("rejects unknown fields and every named pricing-authority field before calculation", async () => {
    const user = await createVerifiedUser("authority", "PAUTHORITY");
    const authorityFields = contract.quoteCalculation.pricingAuthorityDenial.deniedFields;
    const unknownResponse = await calculatePortalQuote(
      authRequest(user, requestBody({ unknownTopLevel: true })),
    );
    expect(unknownResponse.status).toBe(400);
    expect(await json(unknownResponse)).toEqual({
      error: "validation_failed",
      fieldErrors: { _request: "許可されていない入力項目が含まれています。" },
    });
    const bodies = [
      requestBody({ skus: [{ name: "SKU", quantity: "10000", fillMlPerChamber: "3", colorCount: 1, bulkUnitPrice: "1" }] }),
      requestBody({ parameters: {} }),
      requestBody({ parameters: { filmUnitPrices: {} } }),
    ];
    for (const field of authorityFields.slice(2)) bodies.push(requestBody({ [field]: field === "gravureYRows" ? [] : field === "ySupplierRows" ? [] : field === "pricingSnapshot" ? {} : "x" }));
    for (const body of bodies) {
      const response = await calculatePortalQuote(authRequest(user, body));
      expect(response.status).toBe(400);
      expect(await json(response)).toEqual({
        error: "pricing_authority_rejected",
        fieldErrors: { _request: "価格設定情報は送信できません。" },
      });
    }
    expect(await counts()).toEqual({ quotations: 0, mappings: 0 });
  });

  it("returns Japanese field errors for malformed business input", async () => {
    const user = await createVerifiedUser("validation", "PVALID");
    const response = await calculatePortalQuote(request(requestBody({ quantity: "0" }), [], authFor(user)));
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toBe("validation_failed");
    expect((body.fieldErrors as Record<string, string>).quantity).toContain("数量は");
    expect(await counts()).toEqual({ quotations: 0, mappings: 0 });
  });

  it("calculates digital admin-side, persists complete internal data, and returns only the safe projection", async () => {
    const user = await createVerifiedUser("digital", "PDIGITAL");
    const response = await calculatePortalQuote(authRequest(user, requestBody({ idempotencyKey: "digital-success" })));
    expect(response.status).toBe(201);
    const body = await json(response);
    assertCustomerSafe(body);
    expect(body.customerName).toBe("digital株式会社");
    expect(body.paymentTerms).toBe("月末締め翌月末払い");

    const db = await getPortalQuoteDatabaseForTest();
    const mapping = await db.get<Record<string, unknown>>(
      "SELECT * FROM portal_quote_mappings WHERE public_id = ?",
      [body.publicId],
    );
    expect(mapping).toMatchObject({
      portal_user_id: user.id,
      owner_domain: "kanei",
      customer_code: user.customerCode,
      source: "customer_portal",
      idempotency_key: "digital-success",
    });
    const quotation = await db.get<Record<string, unknown>>(
      "SELECT * FROM quotations WHERE id = ?",
      [mapping!.quotation_id],
    );
    expect(quotation).toMatchObject({ status: "draft", customer_name: "digital株式会社" });
    const payload = JSON.parse(String(quotation!.payload_json)) as Record<string, unknown>;
    expect(payload.source).toBe("customer_portal");
    expect(payload.calculationRequest).toBeTruthy();
    expect(payload.calculationResult).toBeTruthy();
    expect(payload.displayedTotals).toBeTruthy();
    expect((payload.calculationRequest as Record<string, unknown>).parameters).toBeTruthy();
    expect((payload.calculationResult as Record<string, unknown>).costTotal).toBeTruthy();
  });

  it("resolves film prices server-side and ignores any client pricing channel", async () => {
    const user = await createVerifiedUser("pricing", "PPRICING");
    const overriddenPrices = {
      lte570: { "500": "411", "1000": "322", "1500": "291" },
      "571to740": { "500": "441", "1000": "350", "1500": "311" },
    };
    const calculate = vi.fn(calculatePouchCost);
    const resolveFilmPrices = vi.fn(async () => overriddenPrices);
    const response = await calculatePortalQuote(
      authRequest(user, requestBody({ idempotencyKey: "server-pricing" })),
      { calculate, resolveFilmPrices },
    );
    expect(response.status).toBe(201);
    expect(resolveFilmPrices).toHaveBeenCalledWith("2026-10-23", expect.any(Object));
    const input = calculate.mock.calls[0]?.[0] as Record<string, any>;
    expect(input.parameters.filmUnitPrices).toEqual(overriddenPrices);
    expect(await counts().then((value) => value.quotations)).toBeGreaterThan(1);

    await upsertFilmPrice({
      band: "lte570",
      tier: "500",
      unitPriceYenPerM: "777",
      effectiveFrom: "2026-10-01",
      effectiveTo: "2026-10-31",
      memo: "portal test",
    }, "test");
    const { resolveFilmUnitPrices } = await import("@/lib/film-price-store");
    const resolved = await resolveFilmUnitPrices("2026-10-23", {
      lte570: { "500": "1", "1000": "1", "1500": "1" },
      "571to740": { "500": "1", "1000": "1", "1500": "1" },
    });
    expect(resolved.lte570["500"]).toBe("777");
  });

  it("returns the original safe result for an identical idempotency key without duplicating rows", async () => {
    const user = await createVerifiedUser("idempotent", "PIDEMPOTENT");
    const body = requestBody({ idempotencyKey: "same-key" });
    const first = await calculatePortalQuote(authRequest(user, body));
    const second = await calculatePortalQuote(authRequest(user, body));
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await json(second)).toEqual(await json(first));
    const db = await getPortalQuoteDatabaseForTest();
    const rows = await db.all("SELECT * FROM portal_quote_mappings WHERE idempotency_key = 'same-key'");
    expect(rows).toHaveLength(1);
  });

  it("accepts only the canonical portal session header for calculation", async () => {
    const user = await createVerifiedUser("canonical-header", "PCANONICAL");
    const body = requestBody({ idempotencyKey: "canonical-header-key" });
    const aliasResponse = await calculatePortalQuote(request(body, [], {
      ...authorization,
      "x-portal-session": user.token,
    }));
    expect(aliasResponse.status).toBe(401);
    expect(await json(aliasResponse)).toEqual({ error: "unauthorized" });

    const canonicalResponse = await calculatePortalQuote(authRequest(user, body));
    expect(canonicalResponse.status).toBe(201);
    expect(await json(canonicalResponse)).toHaveProperty("publicId");
  });

  it("rejects a reused idempotency key with different business input", async () => {
    const user = await createVerifiedUser("conflict", "PCONFLICT");
    await calculatePortalQuote(authRequest(user, requestBody({ idempotencyKey: "conflict-key" })));
    const response = await calculatePortalQuote(
      authRequest(user, requestBody({ idempotencyKey: "conflict-key", quantity: "20000" })),
    );
    expect(response.status).toBe(409);
    const db = await getPortalQuoteDatabaseForTest();
    expect((await db.all("SELECT * FROM portal_quote_mappings WHERE idempotency_key = 'conflict-key'")).length).toBe(1);
  });

  it("creates separate quote numbers and mappings for concurrent distinct calculations", async () => {
    const user = await createVerifiedUser("concurrent", "PCONCURRENT");
    const requests = [1, 2, 3].map((index) => calculatePortalQuote(
      authRequest(user, requestBody({ idempotencyKey: `distinct-${index}`, quantity: String(10000 * index) })),
    ));
    const responses = await Promise.all(requests);
    const bodies = [];
    for (const response of responses) {
      expect(response.status).toBe(201);
      bodies.push(await json(response));
    }
    expect(new Set(bodies.map((body) => body.publicId))).toHaveLength(3);
    expect(new Set(bodies.map((body) => body.quotationNumber))).toHaveLength(3);
    const db = await getPortalQuoteDatabaseForTest();
    const rows = await db.all("SELECT * FROM portal_quote_mappings WHERE idempotency_key LIKE 'distinct-%'");
    expect(rows).toHaveLength(3);
  });

  it("returns one original quote when the same idempotency key races", async () => {
    const user = await createVerifiedUser("race", "PRACE");
    const body = requestBody({ idempotencyKey: "race-key" });
    const [first, second] = await Promise.all([
      calculatePortalQuote(authRequest(user, body)),
      calculatePortalQuote(authRequest(user, body)),
    ]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await json(second)).toEqual(await json(first));
    const db = await getPortalQuoteDatabaseForTest();
    expect((await db.all("SELECT * FROM portal_quote_mappings WHERE idempotency_key = 'race-key'")).length).toBe(1);
  });

  it("conflicts when a unique-idempotency race has a different request fingerprint", async () => {
    const user = await createVerifiedUser("race-conflict", "PRACECONFLICT");
    const [created, conflicted] = await Promise.all([
      calculatePortalQuote(authRequest(user, requestBody({
        idempotencyKey: "race-conflict-key",
        quantity: "10000",
      }))),
      calculatePortalQuote(authRequest(user, requestBody({
        idempotencyKey: "race-conflict-key",
        quantity: "20000",
      }))),
    ]);
    const responses = [created, conflicted];
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(await json(conflict)).toMatchObject({ error: "conflict" });

    const db = await getPortalQuoteDatabaseForTest();
    const mappings = await db.all<{ quantity: string }>(
      `SELECT quotations.quantity AS quantity
       FROM portal_quote_mappings
         INNER JOIN quotations ON quotations.id = portal_quote_mappings.quotation_id
       WHERE portal_quote_mappings.idempotency_key = 'race-conflict-key'`,
    );
    expect(mappings).toHaveLength(1);
    expect(mappings[0].quantity).toBe("10000");
  });

  it("conflicts in unique-race recovery when fingerprints differ", async () => {
    const user = await createVerifiedUser("unique-recovery", "PUNIQUERECOVERY");
    const db = await getPortalQuoteDatabaseForTest();
    const idempotencyKey = "unique-recovery-key";
    const quotation = {
      status: "draft" as const,
      issueDate: "2026-10-23",
      validUntil: "2026-11-06",
      customerName: "ユニークリカバリー株式会社",
      customerContact: "ポータル太郎",
      productName: "リカバリーテスト",
      sizeSummary: "50×60mm",
      quantity: "10000",
      fillingCostPerPiece: "1",
      filmCostPerPiece: "1",
      filmMeterPrice: "1",
      filmOrderLengthM: "1",
      targetMargin: "0.1",
      taxRatePercent: "0.1",
      pricePerPiece: "10",
      subtotal: "100000",
      tax: "10000",
      grandTotal: "110000",
      deliveryDate: "別途相談",
      paymentTerms: "月末締め翌月末払い",
      notes: "",
      calculationVersion: "test",
      resultHash: "test-hash",
      payload: { quantity: "10000" },
    };
    const input = (requestFingerprint: string) => ({
      quotation,
      actorId: user.id,
      portalUserId: user.id,
      ownerDomain: "kanei" as const,
      customerCode: user.customerCode,
      idempotencyKey,
      requestFingerprint,
      buildResponse: ({ publicId, quotationNumber }: { publicId: string; quotationNumber: string }) => ({
        publicId,
        quotationNumber,
      }),
    });

    const actorId = await getPortalServiceActorId();
    expect(actorId).not.toBeNull();
    const committed = await createPortalQuoteWithMapping({
      ...input("fingerprint-a"),
      actorId: actorId!,
    });
    const raceInput = (requestFingerprint: string) => ({
      ...input(requestFingerprint),
      actorId: actorId!,
    });
    const actualTransaction = db.transaction.bind(db);
    Object.defineProperty(db, "transaction", {
      configurable: true,
      writable: true,
      value: async (operation: (tx: SqlClient) => Promise<unknown>) => actualTransaction(async (tx) => {
        const hiddenMappingTx: SqlClient = Object.create(tx);
        hiddenMappingTx.get = async (sql: string, params: unknown[] = []) => {
          if (sql.includes("FROM portal_quote_mappings") && params[2] === idempotencyKey) return undefined;
          return tx.get(sql, params);
        };
        return operation(hiddenMappingTx);
      }),
    });

    try {
      const [sameFingerprint, differentFingerprint] = await Promise.allSettled([
        createPortalQuoteWithMapping(raceInput("fingerprint-a")),
        createPortalQuoteWithMapping(raceInput("fingerprint-b")),
      ]);
      expect(sameFingerprint.status).toBe("fulfilled");
      expect(differentFingerprint.status).toBe("rejected");
      if (sameFingerprint.status === "fulfilled") {
        expect(sameFingerprint.value.publicId).toBe(committed.publicId);
      }
      if (differentFingerprint.status === "rejected") {
        expect(differentFingerprint.reason).toBeInstanceOf(PortalQuoteIdempotencyConflictError);
      }
    } finally {
      Object.defineProperty(db, "transaction", {
        configurable: true,
        writable: true,
        value: actualTransaction,
      });
    }
  });

  it("rolls back quote and mapping together when mapping persistence fails", async () => {
    const user = await createVerifiedUser("rollback", "PROLLBACK");
    const db = await getPortalQuoteDatabaseForTest();
    await db.exec(`
      CREATE TRIGGER force_portal_quote_mapping_failure
      BEFORE INSERT ON portal_quote_mappings
      BEGIN SELECT RAISE(ABORT, 'forced_portal_mapping_failure'); END
    `);
    const before = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quotations");
    try {
      const failed = await calculatePortalQuote(request(requestBody({ idempotencyKey: "rollback-key" }), [], authFor(user)));
      expect(failed.status).toBe(500);
      const after = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quotations");
      expect(Number(after!.count)).toBe(Number(before!.count));
      expect((await db.all("SELECT * FROM portal_quote_mappings WHERE idempotency_key = 'rollback-key'")).length).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER force_portal_quote_mapping_failure");
    }
  });

  it("enforces ownership isolation at the service-function level", async () => {
    const first = await createVerifiedUser("owner-one", "POWNER1");
    const second = await createVerifiedUser("owner-two", "POWNER2");
    const ownerResponse = await calculatePortalQuote(
      request(requestBody({ idempotencyKey: "owner-key" }), [], authFor(first)),
    );
    expect(ownerResponse.status).toBe(201);
    const otherResponse = await calculatePortalQuote(
      request(requestBody({ idempotencyKey: "owner-key", quantity: "12345" }), [], authFor(second)),
    );
    expect(otherResponse.status).toBe(201);
    const otherBody = await json(otherResponse);
    expect(otherBody.publicId).not.toBe((await json(ownerResponse)).publicId);
    const db = await getPortalQuoteDatabaseForTest();
    const mappings = await db.all("SELECT portal_user_id FROM portal_quote_mappings WHERE idempotency_key = 'owner-key'");
    expect(mappings.map((row) => Number(row.portal_user_id)).sort()).toEqual([first.id, second.id].sort());
  });

  it("enforces a durable per-user hourly limit", async () => {
    const user = await createVerifiedUser("rate", "PRATE");
    const { incrementPortalRateLimit } = await import("@/lib/portal/identity-store");
    for (let index = 0; index < 10; index += 1) {
      await incrementPortalRateLimit({
        key: `portal-quote-calculate:kanei:${user.id}`,
        limit: 10,
        windowSeconds: 60 * 60,
        now: new Date(),
      });
    }
    const identityDb = await (await import("@/lib/portal/identity-store")).getPortalIdentityDatabase();
    const rateRows = await identityDb.all("SELECT bucket_key,count FROM portal_rate_limits WHERE bucket_key LIKE ?", [`portal-quote-calculate:kanei:${user.id}:%`]);
    expect(rateRows).toHaveLength(1);
    expect(Number(rateRows[0].count)).toBe(10);
    const response = await calculatePortalQuote(authRequest(user, requestBody({ idempotencyKey: "rate-key" })));
    const rateAfter = await identityDb.all("SELECT bucket_key,count FROM portal_rate_limits WHERE bucket_key LIKE ?", [`portal-quote-calculate:kanei:${user.id}:%`]);
    expect(rateAfter).toHaveLength(1);
    expect(Number(rateAfter[0].count)).toBe(11);
    expect(response.status).toBe(429);
    expect(await json(response)).toEqual({ error: "rate_limited", message: expect.any(String) });
  });

  it("returns gravure unavailable when snapshot issuance is disabled and persists nothing", async () => {
    const user = await createVerifiedUser("gravure-off", "PGRAVUREOFF");
    process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = "false";
    const before = await counts();
    const response = await calculatePortalQuote(
      request(requestBody({ idempotencyKey: "gravure-disabled", printingMethod: "gravure" }), [], authFor(user)),
    );
    expect(response.status).toBe(503);
    expect((await json(response)).error).toBe("print_method_unavailable");
    expect(await counts()).toEqual(before);
  });

  it("uses the durable gravure path and snapshot when enabled", async () => {
    const user = await createVerifiedUser("gravure-on", "PGRAVUREON");
    process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = "true";
    const response = await calculatePortalQuote(
      request(requestBody({ idempotencyKey: "gravure-enabled", printingMethod: "gravure" }), [], authFor(user)),
    );
    expect(response.status).toBe(201);
    const body = await json(response);
    assertCustomerSafe(body);
    const db = await getPortalQuoteDatabaseForTest();
    const row = await db.get<{ payload_json: string; created_by: number }>(
      `SELECT quotations.payload_json, quotations.created_by
       FROM quotations INNER JOIN portal_quote_mappings ON portal_quote_mappings.quotation_id = quotations.id
       WHERE portal_quote_mappings.public_id = ?`,
      [body.publicId],
    );
    const payload = JSON.parse(row!.payload_json) as Record<string, any>;
    expect(payload.calculationRequest.printingMethod).toBe("gravure");
    expect(Array.isArray(payload.calculationRequest.gravureYRows)).toBe(true);
    expect(payload.gravureSnapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    const actor = await db.get<{ id: number; is_active: number; email: string }>(
      "SELECT id,is_active,email FROM users WHERE id = ?",
      [row!.created_by],
    );
    expect(actor!.email).toBe("portal-service@system.invalid");
    expect(Number(actor!.is_active)).toBe(0);
    await expect((await import("@/lib/portal/identity-store")).createPortalSession(Number(actor!.id), { now: now() }))
      .rejects.toThrow("portal_service_login_forbidden");
  });

  it("does not persist when calculation fails", async () => {
    const user = await createVerifiedUser("calc-failure", "PCALCFAIL");
    const before = await counts();
    const response = await calculatePortalQuote(
      authRequest(user, requestBody({ idempotencyKey: "calc-failure" })),
      {
        ...authFor(user),
        calculate: () => {
          throw new Error("forced_calculation_failure");
        },
      },
    );
    expect(response.status).toBe(500);
    expect(await counts()).toEqual(before);
    expect((await json(response)).error).toBe("internal_error");
  });
});
