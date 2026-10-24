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
const { GET: getQuotationRoute } = await import("@/app/api/quotations/[id]/route");
const { PATCH: patchQuotation } = await import("@/app/api/quotations/[id]/route");
const { DELETE: deleteQuotation } = await import("@/app/api/quotations/[id]/route");
const { createUser } = await import("@/lib/auth-store");
const { POST: postQuotationApproval } = await import("@/app/api/quotations/[id]/approvals/route");
const {
  approveQuotationGate,
  saveQuotation,
  updateQuotationStatus,
} = await import("@/lib/quotation-store");
const { syncFilmOrdersFromQuotations } = await import("@/lib/film-orders");
const { getQuotation: getQuotationRecord } = await import("@/lib/quotation-store");
const { filmOrderExistsForQuotation } = await import("@/lib/film-orders");

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
    validUntil: "2099-12-31",
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
  it("allows shared reads and restricts status/delete to creator or admin", { timeout: 30_000 }, async () => {
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
    const kaneiAdmin = await createUser({
      email: "kanei-approver@kanei-trade.co.jp",
      name: "Kanei Approver",
      password: "kanei-approver-password",
      role: "admin",
    });
    const kaneiAdminToken = await loginToken(kaneiAdmin.email, "kanei-approver-password");
    const record = await createRecord("S7-PERMISSION-001", owner.id);
    const context = { params: Promise.resolve({ id: String(record.id) }) };

    await expect(getQuotationRoute(request("http://localhost/api/quotations/1", {}, readerToken), context)).resolves.toMatchObject({ status: 200 });
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
    expect(ownerPatch.status).toBe(409);
    await expect(ownerPatch.json()).resolves.toEqual({ error: "invalid_status_transition" });

    // Customer approval is evidence only. A sales owner must move the sent
    // quotation to 成約 explicitly before film-order synchronization.
    await approveQuotationGate(record.id, "internal", owner.id);
    await updateQuotationStatus(record.id, "sent", owner.id);
    const approvalResponse = await postQuotationApproval(request(
      "http://localhost/api/quotations/1/approvals",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gate: "customerApproval" }),
      },
      kaneiAdminToken,
    ), context);
    expect(approvalResponse.status).toBe(200);
    const approvalPayload = await approvalResponse.json();
    expect(approvalPayload).toMatchObject({
      gate: "customerApproval",
      filmOrderSynced: false,
      record: { id: record.id, status: "sent" },
    });
    expect(approvalPayload.record.customerApproval).not.toBeNull();
    expect(await filmOrderExistsForQuotation(record.id)).toBe(false);

    const contractResponse = await patchQuotation(request(
      `http://localhost/api/quotations/${record.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
      ownerToken,
    ), context);
    expect(contractResponse.status).toBe(200);
    await expect(contractResponse.json()).resolves.toMatchObject({ record: { id: record.id, status: "approved" } });
    expect(await filmOrderExistsForQuotation(record.id)).toBe(true);

    const manualRecord = await createRecord("S7-PERMISSION-MANUAL-APPROVED", owner.id);
    await approveQuotationGate(manualRecord.id, "internal", owner.id);
    const manualContext = { params: Promise.resolve({ id: String(manualRecord.id) }) };
    const manualApproved = await patchQuotation(request(
      `http://localhost/api/quotations/${manualRecord.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
      ownerToken,
    ), manualContext);
    expect(manualApproved.status).toBe(200);
    const manualPayload = await manualApproved.json();
    expect(manualPayload.record.id).toBe(manualRecord.id);
    expect(manualPayload.record.status).toBe("approved");
    const persistedManualResponse = await getQuotationRoute(request(`http://localhost/api/quotations/${manualRecord.id}`, {}, ownerToken), manualContext);
    await expect(persistedManualResponse.json()).resolves.toMatchObject({
      record: { id: manualRecord.id, status: "approved" },
    });
    expect(await filmOrderExistsForQuotation(manualRecord.id)).toBe(true);

    // The 成約 option stays visible, but the server still rejects conversion before internal approval.
    const noGateRecord = await createRecord("S7-PERMISSION-NO-GATE-APPROVED", owner.id);
    const noGateContext = { params: Promise.resolve({ id: String(noGateRecord.id) }) };
    const noGateResponse = await patchQuotation(request(
      `http://localhost/api/quotations/${noGateRecord.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      },
      ownerToken,
    ), noGateContext);
    expect(noGateResponse.status).toBe(409);
    await expect(noGateResponse.json()).resolves.toEqual({ error: "internal_approval_required" });
    expect(await filmOrderExistsForQuotation(noGateRecord.id)).toBe(false);

    const readerDelete = await deleteQuotation(request("http://localhost/api/quotations/1", { method: "DELETE" }, readerToken), context);
    expect(readerDelete.status).toBe(403);
    const ownerDelete = await deleteQuotation(request("http://localhost/api/quotations/1", { method: "DELETE" }, ownerToken), context);
    // 成約済みでフィルム発注管理に反映された見積はワークフロー保護のため削除できない。
    expect(ownerDelete.status).toBe(409);
    await expect(ownerDelete.json()).resolves.toEqual({ error: "film_order_exists" });
  });
});
