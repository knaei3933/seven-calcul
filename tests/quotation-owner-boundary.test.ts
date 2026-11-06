import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-owner-boundary-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "seed-admin@boundary.test";
process.env.ADMIN_PASSWORD = "seed-admin-password";
process.env.ADMIN_NAME = "Boundary Seed Admin";

const { createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const {
  getDatabaseForTest,
  getQuotation,
  QuotationActionForbiddenError,
  UnresolvedQuotationOwnerError,
  saveIssuedQuotation,
  saveQuotation,
} = await import("@/lib/quotation-store");
const { canMutateQuotation, canPerformOwnerWorkflowAction } = await import("@/lib/quotation-access");

const kaneiCreator = await createUser({
  email: "kanei.creator@kanei-trade.co.jp",
  name: "Kanei Creator",
  password: "kanei-creator-password",
  role: "user",
});
const sevenCreator = await createUser({
  email: "seven.creator@727.co.jp",
  name: "Seven Creator",
  password: "seven-creator-password",
  role: "user",
});
const sevenAdmin = await createUser({
  email: "seven.admin@727.co.jp",
  name: "Seven Admin",
  password: "seven-admin-password",
  role: "admin",
});
const kaneiAdmin = await createUser({
  email: "kanei.admin@kanei-trade.co.jp",
  name: "Kanei Admin",
  password: "kanei-admin-password",
  role: "admin",
});
const inactiveSevenCreator = await createUser({
  email: "inactive.creator@727.co.jp",
  name: "Inactive Seven Creator",
  password: "inactive-seven-creator-password",
  role: "user",
});
const movedSevenCreator = await createUser({
  email: "moving.creator@727.co.jp",
  name: "Moving Seven Creator",
  password: "moving-seven-creator-password",
  role: "user",
});

function input(quotationNumber: string, status: QuotationRecordInput["status"] = "draft"): QuotationRecordInput {
  return {
    quotationNumber,
    status,
    issueDate: "2026-11-04",
    validUntil: "2099-12-31",
    customerName: "Boundary Customer",
    customerContact: "Boundary Contact",
    productName: "Boundary Pouch",
    sizeSummary: "50x90",
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
    calculationVersion: "owner-boundary",
    resultHash: "",
    payload: { revision: 1 },
  };
}

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation durable owner boundaries", () => {
  it("denies a creator whose current email/domain no longer matches the durable owner", async () => {
    const created = await saveQuotation(input("S7-DOMAIN-CHANGE", "sent"), movedSevenCreator.id);
    const db = await getDatabaseForTest();
    await db.run("UPDATE users SET email = ? WHERE id = ?", ["moved@example.test", movedSevenCreator.id]);
    const actor = { id: movedSevenCreator.id, email: "moved@example.test" };

    expect(canPerformOwnerWorkflowAction(actor, created)).toBe(false);
    expect(canMutateQuotation(actor, created)).toBe(true);
  });

  it("requires an active matching owner even for issuance", async () => {
    const db = await getDatabaseForTest();
    await db.run("UPDATE users SET is_active = 0 WHERE id = ?", [inactiveSevenCreator.id]);
    const pdf = Buffer.from("%PDF-inactive-owner", "utf8");
    await expect(saveIssuedQuotation(
      input("S7-INACTIVE-ISSUANCE", "sent"),
      inactiveSevenCreator.id,
      "user",
      pdf,
      "inactive.pdf",
      null,
    )).rejects.toBeInstanceOf(UnresolvedQuotationOwnerError);

    const activeQuoteOwner = await createUser({
      email: "active.company.owner@727.co.jp",
      name: "Active Company Owner",
      password: "active-company-owner-password",
      role: "user",
    });
    const inactiveActorQuote = await saveQuotation(
      input("S7-INACTIVE-ACTOR", "sent"),
      activeQuoteOwner.id,
    );
    expect(canPerformOwnerWorkflowAction({
      id: inactiveSevenCreator.id,
      email: inactiveSevenCreator.email,
      isActive: false,
    }, inactiveActorQuote)).toBe(false);
  });

  it("binds stale legacy numbers to Seven issuance", async () => {
    const kaneiPrepared = await saveQuotation(input("KT-KANEI-PREPARED"), kaneiCreator.id);
    expect(kaneiPrepared.ownerDomain).toBe("seven");
    const sevenPreparedFromKt = await saveQuotation(input("KT-SEVEN-MISMATCH"), sevenCreator.id);
    expect(sevenPreparedFromKt.quotationNumber).toMatch(/^S7-/);
    expect(sevenPreparedFromKt.ownerDomain).toBe("seven");

    const pdf = Buffer.from("%PDF-prefix-binding", "utf8");
    const normalizedIssued = await saveIssuedQuotation(
      input("KT-SEVEN-ISSUE-MISMATCH", "sent"), sevenCreator.id, "user", pdf, "seven.pdf", null,
    );
    expect(normalizedIssued.created).toBe(true);
    expect(normalizedIssued.record.quotationNumber).toMatch(/^S7-/);
    expect(normalizedIssued.record.ownerDomain).toBe("seven");

    const kaneiPreparedIssued = await saveIssuedQuotation(
      input("S7-KANEI-PREPARED", "sent"), kaneiCreator.id, "user", pdf, "kanei.pdf", null,
    );
    const seven = await saveIssuedQuotation(
      input("S7-PREFIX-BOUND", "sent"), sevenCreator.id, "user", pdf, "seven.pdf", null,
    );
    expect(kaneiPreparedIssued.record.ownerDomain).toBe("seven");
    expect(seven.record.ownerDomain).toBe("seven");
    expect(kaneiPreparedIssued.created).toBe(true);
    expect(seven.created).toBe(true);
  });

  it("uses the durable Seven owner, not creator identity or cross-company admin", async () => {
    const owned = await saveQuotation(input("S7-DURABLE-OWNER", "sent"), sevenCreator.id);
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET created_by = ? WHERE id = ?", [kaneiCreator.id, owned.id]);
    const durableRecord = await getQuotation(owned.id);
    expect(durableRecord).toMatchObject({ ownerDomain: "seven", createdBy: { id: kaneiCreator.id } });

    expect(canMutateQuotation(
      { id: kaneiCreator.id, email: kaneiCreator.email },
      durableRecord!,
    )).toBe(true);
    expect(canMutateQuotation(
      { id: kaneiAdmin.id, email: kaneiAdmin.email, role: "admin" },
      durableRecord!,
    )).toBe(false);
    expect(canMutateQuotation(
      { id: sevenAdmin.id, email: sevenAdmin.email, role: "admin" },
      durableRecord!,
    )).toBe(true);

    await expect(saveIssuedQuotation(
      input("S7-DURABLE-OWNER", "sent"),
      kaneiAdmin.id,
      "admin",
      Buffer.from("%PDF-cross-company", "utf8"),
      "cross-company.pdf",
      null,
    )).rejects.toBeInstanceOf(QuotationActionForbiddenError);
    const unchanged = await db.get<{ payload_json: string; status: string; has_pdf: number }>(
      "SELECT payload_json, status, (pdf_data IS NOT NULL) AS has_pdf FROM quotations WHERE id = ?",
      [owned.id],
    );
    expect(unchanged).toEqual({
      payload_json: JSON.stringify({ revision: 1 }),
      status: "sent",
      has_pdf: 0,
    });

    const updatedBySameCompanyAdmin = await saveQuotation({
      ...input("S7-DURABLE-OWNER"),
      status: "approved",
      payload: { revision: 2 },
    }, sevenAdmin.id, "admin");
    expect(updatedBySameCompanyAdmin).toMatchObject({
      status: "approved",
      ownerDomain: "seven",
      updatedBy: { id: sevenAdmin.id },
    });
  });

  it("preserves an arbitrary legacy number on a same-owner update", async () => {
    const owner = await createUser({
      email: "legacy.owner@727.co.jp",
      name: "Legacy Owner",
      password: "legacy-owner-password",
      role: "user",
    });
    const generated = await saveQuotation(input("S7-LEGACY-BOUNDARY-ORIGIN"), owner.id);
    const db = await getDatabaseForTest();
    await db.run(
      "UPDATE quotations SET quotation_number = ? WHERE id = ?",
      ["LEGACY-BOUNDARY-001", generated.id],
    );
    const legacy = await getQuotation(generated.id);
    const updated = await saveQuotation({
      ...input("LEGACY-BOUNDARY-001"),
      status: "sent",
      payload: { revision: 2 },
    }, owner.id, "user");
    expect(legacy).toMatchObject({ id: generated.id, quotationNumber: "LEGACY-BOUNDARY-001" });
    expect(updated).toMatchObject({
      id: legacy!.id,
      quotationNumber: "LEGACY-BOUNDARY-001",
      status: "sent",
      ownerDomain: "seven",
    });
  });
});
