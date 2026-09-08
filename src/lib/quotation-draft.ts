import { D } from "./decimal";
import type { CostResult } from "./calculation";
import type { CostParameters } from "./types";
import { buildPurchaseOrderSnapshot, type PurchaseContext, type PurchaseOrderSnapshot } from "./purchase-order";
import { buildCalculationChecklistSnapshot, type CalculationChecklistSnapshot } from "./calculation-checklist";

export const QUOTATION_DRAFT_KEY = "pouch-quotation-draft-v1";

export const sevenChemical = {
  name: "株式会社セブン化学",
  englishName: "SEVEN CHEMICAL CO., LTD.",
  representative: "代表取締役社長 吾藤 靖",
  postalCode: "〒582-0017",
  address: "大阪府柏原市太平寺1丁目12番1号",
  telephone: "TEL 072-971-0726",
  website: "https://7chemical.co.jp/",
} as const;

export interface QuotationDraft {
  productSummary: string;
  sizeSummary: string;
  quantity: string;
  targetMargin: string;
  fillingCostPerPiece: string;
  customLotCost: string;
  customQuantity: string;
  filmCostPerPiece: string;
  filmMeterPrice: string;
  filmOrderLengthM: string;
  totalCostPerPiece: string;
  calculationVersion: string;
  resultHash: string;
  customerName?: string;
  customerCode?: string;
  customerContact?: string;
  customerPostalCode?: string;
  customerAddress?: string;
  customerTelephone?: string;
  customerEmail?: string;
  printingMethod?: string;
  copperPlateCostPerPiece?: string;
  orderPatternCount?: string;
  deliverablePatternLengthM?: string;
  recommendedQuantity?: string;
  purchaseOrder?: PurchaseOrderSnapshot;
  calculationChecklistSnapshot?: import("./calculation-checklist").CalculationChecklistSnapshot;
}

export function buildQuotationDraft(
  result: CostResult,
  context: {
    widthMm: string;
    lengthMm: string;
    connected: string;
    skuNames: string[];
    targetMargin: string;
    printingMethod?: string;
    customerName?: string;
    customerCode?: string;
    customerContact?: string;
    customerPostalCode?: string;
    customerAddress?: string;
    customerTelephone?: string;
    customerEmail?: string;
    parameters?: CostParameters;
    quotationNumber: string;
    sourceHash: string;
    resultHash: string;
    filmComposition: string;
    webWidthMm: number;
    lanes: number;
    pitchMm: string;
    prodMultiplier: number;
    colorCount: number;
    lossRate: string;
    bulkUnitPrice: string;
  },
): QuotationDraft {
  const fillingCost = D(result.costPerPieceComponents.bulk)
    .plus(result.costPerPieceComponents.variableProcessing)
    .plus(result.costPerPieceComponents.fixedLot)
    .plus(result.costPerPieceComponents.custom);
  const productSummary = context.skuNames.filter(Boolean).join(" / ") || "パウチ製品";

  return {
    productSummary,
    sizeSummary: `${context.widthMm}×${context.lengthMm}mm / ${context.connected}連`,
    quantity: result.quantity,
    targetMargin: context.targetMargin,
    customLotCost: result.customCharge,
    customQuantity: "1",
    fillingCostPerPiece: fillingCost.minus(result.costPerPieceComponents.custom).toString(),
    filmCostPerPiece: result.costPerPieceComponents.film,
    filmMeterPrice: result.film.unitPrice,
    filmOrderLengthM: result.film.orderLengthM,
    totalCostPerPiece: result.totalCostPerPiece,
    calculationVersion: result.audit.calculationVersion,
    resultHash: result.audit.resultJsonSha256,
    printingMethod: context.printingMethod,
    customerName: context.customerName,
    customerContact: context.customerContact,
    customerCode: context.customerCode,
    customerPostalCode: context.customerPostalCode,
    customerAddress: context.customerAddress,
    customerTelephone: context.customerTelephone,
    customerEmail: context.customerEmail,
    ...(context.printingMethod === "gravure" ? {
      copperPlateCostPerPiece: result.copperPlateCostPerPiece,
      orderPatternCount: String(result.orderPatternCount ?? 1),
      deliverablePatternLengthM: result.deliverablePatternLengthM ?? "5500",
      recommendedQuantity: result.recommendedQuantity ?? result.quantity,
    } : {}),
    calculationChecklistSnapshot: buildCalculationChecklistSnapshot(result, {
      quotationNumber: context.quotationNumber,
      customerName: context.customerName,
      customerCode: context.customerCode,
      printingMethod: context.printingMethod ?? "digital",
      sourceHash: context.resultHash,
      widthMm: context.widthMm,
      lengthMm: context.lengthMm,
      parameters: context.parameters,
      filmComposition: context.filmComposition,
      webWidthMm: context.webWidthMm,
      lanes: context.lanes,
      pitchMm: context.pitchMm,
      prodMultiplier: context.prodMultiplier,
      colorCount: context.colorCount,
      lossRate: context.lossRate,
      bulkUnitPrice: context.bulkUnitPrice,
    }),
  };
}

export function parseQuotationDraft(value: unknown): QuotationDraft | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<QuotationDraft>;
  const required = [
    candidate.productSummary,
    candidate.sizeSummary,
    candidate.quantity,
    candidate.targetMargin,
    candidate.fillingCostPerPiece,
    candidate.filmCostPerPiece,
    candidate.filmMeterPrice,
    candidate.filmOrderLengthM,
    candidate.totalCostPerPiece,
    candidate.calculationVersion,
    candidate.resultHash,
  ];
  if (required.some((item) => typeof item !== "string" || item.trim() === "")) return null;
  return candidate as QuotationDraft;
}
