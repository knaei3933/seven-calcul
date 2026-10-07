import { D, Decimal, parseDecimal, roundUp1 } from "./decimal";
import { DEFAULT_FILM_COMPOSITION } from "./quotation-shared";
import { COPPER_TARGET_MARGIN } from "./quotation-pricing";
import type { QuotationRecord } from "./quotation-shared";

const storedNumber = (value: unknown): Decimal => {
  if (typeof value === "string") return parseDecimal(value) ?? D(0);
  return typeof value === "number" && Number.isFinite(value) ? D(value) : D(0);
};

const editedNumber = (value: unknown): Decimal | null => {
  if (typeof value === "number") return Number.isFinite(value) ? D(value) : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  return parseDecimal(value);
};

const positiveNumber = (value: unknown): Decimal | null => {
  const numeric = editedNumber(value);
  return numeric && numeric.gt(0) ? numeric : null;
};

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.trim() !== "" ? value : fallback;

// 見積書の容量単価（500m未満=480 / 500-999m=450 / 1000-1499m=410 / 1500m以上=380）。
// 表示snapshotを持たない旧レコードの明細復元にのみ使う。
function legacyRecommendedFilmMeterUnit(value: unknown): Decimal | null {
  const length = editedNumber(value);
  if (!length) return null;
  if (length.gte(1500)) return D(380);
  if (length.gte(1000)) return D(410);
  if (length.gte(500)) return D(450);
  return D(480);
}

export function filmCompositionOf(record: QuotationRecord): string {
  return text(record.payload.filmComposition, DEFAULT_FILM_COMPOSITION);
}

export function printingMethodOf(record: QuotationRecord): "digital" | "gravure" {
  const value = text(record.payload.printingMethod, "digital");
  return value === "gravure" ? "gravure" : "digital";
}

export function analyzeQuotation(record: QuotationRecord) {
  const payload = record.payload;
  const quantity = storedNumber(payload.quantity ?? record.quantity);
  const fillingCostUnit = storedNumber(payload.fillingCostPerPiece ?? record.fillingCostPerPiece);
  // 충진·가공 원가를「파우치 가공비（変動＋固定）」와「バルク費用」으로 분해한다.
  // 계산 체크리스트 스냅샷에 구성요소가 저장되어 있을 때만 분해하고, 구 레코드는 통합값을 유지한다.
  const checklistCostBreakdown = (() => {
    const snapshot = payload.calculationChecklistSnapshot;
    if (!snapshot || typeof snapshot !== "object") return null;
    const costs = snapshot as { bulkCost?: unknown; variableProcessingTotal?: unknown; fixedLotCost?: unknown };
    const bulk = editedNumber(costs.bulkCost);
    const variable = editedNumber(costs.variableProcessingTotal);
    const fixed = editedNumber(costs.fixedLotCost);
    if (!bulk || !variable || !fixed || !quantity.gt(0)) return null;
    return { bulk, processing: { variable, fixed } };
  })();
  // 신규 형식: 견적서에서 バルクを別ライン로 분리(payload.bulkCostPerPiece 보유).
  const payloadBulkCost = editedNumber(payload.bulkCostPerPiece);
  const separatedBulkCostUnit = payloadBulkCost && quantity.gt(0) ? payloadBulkCost.div(quantity) : null;
  // 견적 초안과 동일하게 매수당 소수 1자리 올림 후 합산해 분해합계＝통합원가가 되게 한다.
  const snapshotProcessingCostUnit = checklistCostBreakdown
    ? roundUp1(checklistCostBreakdown.processing.variable.div(quantity))
      .plus(roundUp1(checklistCostBreakdown.processing.fixed.div(quantity)))
    : D(0);
  const snapshotBulkCostUnit = checklistCostBreakdown ? roundUp1(checklistCostBreakdown.bulk.div(quantity)) : D(0);
  const hasSeparatedBulkLine = separatedBulkCostUnit !== null;
  const processingCostUnit = hasSeparatedBulkLine ? fillingCostUnit : snapshotProcessingCostUnit;
  const bulkCostUnit = separatedBulkCostUnit ?? snapshotBulkCostUnit;
  const filmCostUnit = storedNumber(payload.filmCostPerPiece ?? record.filmCostPerPiece);
  const copperCostUnit = storedNumber(payload.copperPlateCostPerPiece);
  const customLotCost = storedNumber(payload.customLotCost);
  const customQuantity = positiveNumber(payload.customQuantity) ?? D(1);
  const customCostUnit = customLotCost.div(quantity);
  const costUnit = fillingCostUnit
    .plus(separatedBulkCostUnit ?? D(0))
    .plus(filmCostUnit)
    .plus(copperCostUnit)
    .plus(customCostUnit);

  const targetMargin = positiveNumber(payload.targetMargin ?? record.targetMargin) ?? D(0);
  const marginDivider = D(1).minus(targetMargin.lt(1) ? targetMargin : D(0));
  const copperMarginDivider = D(1).minus(COPPER_TARGET_MARGIN);
  // 신규 견적은「1연 기준 원가×연결수×(1+가산율)」을 가격 기준으로 저장한다.
  // pricingFillingCostPerPiece가 있으면 그것을 우선 사용해 이력 분석이 견적 페이지와 일치하게 한다.
  const pricingFillingCostUnit = editedNumber(payload.pricingFillingCostPerPiece);
  const targetFillingUnit = (pricingFillingCostUnit ?? fillingCostUnit).div(marginDivider);
  const targetFilmUnit = filmCostUnit.div(marginDivider);
  const targetCopperUnit = copperCostUnit.div(copperMarginDivider);
  const targetCustomSaleTotal = Decimal.max(
    customLotCost.div(customQuantity).div(marginDivider).toDecimalPlaces(0, Decimal.ROUND_CEIL).div(1000).ceil().times(1000).times(customQuantity),
    D(0),
  );
  const targetCustomUnit = customQuantity.gt(0) ? targetCustomSaleTotal.div(customQuantity) : D(0);
  const targetCustomSalePerPiece = quantity.gt(0) ? targetCustomSaleTotal.div(quantity) : D(0);

  // record側の単価・合計は保存時に見積書表示値として確定しているため、
  // 旧payload（表示snapshotがない履歴）でも必ずrecord値をfallbackにする。
  const sellingUnit = editedNumber(payload.pricePerPieceDisplay)
    ?? editedNumber(record.pricePerPiece)
    ?? targetFillingUnit.plus(targetFilmUnit).plus(targetCopperUnit).plus(targetCustomSalePerPiece);

  const displayedFilmMeterUnit = editedNumber(payload.filmUnitDisplay)
    ?? legacyRecommendedFilmMeterUnit(payload.filmOrderLengthM ?? record.filmOrderLengthM);
  const filmOrderLength = storedNumber(payload.filmOrderLengthM ?? record.filmOrderLengthM);
  const legacyFilmAmount = displayedFilmMeterUnit && filmOrderLength.gt(0)
    ? displayedFilmMeterUnit.times(filmOrderLength)
    : null;
  const legacyFillingAmount = legacyFilmAmount
    ? Decimal.max(sellingUnit.times(quantity).minus(legacyFilmAmount), D(0))
    : null;

  const fillingUnit = editedNumber(payload.fillingUnitDisplay)
    ?? (legacyFillingAmount && quantity.gt(0) ? legacyFillingAmount.div(quantity) : targetFillingUnit);
  // 신규 형식의 バルク販売 ラ인（客給 시 0＝비표시）。
  const bulkUnit = editedNumber(payload.bulkUnitDisplay)
    ?? (separatedBulkCostUnit ? separatedBulkCostUnit.div(marginDivider) : D(0));
  const bulkAmount = editedNumber(payload.bulkAmountDisplay) ?? bulkUnit.times(quantity);
  const filmUnit = editedNumber(payload.filmPouchUnitDisplay)
    ?? (legacyFilmAmount && quantity.gt(0) ? legacyFilmAmount.div(quantity) : targetFilmUnit);
  const copperColorCount = positiveNumber(payload.copperColorCount);
  const displayedCopperAmount = editedNumber(payload.copperAmountDisplay);
  const displayedCopperUnit = editedNumber(payload.copperUnitDisplay);
  // copperUnitDisplay は新版では色単価。旧データはパウチ単価として扱う。
  const automaticCopperAmount = copperCostUnit.div(copperMarginDivider).times(quantity);
  const fallbackCopperColorUnit = copperColorCount && copperColorCount.gt(0)
    ? automaticCopperAmount.div(copperColorCount).toDecimalPlaces(0, Decimal.ROUND_CEIL)
    : null;
  const copperColorUnit = displayedCopperUnit
    ?? (displayedCopperAmount && copperColorCount && copperColorCount.gt(0)
      ? displayedCopperAmount.div(copperColorCount).toDecimalPlaces(0, Decimal.ROUND_CEIL)
      : fallbackCopperColorUnit);
  const copperAmount = displayedCopperAmount
    ?? (copperColorUnit && copperColorCount ? copperColorUnit.times(copperColorCount) : automaticCopperAmount);
  const copperUnit = displayedCopperUnit && !copperColorCount
    ? displayedCopperUnit
    : quantity.gt(0) ? copperAmount.div(quantity) : D(0);
  const customUnit = editedNumber(payload.customUnitDisplay)
    ?? targetCustomUnit;
  const customAmount = editedNumber(payload.customAmountDisplay) ?? customUnit.times(customQuantity);
  const profitUnit = sellingUnit.minus(costUnit);
  const profitRate = sellingUnit.gt(0) ? profitUnit.div(sellingUnit).times(100) : D(0);
  const markupRate = costUnit.gt(0) ? profitUnit.div(costUnit).times(100) : D(0);
  const totalRevenue = sellingUnit.times(quantity);
  const totalProfit = profitUnit.times(quantity);

  const beforeAdjustment = sellingUnit.times(quantity);
  const automaticSubtotal = beforeAdjustment.floor();
  const adjustmentText = payload.adjustmentDisplay;
  const adjustment = adjustmentText === "-"
    ? D(0)
    : editedNumber(payload.adjustmentDisplay) ?? automaticSubtotal.minus(beforeAdjustment);
  const subtotal = editedNumber(payload.subtotalDisplay)
    ?? editedNumber(record.subtotal)
    ?? automaticSubtotal;
  const taxRate = positiveNumber(payload.taxRatePercent ?? record.taxRatePercent) ?? D(0);
  const tax = editedNumber(payload.taxDisplay)
    ?? editedNumber(record.tax)
    ?? subtotal.times(taxRate.div(100)).toDecimalPlaces(0);
  const grandTotal = editedNumber(payload.grandTotalDisplay)
    ?? editedNumber(record.grandTotal)
    ?? subtotal.plus(tax);

  const storedSellingUnit = storedNumber(record.pricePerPiece);
  const storedCostUnit = storedNumber(record.fillingCostPerPiece).plus(record.filmCostPerPiece).plus(storedNumber(record.payload.customLotCost).div(storedNumber(record.payload.quantity || record.quantity)));
  const storedProfitUnit = storedSellingUnit.minus(storedCostUnit);
  const storedProfitRate = storedSellingUnit.gt(0) ? storedProfitUnit.div(storedSellingUnit).times(100) : D(0);

  const overrides = [
    "copperUnitDisplay", "copperAmountDisplay",
    "fillingUnitDisplay", "fillingAmountDisplay", "filmUnitDisplay", "filmPouchUnitDisplay",
    "filmAmountDisplay", "adjustmentDisplay", "pricePerPieceDisplay", "subtotalDisplay",
    "taxDisplay", "grandTotalDisplay",
    "customUnitDisplay", "customAmountDisplay",
  ].filter((key) => editedNumber(payload[key]) !== null);

  return {
    quantity,
    fillingCostUnit,
    hasFillingCostBreakdown: checklistCostBreakdown !== null || hasSeparatedBulkLine,
    hasSeparatedBulkLine,
    processingCostUnit,
    bulkCostUnit,
    filmCostUnit,
    copperCostUnit,
    customCostUnit,
    customQuantity,
    displayedFilmMeterUnit,
    orderPatternCount: storedNumber(payload.orderPatternCount),
    deliverablePatternLengthM: storedNumber(payload.deliverablePatternLengthM),
    recommendedQuantity: storedNumber(payload.recommendedQuantity),
    filmMeterPrice: storedNumber(payload.filmMeterPrice ?? record.filmMeterPrice),
    filmOrderLength,
    costUnit,
    targetMargin,
    targetFillingUnit,
    targetFilmUnit,
    targetCopperUnit,
    targetCustomUnit,
    targetCustomSalePerPiece,
    fillingUnit,
    bulkUnit,
    bulkAmount,
    filmUnit,
    copperUnit,
    copperColorUnit: copperColorUnit ?? D(0),
    copperColorCount: copperColorCount ?? D(0),
    copperAmount,
    customUnit,
    customAmount,
    displayedAdjustment: adjustmentText === "-" ? "-" : text(payload.adjustmentDisplay, ""),
    fillingAmount: editedNumber(payload.fillingAmountDisplay)
      ?? legacyFillingAmount
      ?? fillingUnit.times(quantity),
    filmAmount: editedNumber(payload.filmAmountDisplay)
      ?? legacyFilmAmount
      ?? filmUnit.times(quantity),
    sellingUnit,
    profitUnit,
    profitRate,
    markupRate,
    totalRevenue,
    totalProfit,
    adjustment,
    subtotal,
    taxRate,
    tax,
    grandTotal,
    storedSellingUnit,
    storedCostUnit,
    storedProfitUnit,
    storedProfitRate,
    overrideCount: overrides.length,
    overrides,
  };
}
