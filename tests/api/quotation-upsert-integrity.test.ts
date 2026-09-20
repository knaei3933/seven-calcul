import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-upsert-integrity-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@upsert-integrity.test";
process.env.ADMIN_PASSWORD = "admin-upsert-integrity";
process.env.ADMIN_NAME = "Integrity Admin";

const { createUser } = await import("@/lib/auth-store");
const {
  getDatabaseForTest,
  getQuotation,
  QuotationOwnershipConflictError,
  saveQuotation,
} = await import("@/lib/quotation-store");

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

const baseInput: QuotationRecordInput = {
  quotationNumber: "S7-UPSERT-INTEGRITY",
  status: "draft",
  issueDate: "2026-09-20",
  validUntil: "2026-10-20",
  customerName: "Integrity Customer",
  customerContact: "Owner",
  productName: "Integrity Pouch",
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
  payload: { revision: 1 },
};

describe("quotation upsert ownership and referential integrity", () => {
  it("does not mutate another owner's record in a racing conditional upsert", async () => {
    const owner = await createUser({ email: "owner@upsert.test", name: "Owner", password: "owner-upsert-password", role: "user" });
    const attacker = await createUser({ email: "attacker@upsert.test", name: "Attacker", password: "attacker-upsert-password", role: "user" });
    await createUser({ email: "admin-user@upsert.test", name: "Admin User", password: "admin-user-upsert-password", role: "admin" });
    const original = await saveQuotation(baseInput, owner.id, "user");

    await expect(saveQuotation({
      ...baseInput,
      status: "approved",
      quantity: "999",
      pricePerPiece: "1",
      subtotal: "999",
      tax: "99",
      grandTotal: "1098",
      payload: { revision: 999 },
    }, attacker.id, "user")).rejects.toBeInstanceOf(QuotationOwnershipConflictError);

    const unchanged = await getQuotation(original.id);
    expect(unchanged?.status).toBe("draft");
    expect(unchanged?.quantity).toBe("10000");
    expect(unchanged?.payload).toEqual({ revision: 1 });
    expect(unchanged?.createdBy.id).toBe(owner.id);
    expect(unchanged?.updatedBy?.id).toBe(owner.id);

    const adminUpdated = await saveQuotation({
      ...baseInput,
      status: "sent",
      quantity: "20000",
      payload: { revision: 2 },
    }, attacker.id, "admin");
    expect(adminUpdated.status).toBe("sent");
    expect(adminUpdated.createdBy.id).toBe(owner.id);
    expect(adminUpdated.updatedBy?.id).toBe(attacker.id);
  });

  it("enforces users relationships with foreign keys on the quotation connection", async () => {
    const db = await getDatabaseForTest();
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(Number(foreignKeys.foreign_keys)).toBe(1);

    const owner = await createUser({ email: "referenced@upsert.test", name: "Referenced Owner", password: "referenced-upsert-password", role: "user" });
    const record = await saveQuotation({ ...baseInput, quotationNumber: "S7-FK-INTEGRITY" }, owner.id, "user");
    expect(() => db.prepare("DELETE FROM users WHERE id = ?").run(owner.id))
      .toThrow(/FOREIGN KEY/u);
    expect(await getQuotation(record.id)).not.toBeNull();
  });
});
