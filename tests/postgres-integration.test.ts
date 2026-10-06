import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseUrl = process.env.POUCH_TEST_DATABASE_URL;

const databaseDirectory = await mkdtemp(join(tmpdir(), "postgres-integration-"));
if (databaseUrl) {
  process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "unused.sqlite");
  process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "unused-customers.sqlite");
  process.env.DATABASE_URL = databaseUrl;
  process.env.ADMIN_EMAIL = "pg-admin@integration.test";
  process.env.ADMIN_PASSWORD = "pg-admin-password";
  process.env.ADMIN_NAME = "PG Admin";
}

// POUCH_TEST_DATABASE_URL が設定されている環境（ローカル検証・CI）でのみ実行する。
describe.skipIf(!databaseUrl)("PostgreSQL-backed stores", () => {
  let pool: Pool;

  beforeAll(async () => {
    const { Pool: PgPool } = await import("pg");
    pool = new PgPool({ connectionString: databaseUrl });
    await pool.query(`
      DROP TABLE IF EXISTS quotation_checklists CASCADE;
      DROP TABLE IF EXISTS quotations CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS customers CASCADE;
    `);
  });

  afterAll(async () => {
    const { closeDatabaseForTest } = await import("@/lib/auth-store");
    await closeDatabaseForTest();
    await pool.end();
    await rm(databaseDirectory, { recursive: true, force: true });
  });

  const baseInput: QuotationRecordInput = {
    quotationNumber: "S7-PG-INTEGRITY-001",
    status: "draft",
    issueDate: "2026-10-06",
    validUntil: "2026-11-06",
    customerName: "PostgreSQL顧客",
    customerContact: "担当",
    productName: "PGテストパウチ",
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

  it("stores users, quotations, checklists, and customers in PostgreSQL", async () => {
    const { ensureAdministratorSeed, createUser, authenticate } = await import("@/lib/auth-store");
    const administratorId = await ensureAdministratorSeed();
    expect(Number.isInteger(administratorId)).toBe(true);

    const owner = await createUser({
      email: "owner@pg.test",
      name: "PG Owner",
      password: "owner-password-123",
      role: "user",
    });
    const other = await createUser({
      email: "other@pg.test",
      name: "PG Other",
      password: "other-password-123",
      role: "user",
    });
    await expect(createUser({
      email: "OWNER@PG.TEST",
      name: "Duplicate",
      password: "duplicate-password",
      role: "user",
    })).rejects.toThrow("duplicate_email");
    expect(await authenticate("owner@pg.test", "owner-password-123")).toMatchObject({ id: owner.id });

    const { saveQuotation, getQuotation, listQuotations, QuotationOwnershipConflictError } = await import("@/lib/quotation-store");
    const saved = await saveQuotation(baseInput, owner.id, "user");
    expect(saved.quotationNumber).toBe(baseInput.quotationNumber);
    expect(saved.payload).toEqual({ revision: 1 });
    expect(saved.createdBy.email).toBe("owner@pg.test");

    await expect(saveQuotation({ ...baseInput, quantity: "999" }, other.id, "user"))
      .rejects.toBeInstanceOf(QuotationOwnershipConflictError);

    const searched = await listQuotations({ q: "postgresql", limit: 10 });
    expect(searched.some((record) => record.id === saved.id)).toBe(true);
    expect(await getQuotation(saved.id)).not.toBeNull();

    const { updateQuotationStatus } = await import("@/lib/quotation-store");
    const approved = await updateQuotationStatus(saved.id, "approved", other.id);
    expect(approved?.status).toBe("approved");

    const { createChecklistsForQuotation, getChecklistsForQuotation, updateChecklistItem } = await import("@/lib/quotation-store");
    const { calculatePouchCost } = await import("@/lib/calculation");
    const { buildCalculationChecklistSnapshot } = await import("@/lib/calculation-checklist");
    const calculated = calculatePouchCost({
      spec: {
        sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      },
      quantity: "10000", printingMethod: "digital",
    });
    const snapshot = buildCalculationChecklistSnapshot(calculated, {
      quotationNumber: approved!.quotationNumber,
      customerName: approved!.customerName,
      printingMethod: "digital",
      sourceHash: "source-hash",
      resultHash: "result-hash",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      skus: [{ name: "PG充填物", quantity: "10000", fillMl: "3", colorCount: "4" }],
    });
    const checklists = await createChecklistsForQuotation(approved!, snapshot);
    expect(checklists.map((entry) => entry.audience)).toEqual(["CUSTOMER", "INTERNAL_QA"]);
    const reloaded = await getChecklistsForQuotation(approved!.id);
    expect(reloaded).toHaveLength(2);
    const customerChecklist = reloaded.find((entry) => entry.audience === "CUSTOMER");
    expect(customerChecklist).toBeDefined();
    const updatedChecklist = await updateChecklistItem(approved!.id, "CUSTOMER", "film.total", true, "PG担当");
    expect(updatedChecklist!.acceptedCount).toBeGreaterThan(0);

    const { saveCustomer, getCustomer, listCustomers } = await import("@/lib/customer-store");
    const customer = await saveCustomer({
      customerCode: "PG-001",
      customerName: "PostgreSQL顧客マスタ",
      customerPostalCode: "1000001",
      customerAddress: "東京都",
      customerContact: "PG担当",
      customerTelephone: "03-0000-0000",
      customerEmail: "customer@pg.test",
    });
    expect(customer.customerCode).toBe("PG-001");
    expect(await getCustomer("pg-001")).toBeNull();
    const customers = await listCustomers("postgresql");
    expect(customers).toHaveLength(1);

    const { getDatabaseForTest } = await import("@/lib/quotation-store");
    const db = await getDatabaseForTest();
    expect(db.dialect).toBe("postgres");
    await expect(db.run("DELETE FROM users WHERE id = ?", [owner.id]))
      .rejects.toThrow(/foreign key/iu);
  });
});
