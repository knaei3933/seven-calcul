import type { CostResult } from "./calculation";
import { defaultParameters, sizeMaster } from "./constants";
import type { CostParameters } from "./types";
import type { QuotationRecord } from "./quotation-shared";
import { D } from "./decimal";

export type ChecklistAudience = "CUSTOMER" | "INTERNAL_QA";

export const CURRENT_CHECKLIST_SNAPSHOT_KEY = "pouch-current-checklist-snapshot-v1";
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
  widthMm: string;
  lengthMm: string;
  parameters: CostParameters;
  fillMlPerChamber: string;
  totalFillMlPerPouch: string;
  fillingMethod: string;
  fillingLanes: number;
  bulkUnitPrice: string;
  bulkLossRate: string;
  bulkUsageMl: string;
  bulkCost: string;
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
  return hasText(snapshot.checklistVersion, snapshot.quantity, snapshot.totalCostPerPiece)
    && typeof snapshot.connectedChambers === "number"
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
  prodMultiplier?: number;
  colorCount?: number;
  lossRate?: string;
  parameters?: CostParameters;
};

export function buildCalculationChecklistSnapshot(
  result: CostResult,
  context: CalculationChecklistContext,
): CalculationChecklistSnapshot {
  return {
    checklistVersion: "2026-09.1",
    calculationVersion: result.audit.calculationVersion,
    sourceHash: context.sourceHash,
    resultHash: context.resultHash,
    printingMethod: context.printingMethod,
    quotationNumber: context.quotationNumber,
    customerName: context.customerName ?? "",
    customerCode: context.customerCode ?? "",
    quantity: result.quantity,
    connectedChambers: result.connectedChambers,
    widthMm: result.gravure
      ? String(result.gravure.materialWidthMm)
      : result.film.skuCosts[0] ? String(result.film.skuCosts[0].webWidthMm) : context.widthMm ?? "",
    lengthMm: context.lengthMm ?? "",
    fillMlPerChamber: result.fillMlPerChamber,
    totalFillMlPerPouch: result.totalFillMlPerPouch,
    fillingMethod: result.fillingMethod,
    fillingLanes: result.fillingLanes,
    bulkUnitPrice: context.bulkUnitPrice ?? "0",
    bulkLossRate: context.parameters?.bulkLossRate ?? result.bulkLossRate,
    bulkUsageMl: result.bulkUsageMl,
    bulkCost: result.bulkCost,
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
  const items: ChecklistItem[] = [];
  const add = (
    id: string,
    category: string,
    variable: string,
    explanation: string,
    formula: string,
    substitution: string,
    result: string,
    unit?: string,
  ) => items.push(item(id, category, variable, explanation, formula, substitution, result, unit));

  const basic = "기본 견적 조건";
  add("basic.quantity", basic, "발주 수량", "연결 후 파우치 1개 기준 발주 수량입니다.", "입력값", `입력값 = ${snapshot.quantity}`, snapshot.quantity, "枚");
  add("basic.connected", basic, "連結形式", "1개 파우치에 연결된 충전 실 수입니다.", "입력값", `입력값 = ${snapshot.connectedChambers}`, String(snapshot.connectedChambers), "連");
  add("basic.chambers", basic, "総室数", "발주 수량과 연결 수로 만들어지는 전체 충전 실 수입니다.", "発注数量 × 連結数", `${snapshot.quantity} × ${snapshot.connectedChambers}`, D(snapshot.quantity).times(snapshot.connectedChambers).toString(), "室");
  add("basic.fill", basic, "充填量", "1실에 충전하는 액체 양입니다.", "SKU 수량 가중 평균", `가중 평균 = ${snapshot.fillMlPerChamber}`, snapshot.fillMlPerChamber, "ml");
  add("basic.total-fill", basic, "1개당 총 충전량", "연결 실 수를 포함한 파우치 1개당 총 충전량입니다.", "充填量 × 連結数", `${snapshot.fillMlPerChamber} × ${snapshot.connectedChambers}`, snapshot.totalFillMlPerPouch, "ml");

  const production = "생산 조건";
  add("production.base-speed", production, "기준 생산 속도", "충전량 규칙 또는 사용자 입력으로 정한 1연 기준 분당 생산 속도입니다.", "입력 또는 충전량 규칙", `입력값 = ${snapshot.baseProductionSpeedPerMinute}`, snapshot.baseProductionSpeedPerMinute, "枚/分");
  add("production.effective-speed", production, "実効生産速度", "연결 형식을 반영한 시간당 실제 생산 속도입니다.", "基準速度 × 60 × (lanesPerCycle ÷ 充填列数)", `${snapshot.baseProductionSpeedPerMinute} × 60 × (${snapshot.lanesPerCycle} ÷ ${snapshot.fillingLanes})`, snapshot.effectiveProductionSpeed, "枚/h");
  add("production.run-quantity", production, "稼働生産数量", "필름 로스를 포함해 실제 라인에 투입되는 수량입니다.", "発注数量 ÷ (1 − フィルムロス率)", `발주 수량 ÷ (1 - 로스율)`, snapshot.productionRunQuantity, "枚");
  add("production.production-hours", production, "生産時間", "실제 생산에 필요한 시간입니다.", "稼働生産数量 ÷ 実効生産速度", `${snapshot.productionRunQuantity} ÷ ${snapshot.effectiveProductionSpeed}`, snapshot.productionHours, "h");
  add("production.inspection-hours", production, "検品時間", "검품에 필요한 시간입니다.", "稼働生産数量 ÷ 検品速度", `稼働生産数量 ÷ 検品速度`, snapshot.inspectionHours, "h");

  const processing = "충전・가공비";
  add("processing.variable-total", processing, "変動加工費", "생산·검품 인건비와 가동 기계비를 합산한 가공비입니다.", "生産人件費 + 検品人件費 + 機械費", "각 시간 비용의 합", snapshot.variableProcessingTotal, "円");
  add("processing.fixed-lot", processing, "段取り・清掃費", "로트 시작 준비과 종료 후 청소에 필요한 고정비입니다.", "(段取り + 清掃) × (人件費 + 機械チャージ)", "고정 시간 × 시간당 비용", snapshot.fixedLotCost, "円");
  add("processing.custom", processing, "カスタム費用", "커스텀 사이즈/금형 등에 따른 추가 비용입니다.", "커스텀 적용 시 로트 비용", snapshot.customCharge === "0" ? "標準サイズのため ¥0" : `커스텀 적용 = ${snapshot.customCharge}`, snapshot.customCharge, "円");

  const film = "フィルム計算";
  add("film.required-length", film, "必要フィルム長", "로스를 포함해 필요한 필름 길이입니다.", "発注数量 ÷ (1 − ロス率) × ピッチ ÷ 1000 ÷ 列数", "SKU 조건 기준 합계", snapshot.film.requiredLengthM, "m");
  add("film.order-length", film, "発注長", "실제 발주하는 필름 길이입니다.", "SKU별 100m 단위 올림 + 최소 발주長", "SKU 조건 기준 합계", snapshot.film.orderLengthM, "m");
  add("film.loss", film, "フィルムロス", "생산 과정에서 발생하는 필름 로스입니다.", "発注長 × ロス率 또는 최소ロス", `적용 로스율 = 로스율`, snapshot.film.lossM, "m");
  add("film.effective-length", film, "有効長", "로스를 제외하고 실제 사용할 수 있는 길이입니다.", "発注長 × 生産倍率 − ロス", `발주/검토 길이 - 로스`, snapshot.film.effectiveLengthM, "m");
  add("film.unit-price", film, "適用フィルム単価", "발주 길이와 가격대에 따라 적용된 M당 단가입니다.", "가격표 선택", `発注長・幅에 따라 선택`, snapshot.film.unitPrice, "円/m");
  add("film.base-cost", film, "フィルム代", "필름 자체 발주 비용입니다.", "発注長 × 適用単価", `${snapshot.film.orderLengthM} × ${snapshot.film.unitPrice}`, snapshot.film.filmBaseCost, "円");
  add("film.domestic-shipping", film, "国内配送", "국내 운송 비용입니다.", "配送回数 × 国内配送単価", `配送 조건 기준`, snapshot.film.domesticShipping, "円");
  add("film.overseas-shipping", film, "海外配送", "해외 운송 비용입니다.", "配送回数 × 海外配送単価", `配送 조건 기준`, snapshot.film.overseasShipping, "円");
  add("film.customs", film, "通関料", "통관 비용입니다.", "필름 금액 또는 회수 기준", `통관 규칙 적용`, snapshot.film.customs, "円");
  add("film.total", film, "フィルム費用合計", "필름 관련 비용 총합입니다.", "フィルム代 + 国内配送 + 海外配送 + 通関料", `${snapshot.film.filmBaseCost} + ${snapshot.film.domesticShipping} + ${snapshot.film.overseasShipping} + ${snapshot.film.customs}`, snapshot.film.filmTotal, "円");

  const margin = "マージン・販売価格";
  add("margin.cost-per-piece", margin, "総原価 /枚", "모든 원가를 발주 수량으로 나눈 1개당 원가입니다.", "総原価 ÷ 発注数量", `${snapshot.costTotal} ÷ ${snapshot.quantity}`, snapshot.totalCostPerPiece, "円");
  snapshot.sellingPrices.forEach((price, index) => {
    add(
      `margin.selling-price.${index}`,
      margin,
      `販売単価 ${D(price.margin).times(100).toString()}%`,
      "목표 이익률을 반영한 판매 단가입니다.",
      "総原価/枚 ÷ (1 − 利益率)",
      `${snapshot.totalCostPerPiece} ÷ (1 − ${price.margin})`,
      price.pricePerPiece,
      "円",
    );
  });

  if (snapshot.gravure) {
    const gravure = "グラビア フィルム・銅版";
    const g = snapshot.gravure;
    add("gravure.pattern-count", gravure, "発注パターン", "필요 길이를 그라비아 발주 패턴으로 올림한 횟수입니다.", "ceil(必要納品長 ÷ 納品パターン長)", `必要長 ÷ 패턴 길이`, String(snapshot.orderPatternCount), "回");
    add("gravure.material-width", gravure, "原反幅", "그라비아 제작에 필요한 원반 폭입니다.", "最小500mm 또는 사이즈 기준幅", `적용 폭`, g ? g.materialWidthMm ?? "" : "", "mm");
    add("gravure.production-length", gravure, "製作長", "그라비아 제작 로트 길이입니다.", "パターン数 × 製作パターン長", `패턴 수 × 패턴 길이`, snapshot.productionPatternLengthM, "m");
    add("gravure.deliverable-length", gravure, "納品可能長", "로스를 제외하고 납품 가능한 길이입니다.", "パターン数 × 納品パターン長", `패턴 수 × 납품 길이`, snapshot.deliverablePatternLengthM, "m");
    add("gravure.material-cost", gravure, "原材料費", "필름 원재료 비용입니다.", "층별 두께 × 폭 × 길이 × 비중 × 단가의 합", `PET/AL/LLDPE 합계`, g ? g.materialCostYen ?? "" : "", "円");
    add("gravure.printing-cost", gravure, "印刷費", "그라비아 인쇄 비용입니다.", "幅 × 製作長 × 色数 × 印刷単価", `폭・길이・색수 기준`, g ? g.printingCostYen ?? "" : "", "円");
    add("gravure.lamination-cost", gravure, "ラミネート費", "필름 라미네이트 비용입니다.", "幅 × 製作長 × ラミ回数 × 単価", `라미네이트 조건 기준`, g ? g.laminationCostYen ?? "" : "", "円");
    add("gravure.manufacturer-margin", gravure, "製造マージン", "제조사 판매가에 포함되는 마진입니다.", "フィルム製造原価 × 製造マージン率", `제조 원가 × 마진율`, g ? g.manufacturerMarginCostYen ?? "" : "", "円");
    add("gravure.customs", gravure, "通関料", "관세 비용입니다.", "製造者販売価格 × 관세율", `관세 기준금액 × 관세율`, g ? g.customsCostYen ?? "" : "", "円");
    add("gravure.shipping", gravure, "海外配送費", "납품 가능 길이 기준 해외 배송비입니다.", "ceil(納品可能長 ÷ 配送単位) × 配送単価", `배송 회수 × 회당 비용`, g ? g.overseasShippingCostYen ?? "" : "", "円");
    add("gravure.seller-adjustment", gravure, "供給価格調整", "필름 비용에 포함되는 공급 가격 조정입니다.", "フィルム費用基準 × 調整率", `필름 기준 × 조정율`, snapshot.sellerProfitCost, "円");
    if (g.copperPlateCostYen) {
      add("gravure.copper-plate", gravure, "新規銅版費", "항상 신규로 제작하는 그라비아 동판 비용입니다.", "MAX(¥32,000, 色数 × 版幅 × 単価 × 外径)", `색수・폭·단가·외경 기준`, g.copperPlateCostYen, "円");
    }
  }

  return items;
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

  add("legacy.quantity", "기본 견적 조건", "발주 수량", "견적서에 저장된 발주 수량입니다.", "저장값", `저장값 = ${record.quantity}`, record.quantity, "枚");
  add("legacy.connected", "기본 견적 조건", "연결 형식", "저장된 사이즈 요약에서 확인한 연결 수입니다.", "사이즈 요약 파싱", `사이즈 요약 = ${record.sizeSummary}`, String(connected), "連");
  add("legacy.size", "기본 견적 조건", "파우치 사이즈", "저장된 사이즈 요약입니다.", "저장값", record.sizeSummary, `${widthMm} × ${lengthMm} mm`, "mm");
  add("legacy.film-order", "필름 계산", "필름 발주 길이", "견적서에 저장된 필름 발주 길이입니다.", "저장값", `저장값 = ${record.filmOrderLengthM}`, record.filmOrderLengthM, "m");
  add("legacy.film-unit", "필름 계산", "필름 구매 단가", "견적서에 저장된 M당 필름 구매 단가입니다.", "저장값", `저장값 = ${record.filmMeterPrice}`, record.filmMeterPrice, "円/m");
  add("legacy.film-amount", "필름 계산", "필름 표시 금액", "견적서에 저장된 필름 표시 금액입니다.", "저장된 표시 금액 우선", value("filmAmountDisplay") || "계산 불가", filmAmount, "円");
  add("legacy.filling-unit", "충전・가공비", "충전・가공 단가", "견적서에 저장된 1개당 충전·가공 단가입니다.", "저장값", `저장값 = ${fillingUnit}`, fillingUnit, "円");
  add("legacy.filling-amount", "충전・가공비", "충전・가공 금액", "견적서 저장값이 없으면 발주 수량 × 단가로 재계산합니다.", value("fillingAmountDisplay") ? "저장값" : "발주数量 × 단가", `${record.quantity} × ${fillingUnit}`, fillingAmount, "円");
  if (printingMethod === "gravure") {
    add("legacy.gravure-pattern", "그라비아 계산", "発注パターン", "저장된 그라비아 발주 패턴 수입니다.", "저장값", `저장값 = ${value("orderPatternCount")}`, value("orderPatternCount"), "回");
    add("legacy.gravure-delivery", "그라비아 계산", "納品パターン長", "저장된 납품 패턴 길이입니다.", "저장값", `저장값 = ${value("deliverablePatternLengthM")}`, value("deliverablePatternLengthM"), "m");
    add("legacy.gravure-production", "그라비아 계산", "製作長", "저장된 그라비아 제작 길이입니다.", "저장값", `저장값 = ${record.filmOrderLengthM}`, record.filmOrderLengthM, "m");
  }
  add("legacy.custom", "커스텀 / 금형", "金型・カスタム費用", "견적서에 저장된 금형·커스텀 비용입니다. 저장값이 없으면 0円으로 표시합니다.", "저장값", `저장값 = ${customCost}`, customCost, "円");
  add("legacy.total-cost", "마진 / 합계", "総原価 /枚", "견적서 저장값이 없으면 충전·가공 단가 + 필름 단가 + 커스텀 개당 비용으로 재구성합니다.", value("totalCostPerPiece") ? "저장값" : "충전단가 + 필름단가 + 커스텀/枚", totalCostPerPiece, "円");
  return items;
}
