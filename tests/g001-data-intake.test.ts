// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "g001-data-intake-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-data-intake-password";
process.env.ADMIN_NAME = "Seven Data Intake";

const { GET: dataIntakeRoute } = await import("@/app/api/data-intake/route");
const { POST: approvalRoute } = await import("@/app/api/quotations/[id]/approvals/route");
const { createSession, createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const { getDatabaseForTest, saveQuotation } = await import("@/lib/quotation-store");
const { syncFilmOrdersFromQuotations } = await import("@/lib/film-orders");
const { listFilmOrderIntakeEntries } = await import("@/lib/film-order-intake");

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function input(quotationNumber: string): QuotationRecordInput {
  return {
    quotationNumber,
    status: "draft",
    issueDate: "2026-11-06",
    validUntil: "2099-12-31",
    customerName: "データ受入株式会社",
    customerContact: "担当",
    productName: "受入検証パウチ",
    sizeSummary: "60×80mm",
    quantity: "10000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "5",
    filmMeterPrice: "180",
    filmOrderLengthM: "1700",
    targetMargin: "0.3",
    taxRatePercent: "10",
    pricePerPiece: "20",
    subtotal: "200000",
    tax: "20000",
    grandTotal: "220000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "g001-data-intake",
    resultHash: "g001-hash",
    payload: {
      customerEmail: "customer@example.test",
      purchaseOrder: {
        printingMethod: "digital",
        orderLengthM: "1700",
        webWidthMm: 556,
      },
    },
  };
}

describe("G001 data intake approval transfer", () => {
  it("creates the durable film order at internal approval and exposes one linked intake entry", async () => {
    const owner = await createUser({
      email: "seven-owner@727.co.jp",
      name: "Seven Data Intake",
      password: "seven-data-intake-password",
      role: "user",
    });
    const quotation = await saveQuotation(input("S7-G001-INTAKE-001"), owner.id, "user");
    const session = await createSession(owner.id);
    const request = (url: string, body?: unknown) => new Request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        cookie: `pouch_session=${session.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const approvalResponse = await approvalRoute(
      request(`http://localhost/api/quotations/${quotation.id}/approvals`, { gate: "internal" }),
      { params: Promise.resolve({ id: String(quotation.id) }) },
    );
    expect(approvalResponse.status).toBe(200);
    await expect(approvalResponse.json()).resolves.toMatchObject({
      gate: "internal",
      filmOrderSynced: true,
      record: { id: quotation.id, internalApproval: { approvedBy: { id: owner.id } } },
    });

    const db = await getDatabaseForTest();
    const linkedOrder = await db.get<{ id: number; order_number: string }>(
      "SELECT id, order_number FROM film_orders WHERE quotation_id = ?",
      [quotation.id],
    );
    expect(linkedOrder?.id).toBeGreaterThan(0);
    expect(linkedOrder?.order_number).toMatch(/^F-\d{6}-001$/u);

    const listResponse = await dataIntakeRoute(request("http://localhost/api/data-intake"));
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json();
    expect(listPayload.created).toBe(0);
    expect(listPayload.entries).toHaveLength(1);
    expect(listPayload.entries[0]).toMatchObject({
      quotationId: quotation.id,
      quotationNumber: "S7-G001-INTAKE-001",
      productName: "受入検証パウチ",
      customerName: "データ受入株式会社",
      quantity: "10000",
      internalApprovedAt: expect.any(String),
      ownerDomain: "seven",
      state: "linked",
      filmOrder: {
        id: linkedOrder?.id,
        orderNumber: linkedOrder?.order_number,
        status: "pending",
      },
      makerHandoffStatus: "not_registered",
      proofStatus: "pending",
      dualApprovalStatus: "pending",
      poStatus: "not_sent",
    });

    await expect(syncFilmOrdersFromQuotations("seven@727.co.jp")).resolves.toBe(0);
  });

  it("keeps an internally approved unresolved owner fail-closed without a film order", async () => {
    const outsider = await createUser({
      email: "unresolved-owner@example.test",
      name: "Unresolved Owner",
      password: "unresolved-owner-password",
      role: "user",
    });
    const quotation = await saveQuotation(input("UNRESOLVED-G001-001"), outsider.id, "user");
    const db = await getDatabaseForTest();
    await db.run(
      "UPDATE quotations SET owner_domain='unresolved', quotation_number='UNRESOLVED-G001-001' WHERE id=?",
      [quotation.id],
    );
    const unauthorized = await dataIntakeRoute(new Request("http://localhost/api/data-intake"));
    expect(unauthorized.status).toBe(401);
    const outsiderSession = await createSession(outsider.id);
    const forbidden = await dataIntakeRoute(new Request("http://localhost/api/data-intake", {
      headers: { cookie: `pouch_session=${outsiderSession.token}` },
    }));
    expect(forbidden.status).toBe(403);
    const updateResult = await db.run(
      "UPDATE quotations SET internal_approved_at = ? WHERE id = ?",
      [new Date().toISOString(), quotation.id],
    );
    expect(Number(updateResult.changes)).toBe(1);

    await expect(syncFilmOrdersFromQuotations("seven@727.co.jp")).resolves.toBe(0);
    const entries = await listFilmOrderIntakeEntries({}, null);
    const unresolved = entries.find((entry) => entry.quotationId === quotation.id);
    if (!unresolved) throw new Error(`intake entries: ${JSON.stringify(entries)}`);
    expect(unresolved).toMatchObject({
      quotationNumber: "UNRESOLVED-G001-001",
      ownerDomain: "unresolved",
      state: "unresolved_owner",
      filmOrder: null,
    });
  });
});
