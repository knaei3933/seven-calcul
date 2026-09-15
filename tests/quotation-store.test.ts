import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeQuotation } from "@/lib/quotation-history";
import { calculatePouchCost } from "@/lib/calculation";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { buildQuotationDraft } from "@/lib/quotation-draft";
import { buildCalculationChecklistSnapshot, buildLegacyChecklistItems } from "@/lib/calculation-checklist";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-store-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
const { createChecklistsForQuotation, createLegacyChecklistsForQuotation, getChecklistsForQuotation, getQuotation, saveQuotation, updateChecklistItem } = await import("@/lib/quotation-store");

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
      skus: [{
        name: "テスト充填物",
        quantity: "10000",
        fillMl: "3",
        colorCount: "4",
      }],
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
    const customerItems = created[0]!.items;
    expect(customerItems.find((item) => item.id === "basic.quantity")!.inputs).toContain("10,000");
    expect(customerItems.find((item) => item.id === "film.sku.0")!.inputs).toContain("テスト充填物");
    expect(customerItems.find((item) => item.id === "film.total")!.substitution).toContain("164,000");
    expect(customerItems.every((item) => !/[가-힣]/u.test(item.category + item.variable + item.explanation + item.formula + item.substitution))).toBe(true);

    const updated = await updateChecklistItem(saved.id, "CUSTOMER", "film.total", true, "テスト顧客");
    const records = await getChecklistsForQuotation(saved.id);
    const customerRecord = records.find((record) => record.audience === "CUSTOMER")!;
    const internalRecord = records.find((record) => record.audience === "INTERNAL_QA")!;
    expect(updated!.acceptedCount).toBeGreaterThan(0);
    expect(customerRecord.acceptedCount).toBeGreaterThan(0);
    expect(internalRecord.acceptedCount).toBe(0);
    expect(customerRecord.items.find((item) => item.id === "film.total")!.accepted).toBe(true);
    expect(internalRecord.items.find((item) => item.id === "film.total")!.accepted).toBe(false);

    const changedSnapshot = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    changedSnapshot.resultHash = "checklist-hash-updated";
    changedSnapshot.quantity = "20000";
    const updatedInput: QuotationRecordInput = {
      ...quotationInput,
      quantity: "20000",
      resultHash: "checklist-hash-updated",
      payload: {
        calculationChecklistSnapshot: changedSnapshot,
      },
    };
    const updatedQuotation = await saveQuotation(updatedInput);
    const rebuilt = await createChecklistsForQuotation(updatedQuotation, changedSnapshot);
    const rebuiltCustomerItem = rebuilt[0]!.items.find((item) => item.id === "basic.quantity")!;

    expect(rebuilt[0]!.snapshot.resultHash).toBe("checklist-hash-updated");
    expect(rebuiltCustomerItem.result).toBe("20,000");
    expect(rebuiltCustomerItem.substitution).toContain("20,000");
    expect(await getChecklistsForQuotation(updatedQuotation.id)).toHaveLength(2);
  });
  
  it("rebuilds checklists when the snapshot changes but the calculation hash is unchanged", async () => {
    const baseSnapshot = buildCalculationChecklistSnapshot(
      calculatePouchCost({
        spec: {
          sizeKey: "round-50x60", customWidthMm: "50", customLengthMm: "60", fillMlPerChamber: "3", connectedChambers: 1,
          fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 1, bulkUnitPrice: "0", skuCount: 1,
        },
        quantity: "10000", printingMethod: "digital",
      }),
      {
        quotationNumber: "S7-SNAPSHOT-REFRESH",
        printingMethod: "digital",
        sourceHash: "same-source-hash",
        resultHash: "same-result-hash",
        filmComposition: "PET12+AL7+PET12+LLDPE50",
        skus: [{ name: "旧SKU", quantity: "10000", fillMl: "3", colorCount: "1" }],
      },
    );
    const input: QuotationRecordInput = {
      quotationNumber: "S7-SNAPSHOT-REFRESH",
      status: "draft",
      issueDate: "2026-09-12",
      validUntil: "2026-10-12",
      customerName: "スナップショット更新株式会社",
      customerContact: "QA",
      productName: "更新テスト",
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
      calculationVersion: "snapshot-refresh-test",
      resultHash: "same-result-hash",
      payload: { calculationChecklistSnapshot: baseSnapshot },
    };
    const saved = await saveQuotation(input);
    await createChecklistsForQuotation(saved, baseSnapshot);

    const changedSnapshot = {
      ...baseSnapshot,
      quantity: "20000",
      skus: (baseSnapshot.skus ?? []).map((sku) => ({ ...sku, quantity: "20000" })),
    };
    const updated = await saveQuotation({ ...input, quantity: "20000", payload: { calculationChecklistSnapshot: changedSnapshot } });
    const rebuilt = await createChecklistsForQuotation(updated, changedSnapshot);
    expect(rebuilt[0]!.snapshot.quantity).toBe("20000");
    expect(rebuilt[0]!.items.find((item) => item.id === "basic.quantity")!.result).toBe("20,000");
  });

  it("carries a purchase-order snapshot with SKU order details into the quotation draft", () => {
    const activeResult = calculatePouchCost({
      spec: {
        sizeKey: "tube-35x80", fillMlPerChamber: "3", connectedChambers: 1, fillingMethod: "hopper", fillingLanes: 4,
        isCustom: false, colorCount: 2, bulkUnitPrice: "0", skuCount: 2,
        skuQuantities: ["79800", "53200"], skuNames: ["Serum", "Emulsion"],
        skuFillMlPerChamber: ["10", "30"], skuColorCounts: ["2", "4"],
      },
      quantity: "133000",
      printingMethod: "gravure",
      recommendationMode: true,
      selectedCandidateId: "",
    });
    const candidate = activeResult.recommendationCandidates?.find((item) => item.route === "Y");
    expect(candidate).toBeDefined();

    const draft = buildQuotationDraft(activeResult, {
      quotationNumber: "",
      sourceHash: activeResult.audit.resultJsonSha256,
      resultHash: activeResult.audit.resultJsonSha256,
      widthMm: "35",
      lengthMm: "80",
      connected: "1",
      skuNames: ["Serum", "Emulsion"],
      targetMargin: "0.3",
      printingMethod: activeResult.printingMethod,
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      webWidthMm: 356,
      lanes: 4,
      pitchMm: "86",
      pitchAddMm: "6",
      prodMultiplier: 1,
      colorCount: 6,
      skus: candidate!.adjustedSkuQuantities.map((quantity, index) => ({
        name: index === 0 ? "Serum" : "Emulsion",
        quantity,
        fillMl: index === 0 ? "10" : "30",
        colorCount: index === 0 ? "2" : "4",
      })),
      lossRate: "0.1",
      bulkUnitPrice: "0",
    });

    expect(draft.purchaseOrder?.printingMethod).toBe("gravure");
    expect(draft.purchaseOrder?.skuColorCounts).toEqual(["2", "4"]);
    expect(draft.purchaseOrder?.skuOrderDetails.map((sku) => Number(sku.quantity))).toEqual(candidate!.adjustedSkuQuantities.map(Number));
  });

  it("uses the selected gravure material width for purchase-order and nested checklist SKU rows", () => {
    const input = {
      spec: {
        sizeKey: "tube-50x90" as const, fillMlPerChamber: "3", connectedChambers: 1 as const, fillingMethod: "hopper" as const,
        fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0", skuCount: 1,
      },
      quantity: "50000", printingMethod: "digital" as const,
      parameters: defaultParameters, gravureParameters: defaultGravureRollParameters(),
      targetMargins: ["0.3", "0.35", "0.4"], recommendationMode: true,
    };
    const original = calculatePouchCost(input);
    const candidate = original.recommendationCandidates!.find((item) => item.route === "Y")!;
    const selected = calculatePouchCost({
      ...input,
      selectedCandidateId: candidate.id,
      selectedCandidateTargetMargins: ["0.2", "0.25", "0.3"],
    });
    expect(selected.gravure).toBeDefined();

    const draft = buildQuotationDraft(selected, {
      quotationNumber: "",
      sourceHash: selected.audit.resultJsonSha256,
      resultHash: selected.audit.resultJsonSha256,
      widthMm: "50",
      lengthMm: "90",
      connected: "1",
      skuNames: ["Selected"],
      targetMargin: "0.3",
      printingMethod: selected.printingMethod,
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      webWidthMm: 999,
      lanes: 4,
      pitchMm: "98",
      pitchAddMm: "8",
      prodMultiplier: 1,
      colorCount: 4,
      skus: [{
        name: "Selected", quantity: selected.quantity, fillMl: "3", colorCount: "4", webWidthMm: 888,
      }],
      lossRate: "0.1",
      bulkUnitPrice: "0",
    });
    const activeWidth = Number(selected.gravure?.materialWidthMm);
    expect(draft.purchaseOrder?.webWidthMm).toBe(activeWidth);
    expect(draft.purchaseOrder?.skuOrderDetails.every((sku) => sku.webWidthMm === activeWidth)).toBe(true);
    expect(draft.calculationChecklistSnapshot).toBeDefined();
    const checklistSnapshot = draft.calculationChecklistSnapshot;
    if (!checklistSnapshot) throw new Error("Selected checklist snapshot was not built");
    const checklistSkus = checklistSnapshot.skus ?? [];
    expect(checklistSkus).not.toHaveLength(0);
    expect(checklistSnapshot.materialWidthMm).toBe(String(activeWidth));
    expect(checklistSkus.every((sku) => sku.webWidthMm === activeWidth)).toBe(true);
  });

  it("preserves mixed digital SKU widths in nested purchase-order and checklist rows", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "tube-35x60" as const,
        fillMlPerChamber: "3",
        connectedChambers: 1 as const,
        fillingMethod: "hopper" as const,
        fillingLanes: 4,
        isCustom: false,
        colorCount: 2,
        bulkUnitPrice: "0",
        skuCount: 2,
        skuQuantities: ["60000", "30000"],
        skuNames: ["LargeLot", "Standard"],
        skuFillMlPerChamber: ["3", "3"],
        skuColorCounts: ["2", "2"],
      },
      quantity: "90000",
      printingMethod: "digital" as const,
    });
    const expectedWidths = result.film.skuCosts.map((sku) => sku.webWidthMm);
    expect(expectedWidths).toEqual([736, 356]);

    const draft = buildQuotationDraft(result, {
      quotationNumber: "",
      sourceHash: result.audit.resultJsonSha256,
      resultHash: result.audit.resultJsonSha256,
      widthMm: "35",
      lengthMm: "60",
      connected: "1",
      skuNames: ["LargeLot", "Standard"],
      targetMargin: "0.4",
      printingMethod: "digital",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      webWidthMm: 356,
      lanes: 4,
      pitchMm: "66",
      pitchAddMm: "6",
      prodMultiplier: 1,
      colorCount: 2,
      skus: result.film.skuCosts.map((sku, index) => ({
        name: index === 0 ? "LargeLot" : "Standard",
        quantity: sku.quantity || result.quantity,
        fillMl: "3",
        colorCount: "2",
        webWidthMm: expectedWidths[1 - index],
      })),
      lossRate: defaultParameters.lossRate,
      bulkUnitPrice: "0",
      parameters: defaultParameters,
    });

    expect(draft.purchaseOrder?.skuOrderDetails.map((sku) => sku.webWidthMm)).toEqual(expectedWidths);
    const checklistSkus = draft.calculationChecklistSnapshot?.skus ?? [];
    expect(checklistSkus.map((sku) => sku.webWidthMm)).toEqual(expectedWidths);
  });

  it("rebuilds persistent checklists for quotations saved before checklist snapshots", async () => {
    const quotationInput: QuotationRecordInput = {
      quotationNumber: "S7-LEGACY-CHECKLIST-001",
      status: "draft",
      issueDate: "2026-09-01",
      validUntil: "2026-10-01",
      customerName: "レガシー株式会社",
      customerContact: "担当者様",
      productName: "レガシーパウチ",
      sizeSummary: "60×80mm / 2連",
      quantity: "50000",
      fillingCostPerPiece: "4",
      filmCostPerPiece: "6",
      filmMeterPrice: "252",
      filmOrderLengthM: "1200",
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "20",
      subtotal: "1000000",
      tax: "100000",
      grandTotal: "1100000",
      deliveryDate: "別途相談",
      paymentTerms: "別途相談",
      notes: "legacy quotation",
      calculationVersion: "legacy",
      resultHash: "legacy-hash",
      payload: {},
    };
    const saved = await saveQuotation(quotationInput);
    const items = buildLegacyChecklistItems(saved, "digital");
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((item) => item.id && item.result !== "")).toBe(true);

    const created = await createLegacyChecklistsForQuotation(saved, "digital");
    expect(created).toHaveLength(2);
    expect(created.every((record) => record.checklistVersion === "legacy-2026-09.3")).toBe(true);
    expect(created.every((record) => record.totalCount === items.length)).toBe(true);

    const updated = await updateChecklistItem(saved.id, "CUSTOMER", "legacy.quantity", true, "レガシー確認者");
    expect(updated!.items.find((item) => item.id === "legacy.quantity")!.accepted).toBe(true);
    expect(await getChecklistsForQuotation(saved.id)).toHaveLength(2);
  });
});
