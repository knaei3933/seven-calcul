// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentRequestContext } from "@/lib/agent-auth-store";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-approval-provenance-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "approval-provenance-admin-password";
process.env.ADMIN_NAME = "Approval Provenance Admin";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const { buildCustomerApprovalToken } = await import("@/lib/quotation-approval-token");
const { createUser } = await import("@/lib/auth-store");
const {
  approveQuotationByCustomerToken,
  approveQuotationGate,
  getDatabaseForTest,
  getQuotation,
  rerunQuotationApprovalSourceMigrationForTest,
  saveQuotation,
  updateQuotationStatus,
} = await import("@/lib/quotation-store");
const { readAgentQuoteApprovalState } = await import("@/lib/agent-quote-read-service");

function input(number: string): QuotationRecordInput {
  return {
    quotationNumber: number,
    status: "draft",
    issueDate: "2026-11-10",
    validUntil: "2099-12-31",
    customerName: "承認証跡Customer",
    customerContact: "担当",
    productName: "Pouch",
    sizeSummary: "50×90mm",
    quantity: "1000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "1",
    filmMeterPrice: "200",
    filmOrderLengthM: "500",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "10000",
    tax: "1000",
    grandTotal: "11000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "approval-provenance",
    resultHash: "c".repeat(64),
    payload: { customerEmail: "provenance-customer@example.test" },
  };
}

const kaneiCreator = await createUser({
  email: "creator@kanei-trade.co.jp",
  name: "Kanei Creator",
  password: "creator-password",
  role: "user",
});
const kaneiApprover = await createUser({
  email: "approver@kanei-trade.co.jp",
  name: "Kanei Approver",
  password: "approver-password",
  role: "user",
});
const tokenRecord = await saveQuotation(input("KT-APPROVAL-TOKEN-001"), kaneiCreator.id);
const genericRecord = await saveQuotation(input("KT-APPROVAL-OWNER-001"), kaneiCreator.id);
const expiredRecord = await saveQuotation(input("KT-APPROVAL-EXPIRED-001"), kaneiCreator.id);
const rejectedRecord = await saveQuotation(input("KT-APPROVAL-REJECTED-001"), kaneiCreator.id);
const legacyTokenRecord = await saveQuotation(input("KT-APPROVAL-LEGACY-TOKEN-001"), kaneiCreator.id);
const legacyOwnerRecord = await saveQuotation(input("KT-APPROVAL-LEGACY-OWNER-001"), kaneiCreator.id);

for (const record of [tokenRecord, genericRecord, expiredRecord]) {
  await approveQuotationGate(record.id, "internal", kaneiApprover.id);
  await updateQuotationStatus(record.id, "sent", kaneiApprover.id);
}

function agentContext(): AgentRequestContext {
  return {
    auth: {
      credentialId: "provenance-reader-credential",
      userId: kaneiApprover.id,
      principalEmail: "ai@kanei-trade.co.jp",
      name: "Hermes Agent",
      scopes: ["approval_state:read"],
    },
    correlationId: "provenance-test",
  };
}

async function approvalState(id: number) {
  return (await readAgentQuoteApprovalState(new Request("https://app.test/x"), agentContext(), id)).customerApproval;
}

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("durable customer approval provenance", () => {
  it("writes customer_token only from the verified customer-token route", async () => {
    const before = await getQuotation(tokenRecord.id);
    const token = buildCustomerApprovalToken(before!);
    await expect(approveQuotationByCustomerToken(`${token}tampered`))
      .rejects.toThrow("invalid_customer_approval_token");
    const approved = await approveQuotationByCustomerToken(token, {
      customerIpHash: "ip-hash",
      userAgent: "UA",
    });
    expect(approved.customerApproval).toMatchObject({
      approvedAt: expect.any(String),
      source: "customer_token",
    });
    expect(await approvalState(tokenRecord.id)).toEqual({
      state: "customer_approved",
      approvedAt: approved.customerApproval?.approvedAt ?? null,
      source: "customer_token",
    });
  });

  it("marks generic owner-domain approval as non-token evidence", async () => {
    const approved = await approveQuotationGate(genericRecord.id, "customerApproval", kaneiApprover.id);
    expect(approved.customerApproval).toMatchObject({
      approvedAt: expect.any(String),
      approvedBy: { id: kaneiApprover.id },
      source: "owner_domain",
    });
    expect(await approvalState(genericRecord.id)).toEqual({
      state: "owner_domain_approved",
      approvedAt: approved.customerApproval?.approvedAt ?? null,
      source: "owner_domain",
    });
  });

  it("reports expired and blocked transitions without inventing token evidence", async () => {
    const db = await getDatabaseForTest();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.run("UPDATE quotations SET valid_until = ? WHERE id = ?", [yesterday, expiredRecord.id]);
    expect(await approvalState(expiredRecord.id)).toMatchObject({
      state: "approval_expired",
      source: null,
    });
    await updateQuotationStatus(rejectedRecord.id, "rejected", kaneiCreator.id);
    expect(await approvalState(rejectedRecord.id)).toMatchObject({
      state: "approval_blocked",
      source: null,
    });
  });

  it("migrates compatible legacy evidence once and never infers from null afterward", async () => {
    const db = await getDatabaseForTest();
    await db.run(`
      UPDATE quotations
      SET customer_approved_at = '2026-01-01T00:00:00.000Z', customer_approved_by = NULL,
          customer_approval_source = NULL
      WHERE id = ?
    `, [legacyTokenRecord.id]);
    await db.run(`
      UPDATE quotations
      SET customer_approved_at = '2026-01-02T00:00:00.000Z', customer_approved_by = ?,
          customer_approval_source = NULL
      WHERE id = ?
    `, [kaneiApprover.id, legacyOwnerRecord.id]);

    await rerunQuotationApprovalSourceMigrationForTest();
    await rerunQuotationApprovalSourceMigrationForTest();
    const rows = await db.all<{ id: number; customer_approval_source: string | null }>(
      "SELECT id, customer_approval_source FROM quotations WHERE id IN (?, ?) ORDER BY id",
      [legacyTokenRecord.id, legacyOwnerRecord.id],
    );
    expect(rows).toEqual([
      { id: legacyTokenRecord.id, customer_approval_source: "customer_token" },
      { id: legacyOwnerRecord.id, customer_approval_source: "owner_domain" },
    ]);
    expect(await approvalState(legacyTokenRecord.id)).toMatchObject({
      state: "customer_approved",
      source: "customer_token",
    });

    await db.run("UPDATE quotations SET customer_approval_source = NULL WHERE id = ?", [legacyTokenRecord.id]);
    expect(await approvalState(legacyTokenRecord.id)).toMatchObject({
      state: "approval_evidence_unresolved",
      source: null,
    });
    const columns = await db.all<{ name: string }>("PRAGMA table_info(quotations)");
    expect(columns.some((column) => column.name === "customer_approval_source")).toBe(true);
  });
});
