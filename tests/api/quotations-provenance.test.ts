import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { calculatePouchCost } from "@/lib/calculation";
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import { buildQuotationDraft, type QuotationDraft } from "@/lib/quotation-draft";
import type { CalculationInput, CostResult } from "@/lib/calculation";
import { D } from "@/lib/decimal";
import type { PouchSpec } from "@/lib/types";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-provenance-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
const { POST } = await import("@/app/api/quotations/route");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

const spec: PouchSpec = {
  sizeKey: "tube-50x90",
  fillMlPerChamber: "3",
  connectedChambers: 1,
  fillingMethod: "hopper",
  fillingLanes: 4,
  isCustom: false,
  colorCount: 4,
  bulkUnitPrice: "0",
  skuCount: 1,
};
const baseInput = {
  spec,
  quantity: "50000",
  printingMethod: "digital" as const,
  parameters: defaultParameters,
  gravureParameters: defaultGravureRollParameters(),
  targetMargins: ["0.3", "0.35", "0.4"],
  recommendationMode: true,
};
const originalRequest: CalculationInput = {
  ...baseInput,
  selectedCandidateId: "",
  selectedCandidateTargetMargins: baseInput.targetMargins,
};
const originalResult = calculatePouchCost(originalRequest);
const candidate = originalResult.recommendationCandidates!.find((item) => item.route === "Y")!;
const selectedRequest: CalculationInput = {
  ...baseInput,
  selectedCandidateId: candidate.id,
  selectedCandidateTargetMargins: ["0.2", "0.25", "0.3"],
};
const selectedResult = calculatePouchCost(selectedRequest);

const gravureSpec: PouchSpec = {
  sizeKey: "tube-35x80",
  fillMlPerChamber: "10",
  connectedChambers: 1,
  fillingMethod: "hopper",
  fillingLanes: 4,
  isCustom: false,
  colorCount: 2,
  bulkUnitPrice: "0",
  skuCount: 2,
  skuQuantities: ["79800", "53200"],
  skuNames: ["Serum", "Emulsion"],
  skuFillMlPerChamber: ["10", "30"],
  skuColorCounts: ["2", "4"],
};
const gravureRequest: CalculationInput = {
  spec: gravureSpec,
  quantity: "133000",
  printingMethod: "gravure",
  parameters: defaultParameters,
  gravureParameters: defaultGravureRollParameters(),
  targetMargins: ["0.2", "0.25", "0.3"],
  recommendationMode: true,
  selectedCandidateId: "",
  selectedCandidateTargetMargins: ["0.2", "0.25", "0.3"],
};
const gravureResult = calculatePouchCost(gravureRequest);
const gravureTotalQuantity = D(gravureRequest.quantity);
const gravureSkuOrderLengths = gravureSpec.skuQuantities!.map((quantity) => (
  D(gravureResult.film.orderLengthM).times(D(quantity).div(gravureTotalQuantity)).toString()
));
const gravureDraft = buildQuotationDraft(gravureResult, {
  quotationNumber: "",
  sourceHash: gravureResult.audit.resultJsonSha256,
  resultHash: gravureResult.audit.resultJsonSha256,
  widthMm: "35",
  lengthMm: "80",
  connected: "1",
  skuNames: ["Serum", "Emulsion"],
  targetMargin: "0.3",
  printingMethod: gravureResult.printingMethod,
  filmComposition: "PET12+AL7+PET12+LLDPE50",
  webWidthMm: 999,
  lanes: 4,
  pitchMm: "86",
  pitchAddMm: "6",
  prodMultiplier: 1,
  colorCount: 6,
  skus: gravureSpec.skuQuantities!.map((quantity, index) => ({
    name: index === 0 ? "Serum" : "Emulsion",
    quantity,
    fillMl: gravureSpec.skuFillMlPerChamber![index],
    colorCount: gravureSpec.skuColorCounts![index],
    orderLengthM: gravureSkuOrderLengths[index],
    webWidthMm: 888,
  })),
  parameters: defaultParameters,
  lossRate: defaultParameters.lossRate,
  bulkUnitPrice: "0",
  gravureParameters: defaultGravureRollParameters(),
  calculationRequest: gravureRequest,
});

function draftFor(result: CostResult, request: CalculationInput): QuotationDraft {
  return buildQuotationDraft(result, {
    quotationNumber: "",
    sourceHash: result.audit.resultJsonSha256,
    resultHash: result.audit.resultJsonSha256,
    widthMm: "50",
    lengthMm: "90",
    connected: "1",
    skuNames: ["Provenance"],
    targetMargin: "0.3",
    printingMethod: result.printingMethod,
    filmComposition: "PET12+AL7+PET12+LLDPE50",
    webWidthMm: 999,
    lanes: 4,
    pitchMm: "98",
    pitchAddMm: "8",
    prodMultiplier: 1,
    colorCount: 4,
    skus: [{
      name: "Provenance",
      quantity: result.quantity,
      fillMl: "3",
      colorCount: "4",
      webWidthMm: 888,
    }],
    parameters: defaultParameters,
    lossRate: defaultParameters.lossRate,
    bulkUnitPrice: "0",
    gravureParameters: defaultGravureRollParameters(),
    calculationRequest: request,
  });
}

const selectedDraft = draftFor(selectedResult, selectedRequest);

function quotationBody(
  quotationNumber: string,
  draft: QuotationDraft = selectedDraft,
  result: CostResult = selectedResult,
) {
  return {
    quotationNumber,
    status: "draft",
    issueDate: "2026-09-15",
    validUntil: "2026-10-15",
    customerName: "プロビナンス株式会社",
    customerContact: "担当者",
    productName: "プロビナンス",
    sizeSummary: "50×90mm / 1連",
    quantity: draft.quantity,
    fillingCostPerPiece: draft.fillingCostPerPiece,
    filmCostPerPiece: draft.filmCostPerPiece,
    filmMeterPrice: draft.filmMeterPrice,
    filmOrderLengthM: draft.filmOrderLengthM,
    calculationFilmTotal: draft.calculationFilmTotal,
    targetMargin: draft.targetMargin,
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "500000",
    tax: "50000",
    grandTotal: "550000",
    deliveryDate: "別途相談",
    paymentTerms: "別途相談",
    notes: "provenance",
    calculationVersion: "simulator-linked",
    resultHash: result.audit.resultJsonSha256,
    payload: {
      printingMethod: draft.printingMethod,
      quantity: draft.quantity,
      filmOrderLengthM: draft.filmOrderLengthM,
      calculationFilmTotal: draft.calculationFilmTotal,
      calculationRequest: draft.calculationRequest,
      purchaseOrder: draft.purchaseOrder,
      calculationChecklistSnapshot: draft.calculationChecklistSnapshot,
      resultHash: result.audit.resultJsonSha256,
    },
  };
}

async function post(body: unknown): Promise<Response> {
  return POST(new Request("http://localhost/api/quotations", {
    method: "POST",
    body: JSON.stringify(body),
  }));
}

describe("quotation calculation provenance", () => {
  it("accepts a selected request whose recomputation matches immutable artifacts", async () => {
    const response = await post(quotationBody("S7-PROVENANCE-001"));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.record.resultHash).toBe(selectedResult.audit.resultJsonSha256);
  });

  it("accepts the original no-selection request after clearing a selected candidate", async () => {
    const draft = draftFor(originalResult, originalRequest);
    const response = await post(quotationBody("S7-PROVENANCE-CLEAR", draft, originalResult));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.record.resultHash).toBe(originalResult.audit.resultJsonSha256);
  });

  it("accepts an original multi-SKU gravure calculation with no selected candidate", async () => {
    const response = await post(quotationBody("S7-PROVENANCE-GRAVURE-ORIGINAL", gravureDraft, gravureResult));
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.record.resultHash).toBe(gravureResult.audit.resultJsonSha256);
  });

  it("rejects a fabricated result hash before persistence", async () => {
    const body = quotationBody("S7-PROVENANCE-002");
    body.resultHash = "fabricated-hash";
    body.payload.resultHash = "fabricated-hash";
    const response = await post(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "calculation_provenance_invalid" });
  });

  it("rejects a mismatched checklist provenance hash", async () => {
    const body = quotationBody("S7-PROVENANCE-CHECKLIST");
    const checklistSnapshot = body.payload.calculationChecklistSnapshot;
    expect(checklistSnapshot).toBeDefined();
    if (!checklistSnapshot) throw new Error("Checklist snapshot was not built");
    checklistSnapshot.resultHash = "checklist-hash-mismatch";
    const response = await post(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "calculation_provenance_invalid" });
  });

  it("rejects a fabricated purchase-order SKU anchor", async () => {
    const body = quotationBody("S7-PROVENANCE-PURCHASE");
    const purchaseOrder = body.payload.purchaseOrder;
    const purchaseSku = purchaseOrder?.skuOrderDetails[0];
    expect(purchaseOrder).toBeDefined();
    expect(purchaseSku).toBeDefined();
    if (!purchaseOrder || !purchaseSku) throw new Error("Purchase-order snapshot was not built");
    purchaseSku.orderLengthM = `${Number(purchaseSku.orderLengthM) + 1}`;
    const response = await post(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "calculation_provenance_invalid" });
  });

  it("enforces recomputation when a manual-labelled record carries a result hash", async () => {
    const body = {
      ...quotationBody("S7-PROVENANCE-MANUAL-LABEL"),
      calculationVersion: "manual-entry",
    };
    const response = await post(body);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "calculation_provenance_invalid" });
  });

  it("keeps manual-entry quotations allowed without calculation artifacts", async () => {
    const response = await post({
      ...quotationBody("S7-PROVENANCE-MANUAL"),
      calculationVersion: "manual-entry",
      resultHash: "",
      calculationFilmTotal: "0",
      payload: {
        printingMethod: "digital",
        quantity: "10000",
        filmOrderLengthM: "500",
        calculationFilmTotal: "0",
      },
    });
    expect(response.status).toBe(201);
  });
});
