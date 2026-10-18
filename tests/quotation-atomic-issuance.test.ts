// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { calculatePouchCost } from "@/lib/calculation";
import { defaultParameters } from "@/lib/constants";
import { buildCalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-atomic-issuance-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@atomic.test";
process.env.ADMIN_PASSWORD = "admin-atomic-password";
process.env.ADMIN_NAME = "Atomic Admin";

const { createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const {
  getDatabaseForTest,
  getQuotationPdf,
  QuotationPdfIntegrityError,
  QuotationCanonicalPdfExistsError,
  saveIssuedQuotation,
} = await import("@/lib/quotation-store");

const pdf = Buffer.concat([Buffer.from("%PDF-"), Buffer.from([0x01, 0x02, 0xff, 0xfe])]);
const changedPdf = Buffer.concat([Buffer.from("%PDF-"), Buffer.from([0x03, 0x04, 0xaa, 0xbb])]);
const actor = await createUser({
  email: "owner@atomic.test",
  name: "Atomic Owner",
  password: "owner-atomic-password",
  role: "user",
});
const calculation = calculatePouchCost({
  spec: {
    sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3",
    connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4, isCustom: false,
    colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
  },
  quantity: "10000", printingMethod: "digital",
});
const checklistSnapshot = buildCalculationChecklistSnapshot(calculation, {
  quotationNumber: "S7-ATOMIC-001",
  customerName: "Atomic Customer",
  printingMethod: "digital",
  sourceHash: calculation.audit.resultJsonSha256,
  resultHash: calculation.audit.resultJsonSha256,
  filmComposition: "PET12+AL7+PET12+LLDPE50μ",
});

function quotationInput(): QuotationRecordInput {
  return {
    quotationNumber: "S7-ATOMIC-001",
    status: "draft",
    issueDate: "2026-10-15",
    validUntil: "2026-11-15",
    customerName: "Atomic Customer",
    customerContact: "Atomic Contact",
    productName: "Atomic Pouch",
    sizeSummary: "50×60mm / 1連",
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
    calculationVersion: "simulator-linked",
    resultHash: calculation.audit.resultJsonSha256,
    payload: { revision: 1, calculationChecklistSnapshot: checklistSnapshot },
  };
}

async function persistedIssuance(quotationId: number) {
  const db = await getDatabaseForTest();
  return {
    quotation: await db.get("SELECT * FROM quotations WHERE id = ?", [quotationId]),
    checklists: await db.all<{ audience: string }>(
      "SELECT audience FROM quotation_checklists WHERE quotation_id = ? ORDER BY audience",
      [quotationId],
    ),
    pdf: await getQuotationPdf(quotationId),
  };
}

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("atomic quotation issuance", () => {
  it("commits quotation, checklists, exact bytes, and digest together", async () => {
    const issued = await saveIssuedQuotation(
      quotationInput(),
      actor.id,
      "user",
      pdf,
      "S7-ATOMIC-001.pdf",
      checklistSnapshot,
    );
    const persisted = await persistedIssuance(issued.record.id);
    expect(persisted.quotation).toMatchObject({ customer_name: "Atomic Customer" });
    expect(persisted.checklists.map((row) => row.audience)).toEqual(["CUSTOMER", "INTERNAL_QA"]);
    expect(persisted.pdf?.data.equals(pdf)).toBe(true);
    expect(issued.pdfSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("serializes same-number creation and rejects the loser without an orphan record", async () => {
    const secondNumber = `${quotationInput().quotationNumber}-R2`;
    const [first, second] = await Promise.allSettled([
      saveIssuedQuotation(
        { ...quotationInput(), quotationNumber: secondNumber },
        actor.id,
        "user",
        pdf,
        `${secondNumber}.pdf`,
        checklistSnapshot,
      ),
      saveIssuedQuotation(
        { ...quotationInput(), quotationNumber: secondNumber, customerName: "Race Loser" },
        actor.id,
        "user",
        changedPdf,
        `${secondNumber}.pdf`,
        checklistSnapshot,
      ),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.reason).toBeInstanceOf(QuotationCanonicalPdfExistsError);
    const db = await getDatabaseForTest();
    const rows = await db.all(
      "SELECT id, customer_name, pdf_sha256 FROM quotations WHERE quotation_number = ?",
      [secondNumber],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_name: "Atomic Customer" });
  });

  it("rejects a failed reissue and leaves metadata, digest, and canonical bytes unchanged", async () => {
    const issued = await saveIssuedQuotation(
      { ...quotationInput(), quotationNumber: "S7-ATOMIC-002" },
      actor.id,
      "user",
      pdf,
      "S7-ATOMIC-002.pdf",
      checklistSnapshot,
    );
    const before = await persistedIssuance(issued.record.id);
    await expect(saveIssuedQuotation(
      { ...quotationInput(), quotationNumber: "S7-ATOMIC-002", customerName: "Corrected" },
      actor.id,
      "user",
      changedPdf,
      "S7-ATOMIC-002.pdf",
      checklistSnapshot,
    )).rejects.toBeInstanceOf(QuotationCanonicalPdfExistsError);
    expect(await persistedIssuance(issued.record.id)).toEqual(before);
  });

  it("verifies the stored SHA-256 digest on retrieval", async () => {
    const issued = await saveIssuedQuotation(
      { ...quotationInput(), quotationNumber: "S7-ATOMIC-DIGEST" },
      actor.id,
      "user",
      pdf,
      "S7-ATOMIC-DIGEST.pdf",
      checklistSnapshot,
    );
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET pdf_data = ? WHERE id = ?", [changedPdf, issued.record.id]);
    await expect(getQuotationPdf(issued.record.id)).rejects.toBeInstanceOf(QuotationPdfIntegrityError);
  });

  it("rolls back quotation and checklist writes when associated checklist persistence fails", async () => {
    const db = await getDatabaseForTest();
    await db.exec(`
      CREATE TRIGGER force_quotation_checklist_failure
      BEFORE INSERT ON quotation_checklists
      BEGIN
        SELECT RAISE(ABORT, 'forced_checklist_failure');
      END
    `);
    try {
      await expect(saveIssuedQuotation(
        { ...quotationInput(), quotationNumber: "S7-ATOMIC-003" },
        actor.id,
        "user",
        pdf,
        "S7-ATOMIC-003.pdf",
        checklistSnapshot,
      )).rejects.toThrow("forced_checklist_failure");
      const quotations = await db.all("SELECT id FROM quotations WHERE quotation_number = 'S7-ATOMIC-003'");
      const checklists = await db.all(`
        SELECT quotation_checklists.quotation_id
        FROM quotation_checklists
        LEFT JOIN quotations ON quotations.id = quotation_checklists.quotation_id
        WHERE quotations.id IS NULL
           OR quotations.quotation_number = 'S7-ATOMIC-003'
      `);
      expect(quotations).toEqual([]);
      expect(checklists).toEqual([]);
    } finally {
      await db.exec("DROP TRIGGER force_quotation_checklist_failure");
    }
  });
});
