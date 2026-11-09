import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-owner-cold-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "cold-admin@migration.test";
process.env.ADMIN_PASSWORD = "cold-admin-password";
process.env.ADMIN_NAME = "Cold Admin";

const { createUser } = await import("@/lib/auth-store");
const { getDatabaseForTest, saveIssuedQuotation } = await import("@/lib/quotation-store");

const kaneiCreator = await createUser({
  email: "creator@kanei-trade.co.jp",
  name: "Cold Kanei",
  password: "cold-kanei-password",
  role: "user",
});
const sevenCreator = await createUser({
  email: "creator@727.co.jp",
  name: "Cold Seven",
  password: "cold-seven-password",
  role: "user",
});

function input(quotationNumber: string): QuotationRecordInput {
  return {
    quotationNumber,
    status: "sent",
    issueDate: "2026-11-04",
    validUntil: "2026-12-04",
    customerName: "Cold Start",
    customerContact: "担当",
    productName: "Pouch",
    sizeSummary: "50x60",
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
    calculationVersion: "cold-start",
    resultHash: "cold-start-hash",
    payload: {},
  };
}

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation owner schema cold start", () => {
  it("creates a constrained durable owner column and derives issuance owner", async () => {
    const pdf = Buffer.from("%PDF-cold-owner", "utf8");
    const preparedByKanei = await saveIssuedQuotation(
      input(""), kaneiCreator.id, "user", pdf, "kanei.pdf", null,
    );
    const seven = await saveIssuedQuotation(
      input(""), sevenCreator.id, "user", pdf, "seven.pdf", null,
    );
    expect(preparedByKanei.record.ownerDomain).toBe("kanei");
    expect(seven.record.ownerDomain).toBe("kanei");

    const db = await getDatabaseForTest();
    const columns = await db.all<{ name: string; type: string; dflt_value: string | null; notnull: number }>(
      "PRAGMA table_info(quotations)",
    );
    const ownerColumn = columns.find((column) => column.name === "owner_domain");
    expect(ownerColumn).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'unresolved'" });
    const tableSql = await db.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='quotations'",
    );
    expect(tableSql?.sql).toContain("CHECK(owner_domain IN ('kanei','seven','unresolved'))");
  });
});
