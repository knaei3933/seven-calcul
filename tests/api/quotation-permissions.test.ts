import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecord } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-permissions-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@permissions.test";
process.env.ADMIN_PASSWORD = "admin-permissions-password";
process.env.ADMIN_NAME = "Permissions Admin";

const { POST: login } = await import("@/app/api/auth/login/route");
const { GET: getQuotation } = await import("@/app/api/quotations/[id]/route");
const { PATCH: patchQuotation } = await import("@/app/api/quotations/[id]/route");
const { DELETE: deleteQuotation } = await import("@/app/api/quotations/[id]/route");
const { createUser } = await import("@/lib/auth-store");
const { saveQuotation } = await import("@/lib/quotation-store");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

async function loginToken(email: string, password: string): Promise<string> {
  const response = await login(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
  const token = response.headers.get("set-cookie")?.match(/pouch_session=([^;]+)/)?.[1];
  if (!token) throw new Error("login_failed");
  return token;
}

function request(url: string, init: RequestInit, token: string): Request {
  return new Request(url, {
    ...init,
    headers: { ...init.headers, cookie: `pouch_session=${token}` },
  });
}

async function createRecord(number: string, creatorId: number): Promise<QuotationRecord> {
  return saveQuotation({
    quotationNumber: number,
    status: "draft",
    issueDate: "2026-09-20",
    validUntil: "2026-10-20",
    customerName: "Permissions",
    customerContact: "Tester",
    productName: "Permission Pouch",
    sizeSummary: "50×90mm / 1連",
    quantity: "10000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "1",
    filmMeterPrice: "200",
    filmOrderLengthM: "500",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "100000",
    tax: "10000",
    grandTotal: "110000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "manual-entry",
    resultHash: "",
    payload: {},
  }, creatorId);
}

describe("quotation ownership permissions", () => {
  it("allows shared reads and restricts status/delete to creator or admin", async () => {
    const owner = await createUser({
      email: "owner@permissions.test",
      name: "Owner",
      password: "owner-permission-password",
      role: "user",
    });
    const reader = await createUser({
      email: "reader@permissions.test",
      name: "Reader",
      password: "reader-permission-password",
      role: "user",
    });
    const ownerToken = await loginToken(owner.email, "owner-permission-password");
    const readerToken = await loginToken(reader.email, "reader-permission-password");
    const adminToken = await loginToken("admin@permissions.test", "admin-permissions-password");
    const record = await createRecord("S7-PERMISSION-001", owner.id);
    const context = { params: Promise.resolve({ id: String(record.id) }) };

    await expect(getQuotation(request("http://localhost/api/quotations/1", {}, readerToken), context)).resolves.toMatchObject({ status: 200 });
    const forbidden = await patchQuotation(request("http://localhost/api/quotations/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    }, readerToken), context);
    expect(forbidden.status).toBe(403);

    const ownerPatch = await patchQuotation(request("http://localhost/api/quotations/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    }, ownerToken), context);
    expect(ownerPatch.status).toBe(200);
    const payload = await ownerPatch.json();
    expect(payload.record.status).toBe("sent");
    expect(payload.record.createdBy.id).toBe(owner.id);
    expect(payload.record.updatedBy.id).toBe(owner.id);

    const adminPatch = await patchQuotation(request("http://localhost/api/quotations/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "approved" }),
    }, adminToken), context);
    expect(adminPatch.status).toBe(200);

    const readerDelete = await deleteQuotation(request("http://localhost/api/quotations/1", { method: "DELETE" }, readerToken), context);
    expect(readerDelete.status).toBe(403);
    const ownerDelete = await deleteQuotation(request("http://localhost/api/quotations/1", { method: "DELETE" }, ownerToken), context);
    expect(ownerDelete.status).toBe(200);
  });
});
