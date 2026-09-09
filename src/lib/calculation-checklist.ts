import type { CostResult } from "./calculation";
import { defaultParameters, sizeMaster } from "./constants";
import type { CostParameters } from "./types";
import type { GravureRollParameters } from "./gravure-roll";
import type { QuotationRecord } from "./quotation-shared";
import { D } from "./decimal";
import { buildJapaneseChecklistItems } from "./japanese-calculation-checklist";

export type ChecklistAudience = "CUSTOMER" | "INTERNAL_QA";

export const CURRENT_CHECKLIST_SNAPSHOT_KEY = "pouch-current-checklist-snapshot-v1";
export const CHECKLIST_VERSION = "2026-09.2";
export const LEGACY_CHECKLIST_VERSION = "legacy-2026-09.3";

export type ChecklistItemState = {
  accepted: boolean;
  checkedAt: string | null;
  checkedBy: string | null;
};

export type ChecklistItem = ChecklistItemState & {
  id: string;
  category: string;
  variable: string;
  explanation: string;
  inputs?: string;
  formula: string;
  substitution: string;
  result: string;
  unit?: string;
};

export type ChecklistRecord = {
  quotationId: number;
  audience: ChecklistAudience;
  checklistVersion: string;
  status: "in_progress" | "completed";
  snapshot: Partial<CalculationChecklistSnapshot>;
  items: ChecklistItem[];
  acceptedCount: number;
  totalCount: number;
  progressPercent: number;
  checkedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CalculationChecklistSnapshot = {
  checklistVersion: string;
  calculationVersion: string;
  sourceHash: string;
  resultHash: string;
  printingMethod: string;
  quotationNumber: string;
  customerName: string;
  customerCode: string;
  quantity: string;
  connectedChambers: number;
  chamberCount?: string;
  widthMm: string;
  lengthMm: string;
  pouchWidthMm?: string;
  pouchLengthMm?: string;
  pitchMm?: string;
  pitchAddMm?: string;
  materialWidthMm?: string;
  parameters: CostParameters;
  fillMlPerChamber: string;
  totalFillMlPerPouch: string;
  fillingMethod: string;
  fillingLanes: number;
  bulkUnitPrice: string;
  bulkLossRate: string;
  bulkUsageMl: string;
  bulkCost: string;
  bulkInitialChargeMl?: string;
  bulkTestFillMl?: string;
  customCharge: string;
  baseProductionSpeedPerMinute: string;
  effectiveProductionSpeed: string;
  lanesPerCycle: number;
  productionRunQuantity: string;
  productionHours: string;
  inspectionHours: string;
  inspectionSpeed: string;
  laborPerHour: string;
  machineChargePerHour: string;
  variableProcessingTotal: string;
  fixedLotCost: string;
  totalCostPerPiece: string;
  costTotal: string;
  sellingPrices: CostResult["sellingPrices"];
  film: CostResult["film"];
  gravure?: CostResult["gravure"];
  gravureParameters?: GravureRollParameters;
  skus?: {
    name: string;
    quantity: string;
    fillMlPerChamber: string;
    colorCount: string;
    requiredLengthM: string;
    orderLengthM: string;
    multiplier: number;
    webWidthMm: number;
    appliedBand: string;
  }[];
  orderPatternCount: number;
  deliverablePatternLengthM: string;
  productionPatternLengthM: string;
  sellerProfitCost: string;
};

export function readCalculationChecklistSnapshot(value: unknown): CalculationChecklistSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const snapshot = value as Partial<CalculationChecklistSnapshot>;
  const hasText = (...values: unknown[]) => values.every((entry) => typeof entry === "string" && entry.trim() !== "");
  const film = snapshot.film;
  const parameters = snapshot.parameters;
  return snapshot.checklistVersion === CHECKLIST_VERSION
    && hasText(snapshot.quantity, snapshot.totalCostPerPiece, snapshot.pouchWidthMm, snapshot.pouchLengthMm, snapshot.pitchMm, snapshot.pitchAddMm, snapshot.materialWidthMm)
    && typeof snapshot.connectedChambers === "number"
    && Array.isArray(snapshot.skus) && snapshot.skus.length > 0
    && !!film && typeof film === "object"
    && hasText(film.requiredLengthM, film.orderLengthM, film.unitPrice, film.filmTotal)
    && Array.isArray(snapshot.sellingPrices)
    && !!parameters && typeof parameters === "object"
    ? snapshot as CalculationChecklistSnapshot
    : null;
}

export type CalculationChecklistContext = {
  quotationNumber: string;
  customerName?: string;
  customerCode?: string;
  printingMethod: string;
  sourceHash: string;
  resultHash: string;
  filmComposition: string;
  bulkUnitPrice?: string;
  widthMm?: string;
  lengthMm?: string;
  lanes?: number;
  webWidthMm?: number;
  pitchMm?: string;
  pitchAddMm?: string;
  prodMultiplier?: number;
  colorCount?: number;
  skus?: {
    name?: string;
    quantity: string;
    fillMl: string;
    colorCount: string;
  }[];
  lossRate?: string;
  parameters?: CostParameters;
  gravureParameters?: GravureRollParameters;
};

export function buildCalculationChecklistSnapshot(
  result: CostResult,
  context: CalculationChecklistContext,
): CalculationChecklistSnapshot {
  return {
    checklistVersion: CHECKLIST_VERSION,
    calculationVersion: result.audit.calculationVersion,
    sourceHash: context.sourceHash,
    resultHash: context.resultHash,
    printingMethod: context.printingMethod,
    quotationNumber: context.quotationNumber,
    customerName: context.customerName ?? "",
    customerCode: context.customerCode ?? "",
    quantity: result.quantity,
    connectedChambers: result.connectedChambers,
    chamberCount: result.chamberCount,
    widthMm: result.gravure
      ? String(result.gravure.materialWidthMm)
      : result.film.skuCosts[0] ? String(result.film.skuCosts[0].webWidthMm) : context.widthMm ?? "",
    lengthMm: context.lengthMm ?? "",
    pouchWidthMm: context.widthMm,
    pouchLengthMm: context.lengthMm,
    pitchMm: context.pitchMm,
    pitchAddMm: context.pitchAddMm,
    materialWidthMm: context.webWidthMm != null
      ? String(context.webWidthMm)
      : result.gravure?.materialWidthMm,
    fillMlPerChamber: result.fillMlPerChamber,
    totalFillMlPerPouch: result.totalFillMlPerPouch,
    fillingMethod: result.fillingMethod,
    fillingLanes: result.fillingLanes,
    bulkUnitPrice: context.bulkUnitPrice ?? "0",
    bulkLossRate: context.parameters?.bulkLossRate ?? result.bulkLossRate,
    bulkUsageMl: result.bulkUsageMl,
    bulkCost: result.bulkCost,
    bulkInitialChargeMl: result.initialChargeMl,
    bulkTestFillMl: result.testFillMl,
    customCharge: result.customCharge,
    baseProductionSpeedPerMinute: result.baseProductionSpeedPerMinute,
    effectiveProductionSpeed: result.effectiveProductionSpeed,
    lanesPerCycle: result.lanesPerCycle,
    productionRunQuantity: result.productionRunQuantity,
    productionHours: result.productionHours,
    inspectionHours: result.inspectionHours,
    inspectionSpeed: context.parameters?.inspectionSpeed ?? "",
    laborPerHour: context.parameters?.laborPerHour ?? "",
    machineChargePerHour: context.parameters?.machineChargePerHour ?? "",
    variableProcessingTotal: result.variableProcessingTotal,
    fixedLotCost: result.fixedLotCost,
    totalCostPerPiece: result.totalCostPerPiece,
    costTotal: result.costTotal,
    sellingPrices: result.sellingPrices,
    film: result.film,
    gravure: result.gravure,
    gravureParameters: context.gravureParameters,
    skus: result.film.skuCosts.map((sku, index) => ({
      name: context.skus?.[index]?.name?.trim() || sku.name || `充填物${index + 1}`,
      quantity: context.skus?.[index]?.quantity ?? sku.quantity,
      fillMlPerChamber: context.skus?.[index]?.fillMl ?? sku.fillMlPerChamber,
      colorCount: context.skus?.[index]?.colorCount ?? sku.colorCount,
      requiredLengthM: sku.requiredLengthM,
      orderLengthM: sku.orderLengthM,
      multiplier: sku.multiplier,
      webWidthMm: sku.webWidthMm,
      appliedBand: sku.appliedBand,
    })),
    orderPatternCount: result.orderPatternCount ?? 1,
    deliverablePatternLengthM: result.deliverablePatternLengthM ?? "0",
    productionPatternLengthM: result.film.orderLengthM,
    sellerProfitCost: result.sellerProfitCost,
    parameters: context.parameters ?? defaultParameters,
  };
}

function item(
  id: string,
  category: string,
  variable: string,
  explanation: string,
  inputs: string,
  formula: string,
  substitution: string,
  result: string,
  unit?: string,
): ChecklistItem {
  return {
    id,
    category,
    variable,
    explanation,
    inputs,
    formula,
    substitution,
    result,
    unit,
    accepted: false,
    checkedAt: null,
    checkedBy: null,
  };
}

export function buildChecklistItems(snapshot: CalculationChecklistSnapshot): ChecklistItem[] {
  return buildJapaneseChecklistItems(snapshot);
}

export function buildLegacyChecklistItems(record: QuotationRecord, printingMethod: string): ChecklistItem[] {
  const payload = record.payload;
  const value = (key: string): string => typeof payload[key] === "string" || typeof payload[key] === "number" ? String(payload[key]) : "";
  const stored = (key: string, fallback = "0"): string => {
    const raw = value(key) || record[key as keyof QuotationRecord];
    return typeof raw === "string" && raw.trim() !== "" ? raw : typeof raw === "number" ? String(raw) : fallback;
  };
  const sizeMatch = record.sizeSummary.match(/([0-9.]+)\s*×\s*([0-9.]+)/);
  const widthMm = sizeMatch ? Number(sizeMatch[1]) : 0;
  const lengthMm = sizeMatch ? Number(sizeMatch[2]) : 0;
  const size = Object.values(sizeMaster).find((entry) => Number(entry.widthMm) === widthMm && Number(entry.lengthMm) === lengthMm);
  const lanes = size?.lanes ?? 4;
  const pitchMm = size ? D(size.lengthMm).plus(size.pitchAddMm).toString() : String(lengthMm + 6);
  const connected = Number(record.sizeSummary.match(/([1-4])連/)?.[1] ?? 1);
  const orderLengthM = D(record.filmOrderLengthM);
  const filmMeterPrice = D(record.filmMeterPrice);
  const filmAmount = value("filmAmountDisplay") || orderLengthM.times(filmMeterPrice).toString();
  const fillingUnit = stored("fillingCostPerPiece");
  const fillingAmount = value("fillingAmountDisplay") || D(record.quantity).times(D(fillingUnit)).toString();
  const customCost = stored("customLotCost");
  const totalCostPerPiece = value("totalCostPerPiece") || D(fillingUnit).plus(D(record.filmCostPerPiece)).plus(D(customCost).div(D(record.quantity))).toString();
  const items: ChecklistItem[] = [];
  const add = (...arguments_: Parameters<typeof item>) => {
    items.push(item(...arguments_));
  };

  add("legacy.quantity", "基本条件", "発注数量", "見積書に保存された発注数量です。", `保存値 = ${record.quantity}`, "保存値を使用します。", `保存値 = ${record.quantity}`, record.quantity, "枚");
  add("legacy.connected", "基本条件", "連結形式", "保存済みサイズ情報から確認した連結数です。", `サイズ情報 = ${record.sizeSummary}`, "サイズ情報の解析", `保存値 = ${connected}`, String(connected), "連");
  add("legacy.size", "基本条件", "パウチサイズ", "見積書に保存されたパウチサイズです。", `サイズ情報 = ${record.sizeSummary}`, "保存値を使用します。", `${widthMm} × ${lengthMm}`, `${widthMm} × ${lengthMm}`, "mm");
  add("legacy.film-order", "フィルム計算", "フィルム発注長", "見積書に保存されたフィルム発注長です。", `保存値 = ${record.filmOrderLengthM}m`, "保存値を使用します。", `保存値 = ${record.filmOrderLengthM}`, record.filmOrderLengthM, "m");
  add("legacy.film-unit", "フィルム計算", "フィルム購入単価", "見積書に保存されたm当たり購入単価です。", `保存値 = ${record.filmMeterPrice}円/m`, "保存値を使用します。", `保存値 = ${record.filmMeterPrice}`, record.filmMeterPrice, "円/m");
  add("legacy.film-amount", "フィルム計算", "フィルム表示金額", "表示金額がなければ発注長 × 単価で再計算します。", value("filmAmountDisplay") ? `表示金額 = ${value("filmAmountDisplay")}円` : `${record.filmOrderLengthM}m × ${record.filmMeterPrice}円/m`, "表示金額を優先、なければ発注長 × 単価", `${record.filmOrderLengthM} × ${record.filmMeterPrice}`, filmAmount, "円");
  add("legacy.filling-unit", "充填・加工費", "充填・加工単価", "パウチ1枚当たりの保存済み充填・加工単価です。", `保存値 = ${fillingUnit}円`, "保存値を使用します。", `保存値 = ${fillingUnit}`, fillingUnit, "円");
  add("legacy.filling-amount", "充填・加工費", "充填・加工金額", "保存金額がなければ発注数量 × 単価で再計算します。", value("fillingAmountDisplay") ? `表示金額 = ${value("fillingAmountDisplay")}円` : `${record.quantity}枚 × ${fillingUnit}円`, "発注数量 × 単価", `${record.quantity} × ${fillingUnit}`, fillingAmount, "円");
  if (printingMethod === "gravure") {
    add("legacy.gravure-pattern", "グラビア計算", "発注パターン", "保存済みグラビア発注パターン数です。", `保存値 = ${value("orderPatternCount")}`, "保存値を使用します。", `保存値 = ${value("orderPatternCount")}`, value("orderPatternCount"), "回");
    add("legacy.gravure-delivery", "グラビア計算", "納品パターン長", "保存済み納品パターン長です。", `保存値 = ${value("deliverablePatternLengthM")}m`, "保存値を使用します。", `保存値 = ${value("deliverablePatternLengthM")}`, value("deliverablePatternLengthM"), "m");
    add("legacy.gravure-production", "グラビア計算", "製作長", "保存済みグラビア製作長です。", `保存値 = ${record.filmOrderLengthM}m`, "保存値を使用します。", `保存値 = ${record.filmOrderLengthM}`, record.filmOrderLengthM, "m");
  }
  add("legacy.custom", "カスタム / 金型", "金型・カスタム費用", "見積書に保存された金型・カスタム費用です。保存値がなければ0円で表示します。", `保存値 = ${customCost}円`, "保存値を使用します。", `保存値 = ${customCost}`, customCost, "円");
  add("legacy.total-cost", "原価・合計", "総原価 /枚", "保存値がなければ充填・加工単価 + フィルム単価 + カスタム/枚で再構成します。", value("totalCostPerPiece") ? `保存値 = ${value("totalCostPerPiece")}円` : `${fillingUnit} + ${record.filmCostPerPiece} + ${customCost} ÷ ${record.quantity}`, "充填単価 + フィルム単価 + カスタム/枚", totalCostPerPiece, "円");
  return items;
}
