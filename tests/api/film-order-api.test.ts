import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-order-api-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-api-password";
process.env.ADMIN_NAME = "Seven API";

const { GET: listRoute } = await import("@/app/api/film-orders/route");
const { POST: uploadSession } = await import("@/app/api/film-orders/[id]/upload-session/route");
const { POST: actionRoute } = await import("@/app/api/film-orders/[id]/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { createUser } = await import("@/lib/auth-store");
const { saveQuotation } = await import("@/lib/quotation-store");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

function request(url: string, init: RequestInit = {}, token?: string): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { cookie: `pouch_session=${token}` } : {}) },
  });
}

async function loginToken(email: string, password: string): Promise<string | undefined> {
  const response = await login(request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
  return response.headers.get("set-cookie")?.match(/pouch_session=([^;]+)/)?.[1];
}

const input: QuotationRecordInput = {
  quotationNumber: "S7-FILM-API-001",
  status: "approved",
  issueDate: "2026-10-08",
  validUntil: "2026-11-08",
  customerName: "API権限検証株式会社",
  customerContact: "",
  productName: "API検証パウチ",
  sizeSummary: "60×80mm",
  quantity: "50000",
  fillingCostPerPiece: "4",
  filmCostPerPiece: "5",
  filmMeterPrice: "180",
  filmOrderLengthM: "1700",
  targetMargin: "0.3",
  taxRatePercent: "10",
  pricePerPiece: "20",
  subtotal: "1000000",
  tax: "100000",
  grandTotal: "1100000",
  deliveryDate: "",
  paymentTerms: "",
  notes: "",
  calculationVersion: "film-order-api-test",
  resultHash: "",
  payload: { purchaseOrder: { printingMethod: "digital", orderLengthM: "1700", webWidthMm: 556 } },
};

describe("film order API permissions and workflow", () => {
  let orderId = 0;
  let sevenToken: string | undefined;
  let kaneiToken: string | undefined;
  let outsiderToken: string | undefined;

  beforeAll(async () => {
    const adminId = await createUser({ email: "seven@727.co.jp", name: "Seven", password: "seven-api-password", role: "admin" }).then((u) => u.id).catch(() => 1);
    await createUser({ email: "kanei@kanei-trade.co.jp", name: "Kanei", password: "kanei-api-password", role: "user" });
    await createUser({ email: "outsider@example.com", name: "Outsider", password: "outsider-password", role: "user" });
    sevenToken = await loginToken("seven@727.co.jp", "seven-api-password");
    kaneiToken = await loginToken("kanei@kanei-trade.co.jp", "kanei-api-password");
    outsiderToken = await loginToken("outsider@example.com", "outsider-password");
    const record = await saveQuotation(input, adminId, "admin");
    orderId = record.id;
  });

  it("requires film workflow access", async () => {
    const unauthorized = await listRoute(request("http://localhost/api/film-orders"));
    expect(unauthorized.status).toBe(401);
    const forbidden = await listRoute(request("http://localhost/api/film-orders", {}, outsiderToken));
    expect(forbidden.status).toBe(403);
  });

  it("syncs approved quotations on list and restricts actions by role", async () => {
    const list = await listRoute(request("http://localhost/api/film-orders", {}, sevenToken));
    const payload = await list.json() as { created: number; orders: Array<{ id: number; status: string }> };
    expect(list.status).toBe(200);
    expect(payload.created).toBe(1);
    expect(payload.orders).toHaveLength(1);
    orderId = payload.orders[0]!.id;

    const outsiderAction = await actionRoute(
      request(`http://localhost/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark-ordered" }),
      }, outsiderToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(outsiderAction.status).toBe(403);

    const marked = await actionRoute(
      request(`http://localhost/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark-ordered" }),
      }, sevenToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(marked.status).toBe(200);
    expect(await marked.json()).toMatchObject({ order: { status: "ordered" } });
  });

  it("keeps receiving for Seven and proof for Kanei", async () => {
    const kaneiReceiving = await actionRoute(
      request(`http://localhost/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "register-receiving", aiFileName: "API検証パウチ.ai", pdfFileName: "API検証パウチ.pdf" }),
      }, kaneiToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(kaneiReceiving.status).toBe(403);

    const sevenReceiving = await actionRoute(
      request(`http://localhost/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "register-receiving", aiFileName: "API検証パウチ.ai", pdfFileName: "API検証パウチ.pdf" }),
      }, sevenToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(sevenReceiving.status).toBe(200);
    const receivingPayload = await sevenReceiving.json() as { order: { status: string }; mails: Array<{ dryRun: boolean }> };
    expect(receivingPayload.order.status).toBe("receiving_registered");
    expect(receivingPayload.mails.every((mail) => mail.dryRun)).toBe(true);

    const kaneiProof = await actionRoute(
      request(`http://localhost/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "register-proof", fileName: "校正_v1.ai" }),
      }, kaneiToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(kaneiProof.status).toBe(200);
    expect(await kaneiProof.json()).toMatchObject({ order: { status: "proof_registered" } });

    const kaneiApprove = await actionRoute(
      request(`http://localhost/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }, kaneiToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(kaneiApprove.status).toBe(403);

    const sevenReProof = await actionRoute(
      request(`http://localhost/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "request-re-proof", comment: "色を調整" }),
      }, sevenToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(sevenReProof.status).toBe(200);
    expect(await sevenReProof.json()).toMatchObject({ order: { status: "re_proof_requested" } });
  });

  it("reports direct upload as unavailable without service account credentials", async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_SA_CLIENT_EMAIL;
    delete process.env.GOOGLE_SA_PRIVATE_KEY;
    const response = await uploadSession(
      request(`http://localhost/api/film-orders/${orderId}/upload-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: "receiving", fileName: "test.ai" }),
      }, sevenToken),
      { params: Promise.resolve({ id: String(orderId) }) } as never,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "drive_not_configured" });
  });

  it("maps domain errors to status codes", async () => {
    const missing = await actionRoute(
      request("http://localhost/api/film-orders/999999", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "mark-ordered" }),
      }, sevenToken),
      { params: Promise.resolve({ id: "999999" }) } as never,
    );
    expect(missing.status).toBe(404);
  });
});
