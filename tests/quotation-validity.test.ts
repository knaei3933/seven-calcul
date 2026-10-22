import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-validity-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@quotation-validity.test";
process.env.ADMIN_PASSWORD = "admin-validity-password";
process.env.ADMIN_NAME = "Validity Admin";

const { expireDueQuotations, getQuotation, isQuotationValidityExpired, listQuotations, saveQuotation, validateQuotationInput } = await import("@/lib/quotation-store");
const { createUser } = await import("@/lib/auth-store");

const actor = await createUser({
  email: "owner@quotation-validity.test",
  name: "Validity Owner",
  password: "owner-validity-password",
  role: "user",
});

function input(number: string, validUntil: string): QuotationRecordInput {
  return {
    quotationNumber: number,
    status: "sent",
    issueDate: "2026-10-01",
    validUntil,
    customerName: "有効期限テスト株式会社",
    customerContact: "",
    productName: "テスト製品",
    sizeSummary: "50×60mm / 1連",
    quantity: "10000",
    fillingCostPerPiece: "0",
    filmCostPerPiece: "0",
    filmMeterPrice: "0",
    filmOrderLengthM: "0",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "100000",
    tax: "10000",
    grandTotal: "110000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "validity-test",
    resultHash: `validity-${number}`,
    payload: {},
  };
}

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation validity", () => {
  let pastId: number;
  let futureId: number;

  beforeAll(async () => {
    const past = await saveQuotation(input("S7-VALIDITY-PAST", "2000-01-01"), actor.id, "user");
    const future = await saveQuotation(input("S7-VALIDITY-FUTURE", "9999-12-31"), actor.id, "user");
    pastId = past.id;
    futureId = future.id;
  });

  it("rejects a validity date that is not a calendar date", () => {
    expect(validateQuotationInput(input("S7-INVALID", "not-a-date"))).toBeNull();
  });

  it("expires only unanswered sent quotations and keeps future quotations sent", async () => {
    await expireDueQuotations();

    const past = await getQuotation(pastId);
    expect(past?.status).toBe("expired");
    const future = await getQuotation(futureId);
    expect(future?.status).toBe("sent");

    const records = await listQuotations({ status: "sent" });
    expect(records.map((record) => record.quotationNumber)).toContain("S7-VALIDITY-FUTURE");
    expect(records.map((record) => record.quotationNumber)).not.toContain("S7-VALIDITY-PAST");
  });

  it("treats the valid-until date itself as still valid", () => {
    const todayJapan = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const tomorrowJapan = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    expect(isQuotationValidityExpired(todayJapan, todayJapan)).toBe(false);
    expect(isQuotationValidityExpired(tomorrowJapan, todayJapan)).toBe(false);
    expect(isQuotationValidityExpired("2000-01-01", todayJapan)).toBe(true);
  });
});
