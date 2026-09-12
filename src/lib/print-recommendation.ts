import { D, Decimal, sum } from "./decimal";
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
  includedUnitPricePerM: string;
  filmTotalYen: string;
  filmCostPerPieceYen: string;
  recommended: boolean;
  toleranceExceeded: boolean;
  priceBreak: boolean;
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

type CandidateDraft = Omit<PrintCandidate, "recommended" | "quantityDelta"> & { __internal?: true };

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
  return {
    ...draft,
    quantityDelta: adjustedQuantity.minus(original).toString(),
    recommended: false,
  };
}

function rankCandidates(candidates: PrintCandidate[], originalQuantity: Decimal): PrintCandidate[] {
  return [...candidates].sort((left, right) => {
    const leftCost = D(left.filmCostPerPieceYen);
    const rightCost = D(right.filmCostPerPieceYen);
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
  requiredLengths: Decimal[],
  totalTarget: Decimal,
  minimumPerSku: Decimal,
): Decimal[] | null {
  const count = requiredLengths.length;
  const minimumTotal = minimumPerSku.times(count);
  if (totalTarget.lt(minimumTotal) || !totalTarget.mod(100).eq(0)) return null;
  const totalRequired = sum(requiredLengths);
  if (!totalRequired.gt(0)) return null;
  const remaining = totalTarget.minus(minimumTotal);
  const base = requiredLengths.map(() => minimumPerSku);
  if (remaining.lte(0)) return base;

  const proportional = requiredLengths.map((required) => remaining.times(required).div(totalRequired));
  const allocated = requiredLengths.map((_, index) => floorTo(proportional[index], 100));
  let distributed = sum(allocated);
  const order = requiredLengths
    .map((required, index) => ({ index, required }))
    .sort((left, right) => (left.required.eq(right.required) ? left.index - right.index : right.required.minus(left.required).toNumber()));

  while (distributed.lt(remaining)) {
    const target = order.find(({ index }) => allocated[index].plus(100).lte(remaining.plus(minimumPerSku)))?.index ?? order[0].index;
    allocated[target] = allocated[target].plus(100);
    distributed = distributed.plus(100);
  }
  return allocated.map((value, index) => value.plus(minimumPerSku));
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
  const normalized = normalizeDigitalFilmOrder(
    skuRequiredLengths.map((required, index) => ({
      skuCode: `SKU-${index + 1}`,
      requiredLengthM: required.toString(),
    })),
    parameters,
  );
  const naturalTotal = sum(normalized.orders.map((order) => D(order.orderLengthM)));
  const minimumPerSku = D(parameters.digitalFilmMinSkuM);
  const minimumTotal = D(parameters.digitalFilmMinTotalM);
  const totalFloor = floorTo(naturalTotal, 100);
  const targets = new Set<string>([naturalTotal.toFixed(0)]);
  for (const offset of [0, 100, 200]) {
    const target = totalFloor.minus(offset);
    if (target.gte(maxDecimal(minimumTotal, minimumPerSku.times(skuRequiredLengths.length)))) targets.add(target.toFixed(0));
  }
  for (const boundary of ["500", "1000", "1500"]) {
    const target = D(boundary);
    if (target.gte(maxDecimal(minimumTotal, minimumPerSku.times(skuRequiredLengths.length)))) targets.add(boundary);
  }

  const drafts: CandidateDraft[] = [];
  for (const targetText of targets) {
    const target = D(targetText);
    const allocations = allocateTotalLength(skuRequiredLengths, target, minimumPerSku);
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

    drafts.push({
      ...candidateCommon("D", originalQuantity, adjustedQuantity, requiredTotal, aggregateOrderLength, effectiveTotal, filmTotal),
      id: `D-${targetText}-${adjustedQuantity.toFixed(0)}`,
      detailLabel: `合計 ${aggregateOrderLength.toFixed(0)}m / ${priceLength}m帯`,
      printingMethod: "digital",
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

  const sellerFactor = D(1).plus(context.parameters.sellerProfitRate);
  return combinations.map((combination): CandidateDraft => {
    const requiredTotal = sum(context.skuRequiredLengths);
    const patternKey = combination.options.map((option) => option.patternCount).join("-");
    const includedFilmTotal = combination.filmTotal
      .times(sellerFactor)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    return {
      ...candidateCommon("K", context.originalQuantity, combination.adjustedQuantity, requiredTotal, combination.orderLengthM, combination.effectiveLengthM, includedFilmTotal),
      id: `K-${patternKey}-${combination.adjustedQuantity.toFixed(0)}`,
      detailLabel: `韓国輸入 ${combination.gravureRoll.orderPatternCount}パターン`,
      printingMethod: "gravure",
      priceBreak: false,
      adjustedSkuQuantities: combination.options.map((option) => option.adjustedQuantity.toString()),
      skuPatternCounts: combination.options.map((option) => option.patternCount),
      gravureRoll: combination.gravureRoll,
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
    return {
      ...candidateCommon("Y", context.originalQuantity, adjustedQuantity, context.requiredLengthM, outputLength, outputLength, D(sasche.filmTotalYen)),
      id: `Y-${sasche.id}`,
      detailLabel: `国内 ${sasche.webWidthMm}mm / ${sasche.laneCount}丁 / ${sasche.printTierM}m印刷`,
      printingMethod: "gravure",
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
  const unique = drafts.filter((draft) => {
    if (seen.has(draft.id) || !D(draft.adjustedQuantity).gt(0)) return false;
    seen.add(draft.id);
    return true;
  });
  const ranked = rankCandidates(unique.map((draft) => finishCandidate(draft, context.originalQuantity)), context.originalQuantity);
  return ranked.map((candidate, index) => ({ ...candidate, recommended: index === 0 })).slice(0, 9);
}
