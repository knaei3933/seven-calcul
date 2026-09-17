import { D, Decimal, ceilTo, sum } from "./decimal";
import { normalizeDigitalFilmOrder } from "./digital-film";
import { calculateRequiredProductionLength, deriveCustomSizeMaster, shippingUnitForWidth } from "./size-calculations";
import { buildSascheCandidates, type SascheCandidate, type SascheLane, type SaschePrintTier } from "./sasche-gravure";
import { calculateGravureRollCost, type GravureRollCostResult, type GravureRollParameters } from "./gravure-roll";
import { sizeMaster } from "./constants";
import type { CostParameters, PouchSpec, PrintingMethod, SizeMaster } from "./types";

export type PrintCandidateRoute = "D" | "K" | "Y";

export type PrintCandidate = {
  id: string;
  route: PrintCandidateRoute;
  routeLabel: string;
  sourceLabel: string;
  detailLabel: string;
  printingMethod: "digital" | "gravure";
  originalQuantity: string;
  capacityQuantity: string;
  capacityPlanningDifference: string;
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
  surplusPieces: string;
  shortagePieces: string;
  isFulfilling: boolean;
  isPractical: boolean;
  isExactQuantity: boolean;
  selectionTag: string;
  incrementalFilmTotalYen?: string;
  incrementalQuantity?: string;
  incrementalCostPerAdditionalPieceYen?: string;
  copperPlateTotalYen?: string;
  allInTotalCostYen?: string;
  allInCostPerPieceYen?: string;
  allInDeltaYen?: string;
  includedUnitPricePerM: string;
  filmTotalYen: string;
  filmCostPerPieceYen: string;
  recommended: boolean;
  toleranceExceeded: boolean;
  priceBreak: boolean;
  orderReason?: string;
  surplusM?: string;
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
  printingMethod,
  basisFilmOrderLengthM,
  basisFilmTotalYen,
}: {
  spec: PouchSpec;
  quantity: string | number | Decimal;
  parameters: CostParameters;
  gravureParameters: GravureRollParameters;
  printingMethod?: PrintingMethod;
  basisFilmOrderLengthM?: string | number | Decimal;
  basisFilmTotalYen?: string | number | Decimal;
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
    printingMethod,
    basisFilmOrderLengthM: basisFilmOrderLengthM ? D(basisFilmOrderLengthM) : null,
    basisFilmTotalYen: basisFilmTotalYen ? D(basisFilmTotalYen) : null,
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
  printingMethod?: PrintingMethod;
  basisFilmOrderLengthM: Decimal | null;
  basisFilmTotalYen: Decimal | null;
};

const PRINT_CANDIDATE_LIMIT = 6;
const PRACTICAL_SURPLUS_PERCENT = 15;
const NEAR_TARGET_SHORTAGE_RATIO = "0.15";
const NEAR_TARGET_SHORTAGE_REFERENCE_LIMIT = 2;

type CandidateDraft = Omit<
  PrintCandidate,
  "recommended" | "quantityDelta" | "quantityShortfallRatio" | "surplusPieces" | "shortagePieces" | "isFulfilling" | "isPractical" | "isExactQuantity" | "selectionTag" | "capacityPlanningDifference"
> & { __internal?: true };

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
  const capacityQuantity = D(draft.capacityQuantity);
  const capacityExactQuantity = D(draft.adjustedQuantity);
  const adjustedQuantity = capacityExactQuantity.gt(0) ? floorTo(capacityExactQuantity, 1000) : capacityExactQuantity;
  const plannedSkuQuantities = draft.adjustedSkuQuantities.map((value) => floorTo(D(value), 1000));
  const plannedSkuTotal = sum(plannedSkuQuantities);
  const planningDifference = adjustedQuantity.minus(plannedSkuTotal);
  if (!planningDifference.eq(0)) {
    const order = plannedSkuQuantities
      .map((value, index) => ({ index, value }))
      .sort((left, right) => (
        left.value.eq(right.value)
          ? left.index - right.index
          : planningDifference.gt(0) ? right.value.minus(left.value).toNumber() : left.value.minus(right.value).toNumber()
      ));
    let remaining = planningDifference;
    for (const { index } of order) {
      if (remaining.eq(0)) break;
      const step = remaining.gt(0) ? D(1000) : D(-1000);
      plannedSkuQuantities[index] = plannedSkuQuantities[index].plus(step);
      remaining = remaining.minus(step);
    }
  }
  const original = D(draft.originalQuantity);
  const shortfallRatio = original.gt(0)
    ? Decimal.max(D(0), original.minus(adjustedQuantity)).div(original).times(100)
    : D(0);
  const surplusPieces = Decimal.max(D(0), adjustedQuantity.minus(original));
  const shortagePieces = Decimal.max(D(0), original.minus(adjustedQuantity));
  const isFulfilling = shortagePieces.lte(0);
  const surplusRatio = original.gt(0) ? surplusPieces.div(original).times(100) : D(0);
  const isPractical = isFulfilling && surplusRatio.lte(D(PRACTICAL_SURPLUS_PERCENT));
  const isExactQuantity = isFulfilling && adjustedQuantity.eq(original);
  return {
    ...draft,
    capacityQuantity: capacityQuantity.toString(),
    capacityPlanningDifference: capacityQuantity.minus(adjustedQuantity).toString(),
    adjustedQuantity: adjustedQuantity.toString(),
    adjustedSkuQuantities: plannedSkuQuantities.map((value) => value.toString()),
    filmCostPerPieceYen: adjustedQuantity.gt(0) ? D(draft.filmTotalYen).div(adjustedQuantity).toString() : "0",
    quantityDelta: adjustedQuantity.minus(original).toString(),
    quantityShortfallRatio: shortfallRatio.toString(),
    surplusPieces: surplusPieces.toString(),
    shortagePieces: shortagePieces.toString(),
    isFulfilling,
    isPractical,
    isExactQuantity,
    selectionTag: isFulfilling
      ? (isExactQuantity ? "発注数一致" : isPractical ? "実用充足" : "充足・余剰大")
      : "不足のため参考",
    recommended: false,
  };
}

function compareCandidates(left: PrintCandidate, right: PrintCandidate, originalQuantity: Decimal): number {
  // Feasibility comes before money. A candidate cannot become "recommended"
  // merely because its per-piece price improves after dropping demand.
  if (left.isFulfilling !== right.isFulfilling) return left.isFulfilling ? -1 : 1;
  // An exact match to the customer's transaction quantity is the safest plan.
  // Capacity-break candidates remain visible after it.
  if (left.isExactQuantity !== right.isExactQuantity) return left.isExactQuantity ? -1 : 1;
  if (left.isPractical !== right.isPractical) return left.isPractical ? -1 : 1;

  // When no practical option exists, the shortest covering order is the safest
  // recommendation; it exposes the customer to the smallest inventory risk.
  if (!left.isPractical && !right.isPractical) {
    const leftSurplus = D(left.surplusPieces);
    const rightSurplus = D(right.surplusPieces);
    if (!leftSurplus.eq(rightSurplus)) return leftSurplus.lt(rightSurplus) ? -1 : 1;
  }

  const leftTotal = D(left.filmTotalYen);
  const rightTotal = D(right.filmTotalYen);
  if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;

  const leftPerPiece = D(left.filmCostPerPieceYen).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const rightPerPiece = D(right.filmCostPerPieceYen).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (!leftPerPiece.eq(rightPerPiece)) return leftPerPiece.lt(rightPerPiece) ? -1 : 1;

  const leftLength = D(left.orderLengthM);
  const rightLength = D(right.orderLengthM);
  if (!leftLength.eq(rightLength)) return leftLength.lt(rightLength) ? -1 : 1;

  const leftDelta = D(left.adjustedQuantity).minus(originalQuantity).abs();
  const rightDelta = D(right.adjustedQuantity).minus(originalQuantity).abs();
  if (!leftDelta.eq(rightDelta)) return leftDelta.lt(rightDelta) ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function createExactQuantityCandidate(candidate: PrintCandidate, originalQuantity: Decimal): PrintCandidate | null {
  const requested = D(originalQuantity);
  if (!candidate.isFulfilling || D(candidate.adjustedQuantity).eq(requested)) return null;

  const sourceQuantities = candidate.adjustedSkuQuantities.map((value) => D(value));
  const sourceTotal = sum(sourceQuantities);
  const exactSkus = sourceQuantities.map((value) => (
    sourceTotal.gt(0) ? value.times(requested).div(sourceTotal).toDecimalPlaces(0, Decimal.ROUND_FLOOR) : D(0)
  ));
  let remaining = requested.minus(sum(exactSkus));
  while (remaining.gt(0)) {
    const target = exactSkus.reduce((largest, value, index) => value.gt(exactSkus[largest]) ? index : largest, 0);
    exactSkus[target] = exactSkus[target].plus(1);
    remaining = remaining.minus(1);
  }
  const capacityQuantity = D(candidate.capacityQuantity);
  return {
    ...candidate,
    __internal: true,
    id: `${candidate.id}-exact`,
    capacityQuantity: capacityQuantity.toString(),
    capacityPlanningDifference: capacityQuantity.minus(requested).toString(),
    adjustedQuantity: requested.toString(),
    adjustedSkuQuantities: exactSkus.map((value) => value.toString()),
    filmCostPerPieceYen: requested.gt(0) ? D(candidate.filmTotalYen).div(requested).toString() : "0",
    quantityDelta: "0",
    quantityShortfallRatio: "0",
    surplusPieces: "0",
    shortagePieces: "0",
    surplusRatio: "0",
    toleranceExceeded: false,
    isFulfilling: true,
    isPractical: true,
    isExactQuantity: true,
    selectionTag: "発注数一致",
    recommended: false,
  } as PrintCandidate;
}

function selectionTagForRank(candidate: PrintCandidate, ranked: PrintCandidate[]): string {
  if (!candidate.isFulfilling) {
    const shortagePieces = D(candidate.shortagePieces);
    const originalQuantity = D(candidate.originalQuantity);
    if (shortagePieces.gt(0) && originalQuantity.gt(0)
      && shortagePieces.div(originalQuantity).lte("0.15")) {
      return "目標数近似・不足参考";
    }
    return "不足のため参考";
  }
  const feasible = ranked.filter((item) => item.isFulfilling);
  const tags: string[] = [candidate.isExactQuantity ? "発注数一致" : candidate.isPractical ? "実用充足" : "充足・余剰大"];
  if (feasible.length > 0 && candidate.id === feasible.reduce((best, item) => (
    D(item.filmTotalYen).lt(D(best.filmTotalYen)) ? item : best
  )).id) tags.push("総額最小");
  if (feasible.length > 0 && candidate.id === feasible.reduce((best, item) => (
    D(item.filmCostPerPieceYen).lt(D(best.filmCostPerPieceYen)) ? item : best
  )).id) tags.push("単価最小");
  if (feasible.length > 0 && candidate.id === feasible.reduce((best, item) => (
    D(item.orderLengthM).lt(D(best.orderLengthM)) ? item : best
  )).id) tags.push("最短充足");
  return tags.join("／");
}

function isNearTargetShortage(candidate: PrintCandidate, originalQuantity: Decimal): boolean {
  if (candidate.isFulfilling || originalQuantity.lte(0)) return false;
  const shortagePieces = D(candidate.shortagePieces);
  return shortagePieces.gt(0)
    && shortagePieces.div(originalQuantity).lte(NEAR_TARGET_SHORTAGE_RATIO);
}

function repeatSascheCandidate(
  candidate: SascheCandidate,
  count: number,
  requiredLengthM: Decimal,
): SascheCandidate {
  const outputLengthM = D(candidate.outputLengthM).times(count);
  const filmTotalYen = D(candidate.filmTotalYen).times(count);
  const quantity = D(candidate.quantity);
  const perPieceRequiredLength = quantity.gt(0) ? requiredLengthM.div(quantity) : D(0);
  const adjustedQuantity = perPieceRequiredLength.gt(0)
    ? outputLengthM.div(perPieceRequiredLength).toDecimalPlaces(0, Decimal.ROUND_FLOOR)
    : D(0);
  const quantityReductionRatio = quantity.gt(0)
    ? Decimal.max(D(0), quantity.minus(adjustedQuantity)).div(quantity).times(100)
    : D(0);
  const surplusLengthM = Decimal.max(outputLengthM.minus(requiredLengthM), D(0));
  const shortageLengthM = Decimal.max(requiredLengthM.minus(outputLengthM), D(0));
  return {
    ...candidate,
    id: `${candidate.id}x${count}`,
    patternCount: count,
    baseApproxLengthM: outputLengthM.toNumber(),
    outputLengthM: outputLengthM.toString(),
    filmTotalYen: filmTotalYen.toString(),
    filmUnitPriceYen: outputLengthM.gt(0) ? filmTotalYen.div(outputLengthM).toString() : "0",
    supplierUnitPriceYenPerM: outputLengthM.gt(0)
      ? filmTotalYen.div("1.12").div(outputLengthM).toString()
      : "0",
    requiredLengthM: requiredLengthM.toString(),
    adjustedQuantity: adjustedQuantity.toString(),
    quantityReductionRatio: quantityReductionRatio.toString(),
    quantityToleranceExceeded: quantityReductionRatio.gt("0.15"),
    surplusLengthM: surplusLengthM.toString(),
    shortageLengthM: shortageLengthM.toString(),
    surplusRatio: requiredLengthM.gt(0)
      ? surplusLengthM.div(requiredLengthM).times(100).toString()
      : "0",
    feasible: outputLengthM.gte(requiredLengthM) || quantityReductionRatio.lte("0.15"),
    skuOutputLengthsM: [outputLengthM.toString()],
    skuPatternIds: Array.from({ length: count }, () => candidate.id),
  };
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
  // Production planning uses a 1,000-piece floor. Exact capacity stays visible
  // so the difference between capacity and released plan is auditable.
  const proposedQuantity = floorTo(rawQuantity, 1000);
  const webWidthMm = useLargeLot ? size.largeLotWebWidthMm! : size.webWidthMm;
  const appliedBand: "lte570" | "571to740" = useLargeLot ? "571to740" : size.priceBand;
  return { pitch, useLargeLot, multiplier, considered, loss, effective, capacityQuantity: rawQuantity, proposedQuantity, webWidthMm, appliedBand };
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

  // The rounded requirement can still be short after loss and 1,000-piece
  // planning. Add the smallest 100m procurement length that actually covers
  // the fixed customer quantity (for example 500m -> 600m for 20,000 pieces).
  {
    const start = maxDecimal(totalFloor, minimumCandidateTotal);
    const limit = maxDecimal(minimumCandidateTotal, naturalTotal).plus(50000);
    for (let target = start; target.lte(limit); target = target.plus(100)) {
      const allocations = allocateTotalLength(purchaseWeights, target, minimums);
      if (!allocations) continue;
      const capacity = allocations.reduce((total, orderLength, index) => (
        total.plus(digitalCapacity(size, skuRequiredLengths[index], orderLength, parameters).proposedQuantity)
      ), D(0));
      if (capacity.gte(originalQuantity)) {
        targets.add(target.toFixed(0));
        break;
      }
    }
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
    const capacityQuantity = sum(capacities.map((capacity) => capacity.capacityQuantity));
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
      capacityQuantity: capacityQuantity.toString(),
      id: `D-${targetText}-${adjustedQuantity.toFixed(0)}`,
      detailLabel: `合計 ${aggregateOrderLength.toFixed(0)}m / ${priceLength}m帯`,
      printingMethod: "digital",
      materialText: materialText,
      colorText: colorText,
      compositionText: compositionText,
      pouchSpecText: pouchSpecText,
      patternText: patternText,
      orderReason,
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
      capacityQuantity: combination.adjustedQuantity.toString(),
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
  type DomesticCombination = {
    sasche: SascheCandidate;
    adjustedQuantities: Decimal[];
    outputLengthM: Decimal;
    filmTotalYen: Decimal;
    plateTotalYen: Decimal;
    skuColorCounts: number[];
  };

  const skuColorCounts = context.spec.skuColorCounts?.length
    ? context.spec.skuColorCounts.map((value) => Math.max(0, Number(value) || 0))
    : context.skuQuantities.map(() => Math.max(0, Number(context.spec.colorCount) || 0));

  // Domestic (Y) rolls are not shared between SKUs. Each SKU needs its own
  // fixed shipping pattern, so options are combined per SKU instead of using
  // the total required length as a single roll.
  let combinations: DomesticCombination[] = [];
  for (let skuIndex = 0; skuIndex < context.skuQuantities.length; skuIndex += 1) {
    const options = buildSascheCandidates({
      webWidthMm: context.size.webWidthMm,
      requiredLengthM: context.skuRequiredLengths[skuIndex],
      quantity: context.skuQuantities[skuIndex],
      colorCount: D(skuColorCounts[skuIndex]),
    });
    if (options.length === 0) return [];

    // One SKU may need several rolls of the same domestic pattern. Plate cost
    // stays once per SKU/colour while film repeats with each fixed roll.
    const expandedOptions = options.flatMap((candidate) => {
      const outputLengthM = D(candidate.outputLengthM);
      if (!outputLengthM.gt(0)) return [candidate];
      const minimumRepeatCount = Decimal.max(
        D(1),
        D(candidate.requiredLengthM).div(outputLengthM).toDecimalPlaces(0, Decimal.ROUND_CEIL),
      ).toNumber();
      if (minimumRepeatCount <= 1) return [candidate];
      return [
        candidate,
        repeatSascheCandidate(candidate, minimumRepeatCount, D(candidate.requiredLengthM)),
      ];
    });

    const createCombination = (candidate: SascheCandidate): DomesticCombination => ({
      sasche: candidate,
      adjustedQuantities: [D(candidate.adjustedQuantity)],
      outputLengthM: D(candidate.outputLengthM),
      filmTotalYen: D(candidate.filmTotalYen),
      plateTotalYen: D(candidate.plateTotalYen),
      skuColorCounts: [candidate.colorCount],
    });

    combinations = expandedOptions.map(createCombination) as typeof combinations;
    if (skuIndex === 0) continue;

    const next: DomesticCombination[] = [];
    for (const left of combinations) {
      for (const right of expandedOptions) {
        const outputLengthM = left.outputLengthM.plus(right.outputLengthM);
        const filmTotalYen = left.filmTotalYen.plus(right.filmTotalYen);
        const plateTotalYen = left.plateTotalYen.plus(right.plateTotalYen);
        const adjustedQuantity = left.adjustedQuantities.reduce(
          (total, value) => total.plus(value),
          D(0),
        );
        const requiredLengthM = D(left.sasche.requiredLengthM).plus(right.requiredLengthM);
        const surplusLengthM = Decimal.max(outputLengthM.minus(requiredLengthM), D(0));
        const shortageLengthM = Decimal.max(requiredLengthM.minus(outputLengthM), D(0));
        const colorCount = left.sasche.colorCount + right.colorCount;
        next.push({
          sasche: {
            id: `${left.sasche.id}+${right.id}`,
            webWidthMm: right.webWidthMm,
            matchedWidthMm: right.matchedWidthMm,
            laneCount: Math.max(left.sasche.laneCount, right.laneCount) as SascheLane,
            printTierM: Math.max(left.sasche.printTierM, right.printTierM) as SaschePrintTier,
            patternCount: left.sasche.patternCount + right.patternCount,
            filmLabel: "Y",
            baseApproxLengthM: left.sasche.baseApproxLengthM + right.baseApproxLengthM,
            supplierUnitPriceYenPerM: outputLengthM.gt(0)
              ? filmTotalYen.div("1.12").div(outputLengthM).toString()
              : "0",
            sellerMarkup: "1.12",
            filmUnitPriceYen: outputLengthM.gt(0) ? filmTotalYen.div(outputLengthM).toString() : "0",
            filmTotalYen: filmTotalYen.toString(),
            requiredLengthM: requiredLengthM.toString(),
            quantity: D(left.sasche.quantity).plus(right.quantity).toString(),
            colorCount,
            plateUnitPriceYen: colorCount > 0 ? plateTotalYen.div(colorCount).toString() : "0",
            plateTotalYen: plateTotalYen.toString(),
            skuOutputLengthsM: [...left.sasche.skuOutputLengthsM ?? [], right.outputLengthM],
            skuPatternIds: [...left.sasche.skuPatternIds ?? [], right.id],
            adjustedQuantity: adjustedQuantity.toString(),
            quantityReductionRatio: context.originalQuantity.gt(0)
              ? Decimal.max(D(0), context.originalQuantity.minus(adjustedQuantity))
                .div(context.originalQuantity).times(100).toString()
              : "0",
            quantityToleranceExceeded: context.originalQuantity.gt(0)
              && Decimal.max(D(0), context.originalQuantity.minus(adjustedQuantity))
                .div(context.originalQuantity).gt("0.15"),
            outputLengthM: outputLengthM.toString(),
            surplusLengthM: surplusLengthM.toString(),
            shortageLengthM: shortageLengthM.toString(),
            surplusRatio: requiredLengthM.gt(0)
              ? surplusLengthM.div(requiredLengthM).times(100).toString()
              : "0",
            feasible: left.sasche.feasible && right.feasible,
            recommended: false,
            comparisonRank: 0,
          },
          adjustedQuantities: [...left.adjustedQuantities, D(right.adjustedQuantity)],
          outputLengthM,
          filmTotalYen,
          plateTotalYen,
          skuColorCounts: [...left.skuColorCounts, right.colorCount],
        });
      }
    }
    combinations = next;
  }

  const colorTotal = sum(context.spec.skuColorCounts?.length
    ? context.spec.skuColorCounts.map((value) => Math.max(0, Number(value) || 0))
    : Array.from({ length: context.skuQuantities.length }, () => Math.max(0, Number(context.spec.colorCount) || 0)));
  const colorText = context.skuQuantities.length > 1
    ? `${(context.spec.skuColorCounts ?? []).map((value) => Math.max(0, Number(value) || 0)).join("+")}（計${colorTotal}色）`
    : `${colorTotal}色`;
  const compositionText = "PET12+AL7+PET12+LLDPE50";
  const pouchSpecText = `パウチ ${context.spec.customWidthMm ?? context.size.widthMm}×${context.spec.customLengthMm ?? context.size.lengthMm}mm ／ ${context.spec.connectedChambers}連 ／ ${context.spec.fillingLanes}列`;
  return combinations.map((combination): CandidateDraft => {
    const sasche = combination.sasche;
    const outputLength = D(sasche.outputLengthM);
    const adjustedQuantity = D(sasche.adjustedQuantity);
    const filmTotalYen = D(sasche.filmTotalYen).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const skuQuantities = combination.adjustedQuantities.map((value) => value.toString());
    const outputParts = (sasche.skuOutputLengthsM ?? [sasche.outputLengthM]).map((length) => `${D(length).toFixed(0)}m`);
    const outputText = outputParts.length > 1
      ? `${outputParts.join("+")} ／ 合計${outputLength.toFixed(0)}m`
      : `${outputLength.toFixed(0)}m`;
    const materialText = `原反 ${sasche.matchedWidthMm}mm / ${sasche.laneCount}丁 / SKUごと ${outputText}`;
    const patternText = `${materialText} ／ ${colorText}`;
    return {
      ...candidateCommon("Y", context.originalQuantity, adjustedQuantity, context.requiredLengthM, outputLength, outputLength, filmTotalYen),
      capacityQuantity: adjustedQuantity.toString(),
      id: `Y-${sasche.id}`,
      detailLabel: `国内 ${sasche.webWidthMm}mm / ${sasche.laneCount}丁 / ${sasche.printTierM}m印刷`,
      printingMethod: "gravure",
      materialText: materialText,
      colorText: colorText,
      compositionText: compositionText,
      pouchSpecText: pouchSpecText,
      patternText: patternText,
      orderReason: outputParts.length > 1
        ? `国内Y調達はSKUごとに独立発注のため、${outputParts.join("+")} を発注しました。`
        : `国内Yパターン ${outputLength.toFixed(0)}m のため、発注数量を調整しました。`,
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

  candidates.push(...candidates.flatMap((candidate) => createExactQuantityCandidate(candidate, context.originalQuantity) ?? []));

  const originalQuantity = context.originalQuantity;
  const ranked = [...candidates].sort((left, right) => compareCandidates(left, right, originalQuantity));
  const fulfillingRanked = ranked.filter((candidate) => candidate.isFulfilling);
  const practicalPool = fulfillingRanked.filter((candidate) => candidate.isPractical);
  // A shortage candidate is reference-only. It must never receive 推奨 status,
  // even when every route would otherwise require reducing the order quantity.
  const recommendedCandidate = practicalPool[0] ?? fulfillingRanked[0] ?? null;
  const pareto = paretoCandidates(candidates);

  // Show at most one representative per D/K/Y route. If the recommended
  // candidate belongs to a route, it replaces that route's alternative so the
  // three-card limit can cover all production routes instead of duplicating a
  // route (for example two D rows plus Y and K).
	  const routeRepresentatives = (["D", "K", "Y"] as const)
	    .map((route) => {
	      const rankedRoute = ranked.filter((candidate) => candidate.route === route);
		      const fulfillingRoute = rankedRoute.filter((candidate) => candidate.isFulfilling);
		      const practicalRoute = fulfillingRoute.filter((candidate) => candidate.isPractical);
		      const paretoRoute = pareto.filter((candidate) => candidate.route === route);
		      const paretoFulfillingRoute = paretoRoute.filter((candidate) => candidate.isFulfilling);
		      return practicalRoute[0] ?? fulfillingRoute[0] ?? paretoFulfillingRoute[0] ?? paretoRoute[0] ?? rankedRoute[0];
		    })
    .filter((candidate): candidate is PrintCandidate => Boolean(candidate));
  const paretoOrder = new Map(pareto.map((candidate, index) => [candidate.id, index]));

  const routeCandidatesForDisplay = [
    ...(recommendedCandidate ? [recommendedCandidate] : []),
    ...routeRepresentatives.filter((candidate) => (
      !recommendedCandidate || candidate.route !== recommendedCandidate.route
    )),
  ];
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

  // A shortage proposal is not recommended, but it is the user's explicit
  // "what if we buy only the small lot?" comparison. Keep one far-shortage
  // reference when no near-target plan represents that tradeoff.
  const shortageReference = ranked
    .filter((candidate) => !candidate.isFulfilling)
    .sort((left, right) => {
      const leftShortage = D(left.shortagePieces);
      const rightShortage = D(right.shortagePieces);
      if (!leftShortage.eq(rightShortage)) return leftShortage.lt(rightShortage) ? -1 : 1;
      const leftTotal = D(left.filmTotalYen);
      const rightTotal = D(right.filmTotalYen);
      if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;
      return left.id.localeCompare(right.id);
    })[0] ?? null;

  // A near-target shortage can be a real negotiation option (for example
  // "reduce the order by a few percent to avoid a large fixed-roll jump").
  // Preserve both the closest plan and the lowest-film-cost plan so users can
  // compare "maximum deliverable quantity" against "minimum material cost".
  // These references are never recommended automatically.
  const nearTargetCandidates = ranked
    .filter((candidate) => isNearTargetShortage(candidate, originalQuantity))
    .filter((candidate) => !recommendedCandidate || candidate.id !== recommendedCandidate.id);
  const closestNearTarget = [...nearTargetCandidates].sort((left, right) => {
    const leftDelta = D(left.adjustedQuantity).minus(originalQuantity).abs();
    const rightDelta = D(right.adjustedQuantity).minus(originalQuantity).abs();
    if (!leftDelta.eq(rightDelta)) return leftDelta.lt(rightDelta) ? -1 : 1;
    const leftTotal = D(left.filmTotalYen);
    const rightTotal = D(right.filmTotalYen);
    if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;
    return left.id.localeCompare(right.id);
  })[0] ?? null;
  const cheapestNearTarget = [...nearTargetCandidates].sort((left, right) => {
    const leftTotal = D(left.filmTotalYen);
    const rightTotal = D(right.filmTotalYen);
    if (!leftTotal.eq(rightTotal)) return leftTotal.lt(rightTotal) ? -1 : 1;
    const leftDelta = D(left.adjustedQuantity).minus(originalQuantity).abs();
    const rightDelta = D(right.adjustedQuantity).minus(originalQuantity).abs();
    if (!leftDelta.eq(rightDelta)) return leftDelta.lt(rightDelta) ? -1 : 1;
    return left.id.localeCompare(right.id);
  })[0] ?? null;
  const nearTargetShortageReferences = [
    closestNearTarget,
    cheapestNearTarget,
  ].filter((candidate): candidate is PrintCandidate => (
    Boolean(candidate) && (!recommendedCandidate || recommendedCandidate.id !== candidate.id)
  )).filter((candidate, index, items) => (
    items.findIndex((item) => item.id === candidate.id) === index
  )).slice(0, NEAR_TARGET_SHORTAGE_REFERENCE_LIMIT);

  // The input basis must always remain selectable. Without this, the card can
  // display a concrete planning quantity while no candidate exists to apply it.
  const basisCandidate = context.basisFilmOrderLengthM
    ? candidates.filter((candidate) => D(candidate.orderLengthM).eq(context.basisFilmOrderLengthM!))
        .find((candidate) => candidate.isExactQuantity)
      ?? candidates.find((candidate) => D(candidate.orderLengthM).eq(context.basisFilmOrderLengthM!))
      ?? null
    : null;

  // Each D/K/Y route is a primary decision. Reserve one representative per
  // route before basis/shortage references so a domestic option cannot be
  // crowded out by a Korean option merely because both are gravure.
  const guaranteedRouteCandidates = routeCandidatesForDisplay;

  const displayCandidates = [
    ...guaranteedRouteCandidates,
    ...nearTargetShortageReferences,
    ...(basisCandidate ? [basisCandidate] : []),
    ...(shortageReference ? [shortageReference] : []),
    ...rankedAlternatives,
  ].filter((candidate, index, items) => (
    items.findIndex((item) => item.id === candidate.id) === index
  )).slice(0, PRINT_CANDIDATE_LIMIT);
  const displayTags = new Map(displayCandidates.map((candidate) => [
    candidate.id,
    selectionTagForRank(candidate, ranked),
  ]));

  return displayCandidates.map((candidate) => {
    const fulfillingUpgrade = candidate.route !== "D" && !candidate.isFulfilling
      ? candidates.filter((item) => (
        item.route === candidate.route && item.isFulfilling && D(item.orderLengthM).gt(D(candidate.orderLengthM))
      )).sort((left, right) => D(left.orderLengthM).minus(D(right.orderLengthM)).toNumber())[0]
      : null;
    const upgradeText = fulfillingUpgrade
      ? ` 不足解消には ${fulfillingUpgrade.orderLengthM}m計画への切上げが必要です（+${
        D(fulfillingUpgrade.orderLengthM).minus(candidate.orderLengthM).toFixed(0)
      }m）。`
      : "";
    return {
      ...candidate,
      selectionTag: displayTags.get(candidate.id) ?? candidate.selectionTag,
      recommended: recommendedCandidate?.id === candidate.id,
      orderReason: `${candidate.orderReason}${upgradeText}`,
      ...(
        context.basisFilmTotalYen
          ? {
              incrementalFilmTotalYen: D(candidate.filmTotalYen).minus(context.basisFilmTotalYen).toString(),
              incrementalQuantity: D(candidate.adjustedQuantity).minus(originalQuantity).toString(),
              incrementalCostPerAdditionalPieceYen: D(candidate.adjustedQuantity).gt(originalQuantity)
                ? D(candidate.filmTotalYen).minus(context.basisFilmTotalYen)
                    .div(D(candidate.adjustedQuantity).minus(originalQuantity)).toString()
                : undefined,
            }
          : {}
      ),
    };
  });
}
