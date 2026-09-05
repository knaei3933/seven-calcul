import { D } from "./decimal";
import type { CostResult } from "./calculation";

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
  filmCostPerPiece: string;
  filmMeterPrice: string;
  filmOrderLengthM: string;
  totalCostPerPiece: string;
  calculationVersion: string;
  resultHash: string;
  printingMethod?: string;
  copperPlateCostPerPiece?: string;
  orderPatternCount?: string;
  deliverablePatternLengthM?: string;
  recommendedQuantity?: string;
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
    fillingCostPerPiece: fillingCost.toString(),
    filmCostPerPiece: result.costPerPieceComponents.film,
    filmMeterPrice: result.film.unitPrice,
    filmOrderLengthM: result.film.orderLengthM,
    totalCostPerPiece: result.totalCostPerPiece,
    calculationVersion: result.audit.calculationVersion,
    resultHash: result.audit.resultJsonSha256,
    printingMethod: context.printingMethod,
    ...(context.printingMethod === "gravure" ? {
      copperPlateCostPerPiece: result.copperPlateCostPerPiece,
      orderPatternCount: String(result.orderPatternCount ?? 1),
      deliverablePatternLengthM: result.deliverablePatternLengthM ?? "5500",
      recommendedQuantity: result.recommendedQuantity ?? result.quantity,
    } : {}),
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
