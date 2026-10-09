import { D } from "./decimal";
import { CONNECTED_FILLING_SURCHARGE } from "./constants";
import type { CalculationInput, CostResult } from "./calculation";
import type { CostParameters } from "./types";
import type { GravureRollParameters } from "./gravure-roll";
import { activeMaterialWidthMm, buildPurchaseOrderSnapshot, type PurchaseContext, type PurchaseOrderSnapshot } from "./purchase-order";
import { buildCalculationChecklistSnapshot, type CalculationChecklistSnapshot } from "./calculation-checklist";
import type { SascheCandidate } from "./sasche-gravure";

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
  bulkCostPerPiece?: string;
  pricingFillingCostPerPiece?: string;
  customLotCost: string;
  customQuantity: string;
  filmCostPerPiece: string;
  filmMeterPrice: string;
  filmOrderLengthM: string;
  totalCostPerPiece: string;
  calculationVersion: string;
  resultHash: string;
  calculationFilmTotal: string;
  /** 시뮬레이터에 입력한 원시 SKU 제품명(자동 채움 전). 발행 필수 검증에 사용. */
  skuNamesRaw?: string[];
  calculationRequest?: CalculationInput;
  customerName?: string;
  customerCode?: string;
  customerContact?: string;
  customerPostalCode?: string;
  customerAddress?: string;
  customerTelephone?: string;
  customerEmail?: string;
  printingMethod?: string;
  copperPlateCostPerPiece?: string;
  copperColorCount?: string;
  orderPatternCount?: string;
  deliverablePatternLengthM?: string;
  recommendedQuantity?: string;
  originalQuantity?: string;
  selectedCandidateShortage?: boolean;
  purchaseOrder?: PurchaseOrderSnapshot;
  sascheCandidate?: SascheCandidate;
  sascheCandidates?: SascheCandidate[];
  sascheOverToleranceReason?: string;
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
    pitchAddMm: string;
    prodMultiplier: number;
    colorCount: number;
    skus?: {
      name?: string;
      quantity: string;
      fillMl: string;
      colorCount: string;
      requiredLengthM?: string;
      orderLengthM?: string;
      multiplier?: number;
      webWidthMm?: number;
      appliedBand?: string;
    }[];
    lossRate: string;
    bulkUnitPrice: string;
    gravureParameters?: GravureRollParameters;
    calculationRequest?: CalculationInput;
    originalQuantity?: string;
    selectedCandidateShortage?: boolean;
  },
): QuotationDraft {
  // 見積単価の基準は「1連相当の加工原価×連結加算率」。バルクは別ラインで計上する。
  const connectedFillingSurcharge = D(CONNECTED_FILLING_SURCHARGE[result.connectedChambers] ?? "0");
  // 加算率の倍率を厳密に保つため中間基準値は丸めない（最終単価で小数第1位へ切り上げ）。
  // 基本額は 1連基準 × 連結室数（2連なら6+6=12円）、その基本額に加算率を乗じる。
  const pricingFillingCost = result.singleConnectedProcessingCostPerPiece
    ? D(result.singleConnectedProcessingCostPerPiece)
      .times(D(result.connectedChambers))
      .times(D(1).plus(connectedFillingSurcharge))
    : D(result.costPerPieceComponents.variableProcessing).plus(result.costPerPieceComponents.fixedLot);
  const productSummary = context.skuNames.filter(Boolean).join(" / ") || "パウチ製品";
  const activeWidthMm = activeMaterialWidthMm(result);

  return {
    productSummary,
    sizeSummary: `${context.widthMm}×${context.lengthMm}mm / ${context.connected}連`,
    purchaseOrder: (() => {
      const snapshot = buildPurchaseOrderSnapshot(result, {
        filmComposition: context.filmComposition,
        webWidthMm: activeWidthMm ?? context.webWidthMm,
        lanes: context.lanes,
        pitchMm: context.pitchMm,
        prodMultiplier: context.prodMultiplier,
        colorCount: result.gravure?.copperPlateCount ?? context.colorCount,
        lossRate: context.lossRate,
        gravureParameters: context.gravureParameters,
      });
      if (context.skus?.length) {
        snapshot.skuColorCounts = context.skus.map((sku) => String(sku.colorCount ?? 0));
        snapshot.skuOrderDetails = context.skus.map((sku, index) => {
          const skuCost = result.film.skuCosts[index];
          return {
            skuCode: `SKU-${index + 1}`,
            name: sku.name?.trim() || `充填物${index + 1}`,
            quantity: sku.quantity ?? result.quantity,
            colorCount: sku.colorCount ?? "0",
            requiredLengthM: sku.requiredLengthM ?? skuCost?.requiredLengthM ?? result.film.requiredLengthM,
            orderLengthM: sku.orderLengthM ?? skuCost?.orderLengthM ?? result.film.orderLengthM,
            webWidthMm: skuCost?.webWidthMm
              ?? (result.gravure ? activeWidthMm : sku.webWidthMm ?? activeWidthMm)
              ?? context.webWidthMm,
            multiplier: sku.multiplier ?? skuCost?.multiplier ?? 1,
          };
        });
      }
      return snapshot;
    })(),
    quantity: result.quantity,
    targetMargin: context.targetMargin,
    customLotCost: result.customCharge,
    customQuantity: "1",
    // 見積書の充填・加工はバルクを除いた加工のみ。バルクは bulkCostPerPiece で別管理。
    fillingCostPerPiece: D(result.costPerPieceComponents.variableProcessing)
      .plus(result.costPerPieceComponents.fixedLot)
      .toString(),
    bulkCostPerPiece: result.costPerPieceComponents.bulk,
    pricingFillingCostPerPiece: pricingFillingCost.toString(),
    filmCostPerPiece: result.costPerPieceComponents.film,
    filmMeterPrice: result.film.unitPrice,
    filmOrderLengthM: result.film.orderLengthM,
    totalCostPerPiece: result.totalCostPerPiece,
    calculationVersion: result.audit.calculationVersion,
    resultHash: result.audit.resultJsonSha256,
    calculationFilmTotal: result.film.filmTotal,
    // 자동 채움(充填物N) 전의 원시 제품명. 발행 필수 검증에 사용.
    skuNamesRaw: (context.skus ?? []).map((sku) => sku.name?.trim() ?? ""),
    calculationRequest: context.calculationRequest,
    printingMethod: context.printingMethod,
    customerName: context.customerName,
    customerContact: context.customerContact,
    customerCode: context.customerCode,
    customerPostalCode: context.customerPostalCode,
    customerAddress: context.customerAddress,
    customerTelephone: context.customerTelephone,
    customerEmail: context.customerEmail,
    originalQuantity: context.originalQuantity,
    selectedCandidateShortage: context.selectedCandidateShortage,
    ...(context.printingMethod === "gravure" ? {
      copperPlateCostPerPiece: result.copperPlateCostPerPiece,
      copperColorCount: String(result.gravure?.copperPlateCount ?? context.colorCount),
      sascheCandidate: result.sasche,
      sascheCandidates: result.sascheCandidates,
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
      resultHash: context.resultHash,
      widthMm: context.widthMm,
      lengthMm: context.lengthMm,
      parameters: context.parameters,
      filmComposition: context.filmComposition,
      webWidthMm: context.webWidthMm,
      lanes: context.lanes,
      pitchMm: context.pitchMm,
      pitchAddMm: context.pitchAddMm,
      prodMultiplier: context.prodMultiplier,
      colorCount: context.colorCount,
      skus: context.skus,
      lossRate: context.lossRate,
      bulkUnitPrice: context.bulkUnitPrice,
      gravureParameters: context.gravureParameters,
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
    candidate.calculationFilmTotal,
  ];
  if (required.some((item) => typeof item !== "string" || item.trim() === "")) return null;
  return candidate as QuotationDraft;
}
