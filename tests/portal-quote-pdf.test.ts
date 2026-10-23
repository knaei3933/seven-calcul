import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractText } from "unpdf";

const databaseDirectory = await mkdtemp(join(tmpdir(), "portal-quote-pdf-"));
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
process.env.ADMIN_EMAIL = "admin@portal-pdf.test";
process.env.ADMIN_PASSWORD = "admin-portal-pdf-password";
process.env.ADMIN_NAME = "Portal PDF Admin";
process.env.PORTAL_SERVICE_TOKEN = "portal-pdf-service-token-at-least-32-chars";
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
  downloadPortalQuotePdfApi,
  generatePortalQuotePdfApi,
} = await import("@/lib/portal/quote-pdf-service");
const fontBytes = await readFile("src/fonts/NotoSansJP-Variable.ttf");

const token = process.env.PORTAL_SERVICE_TOKEN;
const serviceAuthorization = { authorization: `Bearer ${token}` };
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
    ...serviceAuthorization,
    "x-portal-client-fingerprint": user.id.toString().padStart(64, "0"),
    "x-portal-session-token": user.token,
  };
}

function generateRequest(user: TestUser, publicId: string, headers = headersFor(user)): Request {
  return new Request(`https://admin.test/api/portal/v1/quotes/${publicId}/pdf/generate`, {
    method: "POST",
    headers,
  });
}

function downloadRequest(user: TestUser, publicId: string, headers = headersFor(user)): Request {
  return new Request(`https://admin.test/api/portal/v1/quotes/${publicId}/pdf`, {
    headers,
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
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
  return { id: verified.id, email, customerCode: verified.customerCode, token: session.token };
}

function calculationBody(idempotencyKey: string): Record<string, unknown> {
  return {
    idempotencyKey,
    productName: `見積テスト ${idempotencyKey}`,
    sizeKey: "round-50x60",
    fillMlPerChamber: "3",
    connectedChambers: 1,
    fillingMethod: "hopper",
    fillingLanes: 4,
    printingMethod: "digital",
    quantity: "10000",
    deliveryDate: "別途相談",
    notes: "日本語備考の確認用テストです。",
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
  return await responseBody(response);
}

async function mappingFor(publicId: string): Promise<Record<string, unknown>> {
  const db = await getPortalQuoteDatabaseForTest();
  const row = await db.get<Record<string, unknown>>(
    "SELECT * FROM portal_quote_mappings WHERE public_id = ?",
    [publicId],
  );
  expect(row).toBeTruthy();
  return row!;
}

async function storedPdf(quotationId: number): Promise<{ data: Buffer; sha256: string | null }> {
  const db = await getPortalQuoteDatabaseForTest();
  const row = await db.get<{ data: Uint8Array; sha256: string | null }>(
    "SELECT pdf_data AS data, pdf_sha256 AS sha256 FROM quotations WHERE id = ?",
    [quotationId],
  );
  expect(row?.data).toBeTruthy();
  return { data: Buffer.from(row!.data), sha256: row!.sha256 };
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const result = await extractText(new Uint8Array(bytes), { mergePages: true });
  return result.text;
}

async function portalRouteFiles(directory = "src/app/api/portal"): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? portalRouteFiles(path) : [path];
  }));
  return files.flat();
}

let owner: TestUser;
let foreignUser: TestUser;
let unverifiedUser: TestUser;
let generatedQuote: Record<string, unknown>;
let generatedPublicId = "";
let expiredQuote: Record<string, unknown>;
let expiredPublicId = "";
let expiredOwner: TestUser;
let raceQuote: Record<string, unknown>;
let racePublicId = "";

beforeAll(async () => {
  await getPortalIdentityDatabase();
  // The service actor owns quotation-store id 1; reserve portal user id 1 so
  // the first real test account cannot collide with that internal actor id.
  await createPortalUser({
    email: "pdf-warmup@example.test",
    password: "secure-portal-password",
    companyName: "準備株式会社",
    contactName: "準備太郎",
    customerCode: "PDFWARMUP",
    ownerDomain: "kanei",
  });
  await createPortalUser({
    email: "pdf-warmup-two@example.test",
    password: "secure-portal-password",
    companyName: "準備二株式会社",
    contactName: "準備太郎",
    customerCode: "PDFWARMUP2",
    ownerDomain: "kanei",
  });
  owner = await createVerifiedUser("pdf-owner", "PDFOwner");
  foreignUser = await createVerifiedUser("pdf-foreign", "PDFForeign");
  expiredOwner = await createVerifiedUser("pdf-expired-owner", "PDFExpiredOwner");
  const unverified = await createPortalUser({
    email: `unverified-${Math.random().toString(16).slice(2)}@example.test`,
    password: "secure-portal-password",
    companyName: "未認証株式会社",
    contactName: "未認証太郎",
    customerCode: "PDFUnverified",
    ownerDomain: "kanei",
  });
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
    "portal-pdf-test",
    now().toISOString(),
  ]);
  unverifiedUser = {
    id: unverified.id,
    email: unverified.email,
    customerCode: unverified.customerCode,
    token: unverifiedToken,
  };

  generatedQuote = await createQuote(owner, "pdf-first");
  generatedPublicId = String(generatedQuote.publicId);
  expiredQuote = await createQuote(expiredOwner, "pdf-expired");
  expiredPublicId = String(expiredQuote.publicId);
  raceQuote = await createQuote(owner, "pdf-race");
  racePublicId = String(raceQuote.publicId);
  await getPortalQuoteDatabaseForTest().then((db) => db.run(
    "UPDATE quotations SET valid_until = ? WHERE id = (SELECT quotation_id FROM portal_quote_mappings WHERE public_id = ?)",
    ["2026-01-01", expiredPublicId],
  ));
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
  if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.databaseUrl;
  if (previous.postgresUrl === undefined) delete process.env.POSTGRES_URL;
  else process.env.POSTGRES_URL = previous.postgresUrl;
  if (previous.portalToken === undefined) delete process.env.PORTAL_SERVICE_TOKEN;
  else process.env.PORTAL_SERVICE_TOKEN = previous.portalToken;
  process.env.ADMIN_EMAIL = previous.adminEmail!;
  process.env.ADMIN_NAME = previous.adminName!;
  process.env.ADMIN_PASSWORD = previous.adminPassword!;
});

describe("portal-owned canonical quotation PDF API", () => {
  it("requires the service bearer token and a verified portal session", async () => {
    const noServiceHeaders = { "x-portal-session-token": owner.token };
    const noService = await generatePortalQuotePdfApi(
      generateRequest(owner, generatedPublicId, noServiceHeaders),
      generatedPublicId,
      { now, fontBytes },
    );
    expect(noService.status).toBe(401);
    const wrongService = await generatePortalQuotePdfApi(
      generateRequest(owner, generatedPublicId, {
        authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
        "x-portal-session-token": owner.token,
      }),
      generatedPublicId,
      {
        now,
        fontBytes,
      },
    );
    expect(wrongService.status).toBe(401);
    const downloadNoService = await downloadPortalQuotePdfApi(
      downloadRequest(owner, generatedPublicId, noServiceHeaders),
      generatedPublicId,
      { now },
    );
    expect(downloadNoService.status).toBe(401);
    const unverified = await generatePortalQuotePdfApi(generateRequest(unverifiedUser, generatedPublicId), generatedPublicId, {
      now,
      fontBytes,
    });
    expect(unverified.status).toBe(401);
    expect(await responseBody(unverified)).toMatchObject({ error: "unauthorized" });
  });

  it("rejects malformed public ids without exposing validation details", async () => {
    for (const publicId of ["not-a-uuid", randomUUID().toUpperCase(), "../../etc/passwd"]) {
      const generated = await generatePortalQuotePdfApi(generateRequest(owner, publicId), publicId, {
        now,
        fontBytes,
      });
      expect(generated.status).toBe(404);
      expect(await responseBody(generated)).toEqual({ error: "not_found", message: "お見積りが見つかりません。" });
    }
  });

  it("enforces mapping-first ownership and returns the same opaque result for a missing quote", async () => {
    const foreign = await generatePortalQuotePdfApi(generateRequest(foreignUser, generatedPublicId), generatedPublicId, {
      now,
      fontBytes,
    });
    expect(foreign.status).toBe(404);
    const missing = await generatePortalQuotePdfApi(generateRequest(owner, randomUUID()), randomUUID(), {
      now,
      fontBytes,
    });
    expect(missing.status).toBe(404);
    expect(await responseBody(foreign)).toEqual(await responseBody(missing));
  });

  it("accepts only the canonical session header for PDF generation and download", async () => {
    const quote = await createQuote(owner, "pdf-header-key");
    const publicId = String(quote.publicId);
    const aliasHeaders = {
      ...serviceAuthorization,
      "x-portal-session": owner.token,
    };

    const aliasGenerate = await generatePortalQuotePdfApi(
      generateRequest(owner, publicId, aliasHeaders),
      publicId,
      { now, fontBytes },
    );
    expect(aliasGenerate.status).toBe(401);
    expect(await responseBody(aliasGenerate)).toMatchObject({ error: "unauthorized" });

    const canonicalGenerate = await generatePortalQuotePdfApi(generateRequest(owner, publicId), publicId, {
      now,
      fontBytes,
      // Header behavior is under test here; avoid consuming the shared owner quota.
      incrementRateLimit: async () => ({
        count: 1,
        windowStartedAt: now().toISOString(),
        expiresAt: now().toISOString(),
      }),
    });
    expect(canonicalGenerate.status).toBe(201);

    const aliasDownload = await downloadPortalQuotePdfApi(
      downloadRequest(owner, publicId, aliasHeaders),
      publicId,
      { now },
    );
    const canonicalDownload = await downloadPortalQuotePdfApi(downloadRequest(owner, publicId), publicId, { now });
    expect(aliasDownload.status).toBe(401);
    expect(await responseBody(aliasDownload)).toMatchObject({ error: "unauthorized" });
    expect(canonicalDownload.status).toBe(200);
    await canonicalDownload.arrayBuffer();
  });

  it("generates one A4 Japanese PDF and stores its SHA-256 without overwriting bytes", async () => {
    const response = await generatePortalQuotePdfApi(generateRequest(owner, generatedPublicId), generatedPublicId, {
      now,
      fontBytes,
    });
    expect(response.status).toBe(201);
    const payload = await responseBody(response);
    const mapping = await mappingFor(generatedPublicId);
    const stored = await storedPdf(Number(mapping.quotation_id));
    const actualSha256 = createHash("sha256").update(stored.data).digest("hex");
    expect(stored.sha256).toBe(actualSha256);
    expect(payload).toEqual({
      saved: true,
      size: stored.data.byteLength,
      sha256: actualSha256,
    });
    expect(stored.data.subarray(0, 5).toString()).toBe("%PDF-");
    expect(stored.data.toString("latin1")).toMatch("/MediaBox [ 0 0 595.28 841.89 ]");
  });

  it("returns 409 for duplicate generation while preserving the original canonical bytes", async () => {
    const mapping = await mappingFor(generatedPublicId);
    const original = await storedPdf(Number(mapping.quotation_id));
    const response = await generatePortalQuotePdfApi(generateRequest(owner, generatedPublicId), generatedPublicId, {
      now,
      fontBytes,
    });
    expect(response.status).toBe(409);
    expect(await responseBody(response)).toMatchObject({ error: "conflict" });
    const retained = await storedPdf(Number(mapping.quotation_id));
    expect(retained.data.equals(original.data)).toBe(true);
    expect(retained.sha256).toBe(original.sha256);
  });

  it("stores exactly one canonical PDF when generation requests race", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      generatePortalQuotePdfApi(generateRequest(owner, racePublicId), racePublicId, {
        now,
        fontBytes,
      })));
    const accepted = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);
    expect(accepted).toHaveLength(1);
    expect(conflicts).toHaveLength(4);
    const mapping = await mappingFor(racePublicId);
    const stored = await storedPdf(Number(mapping.quotation_id));
    const acceptedPayloads = await Promise.all(accepted.map((response) => responseBody(response)));
    expect(acceptedPayloads[0]).toMatchObject({
      saved: true,
      size: stored.data.byteLength,
      sha256: stored.sha256,
    });
  });

  it("downloads only the owner's exact stored bytes with no-store headers and safe filename encoding", async () => {
    const forbiddenOwner = await downloadPortalQuotePdfApi(downloadRequest(foreignUser, generatedPublicId), generatedPublicId, { now });
    expect(forbiddenOwner.status).toBe(404);
    const response = await downloadPortalQuotePdfApi(downloadRequest(owner, generatedPublicId), generatedPublicId, { now });
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "cache-control": "private, no-store",
      "content-type": "application/pdf",
      "x-content-type-options": "nosniff",
    });
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="quote.pdf"; filename*=UTF-8''${encodeURIComponent(`${String(generatedQuote.quotationNumber)}.pdf`)}`,
    );
    const mapping = await mappingFor(generatedPublicId);
    const stored = await storedPdf(Number(mapping.quotation_id));
    expect(Buffer.from(await response.arrayBuffer()).equals(stored.data)).toBe(true);
  });

  it("renders visible Japanese customer-safe content and excludes forbidden content", async () => {
    const response = await downloadPortalQuotePdfApi(downloadRequest(owner, generatedPublicId), generatedPublicId, { now });
    expect(response.status).toBe(200);
    const text = await extractPdfText(new Uint8Array(await response.arrayBuffer()));
    for (const expected of [
      "カネイトレード",
      "お見積書",
      String(generatedQuote.quotationNumber),
      String(generatedQuote.customerName),
      String(generatedQuote.productName),
      String(generatedQuote.sizeSummary),
      String(generatedQuote.quantity),
      String(generatedQuote.displayedUnitPrice),
      String(generatedQuote.displayedSubtotal),
      String(generatedQuote.displayedTax),
      String(generatedQuote.displayedGrandTotal),
      "別途相談",
      "月末締め翌月末払い",
      "日本語備考の確認用テストです。",
      "お客様ポータル",
    ]) {
      expect(text).toContain(expected);
    }
    for (const forbidden of [
      "cost", "purchase", "margin", "profit", "success fee", "film", "supplier",
      "purchase order", "payload", "result hash", "approval", "staff comment",
      "fillingCostPerPiece", "filmCostPerPiece", "filmMeterPrice", "filmOrderLengthM",
      "targetMargin", "resultHash", "payloadJson",
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("keeps expired quotes downloadable and renders only safe expiry wording without changing draft status", async () => {
    const response = await generatePortalQuotePdfApi(generateRequest(expiredOwner, expiredPublicId), expiredPublicId, {
      now,
      fontBytes,
    });
    expect(response.status).toBe(201);
    const mapping = await mappingFor(expiredPublicId);
    const quoteStatus = await getPortalQuoteDatabaseForTest().then((db) => db.get<{ status: string }>(
      "SELECT status FROM quotations WHERE id = ?",
      [Number(mapping.quotation_id)],
    ));
    expect(quoteStatus?.status).toBe("draft");
    const download = await downloadPortalQuotePdfApi(downloadRequest(expiredOwner, expiredPublicId), expiredPublicId, { now });
    expect(download.status).toBe(200);
    const text = await extractPdfText(new Uint8Array(await download.arrayBuffer()));
    expect(text).toContain("有効期限切れ");
    expect(text).toContain("現在無効");
    expect(text).not.toContain("内定");
  });

  it("has no customer-facing portal PDF upload route", async () => {
    const files = await portalRouteFiles();
    expect(files).toContain(join("src/app/api/portal/v1/quotes/[publicId]/pdf/route.ts"));
    expect(files).toContain(join("src/app/api/portal/v1/quotes/[publicId]/pdf/generate/route.ts"));
    expect(files.some((file) => file.toLowerCase().includes("upload"))).toBe(false);
    const downloadSource = await readFile("src/app/api/portal/v1/quotes/[publicId]/pdf/route.ts", "utf8");
    expect(downloadSource).not.toContain("POST");
    const generateSource = await readFile("src/app/api/portal/v1/quotes/[publicId]/pdf/generate/route.ts", "utf8");
    expect(generateSource).not.toContain("formData");
    expect(generateSource).not.toContain("request.arrayBuffer");
  });

  it("rate-limits generation before quote resolution or PDF generation", async () => {
    let resolveCalls = 0;
    let generateCalls = 0;
    const response = await generatePortalQuotePdfApi(generateRequest(owner, generatedPublicId), generatedPublicId, {
      now,
      fontBytes,
      incrementRateLimit: async () => {
        return {
          count: 11,
          windowStartedAt: now().toISOString(),
          expiresAt: now().toISOString(),
        };
      },
      resolveQuote: async (input) => {
        resolveCalls += 1;
        return {
          internalQuotationId: 1,
          projection: {
            publicId: input.publicId,
            quotationNumber: "Q",
            issueDate: "2026-10-23",
            validUntil: "2026-11-22",
            customerName: " customer",
            customerContact: "contact",
            productName: "product",
            sizeSummary: "size",
            quantity: "1",
            displayedUnitPrice: "1",
            displayedSubtotal: "1",
            displayedTax: "0.1",
            displayedGrandTotal: "1.1",
            deliveryDate: "delivery",
            paymentTerms: "payment",
            notes: "",
            createdAt: now().toISOString(),
            pdfAvailability: "unavailable",
            lines: Object.freeze([]),
            availability: "active",
          },
        };
      },
      generatePdf: async () => {
        generateCalls += 1;
        return Buffer.from("%PDF-test");
      },
      savePdf: async () => true,
    });
    expect(response.status).toBe(429);
    expect(await responseBody(response)).toEqual({
      error: "rate_limited",
      message: "処理回数が多いため、しばらくしてから再度お試しください。",
    });
    expect(resolveCalls).toBe(0);
    expect(generateCalls).toBe(0);
  });
});
