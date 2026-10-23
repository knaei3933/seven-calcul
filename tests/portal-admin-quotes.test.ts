// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "portal-admin-quotes-"));
const previous = {
  databaseUrl: process.env.DATABASE_URL,
  postgresUrl: process.env.POSTGRES_URL,
  adminEmail: process.env.ADMIN_EMAIL,
  adminName: process.env.ADMIN_NAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  portalToken: process.env.PORTAL_SERVICE_TOKEN,
};
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.ADMIN_EMAIL = "existing-admin@kanei-trade.co.jp";
process.env.ADMIN_NAME = "Kanei Admin";
process.env.ADMIN_PASSWORD = "existing-kanei-admin-password";
process.env.PORTAL_SERVICE_TOKEN = "portal-admin-quote-service-token-at-least-32";
process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED = "false";

const { createPortalEmailVerification, createPortalSession, createPortalUser, verifyPortalUserAndProvisionCustomer } =
  await import("@/lib/portal/identity-store");
const { calculatePortalQuote } = await import("@/lib/portal/quote-calculation");
const { canViewPortalQuotes, listAdminPortalQuotes, requirePortalQuoteAdmin } =
  await import("@/lib/portal/admin-quote-service");
const { GET: portalQuotesRoute } = await import("@/app/api/admin/portal-quotes/route");
const { createSession, createUser } = await import("@/lib/auth-store");
const { getCustomer, listCustomers } = await import("@/lib/customer-store");
const { getQuotationByNumber, listQuotations, saveQuotationPdf } = await import("@/lib/quotation-store");

const serviceAuthorization = { authorization: `Bearer ${process.env.PORTAL_SERVICE_TOKEN}` };
type AdminQuote = Record<string, unknown> & {
  publicId: string;
  quotationId: number;
  quotationNumber: string;
  customerCode: string;
  source: string;
  sourceLabel: string;
  customer: Record<string, unknown> | null;
  displayedTotals: Record<string, unknown>;
  pdfAvailable: boolean;
};

let admin: Awaited<ReturnType<typeof createUser>>;
let adminToken: string;
let ordinaryToken: string;
let portalUser: Awaited<ReturnType<typeof verifyPortalUserAndProvisionCustomer>> & { token: string };
let firstQuote: AdminQuote;
let secondQuote: AdminQuote;

function portalHeaders(user: { token: string }): Record<string, string> {
  return { ...serviceAuthorization, "x-portal-session-token": user.token, "content-type": "application/json" };
}

function calculationBody(idempotencyKey: string, productName: string): Record<string, unknown> {
  return {
    idempotencyKey,
    productName,
    sizeKey: "round-50x60",
    fillMlPerChamber: "3",
    connectedChambers: 1,
    fillingMethod: "hopper",
    fillingLanes: 4,
    printingMethod: "digital",
    quantity: "12000",
    deliveryDate: "別途相談",
    notes: "G011 admin visibility test",
  };
}

async function createPortalQuote(idempotencyKey: string, productName: string): Promise<AdminQuote> {
  const response = await calculatePortalQuote(new Request(
    "https://admin.test/api/portal/v1/quotes/calculate",
    { method: "POST", headers: portalHeaders(portalUser), body: JSON.stringify(calculationBody(idempotencyKey, productName)) },
  ));
  expect(response.status).toBe(201);
  const projected = await response.json() as AdminQuote;
  const record = await getQuotationByNumber(projected.quotationNumber);
  if (!record) throw new Error("portal quotation not found");
  return { ...projected, quotationId: record.id };
}

function authedRequest(token: string, query = ""): Request {
  return new Request(`https://admin.test/api/admin/portal-quotes${query}`, {
    headers: { cookie: `pouch_session=${token}` },
  });
}

async function firstAdminPage(query = ""): Promise<{ quotes: AdminQuote[]; pagination: Record<string, number | boolean> }> {
  const response = await portalQuotesRoute(authedRequest(adminToken, query), { params: Promise.resolve({}) });
  if (response.status !== 200) console.error("admin route failure", response.status, await response.text());
  expect(response.status).toBe(200);
  return await response.json();
}

beforeAll(async () => {
  admin = await createUser({
    email: "g011-admin@kanei-trade.co.jp",
    name: "G011 Kanei Admin",
    password: "g011-kanei-admin-password",
    role: "admin",
  });
  const ordinary = await createUser({
    email: "g011-user@kanei-trade.co.jp",
    name: "G011 Internal User",
    password: "g011-internal-user-password",
    role: "user",
  });
  adminToken = (await createSession(admin.id)).token;
  ordinaryToken = (await createSession(ordinary.id)).token;

  const email = `portal-admin-${Math.random().toString(16).slice(2)}@example.test`;
  portalUser = await (async () => {
    const created = await createPortalUser({
      email,
      password: "secure-portal-password",
      companyName: "ポータルG011株式会社",
      contactName: "ポータル太郎",
      postalCode: "100-0001",
      address: "東京都テスト区1-2-3",
      telephone: "03-0000-0000",
      ownerDomain: "kanei",
    });
    const verification = await createPortalEmailVerification({ email });
    const verified = await verifyPortalUserAndProvisionCustomer({ email, code: verification.code });
    const session = await createPortalSession(verified.id);
    return { ...verified, token: session.token };
  })();

  firstQuote = await createPortalQuote("g011-first", "先ポータル袋");
  secondQuote = await createPortalQuote("g011-second", "新ポータル袋");
  await saveQuotationPdf(secondQuote.quotationId, Buffer.from("%PDF-1.7\nG011"), "portal-g011.pdf");
  const { saveQuotation } = await import("@/lib/quotation-store");
  await saveQuotation({
    quotationNumber: "S7-G011-INTERNAL-001",
    status: "draft",
    issueDate: "2026-10-23",
    validUntil: "2026-11-22",
    customerName: "既存内部顧客",
    customerContact: "内部担当",
    productName: "G011 internal regression",
    sizeSummary: "80×120mm / 1連",
    quantity: "5000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "1",
    filmMeterPrice: "200",
    filmOrderLengthM: "500",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "50000",
    tax: "5000",
    grandTotal: "55000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "manual-entry",
    resultHash: "",
    payload: {},
  }, admin.id, "admin");
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

describe("portal quote admin authorization", () => {
  it("allows only active Kanei admin users", () => {
    expect(canViewPortalQuotes({
      ...admin,
      sessionId: 1,
    })).toBe(true);
    expect(canViewPortalQuotes(null)).toBe(false);
    expect(canViewPortalQuotes({ ...admin, sessionId: 1, role: "user" })).toBe(false);
    expect(canViewPortalQuotes({ ...admin, sessionId: 1, isActive: false })).toBe(false);
    expect(canViewPortalQuotes({ ...admin, sessionId: 1, email: "admin@727.co.jp" })).toBe(false);
    expect(() => requirePortalQuoteAdmin(null)).toThrow("admin_quote_access_denied");
  });

  it("denies unauthenticated and ordinary internal API callers", async () => {
    const unauthenticated = portalQuotesRoute(
      new Request("https://admin.test/api/admin/portal-quotes"),
      { params: Promise.resolve({}) },
    );
    const ordinary = portalQuotesRoute(authedRequest(ordinaryToken), { params: Promise.resolve({}) });
    await expect(unauthenticated).resolves.toMatchObject({ status: 401 });
    await expect(ordinary).resolves.toMatchObject({ status: 403 });
  });
});

describe("portal quote admin projection", () => {
  it("lists portal quotes newest-first with safe linkage metadata", async () => {
    const page = await firstAdminPage("?limit=20");
    expect(page.quotes).toHaveLength(2);
    expect(page.quotes.map((quote) => quote.quotationNumber)).toEqual([
      secondQuote.quotationNumber,
      firstQuote.quotationNumber,
    ]);
    const newest = page.quotes[0];
    expect(newest.publicId).toBe(secondQuote.publicId);
    expect(newest.quotationId).toBe(secondQuote.quotationId);
    expect(newest.source).toBe("customer_portal");
    expect(newest.sourceLabel).toBe("顧客ポータル");
    expect(newest.customerCode).toBe(portalUser.customerCode);
    expect(newest.customer).toMatchObject({
      code: portalUser.customerCode,
      name: "ポータルG011株式会社",
      contact: "ポータル太郎",
      telephone: "03-0000-0000",
      email: portalUser.email,
    });
    expect(newest.displayedTotals).toEqual({
      pricePerPiece: secondQuote.displayedUnitPrice,
      subtotal: expect.any(String),
      tax: expect.any(String),
      grandTotal: secondQuote.displayedGrandTotal,
    });
    expect(newest.pdfAvailable).toBe(true);
    expect(Object.keys(newest).sort()).toEqual([
      "customer",
      "customerCode",
      "displayedTotals",
      "issueDate",
      "mappingCreatedAt",
      "pdfAvailable",
      "productName",
      "publicId",
      "quantity",
      "quotationId",
      "quotationNumber",
      "quotationUpdatedAt",
      "sizeSummary",
      "source",
      "sourceLabel",
      "status",
      "validUntil",
    ]);
    expect(JSON.stringify(newest)).not.toContain("calculationRequest");
    expect(JSON.stringify(newest)).not.toContain("calculationResult");
    expect(JSON.stringify(newest)).not.toContain("password_hash");
  });

  it("supports safe pagination and quote/customer search", async () => {
    const firstPage = await firstAdminPage("?page=1&limit=1");
    expect(firstPage.pagination).toMatchObject({ page: 1, limit: 1, total: 2, totalPages: 2, hasNext: true });
    expect(firstPage.quotes[0].publicId).toBe(secondQuote.publicId);

    const secondPage = await firstAdminPage("?page=2&limit=1");
    expect(secondPage.pagination).toMatchObject({ page: 2, totalPages: 2, hasPrevious: true, hasNext: false });
    expect(secondPage.quotes[0].publicId).toBe(firstQuote.publicId);

    const byNumber = await firstAdminPage(`?q=${encodeURIComponent(secondQuote.quotationNumber)}`);
    expect(byNumber.quotes).toHaveLength(1);
    expect(byNumber.quotes[0].publicId).toBe(secondQuote.publicId);

    const byCustomerCode = await firstAdminPage(`?q=${encodeURIComponent(portalUser.customerCode)}`);
    expect(byCustomerCode.quotes).toHaveLength(2);

    const noMatch = await firstAdminPage("?q=no-such-portal-quote");
    expect(noMatch.quotes).toEqual([]);
    expect(noMatch.pagination.total).toBe(0);
  });
});

describe("portal data visibility in existing masters and quotation flow", () => {
  it("finds the provisioned portal customer through existing customer functions", async () => {
    const customers = await listCustomers("", 100, "kanei", admin.email);
    const codes = customers.map((customer) => customer.customerCode);
    expect(codes).toContain(portalUser.customerCode);
    await expect(getCustomer("kanei", portalUser.customerCode)).resolves.toMatchObject({
      ownerDomain: "kanei",
      customerCode: portalUser.customerCode,
      customerName: "ポータルG011株式会社",
    });
  });

  it("finds portal quotes through the existing admin quotation list flow", async () => {
    const records = await listQuotations({ limit: 500 });
    const numbers = records.map((record) => record.quotationNumber);
    expect(numbers).toContain(firstQuote.quotationNumber);
    expect(numbers).toContain(secondQuote.quotationNumber);

    const searched = await listQuotations({ q: "ポータルG011株式会社", limit: 500 });
    expect(searched.map((record) => record.quotationNumber).sort()).toEqual([
      firstQuote.quotationNumber,
      secondQuote.quotationNumber,
    ].sort());
    const portalRecords = records.filter((record) => [
      firstQuote.quotationNumber,
      secondQuote.quotationNumber,
    ].includes(record.quotationNumber));
    expect(portalRecords.map((record) => record.createdBy.email)).toEqual([
      "portal-service@system.invalid",
      "portal-service@system.invalid",
    ]);
  });

  it("keeps a separately created internal quote visible without portal mapping", async () => {
    const internal = await listQuotations({ q: "G011 internal regression", limit: 10 });
    expect(internal).toHaveLength(1);
    expect(internal[0].customerName).toBe("既存内部顧客");
    const portalPage = await firstAdminPage("?q=G011%20internal%20regression");
    expect(portalPage.quotes).toEqual([]);
  });
});
