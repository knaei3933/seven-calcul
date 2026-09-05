import { createHash } from "node:crypto";
import { CALCULATION_VERSION, defaultParameters, sizeMaster } from "./constants";
import { D, Decimal, ceilTo, eq, maxD, roundTo2, sum } from "./decimal";
import { normalizeDigitalFilmOrder, QuotationValidationError, type FilmOrderAdjustment, type FilmSkuOrder } from "./digital-film";
import { calculateRequiredProductionLength, deriveCustomSizeMaster, shippingUnitForWidth } from "./size-calculations";
import { calculateGravureRollCost, defaultGravureRollParameters, type GravureRollParameters } from "./gravure-roll";
import type { CostParameters, FilmPriceMode, PriceBand, PouchSpec, PrintingMethod, QuotationStatus, SizeMaster } from "./types";

export interface CostResult {
  quantity: string;
  connectedChambers: 1 | 2 | 3 | 4;
  chamberCount: string;
  fillMlPerChamber: string;
  totalFillMlPerPouch: string;
  fillingMethod: PouchSpec["fillingMethod"];
  fillingLanes: number;
  baseProductionSpeedPerMinute: string;
  effectiveProductionSpeed: string;
  lanesPerCycle: number;
  productionRunQuantity: string;
  productionHours: string;
  inspectionHours: string;
  bulkLossRate: string;
  initialChargeMl: string;
  testFillMl: string;
  bulkUsageMl: string;
  bulkCost: string;
  bulkCostPerPiece: string;
  materialCostPerPiece: string;
  variableLaborPerPiece: string;
  machineVariablePerPiece: string;
  variableProcessingPerPiece: string;
  variableProcessingTotal: string;
  fixedLotCost: string;
  fixedCostPerPiece: string;
  customCharge: string;
  sellerProfitBaseCost: string;
  sellerProfitRate: string;
  sellerProfitCost: string;
  totalCostPerPiece: string;
  costTotal: string;
  costComponents: Record<"film" | "copperPlate" | "bulk" | "variableProcessing" | "fixedLot" | "custom", string>;
  costPerPieceComponents: Record<"film" | "copperPlate" | "bulk" | "variableProcessing" | "fixedLot" | "custom", string>;
  sellingPrices: { margin: string; pricePerPiece: string; totalSales: string; profit: string }[];
  film: FilmCostResult;
  copperPlateCost: string;
  copperPlateCostPerPiece: string;
  orderPatternCount?: number;
  deliverablePatternLengthM?: string;
  recommendedQuantity?: string;
  gravure?: {
    materialCostYen: string;
    printingCostYen: string;
    laminationCostYen: string;
    filmCostYen: string;
    manufacturerMarginCostYen: string;
    smallWidthTier: boolean;
    smallWidthManufacturerUnitPriceKRWPerM: string;
    customsBaseCostYen: string;
    customsCostYen: string;
    overseasShippingCostYen: string;
    shippingTrips: number;
    copperPlateCostYen: string;
    finalHeatSealWidthMm: string;
  };
  warnings: WarningCode[];
  audit: {
    calculationVersion: string;
    inputJsonSha256: string;
    resultJsonSha256: string;
    digitalFilmPriceMode: FilmPriceMode;
    unresolvedInputFlags: WarningCode[];
    componentReconciliationDifference: string;
  };
}

export type WarningCode =
  | "seven_template_unconfirmed"
  | "tax_rounding_unconfirmed"
  | "digital_color_price_not_applied"
  | "custom_size_mapping_unconfirmed"
  | "filling_lanes_differ_from_film_lanes";

export interface FilmCostResult {
  requiredLengthM: string;
  orderLengthM: string;
  lossM: string;
  effectiveLengthM: string;
  actualQuantity: string;
  pricingQuantity: string;
  unitPrice: string;
  filmBaseCost: string;
  domesticShipping: string;
  overseasShipping: string;
  customs: string;
  filmTotal: string;
  filmCostPerPiece: string;
  shippingTrips: string;
  orderAdjustment: FilmOrderAdjustment;
  skuCosts: FilmSkuCostResult[];
}

export interface FilmSkuCostResult {
  skuCode: string;
  name: string;
  quantity: string;
  fillMlPerChamber: string;
  colorCount: string;
  requiredLengthM: string;
  orderLengthM: string;
  filmCost: string;
  multiplier: number;
  consideredLengthM: string;
  appliedBand: PriceBand;
  webWidthMm: number;
}

export interface CalculationInput {
  spec: PouchSpec;
  quantity: string;
  printingMethod: PrintingMethod;
  parameters?: Partial<CostParameters>;
  gravureParameters?: GravureRollParameters;
  targetMargins?: string[];
}

const DEFAULT_TARGET_MARGINS = ["0.4", "0.5"] as const;

function resolveTargetMargins(targetMargins?: string[]): string[] {
  if (!targetMargins || targetMargins.length === 0) return [...DEFAULT_TARGET_MARGINS];
  const seen = new Set<string>();
  const valid: { value: string; numeric: number }[] = [];
  for (const margin of targetMargins) {
    const numeric = Number(margin);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) throw validationError("invalid_target_margin");
    const key = numeric.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ value: margin, numeric });
  }
  return valid.sort((a, b) => a.numeric - b.numeric).map((item) => item.value);
}

export function calculatePouchCost({ spec, quantity, printingMethod, parameters, gravureParameters, targetMargins }: CalculationInput): CostResult {
  const params = { ...defaultParameters, ...parameters } as CostParameters;
  const quantityD = D(quantity);
  if (quantityD.lte(0) || D(spec.fillMlPerChamber).lte(0) || spec.fillingLanes <= 0) throw validationError("invalid_positive_input");
  const margins = resolveTargetMargins(targetMargins);

  const size = getSizeMaster(spec);
  if (!Number.isInteger(spec.skuCount) || spec.skuCount <= 0) throw validationError("invalid_sku_count");
  const useSkuQuantities = Array.isArray(spec.skuQuantities);
  if (useSkuQuantities && spec.skuQuantities!.length !== spec.skuCount) throw validationError("invalid_sku_quantities");
  const skuQuantitiesList: Decimal[] = useSkuQuantities
    ? spec.skuQuantities!.map((value) => {
        const skuQuantity = D(value);
        if (skuQuantity.lte(0)) throw validationError("invalid_positive_input");
        return skuQuantity;
      })
    : Array.from({ length: spec.skuCount }, () => quantityD);
  if (useSkuQuantities && !eq(sum(skuQuantitiesList), quantityD)) throw validationError("invalid_sku_quantity_sum");
  const useSkuFills = Array.isArray(spec.skuFillMlPerChamber);
  if (useSkuFills && spec.skuFillMlPerChamber!.length !== spec.skuCount) throw validationError("invalid_sku_fill_ml");
  const skuFills: Decimal[] = useSkuFills
    ? spec.skuFillMlPerChamber!.map((value) => {
        const fill = D(value);
        if (fill.lte(0)) throw validationError("invalid_positive_input");
        return fill;
      })
    : Array.from({ length: spec.skuCount }, () => D(spec.fillMlPerChamber));
  const skuRequiredLengths = skuQuantitiesList.map((skuQuantity) => calculateRequiredProductionLength(size, skuQuantity, params.lossRate));
  const { orders: digitalOrders, adjustment: orderAdjustment } = normalizeDigitalFilmOrder(
    skuRequiredLengths.map((requiredLength, index) => ({
      skuCode: `SKU-${index + 1}`,
      requiredLengthM: requiredLength.toString(),
    })),
    params,
  );
  const requiredLengthM = sum(skuRequiredLengths);
  const gravureRoll = printingMethod === "gravure"
    ? calculateGravureRollCost({
        requiredLengthM,
        materialWidthMm: Decimal.max(500, size.webWidthMm),
        pouchWidthMm: size.widthMm,
        colors: spec.colorCount,
        quantity,
        skuColorUsage: skuRequiredLengths.map((length, index) => ({
          lengthM: length.toString(),
          colors: spec.skuColorCounts?.[index] ?? spec.colorCount,
        })),
        parameters: gravureParameters ?? defaultGravureRollParameters(),
      })
    : null;
  const film = gravureRoll
    ? {
        requiredLengthM: gravureRoll.requiredLengthM,
        orderLengthM: gravureRoll.productionLengthM,
        lossM: gravureRoll.lossLengthM,
        effectiveLengthM: gravureRoll.deliverableLengthM,
        actualQuantity: quantityD.toString(),
        pricingQuantity: quantityD.toString(),
        unitPrice: D(gravureRoll.customsBaseCostYen).plus(gravureRoll.customsCostYen).plus(gravureRoll.overseasShippingCostYen).div(gravureRoll.productionLengthM).toString(),
        filmBaseCost: gravureRoll.filmCostYen,
        domesticShipping: "0",
        overseasShipping: gravureRoll.overseasShippingCostYen,
        customs: gravureRoll.customsCostYen,
        filmTotal: D(gravureRoll.customsBaseCostYen).plus(gravureRoll.customsCostYen).plus(gravureRoll.overseasShippingCostYen).toString(),
        filmCostPerPiece: gravureRoll.filmCostPerPieceYen,
        shippingTrips: gravureRoll.shippingTrips.toString(),
        orderAdjustment,
        skuCosts: [],
      }
    : calculateFilmCost(size, quantityD, printingMethod, params, digitalOrders, orderAdjustment);
  const skuCosts = film.skuCosts.map((skuCost, index) => ({
    ...skuCost,
    name: (spec.skuNames?.[index] ?? "").trim() || `充填物${index + 1}`,
    quantity: skuQuantitiesList[index].toString(),
    fillMlPerChamber: skuFills[index].toString(),
    colorCount: (spec.skuColorCounts?.[index] ?? spec.colorCount).toString(),
  }));
  const filmWithSkus: FilmCostResult = { ...film, skuCosts };
  const initialCharge = initialChargeMl(spec, params);
  const chamberCount = quantityD.times(spec.connectedChambers);
  const weightedAvgFill = sum(skuQuantitiesList.map((skuQuantity, index) => skuQuantity.times(skuFills[index]))).div(sum(skuQuantitiesList));
  const testFill = D(params.fillTestRuns).times(spec.fillingLanes).times(weightedAvgFill);
  const bulkUsage = chamberCount.times(weightedAvgFill).times(D(1).plus(params.bulkLossRate)).plus(initialCharge).plus(testFill);
  const bulkCost = bulkUsage.times(spec.bulkUnitPrice);
  const bulkPerPiece = bulkCost.div(quantityD);

  const lanesPerCycle = Math.max(1, Math.floor(spec.fillingLanes / spec.connectedChambers));
  const effectiveProductionSpeed = D(params.productionSpeedPerMinute).times(60).times(lanesPerCycle).div(spec.fillingLanes);
  const productionRunQuantity = quantityD.div(D(1).minus(params.lossRate));
  const productionHours = productionRunQuantity.div(effectiveProductionSpeed);
  const inspectionHours = productionRunQuantity.div(params.inspectionSpeed);
  const variableLabor = D(params.laborPerHour).times(productionHours).plus(D(params.laborPerHour).times(inspectionHours));
  const machineVariable = D(params.machineChargePerHour).times(productionHours);
  const variableProcessing = variableLabor.plus(machineVariable);
  const variableTotal = variableProcessing;
  const variableLaborPerPiece = variableLabor.div(quantityD);
  const machineVariablePerPiece = machineVariable.div(quantityD);
  const variableProcessingPerPiece = variableProcessing.div(quantityD);
  const fixedLot = D(params.setupTime).plus(params.cleanupTime).times(D(params.laborPerHour).plus(params.machineChargePerHour));
  const fixedPerPiece = fixedLot.div(quantityD);
  const customCharge = spec.isCustom ? D(params.customPouchCharge) : D(0);

  const copperPlateCost = gravureRoll?.copperPlateCostYen ?? "0";
  const copperPlateCostPerPiece = gravureRoll?.copperPlateCostPerPieceYen ?? "0";
  const sellerProfitBaseCost = D(filmWithSkus.filmTotal);
  const sellerProfitCost = sellerProfitBaseCost.times(params.sellerProfitRate);
  const filmCostWithSellerProfit = sellerProfitBaseCost.plus(sellerProfitCost);
  const filmWithSellerProfit: FilmCostResult = {
    ...filmWithSkus,
    filmBaseCost: filmCostWithSellerProfit.toString(),
    unitPrice: filmCostWithSellerProfit.div(filmWithSkus.orderLengthM).toString(),
    filmTotal: filmCostWithSellerProfit.toString(),
    filmCostPerPiece: filmCostWithSellerProfit.div(quantityD).toString(),
  };
  const costComponents = {
    film: filmCostWithSellerProfit,
    copperPlate: D(copperPlateCost),
    bulk: bulkCost,
    variableProcessing: variableTotal,
    fixedLot,
    custom: customCharge,
  };
  const costTotal = sum(Object.values(costComponents));
  const totalPerPiece = D(costTotal).div(quantityD);
  const reconciliation = costTotal.minus(sum(Object.values(costComponents)));

  const sellingPrices = margins.map((margin) => {
    const price = totalPerPiece.div(D(1).minus(margin));
    return { margin, pricePerPiece: price.toString(), totalSales: price.times(quantityD).toString(), profit: price.minus(totalPerPiece).times(quantityD).toString() };
  });

  const warnings = unresolvedWarnings(spec, size, params);
  const serializedInput = JSON.stringify({ spec, quantity, printingMethod, targetMargins: targetMargins ?? null, parameters: parameters ?? null, gravureParameters: gravureParameters ?? null });
  const result = { quantity: quantityD.toString(), chamberCount: chamberCount.toString(), bulkUsageMl: bulkUsage.toString(), costComponents, costTotal: costTotal.toString(), sellingPrices };

  return {
    quantity: quantityD.toString(),
    connectedChambers: spec.connectedChambers,
    chamberCount: chamberCount.toString(),
    fillMlPerChamber: weightedAvgFill.toString(),
    totalFillMlPerPouch: weightedAvgFill.times(spec.connectedChambers).toString(),
    fillingMethod: spec.fillingMethod,
    fillingLanes: spec.fillingLanes,
    baseProductionSpeedPerMinute: params.productionSpeedPerMinute,
    effectiveProductionSpeed: effectiveProductionSpeed.toString(),
    lanesPerCycle,
    productionRunQuantity: productionRunQuantity.toString(),
    productionHours: productionHours.toString(),
    inspectionHours: inspectionHours.toString(),
    bulkLossRate: params.bulkLossRate,
    initialChargeMl: initialCharge.toString(),
    testFillMl: testFill.toString(),
    bulkUsageMl: bulkUsage.toString(),
    bulkCost: bulkCost.toString(),
    bulkCostPerPiece: bulkPerPiece.toString(),
    materialCostPerPiece: D(filmWithSellerProfit.filmCostPerPiece).plus(bulkPerPiece).toString(),
    variableLaborPerPiece: variableLaborPerPiece.toString(),
    machineVariablePerPiece: machineVariablePerPiece.toString(),
    variableProcessingPerPiece: variableProcessingPerPiece.toString(),
    variableProcessingTotal: variableTotal.toString(),
    fixedLotCost: fixedLot.toString(),
    fixedCostPerPiece: fixedPerPiece.toString(),
    customCharge: customCharge.toString(),
    sellerProfitBaseCost: sellerProfitBaseCost.toString(),
    sellerProfitRate: params.sellerProfitRate,
    sellerProfitCost: sellerProfitCost.toString(),
    totalCostPerPiece: totalPerPiece.toString(),
    costTotal: costTotal.toString(),
    costComponents: mapValues(costComponents, String),
    costPerPieceComponents: mapValues(costComponents, (value) => D(value).div(quantityD).toString()),
    sellingPrices,
    film: filmWithSellerProfit,
    copperPlateCost,
    copperPlateCostPerPiece,
    ...(gravureRoll ? {
      orderPatternCount: gravureRoll.orderPatternCount,
      deliverablePatternLengthM: gravureRoll.deliverableLengthM,
      recommendedQuantity: gravureRoll.recommendedQuantity,
      gravure: {
        materialCostYen: gravureRoll.materialCostYen,
        printingCostYen: gravureRoll.printingCostYen,
        laminationCostYen: gravureRoll.laminationCostYen,
        filmCostYen: gravureRoll.filmCostYen,
        manufacturerMarginCostYen: gravureRoll.manufacturerMarginCostYen,
        smallWidthTier: gravureRoll.smallWidthTier,
        smallWidthManufacturerUnitPriceKRWPerM: gravureRoll.smallWidthManufacturerUnitPriceKRWPerM,
        customsBaseCostYen: gravureRoll.customsBaseCostYen,
        customsCostYen: gravureRoll.customsCostYen,
        overseasShippingCostYen: gravureRoll.overseasShippingCostYen,
        shippingTrips: gravureRoll.shippingTrips,
        copperPlateCostYen: gravureRoll.copperPlateCostYen,
        finalHeatSealWidthMm: gravureRoll.finalHeatSealWidthMm,
      },
    } : {}),
    warnings,
    audit: {
      calculationVersion: CALCULATION_VERSION,
      inputJsonSha256: hash(serializedInput),
      resultJsonSha256: hash(JSON.stringify(result)),
      digitalFilmPriceMode: "common_fallback",
      unresolvedInputFlags: warnings,
      componentReconciliationDifference: reconciliation.toString(),
    },
  };
}

export function approvedCommission(amount: string, status: QuotationStatus, parameters: Partial<CostParameters> = {}): { eligible: boolean; commissionAmount: string | null } {
  if (status !== "approved") return { eligible: false, commissionAmount: null };
  return { eligible: true, commissionAmount: D(amount).times(parameters.commissionRate ?? defaultParameters.commissionRate).toString() };
}

export function displayAmount(value: string): string {
  return roundTo2(value);
}

export function getSizeMaster(spec: PouchSpec): SizeMaster {
  const base = sizeMaster[spec.sizeKey];
  if (!base) throw validationError("size_not_found");
  if (!spec.isCustom) {
    const width = spec.customWidthMm ?? base.widthMm;
    const length = spec.customLengthMm ?? base.lengthMm;
    if (!eq(base.widthMm, width) || !eq(base.lengthMm, length)) throw validationError("standard_size_dimensions_mismatch");
    return base;
  }
  if (!spec.customWidthMm || !spec.customLengthMm) throw validationError("custom_size_mapping_unconfirmed");
  if (D(spec.customWidthMm).lte(0) || D(spec.customLengthMm).lte(0)) throw validationError("invalid_positive_input");
  return deriveCustomSizeMaster(base, spec.customWidthMm, spec.customLengthMm);
}

function calculateFilmCost(
  size: SizeMaster,
  quantity: Decimal,
  printingMethod: PrintingMethod,
  params: CostParameters,
  digitalOrders: FilmSkuOrder[],
  orderAdjustment: FilmOrderAdjustment,
): FilmCostResult {
  if (printingMethod !== "digital") throw validationError("gravure_not_configured");
  const pitch = D(size.lengthMm).plus(size.pitchAddMm);
  const skuResults = digitalOrders.map((sku) => {
    const required = D(sku.requiredLengthM);
    // Excel規則: 35mm幅品・Xraラウンドは必要長が900m超で736mm幅・2倍生産に切替（検討長さ＝発注×2・200m刻み）
    const useLargeLot = Boolean(size.largeLotWebWidthMm) && required.gt(900);
    const orderLength = useLargeLot
      ? Decimal.max(500, ceilTo(required.div(2), 100))
      : D(sku.orderLengthM);
    const multiplier = useLargeLot ? 2 : 1;
    const considered = orderLength.times(multiplier);
    const loss = maxD(params.lossMinM, considered.times(params.lossRate));
    const effective = considered.minus(loss);
    const actual = effective.times(1000).div(pitch).times(size.lanes).floor();
    const pricing = actual.div(500).floor().times(500);
    if (pricing.lte(0)) throw validationError("no_priceable_quantity");
    const appliedBand: PriceBand = useLargeLot ? "571to740" : size.priceBand;
    const unitPrice = filmUnitPrice(appliedBand, orderLength, params);
    const baseCost = orderLength.times(unitPrice);
    const webWidthMm = useLargeLot ? size.largeLotWebWidthMm! : size.webWidthMm;
    return { skuCode: sku.skuCode, required, orderLength, multiplier, considered, appliedBand, webWidthMm, loss, effective, actual, pricing, unitPrice, baseCost };
  });

  const required = sum(skuResults.map((sku) => sku.required));
  const orderLength = sum(skuResults.map((sku) => sku.orderLength));
  const loss = sum(skuResults.map((sku) => sku.loss));
  const effective = sum(skuResults.map((sku) => sku.effective));
  const actual = sum(skuResults.map((sku) => sku.actual));
  const pricing = sum(skuResults.map((sku) => sku.pricing));
  const baseCost = sum(skuResults.map((sku) => sku.baseCost));
  const unitPrice = orderLength.eq(0) ? D(0) : baseCost.div(orderLength);

  const anyLargeLot = skuResults.some((sku) => sku.multiplier === 2);
  const webWidth = anyLargeLot ? size.largeLotWebWidthMm ?? size.webWidthMm : size.webWidthMm;
  const shippingUnit = D(shippingUnitForWidth(webWidth, params));
  const productionEquivalentLength = sum(skuResults.map((sku) => sku.orderLength.times(sku.multiplier)));
  const shippingTrips = productionEquivalentLength.div(shippingUnit).ceil();
  const domestic = shippingTrips.times(params.domesticShippingPerTrip);
  const overseas = shippingTrips.times(params.overseasShippingPerTrip);
  const customs = baseCost.gt(params.customsThreshold)
    ? D(params.customsHighCharge)
    : shippingTrips.times(params.customsPerTrip);
  const total = baseCost.plus(domestic).plus(overseas).plus(customs);
  const perPiece = total.div(pricing);

  return {
    requiredLengthM: required.toString(), orderLengthM: orderLength.toString(), lossM: loss.toString(), effectiveLengthM: effective.toString(),
    actualQuantity: actual.toString(), pricingQuantity: pricing.toString(), unitPrice: unitPrice.toString(), filmBaseCost: baseCost.toString(),
    domesticShipping: domestic.toString(), overseasShipping: overseas.toString(), customs: customs.toString(), filmTotal: total.toString(), filmCostPerPiece: perPiece.toString(),
    shippingTrips: shippingTrips.toString(),
    orderAdjustment,
    skuCosts: skuResults.map(({ skuCode, required, orderLength, multiplier, considered, appliedBand, webWidthMm, baseCost }) => ({
      skuCode, name: "", quantity: "", fillMlPerChamber: "", colorCount: "",
      requiredLengthM: required.toString(), orderLengthM: orderLength.toString(), filmCost: baseCost.toString(),
      multiplier, consideredLengthM: considered.toString(), appliedBand, webWidthMm,
    })),
  };
}

function filmUnitPrice(band: SizeMaster["priceBand"], orderLength: Decimal, params: CostParameters): Decimal {
  const key = orderLength.lt(1000) ? "500" : orderLength.lt(1500) ? "1000" : "1500";
  return D(params.filmUnitPrices[band][key]);
}

function initialChargeMl(spec: PouchSpec, params: CostParameters): Decimal {
  return D(spec.fillingMethod === "pressure" ? params.pressureInitialChargeMl : params.hopperInitialChargeMl);
}

function unresolvedWarnings(spec: PouchSpec, size: SizeMaster, params: CostParameters): WarningCode[] {
  return [
    "seven_template_unconfirmed" as const,
    "tax_rounding_unconfirmed" as const,
    "digital_color_price_not_applied" as const,
    ...(spec.fillingLanes !== size.lanes ? ["filling_lanes_differ_from_film_lanes" as const] : []),
  ];
}

const validationError = (code: string): QuotationValidationError => new QuotationValidationError(code);
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function mapValues<T, R>(value: Record<string, T>, convert: (item: T) => R): Record<string, R> { const out: Record<string, R> = {}; for (const [key, item] of Object.entries(value)) out[key] = convert(item); return out; }
