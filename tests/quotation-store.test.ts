import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeQuotation } from "@/lib/quotation-history";
import { calculatePouchCost } from "@/lib/calculation";
import { buildCalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-store-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
const { createChecklistsForQuotation, getChecklistsForQuotation, getQuotation, saveQuotation, updateChecklistItem } = await import("@/lib/quotation-store");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation persistence with a manually edited selling price", () => {
  it("stores simulator cost, displayed price, and reverse-calculated profit", async () => {
    const input: QuotationRecordInput = {
      quotationNumber: "S7-TEST-EDIT-001",
      status: "draft",
      issueDate: "2026-09-05",
      validUntil: "2026-10-05",
      customerName: "上書き単価テスト株式会社",
      customerContact: "担当者様",
      productName: "テストパウチ",
      sizeSummary: "50×60mm / 1連",
      quantity: "10000",
      fillingCostPerPiece: "4",
      filmCostPerPiece: "1",
      filmMeterPrice: "226",
      filmOrderLengthM: "500",
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "8.1",
      subtotal: "81000",
      tax: "8100",
      grandTotal: "89100",
      deliveryDate: "別途相談",
      paymentTerms: "別途相談",
      notes: "A4面で見積単価を直接修正",
      calculationVersion: "simulator-linked",
      resultHash: "test-result-hash",
      payload: {
        quantity: "10000",
        fillingCostPerPiece: "4",
        filmCostPerPiece: "1",
        pricePerPieceDisplay: "8.1",
        targetMargin: "0.4",
        resultHash: "test-result-hash",
        profitAudit: {
          basis: "displayed-unit-price",
          quantity: "10000",
          totalCostPerPiece: "5",
          proposedPricePerPiece: "8.1",
          profitPerPiece: "3.1",
          profitMarginRate: "0.38271604938271604938271604938271604938",
          profitMarginPercent: "38.271604938271604938271604938271604938",
          targetMarginRate: "0.4",
          targetMarginPercent: "40",
          totalProfit: "31000",
        },
      },
    };

    const saved = await saveQuotation(input);
    const persisted = await getQuotation(saved.id);
    expect(persisted).not.toBeNull();
    expect(persisted!.pricePerPiece).toBe("8.1");
    expect(persisted!.subtotal).toBe("81000");
    expect(persisted!.grandTotal).toBe("89100");
    expect(persisted!.targetMargin).toBe("0.4");

    const audit = persisted!.payload.profitAudit as Record<string, string>;
    expect(audit.basis).toBe("displayed-unit-price");
    expect(audit.totalCostPerPiece).toBe("5");
    expect(audit.proposedPricePerPiece).toBe("8.1");
    expect(audit.profitPerPiece).toBe("3.1");
    expect(audit.totalProfit).toBe("31000");

    const analysis = analyzeQuotation(persisted!);
    expect(analysis.costUnit.toNumber()).toBe(5);
    expect(analysis.sellingUnit.toNumber()).toBe(8.1);
    expect(analysis.profitUnit.toNumber()).toBe(3.1);
    expect(analysis.profitRate.toFixed(8)).toBe("38.27160494");
    expect(analysis.totalProfit.toNumber()).toBe(31000);
    expect(analysis.storedProfitRate.toFixed(8)).toBe("38.27160494");
  });

  it("creates separate customer and internal QA calculation checklists", async () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3", connectedChambers: 1,
        fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      },
      quantity: "10000", printingMethod: "digital",
    });
    const snapshot = buildCalculationChecklistSnapshot(result, {
      quotationNumber: "S7-CHECKLIST-001",
      customerName: "チェック株式会社",
      printingMethod: "digital",
      sourceHash: "checklist-hash",
      resultHash: "checklist-result-hash",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
    });
    const quotationInput: QuotationRecordInput = {
      quotationNumber: "S7-CHECKLIST-001",
      status: "draft",
      issueDate: "2026-09-08",
      validUntil: "2026-10-08",
      customerName: "チェック株式会社",
      customerContact: "QA",
      productName: "チェックパウチ",
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
      calculationVersion: "checklist-test",
      resultHash: "checklist-hash",
      payload: {
        calculationChecklistSnapshot: snapshot,
      },
    };
    const saved = await saveQuotation(quotationInput);
    const created = await createChecklistsForQuotation(saved, snapshot);
    expect(created).toHaveLength(2);
    expect(created.map((record) => record.audience)).toEqual(["CUSTOMER", "INTERNAL_QA"]);
    expect(created.every((record) => record.totalCount > 10)).toBe(true);
    expect(created.every((record) => record.acceptedCount === 0)).toBe(true);

    const updated = await updateChecklistItem(saved.id, "CUSTOMER", "film.total", true, "テスト顧客");
    const records = await getChecklistsForQuotation(saved.id);
    const customerRecord = records.find((record) => record.audience === "CUSTOMER")!;
    const internalRecord = records.find((record) => record.audience === "INTERNAL_QA")!;
    expect(updated!.acceptedCount).toBeGreaterThan(0);
    expect(customerRecord.acceptedCount).toBeGreaterThan(0);
    expect(internalRecord.acceptedCount).toBe(0);
    expect(customerRecord.items.find((item) => item.id === "film.total")!.accepted).toBe(true);
    expect(internalRecord.items.find((item) => item.id === "film.total")!.accepted).toBe(false);
  });
});
