import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "internal-checklist-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "gotou@727.co.jp";
process.env.ADMIN_PASSWORD = "gotou-admin-password";
process.env.ADMIN_NAME = "Gotou Admin";

const { POST: login } = await import("@/app/api/auth/login/route");
const { GET: getChecklists, PATCH: patchChecklist } = await import("@/app/api/quotations/[id]/checklists/route");
const { saveQuotation } = await import("@/lib/quotation-store");
const { createChecklistsForQuotation } = await import("@/lib/quotation-store");
const { createUser } = await import("@/lib/auth-store");
const { calculatePouchCost } = await import("@/lib/calculation");
const { buildCalculationChecklistSnapshot } = await import("@/lib/calculation-checklist");

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

describe("internal (Kanei Trade) checklist visibility and updates", () => {
  let quotationId = 0;
  let firstInternalItemId = "";
  let kaneiToken: string | undefined;
  let sevenToken: string | undefined;

  beforeAll(async () => {
    await createUser({ email: "kim@kanei-trade.co.jp", name: "Kanei QA", password: "kanei-password-123", role: "admin" });
    kaneiToken = await loginToken("kim@kanei-trade.co.jp", "kanei-password-123");
    sevenToken = await loginToken("gotou@727.co.jp", "gotou-admin-password");
    const calculated = calculatePouchCost({
      spec: {
        sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      },
      quantity: "10000", printingMethod: "digital",
    });
    const snapshot = buildCalculationChecklistSnapshot(calculated, {
      quotationNumber: "S7-INTERNAL-ACCESS",
      customerName: "アクセス検証株式会社",
      printingMethod: "digital",
      sourceHash: "source-hash",
      resultHash: "result-hash",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      skus: [{ name: "検証充填物", quantity: "10000", fillMl: "3", colorCount: "4" }],
    });
    const input: QuotationRecordInput = {
      quotationNumber: "S7-INTERNAL-ACCESS",
      status: "draft",
      issueDate: "2026-10-07",
      validUntil: "2026-11-07",
      customerName: "アクセス検証株式会社",
      customerContact: "担当",
      productName: "検証パウチ",
      sizeSummary: "50×60mm / 1連",
      quantity: "10000",
      fillingCostPerPiece: "1",
      filmCostPerPiece: "1",
      filmMeterPrice: "328",
      filmOrderLengthM: "500",
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "3.5",
      subtotal: "35000",
      tax: "3500",
      grandTotal: "38500",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: "access-test",
      resultHash: "result-hash",
      payload: { calculationChecklistSnapshot: snapshot },
    };
    const record = await saveQuotation(input, 1, "admin");
    quotationId = record.id;
    // /checklists/[id] ページ訪問時に生成されるチェックリストを事前に作成する。
    await createChecklistsForQuotation(record, snapshot);
  });

  it("hides the internal QA checklist from non-Kanei users in GET", async () => {
    const response = await getChecklists(
      request(`http://localhost/api/quotations/${quotationId}/checklists`, {}, sevenToken),
      { params: Promise.resolve({ id: String(quotationId) }) } as never,
    );
    const payload = await response.json() as { checklists: Array<{ audience: string }> };
    expect(payload.checklists.map((record) => record.audience)).toEqual(["CUSTOMER"]);
  });

  it("shows both checklists to Kanei Trade users in GET", async () => {
    const response = await getChecklists(
      request(`http://localhost/api/quotations/${quotationId}/checklists`, {}, kaneiToken),
      { params: Promise.resolve({ id: String(quotationId) }) } as never,
    );
    const payload = await response.json() as { checklists: Array<{ audience: string; items: Array<{ id: string }> }> };
    expect(payload.checklists.map((record) => record.audience)).toEqual(["CUSTOMER", "INTERNAL_QA"]);
    const internal = payload.checklists.find((record) => record.audience === "INTERNAL_QA");
    firstInternalItemId = internal!.items[0]!.id;
  });

  it("rejects internal QA updates from non-Kanei users", async () => {
    const response = await patchChecklist(
      request(`http://localhost/api/quotations/${quotationId}/checklists`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: "INTERNAL_QA", itemId: firstInternalItemId, accepted: true, checkedBy: "" }),
      }, sevenToken),
      { params: Promise.resolve({ id: String(quotationId) }) } as never,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "internal_checklist_forbidden" });
  });

  it("accepts internal QA updates from Kanei Trade users", async () => {
    const response = await patchChecklist(
      request(`http://localhost/api/quotations/${quotationId}/checklists`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: "INTERNAL_QA", itemId: firstInternalItemId, accepted: true, checkedBy: "" }),
      }, kaneiToken),
      { params: Promise.resolve({ id: String(quotationId) }) } as never,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as { checklist: { audience: string; acceptedCount: number } };
    expect(payload.checklist.audience).toBe("INTERNAL_QA");
    expect(payload.checklist.acceptedCount).toBe(1);
  });
});
