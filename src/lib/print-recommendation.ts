import { D, Decimal, ceilTo, sum } from "./decimal";
import { normalizeDigitalFilmOrder } from "./digital-film";
import { calculateRequiredProductionLength, deriveCustomSizeMaster, shippingUnitForWidth } from "./size-calculations";
import { buildSascheCandidates, type SascheCandidate } from "./sasche-gravure";
import { calculateGravureRollCost, type GravureRollCostResult, type GravureRollParameters } from "./gravure-roll";
import { sizeMaster } from "./constants";
import type { CostParameters, PouchSpec, SizeMaster } from "./types";

export type PrintCandidateRoute = "D" | "K" | "Y";

export type PrintCandidate = {
  id: string;
  route: PrintCandidateRoute;
  routeLabel: string;
  sourceLabel: string;
  detailLabel: string;
  printingMethod: "digital" | "gravure";
  originalQuantity: string;
  adjustedQuantity: string;
  adjustedSkuQuantities: string[];
  requiredLengthM: string;
  orderLengthM: string;
  effectiveLengthM: string;
  surplusLengthM: string;
  shortageLengthM: string;
  surplusRatio: string;
  quantityDelta: string;
  quantityShortfallRatio: string;
  includedUnitPricePerM: string;
  filmTotalYen: string;
  filmCostPerPieceYen: string;
  recommended: boolean;
  toleranceExceeded: boolean;
  priceBreak: boolean;
  orderReason?: string;
  surplusM?: string;
  surplusPieces?: string;
  materialWidthMm?: number;
  materialMultiplier?: number;
  colorText?: string;
  materialText?: string;
  compositionText?: string;
  pouchSpecText?: string;
  patternText?: string;
  skuPatternCounts?: number[];
  // Server-side selection metadata. Safe to serialize; the API never trusts client-side money values.
  filmOrders?: { skuCode: string; requiredLengthM: string; orderLengthM: string }[];
  sasche?: SascheCandidate;
  gravureRoll?: GravureRollCostResult;
};

export function createPrintCandidateContext({
  spec,
  quantity,
  parameters,
  gravureParameters,
}: {
  spec: PouchSpec;
  quantity: string | number | Decimal;
  parameters: CostParameters;
  gravureParameters: GravureRollParameters;
}): PrintCandidateContext {
  const originalQuantity = D(quantity);
  const baseSize = sizeMaster[spec.sizeKey];
  if (!baseSize) throw new Error("size_not_found");
  const size = spec.isCustom
    ? deriveCustomSizeMaster(baseSize, spec.customWidthMm ?? baseSize.widthMm, spec.customLengthMm ?? baseSize.lengthMm)
    : baseSize;
  const skuQuantities = spec.skuQuantities?.length
    ? spec.skuQuantities.map((value) => D(value))
    : Array.from({ length: spec.skuCount }, () => originalQuantity);
  const skuRequiredLengths = skuQuantities.map((quantity) =>
    calculateRequiredProductionLength(size, quantity, parameters.lossRate),
  );
  return {
    spec,
    size,
    originalQuantity,
    skuQuantities,
    skuRequiredLengths,
    requiredLengthM: sum(skuRequiredLengths),
    parameters,
    gravureParameters,
  };
}

export type PrintCandidateContext = {
  spec: PouchSpec;
  size: SizeMaster;
  originalQuantity: Decimal;
  skuQuantities: Decimal[];
  skuRequiredLengths: Decimal[];
  requiredLengthM: Decimal;
  parameters: CostParameters;
  gravureParameters: GravureRollParameters;
};

const PRINT_CANDIDATE_LIMIT = 3;

type CandidateDraft = Omit<PrintCandidate, "recommended" | "quantityDelta" | "quantityShortfallRatio"> & { __internal?: true };

function floorTo(value: Decimal, unit: string | number): Decimal {
  const step = D(unit);
  return value.div(step).toDecimalPlaces(0, Decimal.ROUND_FLOOR).times(step);
}

function maxDecimal(first: Decimal, second: Decimal): Decimal {
  return first.gte(second) ? first : second;
}

function aggregateIncludedPrice(totalCost: Decimal, orderLengthM: Decimal): string {
  return orderLengthM.gt(0) ? totalCost.div(orderLengthM).toString() : "0";
}

function finishCandidate(
  draft: CandidateDraft,
  originalQuantity: Decimal,
): PrintCandidate {
  const adjustedQuantity = D(draft.adjustedQuantity);
  const original = D(draft.originalQuantity);
  const shortfallRatio = original.gt(0)
    ? Decimal.max(D(0), original.minus(adjustedQuantity)).div(original).times(100)
    : D(0);
  return {
    ...draft,
    quantityDelta: adjustedQuantity.minus(original).toString(),
    quantityShortfallRatio: shortfallRatio.toString(),
    recommended: false,
  };
}

function rankCandidates(candidates: PrintCandidate[], originalQuantity: Decimal): PrintCandidate[] {
  return [...candidates].sort((left, right) => {
    // Ignore meaningless sub-yen differences caused by fixed shipping/customs
    // being spread across vastly different production quantities.
    const leftCost = D(left.filmCostPerPieceYen).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    const rightCost = D(right.filmCostPerPieceYen).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    if (!leftCost.eq(rightCost)) return leftCost.lt(rightCost) ? -1 : 1;
    const leftDelta = D(left.adjustedQuantity).minus(originalQuantity).abs();
    const rightDelta = D(right.adjustedQuantity).minus(originalQuantity).abs();
    if (!leftDelta.eq(rightDelta)) return leftDelta.lt(rightDelta) ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function candidateCommon(
  route: PrintCandidateRoute,
  originalQuantity: Decimal,
  adjustedQuantity: Decimal,
  requiredLengthM: Decimal,
  orderLengthM: Decimal,
  effectiveLengthM: Decimal,
  filmTotal: Decimal,
  tolerancePercent = "15",
  comparisonLengthM?: Decimal,
): Pick<
  PrintCandidate,
  | "route" | "routeLabel" | "sourceLabel" | "originalQuantity" | "adjustedQuantity"
  | "requiredLengthM" | "orderLengthM" | "effectiveLengthM" | "surplusLengthM"
  | "shortageLengthM" | "surplusRatio" | "includedUnitPricePerM" | "filmTotalYen"
  | "filmCostPerPieceYen" | "toleranceExceeded"
> {
  const surplus = maxDecimal(orderLengthM.minus(requiredLengthM), D(0));
  const shortage = maxDecimal(requiredLengthM.minus(orderLengthM), D(0));
  const surplusRatio = requiredLengthM.gt(0) ? surplus.div(requiredLengthM).times(100) : D(0);
  return {
    route,
    routeLabel: route,
    sourceLabel: route === "D" ? "デジタル" : route === "K" ? "韓国輸入" : "国内調達",
    originalQuantity: originalQuantity.toString(),
    adjustedQuantity: adjustedQuantity.toString(),
    requiredLengthM: requiredLengthM.toString(),
    orderLengthM: orderLengthM.toString(),
    effectiveLengthM: effectiveLengthM.toString(),
    surplusLengthM: surplus.toString(),
    shortageLengthM: shortage.toString(),
    surplusRatio: surplusRatio.toString(),
    includedUnitPricePerM: aggregateIncludedPrice(filmTotal, orderLengthM),
    filmTotalYen: filmTotal.toString(),
    filmCostPerPieceYen: adjustedQuantity.gt(0) ? filmTotal.div(adjustedQuantity).toString() : "0",
    toleranceExceeded: surplusRatio.gt(D(tolerancePercent)),
  };
}

function allocateTotalLength(
  weights: Decimal[],
  totalTarget: Decimal,
  minimums: Decimal[],
): Decimal[] | null {
  const count = weights.length;
  const minimumTotal = sum(minimums);
  if (totalTarget.lt(minimumTotal) || !totalTarget.mod(100).eq(0)) return null;
  const totalWeight = sum(weights);
  if (!totalWeight.gt(0)) return null;
  const remaining = totalTarget.minus(minimumTotal);
  const base = [...minimums];
  if (remaining.lte(0)) return base;

  const proportional = weights.map((weight) => remaining.times(weight).div(totalWeight));
  const allocated = weights.map((_, index) => floorTo(proportional[index], 100));
  let distributed = sum(allocated);
  const order = weights
    .map((weight, index) => ({ index, weight }))
    .sort((left, right) => (left.weight.eq(right.weight) ? left.index - right.index : right.weight.minus(left.weight).toNumber()));

  while (distributed.lt(remaining)) {
    const target = order[ distributed.mod(100).eq(0) ? distributed.div(100).toNumber() % order.length : 0 ].index;
    allocated[target] = allocated[target].plus(100);
    distributed = distributed.plus(100);
  }
  return allocated.map((value, index) => value.plus(minimums[index]));
}

function digitalCapacity(
  size: SizeMaster,
  requiredLength: Decimal,
  orderLength: Decimal,
  parameters: CostParameters,
) {
  const pitch = D(size.lengthMm).plus(size.pitchAddMm);
  const useLargeLot = Boolean(size.largeLotWebWidthMm) && requiredLength.gt(900);
  const multiplier = useLargeLot ? 2 : 1;
  const considered = orderLength.times(multiplier);
  const loss = Decimal.max(D(parameters.lossMinM), considered.times(parameters.lossRate));
  const effective = considered.minus(loss);
  const rawQuantity = effective.times(1000).div(pitch).times(size.lanes).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
  const proposedQuantity = floorTo(rawQuantity, 1000);
  const webWidthMm = useLargeLot ? size.largeLotWebWidthMm! : size.webWidthMm;
  const appliedBand: "lte570" | "571to740" = useLargeLot ? "571to740" : size.priceBand;
  return { pitch, useLargeLot, multiplier, considered, loss, effective, rawQuantity, proposedQuantity, webWidthMm, appliedBand };
}

// Local import alias keeps the public helper set of this module small.
function maxD(first: Decimal, second: Decimal): Decimal {
  return maxDecimal(first, second);
}

function buildDigitalCandidates(context: PrintCandidateContext): CandidateDraft[] {
  const { size, parameters, skuRequiredLengths, originalQuantity } = context;
  // For 736mm/2-up candidates, physical purchase length is approximately
  // half of the production-equivalent requirement. Allocate and compare using
  // purchase length, not production-equivalent length.
  const purchaseWeights = skuRequiredLengths.map((required) => {
    const useLargeLot = Boolean(size.largeLotWebWidthMm) && required.gt(900);
    return useLargeLot ? Decimal.max(500, ceilTo(required.div(2), 100)) : ceilTo(required, 100);
  });
  const normalized = purchaseWeights.map((orderLength, index) => ({
    skuCode: `SKU-${index + 1}`,
    requiredLengthM: skuRequiredLengths[index].toString(),
    orderLengthM: Decimal.max(orderLength, D(parameters.digitalFilmMinSkuM)).toString(),
  }));
  const naturalTotal = sum(normalized.map((order) => D(order.orderLengthM)));
  const minimumPerSku = D(parameters.digitalFilmMinSkuM);
  const minimums = skuRequiredLengths.map((required) => {
    const useLargeLot = Boolean(size.largeLotWebWidthMm) && required.gt(900);
    return useLargeLot ? Decimal.max(500, minimumPerSku) : minimumPerSku;
  });
  const minimumTotal = D(parameters.digitalFilmMinTotalM);
  const totalFloor = floorTo(naturalTotal, 100);
  const targets = new Set<string>();
  const minimumCandidateTotal = maxDecimal(minimumTotal, sum(minimums));
  if (naturalTotal.gte(minimumCandidateTotal)) targets.add(naturalTotal.toFixed(0));
  for (const offset of [0, 100, 200]) {
    const target = totalFloor.minus(offset);
    if (target.gte(minimumCandidateTotal)) targets.add(target.toFixed(0));
  }
  for (const boundary of ["500", "1000", "1500"]) {
    const target = D(boundary);
    if (target.gte(minimumCandidateTotal)) targets.add(boundary);
  }

  const drafts: CandidateDraft[] = [];
  for (const targetText of targets) {
    const target = D(targetText);
    const allocations = allocateTotalLength(purchaseWeights, target, minimums);
    if (!allocations) continue;
    const capacities = allocations.map((orderLength, index) =>
      digitalCapacity(size, skuRequiredLengths[index], orderLength, parameters),
    );
    const adjustedSkuQuantities = capacities.map((capacity) => capacity.proposedQuantity);
    const adjustedQuantity = sum(adjustedSkuQuantities);
    if (!adjustedQuantity.gt(0)) continue;

    const aggregateOrderLength = sum(allocations);
    const priceLength = aggregateOrderLength.lt(1000) ? "500" : aggregateOrderLength.lt(1500) ? "1000" : "1500";
    const skuRows = allocations.map((orderLength, index) => {
      const capacity = capacities[index];
      const unitPrice = D(parameters.filmUnitPrices[capacity.appliedBand][priceLength as "500" | "1000" | "1500"]);
      return {
        skuCode: `SKU-${index + 1}`,
        requiredLengthM: skuRequiredLengths[index].toString(),
        orderLengthM: orderLength.toString(),
        colorCount: context.spec.skuColorCounts?.[index] ?? context.spec.colorCount,
        capacity,
        unitPrice,
        baseCost: orderLength.times(unitPrice),
      };
    });
    const filmBaseCost = sum(skuRows.map((row) => row.baseCost));
    const productionEquivalentLength = sum(skuRows.map((row) => row.capacity.considered));
    const webWidthMm = capacities.some((capacity) => capacity.useLargeLot)
      ? size.largeLotWebWidthMm ?? size.webWidthMm
      : size.webWidthMm;
    const shippingUnit = D(shippingUnitForWidth(webWidthMm, parameters));
    const shippingTrips = maxDecimal(D(1), productionEquivalentLength.div(shippingUnit).toDecimalPlaces(0, Decimal.ROUND_CEIL));
    const domestic = shippingTrips.times(parameters.domesticShippingPerTrip);
    const overseas = shippingTrips.times(parameters.overseasShippingPerTrip);
    const customs = filmBaseCost.gt(parameters.customsThreshold)
      ? D(parameters.customsHighCharge)
      : shippingTrips.times(parameters.customsPerTrip);
    const filmTotal = filmBaseCost.plus(domestic).plus(overseas).plus(customs);
    const requiredTotal = sum(skuRequiredLengths);
    const effectiveTotal = sum(capacities.map((capacity) => capacity.effective));
    const priceBreak = ["500", "1000", "1500"].includes(targetText) && !aggregateOrderLength.eq(naturalTotal);
    const naturalRequiredTotal = sum(skuRequiredLengths);
    const minimumTotal = D(parameters.digitalFilmMinTotalM);
    const minimumSkuTotal = sum(minimums);
    const materialWidths = [...new Set(skuRows.map((row) => row.capacity.webWidthMm))];
    const materialText = materialWidths.map((width) => {
      const multiplier = skuRows.find((row) => row.capacity.webWidthMm === width)?.capacity.multiplier ?? 1;
      return `原反 ${width}mm${multiplier > 1 ? ` ×${multiplier}` : ""}`;
    }).join(" / ");
    const colorTotal = sum(skuRows.map((row) => Math.max(0, Number(row.colorCount) || 0)));
    const colorText = skuRows.length > 1
      ? `${skuRows.map((row) => Math.max(0, Number(row.colorCount) || 0)).join("+")}（計${colorTotal}色）`
      : `${colorTotal}色`;
    const compositionText = "PET12+AL7+PET12+LLDPE50";
    const pouchSpecText = `パウチ ${context.spec.customWidthMm ?? context.size.widthMm}×${context.spec.customLengthMm ?? context.size.lengthMm}mm ／ ${context.spec.connectedChambers}連 ／ ${context.spec.fillingLanes}列`;
    const patternText = `${materialText} ／ ${aggregateOrderLength.toFixed(0)}m ／ ${priceLength}m帯`;
    let orderReason = "必要長を100m単位に切り上げました。";
    if (aggregateOrderLength.lt(naturalRequiredTotal)) {
      orderReason = "発注パターンに合わせて生産数量を調整しました。";
    } else if (minimumTotal.gt(naturalRequiredTotal)) {
      orderReason = `合計最低発注 ${minimumTotal.toFixed(0)}mのため、最低発注量まで注文しました。`;
    } else if (minimumSkuTotal.gt(naturalRequiredTotal)) {
      orderReason = `SKU最低発注 ${parameters.digitalFilmMinSkuM}mのため、各SKUの発注長を引き上げました。`;
    } else if (priceBreak) {
      orderReason = `${priceLength}m帯単価適用のため、発注長を引き上げました。`;
    }

    drafts.push({
      ...candidateCommon(
        "D", originalQuantity, adjustedQuantity, requiredTotal, aggregateOrderLength, effectiveTotal, filmTotal,
        "15", sum(capacities.map((capacity) => capacity.considered)),
      ),
      id: `D-${targetText}-${adjustedQuantity.toFixed(0)}`,
      detailLabel: `合計 ${aggregateOrderLength.toFixed(0)}m / ${priceLength}m帯`,
      printingMethod: "digital",
      materialText: materialText,
      colorText: colorText,
      compositionText: compositionText,
      pouchSpecText: pouchSpecText,
      patternText: patternText,
      priceBreak,
      adjustedSkuQuantities: adjustedSkuQuantities.map((value) => value.toString()),
      filmOrders: skuRows.map((row) => ({
        skuCode: row.skuCode,
        requiredLengthM: row.requiredLengthM,
        orderLengthM: row.orderLengthM,
      })),
    });
  }
  return drafts;
}

type KOption = {
  patternCount: number;
  adjustedQuantity: Decimal;
  result: GravureRollCostResult;
  rankingCost: Decimal;
};

function buildKOptions(context: PrintCandidateContext, skuIndex: number): KOption[] {
  const requiredLength = context.skuRequiredLengths[skuIndex];
  const quantity = context.skuQuantities[skuIndex];
  const colors = D(context.spec.skuColorCounts?.[skuIndex] ?? context.spec.colorCount);
  const materialWidth = Decimal.max(500, context.size.webWidthMm);
  const requiredPatternLength = D(context.gravureParameters.deliverablePatternLengthM);
  const productionPatternLength = D(context.gravureParameters.productionPatternLengthM);
  const smallWidthTier = materialWidth.lte(D(context.gravureParameters.smallWidthThresholdMm)) && requiredLength.gt(requiredPatternLength);
  const deliveryPattern = smallWidthTier
    ? D(context.gravureParameters.smallWidthOrderPatternLengthM)
    : requiredPatternLength;
  const productionPattern = smallWidthTier
    ? D(context.gravureParameters.smallWidthProductionPatternLengthM)
    : productionPatternLength;
  const requiredPatterns = Decimal.max(D(1), requiredLength.div(deliveryPattern).toDecimalPlaces(0, Decimal.ROUND_CEIL)).toNumber();
  const start = Math.max(1, requiredPatterns - 2);
  const options: KOption[] = [];
  for (let patternCount = start; patternCount <= requiredPatterns + 2; patternCount += 1) {
    const candidateRequiredLength = deliveryPattern.times(patternCount);
    const perPieceRequiredLength = quantity.gt(0) ? requiredLength.div(quantity) : D(0);
    const adjustedQuantity = perPieceRequiredLength.gt(0)
      ? candidateRequiredLength.div(perPieceRequiredLength).toDecimalPlaces(0, Decimal.ROUND_FLOOR)
      : D(0);
    if (!adjustedQuantity.gt(0)) continue;
    const result = calculateGravureRollCost({
      requiredLengthM: candidateRequiredLength,
      materialWidthMm: materialWidth,
      colors,
      quantity: adjustedQuantity,
      parameters: context.gravureParameters,
    });
    const rankingCost = D(result.customsBaseCostYen)
      .plus(result.customsCostYen)
      .plus(result.overseasShippingCostYen);
    options.push({ patternCount, adjustedQuantity, result, rankingCost });
  }
  return options;
}

type KCombination = {
  options: KOption[];
  adjustedQuantity: Decimal;
  orderLengthM: Decimal;
  effectiveLengthM: Decimal;
  filmTotal: Decimal;
  gravureRoll: GravureRollCostResult;
};

function combineKOption(left: KCombination | null, right: KOption): KCombination {
  if (!left) {
    const adjustedQuantity = right.adjustedQuantity;
    return {
      options: [right],
      adjustedQuantity,
      orderLengthM: D(right.result.productionLengthM),
      effectiveLengthM: D(right.result.deliverableLengthM),
      filmTotal: right.rankingCost,
      gravureRoll: right.result,
    };
  }
  const adjustedQuantity = left.adjustedQuantity.plus(right.adjustedQuantity);
  const productionLength = left.orderLengthM.plus(right.result.productionLengthM);
  const deliverableLength = left.effectiveLengthM.plus(right.result.deliverableLengthM);
  const filmTotal = left.filmTotal.plus(right.rankingCost);
  const fields = [
    "materialCostYen", "printingCostYen", "laminationCostYen", "filmCostYen",
    "manufacturerMarginCostYen", "customsBaseCostYen", "customsCostYen",
    "overseasShippingCostYen", "copperPlateCostYen",
  ] as const;
  const summed = Object.fromEntries(fields.map((field) => [field, D(left.gravureRoll[field]).plus(D(right.result[field])).toString()]));
  const copperPlateCount = left.gravureRoll.copperPlateCount + right.result.copperPlateCount;
  const combined: GravureRollCostResult = {
    ...right.result,
    ...summed,
    requiredLengthM: D(left.gravureRoll.requiredLengthM).plus(right.result.requiredLengthM).toString(),
    orderPatternCount: left.gravureRoll.orderPatternCount + right.result.orderPatternCount,
    deliverableLengthM: deliverableLength.toString(),
    productionLengthM: productionLength.toString(),
    lossLengthM: productionLength.minus(deliverableLength).toString(),
    shippingTrips: left.gravureRoll.shippingTrips + right.result.shippingTrips,
    copperPlateCount,
    copperPlateUnitPriceYen: copperPlateCount > 0
      ? D(left.gravureRoll.copperPlateCostYen).plus(right.result.copperPlateCostYen).div(copperPlateCount).toString()
      : "0",
    totalGravureCostYen: D(left.gravureRoll.totalGravureCostYen).plus(right.result.totalGravureCostYen).toString(),
    filmCostPerPieceYen: adjustedQuantity.gt(0) ? filmTotal.div(adjustedQuantity).toString() : "0",
    copperPlateCostPerPieceYen: adjustedQuantity.gt(0)
      ? D(left.gravureRoll.copperPlateCostYen).plus(right.result.copperPlateCostYen).div(adjustedQuantity).toString()
      : "0",
    recommendedQuantity: adjustedQuantity.toString(),
    recommendedQuantityUtilization: deliverableLength.gt(0)
      ? D(left.gravureRoll.requiredLengthM).plus(right.result.requiredLengthM).div(deliverableLength).toString()
      : "0",
  };
  return { options: [...left.options, right], adjustedQuantity, orderLengthM: productionLength, effectiveLengthM: deliverableLength, filmTotal, gravureRoll: combined };
}

function combinationRank(combination: KCombination, originalQuantity: Decimal) {
  return {
    perPouch: combination.adjustedQuantity.gt(0) ? combination.filmTotal.div(combination.adjustedQuantity) : D(999999999),
    quantityDelta: combination.adjustedQuantity.minus(originalQuantity).abs(),
  };
}

function paretoCandidates(candidates: PrintCandidate[]): PrintCandidate[] {
  // Keep economically meaningful alternatives even when their quantity differs.
  // A candidate is dominated only when another candidate is simultaneously
  // better-or-equal in BOTH purchase total and per-piece cost.
  return candidates.filter((candidate) => {
    const total = D(candidate.filmTotalYen);
    const perPiece = D(candidate.filmCostPerPieceYen);
    return !candidates.some((competitor) => {
      if (competitor.id === candidate.id) return false;
      const competitorTotal = D(competitor.filmTotalYen);
      const competitorPerPiece = D(competitor.filmCostPerPieceYen);
      return competitorTotal.lte(total)
        && competitorPerPiece.lte(perPiece)
        && (competitorTotal.lt(total) || competitorPerPiece.lt(perPiece));
    });
  }).sort((left, right) => {
    const leftTotal = D(left.filmTotalYen);
    const rightTotal = D(right.filmTotalYen);
    if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;
    const leftPerPiece = D(left.filmCostPerPieceYen);
    const rightPerPiece = D(right.filmCostPerPieceYen);
    if (!leftPerPiece.eq(rightPerPiece)) return leftPerPiece.lt(rightPerPiece) ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

function buildKoreaCandidates(context: PrintCandidateContext): CandidateDraft[] {
  let combinations: KCombination[] = [];
  for (let skuIndex = 0; skuIndex < context.skuQuantities.length; skuIndex += 1) {
    const options = buildKOptions(context, skuIndex);
    if (options.length === 0) return [];
    const next: KCombination[] = [];
    for (const left of combinations.length ? combinations : [null as unknown as KCombination]) {
      for (const right of options) next.push(combineKOption(left, right));
    }
    next.sort((left, right) => {
      const a = combinationRank(left, context.originalQuantity);
      const b = combinationRank(right, context.originalQuantity);
      if (!a.perPouch.eq(b.perPouch)) return a.perPouch.lt(b.perPouch) ? -1 : 1;
      if (!a.quantityDelta.eq(b.quantityDelta)) return a.quantityDelta.lt(b.quantityDelta) ? -1 : 1;
      return left.options.map((option) => option.patternCount).join("-").localeCompare(right.options.map((option) => option.patternCount).join("-"));
    });
    combinations = next.slice(0, 32);
  }

  const materialWidth = Decimal.max(500, context.size.webWidthMm);
  const colorTotal = sum(context.spec.skuColorCounts?.length
    ? context.spec.skuColorCounts.map((value) => Math.max(0, Number(value) || 0))
    : Array.from({ length: context.skuQuantities.length }, () => Math.max(0, Number(context.spec.colorCount) || 0)));
  const colorText = context.skuQuantities.length > 1
    ? `${(context.spec.skuColorCounts ?? []).map((value) => Math.max(0, Number(value) || 0)).join("+")}（計${colorTotal}色）`
    : `${colorTotal}色`;
  const compositionText = "PET12+AL7+PET12+LLDPE50";
  const pouchSpecText = `パウチ ${context.spec.customWidthMm ?? context.size.widthMm}×${context.spec.customLengthMm ?? context.size.lengthMm}mm ／ ${context.spec.connectedChambers}連 ／ ${context.spec.fillingLanes}列`;
  const sellerFactor = D(1).plus(context.parameters.sellerProfitRate);
  return combinations.map((combination): CandidateDraft => {
    const requiredTotal = sum(context.skuRequiredLengths);
    const patternKey = combination.options.map((option) => option.patternCount).join("-");
    const includedFilmTotal = combination.filmTotal
      .times(sellerFactor)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const materialText = `原反 ${materialWidth}mm ／ パターン ${combination.options.map((option) => option.patternCount).join("+")} ／ ${combination.orderLengthM.toFixed(0)}m`;
    const patternText = `${materialText} ／ ${colorText}`;
    return {
      ...candidateCommon(
        "K", context.originalQuantity, combination.adjustedQuantity, requiredTotal, combination.orderLengthM,
        combination.effectiveLengthM, includedFilmTotal, "15", combination.effectiveLengthM,
      ),
      id: `K-${patternKey}-${combination.adjustedQuantity.toFixed(0)}`,
      detailLabel: `韓国輸入 パターン ${combination.options.map((option) => option.patternCount).join("+")}`,
      printingMethod: "gravure",
      materialText: materialText,
      colorText: colorText,
      compositionText: compositionText,
      pouchSpecText: pouchSpecText,
      patternText: patternText,
      priceBreak: false,
      orderReason: `韓国輸入パターン ${combination.options.map((option) => option.patternCount).join("+")} のため、発注長と数量を調整しました。`,
      adjustedSkuQuantities: combination.options.map((option) => option.adjustedQuantity.toString()),
      skuPatternCounts: combination.options.map((option) => option.patternCount),
      gravureRoll: {
        ...combination.gravureRoll,
        requiredLengthM: requiredTotal.toString(),
        recommendedQuantityUtilization: requiredTotal.gt(0)
          ? combination.effectiveLengthM.div(requiredTotal).toString()
          : "0",
      },
    } as CandidateDraft;
  });
}

function buildDomesticCandidates(context: PrintCandidateContext): CandidateDraft[] {
  const candidates = buildSascheCandidates({
    webWidthMm: context.size.webWidthMm,
    requiredLengthM: context.requiredLengthM,
    quantity: context.originalQuantity,
    colorCount: sum((context.spec.skuColorCounts?.length ? context.spec.skuColorCounts : [context.spec.colorCount]).map((value) => D(value))),
  });
  const colorTotal = sum(context.spec.skuColorCounts?.length
    ? context.spec.skuColorCounts.map((value) => Math.max(0, Number(value) || 0))
    : Array.from({ length: context.skuQuantities.length }, () => Math.max(0, Number(context.spec.colorCount) || 0)));
  const colorText = context.skuQuantities.length > 1
    ? `${(context.spec.skuColorCounts ?? []).map((value) => Math.max(0, Number(value) || 0)).join("+")}（計${colorTotal}色）`
    : `${colorTotal}色`;
  const compositionText = "PET12+AL7+PET12+LLDPE50";
  const pouchSpecText = `パウチ ${context.spec.customWidthMm ?? context.size.widthMm}×${context.spec.customLengthMm ?? context.size.lengthMm}mm ／ ${context.spec.connectedChambers}連 ／ ${context.spec.fillingLanes}列`;
  return candidates.map((sasche): CandidateDraft => {
    const outputLength = D(sasche.outputLengthM);
    const adjustedQuantity = D(sasche.adjustedQuantity);
    const ratios = context.skuRequiredLengths.map((required) => required.div(context.requiredLengthM));
    const perPieceBySku = context.skuRequiredLengths.map((required, index) => required.div(context.skuQuantities[index]));
    const skuQuantities = context.skuRequiredLengths.map((required, index) => outputLength.times(ratios[index]).div(perPieceBySku[index]).toDecimalPlaces(0, Decimal.ROUND_FLOOR));
    const difference = adjustedQuantity.minus(sum(skuQuantities)).toNumber();
    if (difference !== 0) {
      const index = context.skuRequiredLengths.reduce((largest, required, index) => required.gt(context.skuRequiredLengths[largest]) ? index : largest, 0);
      skuQuantities[index] = skuQuantities[index].plus(difference);
    }
    const materialText = `原反 ${sasche.matchedWidthMm}mm / ${sasche.laneCount}丁 / ${outputLength.toFixed(0)}m`;
    const patternText = `${materialText} ／ ${colorText}`;
    return {
      ...candidateCommon("Y", context.originalQuantity, adjustedQuantity, context.requiredLengthM, outputLength, outputLength, D(sasche.filmTotalYen)),
      id: `Y-${sasche.id}`,
      detailLabel: `国内 ${sasche.webWidthMm}mm / ${sasche.laneCount}丁 / ${sasche.printTierM}m印刷`,
      printingMethod: "gravure",
      materialText: materialText,
      colorText: colorText,
      compositionText: compositionText,
      pouchSpecText: pouchSpecText,
      patternText: patternText,
      orderReason: `国内Yパターン ${outputLength.toFixed(0)}m のため、発注数量を調整しました。`,
      priceBreak: true,
      adjustedSkuQuantities: skuQuantities.map((value) => value.toString()),
      sasche,
    };
  });
}

export function buildPrintCandidates(context: PrintCandidateContext): PrintCandidate[] {
  const drafts = [
    ...buildDigitalCandidates(context),
    ...buildKoreaCandidates(context),
    ...buildDomesticCandidates(context),
  ];
  const seen = new Set<string>();
  const candidates = drafts
    .filter((draft) => {
      if (seen.has(draft.id) || !D(draft.adjustedQuantity).gt(0)) return false;
      seen.add(draft.id);
      return true;
    })
    .map((draft) => finishCandidate(draft, context.originalQuantity));

  const originalQuantity = context.originalQuantity;
  const fulfilling = candidates.filter((candidate) => D(candidate.adjustedQuantity).gte(originalQuantity));
  const practicalPool = fulfilling.filter((candidate) => D(candidate.surplusRatio).lte(D("15")));

  const byTotal = (items: PrintCandidate[]) => [...items].sort((left, right) => {
    const leftTotal = D(left.filmTotalYen);
    const rightTotal = D(right.filmTotalYen);
    if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;
    const leftSurplus = D(left.surplusLengthM);
    const rightSurplus = D(right.surplusLengthM);
    if (!leftSurplus.eq(rightSurplus)) return leftSurplus.lt(rightSurplus) ? -1 : 1;
    const leftDelta = D(left.adjustedQuantity).minus(originalQuantity).abs();
    const rightDelta = D(right.adjustedQuantity).minus(originalQuantity).abs();
    if (!leftDelta.eq(rightDelta)) return leftDelta.lt(rightDelta) ? -1 : 1;
    return left.id.localeCompare(right.id);
  });

  const rankedPractical = byTotal(practicalPool);
  // If a low-surplus fulfilling order exists, prefer it because the customer
  // can use most of the film. Otherwise choose the shortest order that still
  // covers the requested quantity; this prevents 19,000/20,000 style answers.
  const byOrderThenTotal = (items: PrintCandidate[]) => [...items].sort((left, right) => {
    const leftLength = D(left.orderLengthM);
    const rightLength = D(right.orderLengthM);
    if (!leftLength.eq(rightLength)) return leftLength.lt(rightLength) ? -1 : 1;
    const leftTotal = D(left.filmTotalYen);
    const rightTotal = D(right.filmTotalYen);
    if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  const fulfillingRanked = practicalPool.length ? byTotal(practicalPool) : byOrderThenTotal(fulfilling);
  const recommendedCandidate = fulfillingRanked[0] ?? byTotal(candidates)[0];
  const pareto = paretoCandidates(candidates);

  // Show at most one representative per D/K/Y route. If the recommended
  // candidate belongs to a route, it replaces that route's alternative so the
  // three-card limit can cover all production routes instead of duplicating a
  // route (for example two D rows plus Y and K).
  const routeRepresentatives = (["D", "K", "Y"] as const)
    .map((route) => {
      const paretoRoute = pareto.filter((candidate) => candidate.route === route);
      if (paretoRoute.length) return paretoRoute[0];
      const practicalRoute = practicalPool.filter((candidate) => candidate.route === route);
      if (practicalRoute.length) return byTotal(practicalRoute)[0];
      const fulfillingRoute = fulfilling.filter((candidate) => candidate.route === route);
      if (fulfillingRoute.length) return byOrderThenTotal(fulfillingRoute)[0];
      const routeCandidates = candidates.filter((candidate) => candidate.route === route);
      return [...routeCandidates].sort((left, right) => {
        const leftDelta = D(left.adjustedQuantity).minus(originalQuantity).abs();
        const rightDelta = D(right.adjustedQuantity).minus(originalQuantity).abs();
        if (!leftDelta.eq(rightDelta)) return leftDelta.lt(rightDelta) ? -1 : 1;
        const leftTotal = D(left.filmTotalYen);
        const rightTotal = D(right.filmTotalYen);
        if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;
        return left.id.localeCompare(right.id);
      })[0];
    })
    .filter((candidate): candidate is PrintCandidate => Boolean(candidate));
  const paretoOrder = new Map(pareto.map((candidate, index) => [candidate.id, index]));

  const routeCandidatesForDisplay = routeRepresentatives.map((candidate) => (
    recommendedCandidate && candidate.route === recommendedCandidate.route
      ? recommendedCandidate
      : candidate
  ));
  const uniqueRouteCandidates = routeCandidatesForDisplay.filter((candidate, index, items) => (
    items.findIndex((item) => item.id === candidate.id) === index
  ));
  const rankedAlternatives = uniqueRouteCandidates
    .filter((candidate) => !recommendedCandidate || candidate.id !== recommendedCandidate.id)
    .sort((left, right) => {
      const leftRank = paretoOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = paretoOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.id.localeCompare(right.id);
    });

  const displayCandidates = [
    ...(recommendedCandidate ? [recommendedCandidate] : []),
    ...rankedAlternatives,
  ].slice(0, PRINT_CANDIDATE_LIMIT);
  const selectedIds = new Set(displayCandidates.map((candidate) => candidate.id));

  const display = displayCandidates;
  const uniqueDisplay: PrintCandidate[] = [];
  const displayIds = new Set<string>();
  for (const candidate of display) {
    if (displayIds.has(candidate.id)) continue;
    displayIds.add(candidate.id);
    uniqueDisplay.push(candidate);
  }

  return uniqueDisplay
    .slice(0, PRINT_CANDIDATE_LIMIT)
    .map((candidate) => ({ ...candidate, recommended: recommendedCandidate?.id === candidate.id }));
}
