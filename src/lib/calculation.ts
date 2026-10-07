import { createHash } from "node:crypto";
import { CALCULATION_VERSION, CONNECTED_FILLING_SURCHARGE, CONNECTED_PRODUCTION_SPEED_FACTOR, defaultParameters, defaultProductionSpeedForFillMl, sizeMaster } from "./constants";
import { D, Decimal, ceilTo, eq, maxD, roundTo2, roundUp1, sum } from "./decimal";
import { normalizeDigitalFilmOrder, QuotationValidationError, type FilmOrderAdjustment, type FilmSkuOrder } from "./digital-film";
import { calculateRequiredProductionLength, deriveCustomSizeMaster, shippingUnitForWidth } from "./size-calculations";
import { calculateGravureRollCost, defaultGravureRollParameters, type GravureRollParameters } from "./gravure-roll";
import { buildSascheCandidates, buildSascheGravureRollResult, selectSascheCandidate } from "./sasche-gravure";
import type { SascheCandidate } from "./sasche-gravure";
import type { GravureRollCostResult } from "./gravure-roll";
import { buildPrintCandidates, createPrintCandidateContext, type PrintCandidate } from "./print-recommendation";
import type { CostParameters, FilmPriceMode, PriceBand, PouchSpec, PrintingMethod, QuotationStatus, SizeMaster } from "./types";

export interface CostResult {
  printingMethod: PrintingMethod;
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
  singleConnectedFillingCostPerPiece: string;
  singleConnectedProcessingCostPerPiece: string;
  connectedFillingSurchargeRate: string;
  liquidCount: number;
  liquids: LiquidCostResult[];
  chambers: ChamberCostResult[];
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
  gravurePricingMode: "standard" | "sasche";
  sasche?: SascheCandidate;
  sascheCandidates?: SascheCandidate[];
  recommendationCandidates?: PrintCandidate[];
  selectedCandidateId?: string;
  orderPatternCount?: number;
  deliverablePatternLengthM?: string;
  recommendedQuantity?: string;
  gravure?: {
    pricingMode: "standard" | "sasche";
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
    copperPlateCount: number;
    copperPlateUnitPriceYen: string;
    copperPlateCostYen: string;
    materialWidthMm: string;
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

export interface LiquidCostResult {
  liquidName: string;
  bulkUnitPriceYen: string;
  usageMl: string;
  testFillMl: string;
  initialChargeMl: string;
  costYen: string;
}

export interface ChamberCostResult {
  position: number;
  liquidName: string;
  fillMl: string;
  bulkUnitPriceYen: string;
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
  unitPriceYen: string;
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
  recommendationMode?: boolean;
  selectedCandidateId?: string;
  selectedCandidateTargetMargins?: string[];
}

type RecommendationOptions = {
  aggregateDigitalPrice?: boolean;
  filmOrderOverride?: FilmSkuOrder[];
  suppressAutomaticSasche?: boolean;
  sascheCandidateOverride?: SascheCandidate;
  gravureRollOverride?: GravureRollCostResult;
};

const DEFAULT_TARGET_MARGINS = ["0.4", "0.5"] as const;

type CoreCalculationInput = Omit<CalculationInput, "recommendationMode" | "selectedCandidateId" | "selectedCandidateTargetMargins">;

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

function calculatePouchCostCore(
  { spec, quantity, printingMethod, parameters, gravureParameters, targetMargins, recommendation }: CoreCalculationInput & { recommendation?: RecommendationOptions },
): CostResult {
  const quantityD = D(quantity);
  if (quantityD.lte(0) || D(spec.fillMlPerChamber).lte(0) || spec.fillingLanes <= 0) throw validationError("invalid_positive_input");
  // 室ごとに異なる液体を充填できる。未指定時は全室同一（従来互換）。
  const chamberFills = resolveChamberFills(spec);
  const maxChamberFill = chamberFills.reduce((max, chamber) => Decimal.max(max, D(chamber.fillMl)), D(0));
  const avgChamberFill = sum(chamberFills.map((chamber) => D(chamber.fillMl))).div(spec.connectedChambers);
  const params = {
    ...defaultParameters,
    ...parameters,
    productionSpeedPerMinute: parameters?.productionSpeedPerMinute
      // 充填量が実ごとに異なる場合は、最も多い室（ボトルネック）を速度基準にする。
      ?? String(defaultProductionSpeedForFillMl(maxChamberFill.toString())),
  } as CostParameters;
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
  const skuRequiredLengths = skuQuantitiesList.map((skuQuantity) => calculateRequiredProductionLength(
    size,
    skuQuantity,
    params.lossRate,
    spec.connectedChambers,
  ));
  const { orders: digitalOrders, adjustment: orderAdjustment } = recommendation?.filmOrderOverride
    ? {
        orders: recommendation.filmOrderOverride,
        adjustment: "none" as FilmOrderAdjustment,
      }
    : normalizeDigitalFilmOrder(
        skuRequiredLengths.map((requiredLength, index) => ({
          skuCode: `SKU-${index + 1}`,
          requiredLengthM: requiredLength.toString(),
        })),
        params,
      );
  const requiredLengthM = sum(skuRequiredLengths);
  // 銅版はSKU（デザイン）ごとの色数を合算して必要本数を判定する。
  const copperPlateColors = sum(
    (spec.skuColorCounts?.length ? spec.skuColorCounts : [spec.colorCount]).map((colors) => D(colors)),
  );
  const sascheCandidate = printingMethod === "gravure"
    ? recommendation?.sascheCandidateOverride ?? (recommendation?.suppressAutomaticSasche ? null : selectSascheCandidate({
        webWidthMm: size.webWidthMm,
        requiredLengthM,
        quantity: quantityD,
        colorCount: copperPlateColors,
      }))
    : null;
  const sascheCandidates = printingMethod === "gravure"
    ? buildSascheCandidates({
        webWidthMm: size.webWidthMm,
        requiredLengthM,
        quantity: quantityD,
        colorCount: copperPlateColors,
      })
    : [];
  const gravureRoll = printingMethod === "gravure"
    ? recommendation?.gravureRollOverride ?? (sascheCandidate
      ? buildSascheGravureRollResult(sascheCandidate)
      : calculateGravureRollCost({
          requiredLengthM,
          materialWidthMm: Decimal.max(500, size.webWidthMm),
          pouchWidthMm: size.widthMm,
          colors: copperPlateColors,
          quantity,
          skuColorUsage: skuRequiredLengths.map((length, index) => ({
            lengthM: length.toString(),
            colors: spec.skuColorCounts?.[index] ?? spec.colorCount,
          })),
          parameters: gravureParameters ?? defaultGravureRollParameters(),
        }))
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
    : calculateFilmCost(
      size,
      quantityD,
      printingMethod,
      params,
      digitalOrders,
      orderAdjustment,
      recommendation?.aggregateDigitalPrice,
      Boolean(recommendation?.filmOrderOverride),
      skuQuantitiesList,
      spec.connectedChambers,
    );
  const skuCosts = film.skuCosts.map((skuCost, index) => ({
    ...skuCost,
    name: (spec.skuNames?.[index] ?? "").trim() || `充填物${index + 1}`,
    quantity: skuQuantitiesList[index].toString(),
    fillMlPerChamber: skuFills[index].toString(),
    colorCount: (spec.skuColorCounts?.[index] ?? spec.colorCount).toString(),
  }));
  // 原価の金額はすべて小数第1位で切り上げる。
  const filmPartsRounded = {
    filmBaseCost: roundUp1(film.filmBaseCost),
    domesticShipping: roundUp1(film.domesticShipping),
    overseasShipping: roundUp1(film.overseasShipping),
    customs: roundUp1(film.customs),
  };
  const filmTotalRounded = gravureRoll
    ? roundUp1(film.filmTotal)
    : filmPartsRounded.filmBaseCost
      .plus(filmPartsRounded.domesticShipping)
      .plus(filmPartsRounded.overseasShipping)
      .plus(filmPartsRounded.customs);
  const filmWithSkus: FilmCostResult = {
    ...film,
    filmBaseCost: filmPartsRounded.filmBaseCost.toString(),
    domesticShipping: filmPartsRounded.domesticShipping.toString(),
    overseasShipping: filmPartsRounded.overseasShipping.toString(),
    customs: filmPartsRounded.customs.toString(),
    filmTotal: filmTotalRounded.toString(),
    filmCostPerPiece: roundUp1(filmTotalRounded.div(quantityD)).toString(),
    skuCosts: skuCosts.map((skuCost) => ({ ...skuCost, filmCost: roundUp1(skuCost.filmCost).toString() })),
  };
  const initialChargePerLiquid = initialChargeMl(spec, params);
  // 室ごとに異なる液体を充填できる。同一液体（名称＋単価が同じ室）は1つの液体として扱う。
  const liquidGroups = groupChambersByLiquid(chamberFills);
  const initialCharge = initialChargePerLiquid.times(liquidGroups.length);
  const chamberCount = quantityD.times(spec.connectedChambers);
  const weightedAvgFill = sum(skuQuantitiesList.map((skuQuantity, index) => skuQuantity.times(skuFills[index]))).div(sum(skuQuantitiesList));
  const effectiveFillPerChamber = spec.chambers?.length === spec.connectedChambers ? avgChamberFill : weightedAvgFill;
  const liquidCostResults = liquidGroups.map((group) => {
    // 液体ごと：本体充填（その液体を入れる室の合計）＋初期投入1回＋テスト充填。
    const baseFill = quantityD.times(sum(group.fills));
    const base = baseFill.times(D(1).plus(params.bulkLossRate));
    const test = D(params.fillTestRuns).times(spec.fillingLanes).times(group.maxFill);
    const usage = base.plus(initialChargePerLiquid).plus(test);
    return {
      liquidName: group.name,
      bulkUnitPriceYen: group.unitPrice,
      usageMl: usage.toString(),
      testFillMl: test.toString(),
      initialChargeMl: initialChargePerLiquid.toString(),
      costYen: roundUp1(usage.times(D(group.unitPrice))).toString(),
    };
  });
  const testFill = sum(liquidCostResults.map((liquid) => D(liquid.testFillMl)));
  const bulkUsage = sum(liquidCostResults.map((liquid) => D(liquid.usageMl)));
  const bulkCost = sum(liquidCostResults.map((liquid) => D(liquid.costYen)));
  const bulkPerPiece = roundUp1(bulkCost.div(quantityD));

  const lanesPerCycle = Math.max(1, Math.floor(spec.fillingLanes / spec.connectedChambers));
  // 1回のサイクルで作れる製品数は 1連=4個／2連=2個／3連=1個／4連=1個。
  // 3列でも4列でも1回に1個しか出来ないため、3連と4連の実効速度は同じ。
  const effectiveProductionSpeed = D(params.productionSpeedPerMinute)
    .times(60)
    .times(CONNECTED_PRODUCTION_SPEED_FACTOR[spec.connectedChambers]);
  const productionRunQuantity = quantityD.div(D(1).minus(params.lossRate));
  const productionHours = productionRunQuantity.div(effectiveProductionSpeed);
  // 検品は連結後パウチではなく1室（各列）ずつ確認するため、検品対象は稼働生産数×連結数。
  const inspectionRunQuantity = productionRunQuantity.times(spec.connectedChambers);
  const inspectionHours = inspectionRunQuantity.div(params.inspectionSpeed);
  const variableLabor = D(params.laborPerHour).times(productionHours).plus(D(params.laborPerHour).times(inspectionHours));
  const machineVariable = D(params.machineChargePerHour).times(productionHours);
  const variableProcessing = roundUp1(variableLabor.plus(machineVariable));
  const variableTotal = variableProcessing;
  const variableLaborPerPiece = roundUp1(variableLabor.div(quantityD));
  const machineVariablePerPiece = roundUp1(machineVariable.div(quantityD));
  const variableProcessingPerPiece = roundUp1(variableProcessing.div(quantityD));
  const fixedLot = roundUp1(D(params.setupTime).plus(params.cleanupTime).times(D(params.laborPerHour).plus(params.machineChargePerHour)));
  const fixedPerPiece = roundUp1(fixedLot.div(quantityD));
  const customCharge = spec.isCustom ? D(params.customPouchCharge) : D(0);

  // 見積用の充填・加工単価は「1連相当で計算した基準単価」に連結加算率
  // （2連+20%、3連/4連+80%）を適用する。コスト計上とは別に1連相当原価を求める。
  const singleConnectedProductionHours = productionRunQuantity.div(D(params.productionSpeedPerMinute).times(60));
  const singleConnectedInspectionHours = productionRunQuantity.div(params.inspectionSpeed);
  const singleConnectedVariableLabor = D(params.laborPerHour)
    .times(singleConnectedProductionHours.plus(singleConnectedInspectionHours));
  const singleConnectedMachineVariable = D(params.machineChargePerHour).times(singleConnectedProductionHours);
  // 1連基準のバルク原価は「室別原価の平均」（×N すると室別合計と一致する）。
  const perPouchBulkVariable = sum(chamberFills.map((chamber) => (
    D(chamber.fillMl).times(D(1).plus(params.bulkLossRate)).times(D(chamber.bulkUnitPrice))
  )));
  // 初期投入・テスト充填も液体ごとの単価で評価する。
  const lotBulkCost = sum(liquidCostResults.map((liquid) => (
    D(liquid.initialChargeMl).plus(D(liquid.testFillMl)).times(D(liquid.bulkUnitPriceYen))
  )));
  const singleConnectedBulkCost = perPouchBulkVariable
    .div(spec.connectedChambers)
    .times(quantityD)
    .plus(lotBulkCost);
  const singleConnectedFillingCost = singleConnectedBulkCost
    .plus(singleConnectedVariableLabor)
    .plus(singleConnectedMachineVariable)
    .plus(fixedLot);
  const singleConnectedFillingCostPerPiece = roundUp1(singleConnectedFillingCost.div(quantityD));
  // 견적에서 벌크를 별도 라인으로 분리하기 위한「가공 전용(벌크 제외) 1연 기준원가」.
  const singleConnectedProcessingCost = singleConnectedVariableLabor
    .plus(singleConnectedMachineVariable)
    .plus(fixedLot);
  const singleConnectedProcessingCostPerPiece = roundUp1(singleConnectedProcessingCost.div(quantityD));
  const connectedFillingSurchargeRate = CONNECTED_FILLING_SURCHARGE[spec.connectedChambers];

  const copperPlateCost = roundUp1(gravureRoll?.copperPlateCostYen ?? "0").toString();
  const copperPlateCostPerPiece = roundUp1(D(copperPlateCost).div(quantityD)).toString();
  // デジタルのフィルム単価は仕入価格に供給調整済みのため追加調整しない。
  const appliesSellerProfit = printingMethod === "gravure" && !sascheCandidate;
  const sellerProfitBaseCost = appliesSellerProfit ? D(filmWithSkus.filmTotal) : D(0);
  const sellerProfitCost = roundUp1(sellerProfitBaseCost.times(params.sellerProfitRate));
  const filmCostWithSellerProfitRaw = D(filmWithSkus.filmTotal).plus(sellerProfitCost);
  // フィルム費用は見積・発注書の金額単位に合わせて円未満を四捨五入する。
  const filmCostWithSellerProfit = appliesSellerProfit || sascheCandidate
    ? filmCostWithSellerProfitRaw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    : filmCostWithSellerProfitRaw;
  const filmWithSellerProfit: FilmCostResult = {
    ...filmWithSkus,
    filmBaseCost: filmWithSkus.filmBaseCost,
    unitPrice: (appliesSellerProfit || sascheCandidate) && filmWithSkus.orderLengthM ? filmCostWithSellerProfit.div(filmWithSkus.orderLengthM).toString() : filmWithSkus.unitPrice,
    filmTotal: filmCostWithSellerProfit.toString(),
    filmCostPerPiece: roundUp1(filmCostWithSellerProfit.div(quantityD)).toString(),
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
  const totalPerPiece = roundUp1(D(costTotal).div(quantityD));
  const reconciliation = costTotal.minus(sum(Object.values(costComponents)));

  const sellingPrices = margins.map((margin) => {
    const price = roundUp1(totalPerPiece.div(D(1).minus(margin)));
    return { margin, pricePerPiece: price.toString(), totalSales: price.times(quantityD).toString(), profit: roundUp1(price.minus(totalPerPiece).times(quantityD)).toString() };
  });

  const warnings = unresolvedWarnings(spec, size, params);
  const gravurePricingMode: "standard" | "sasche" = printingMethod === "gravure" && sascheCandidate ? "sasche" : "standard";
  const serializedInput = JSON.stringify({ spec, quantity, printingMethod, targetMargins: targetMargins ?? null, parameters: parameters ?? null, gravureParameters: gravureParameters ?? null });
  const result = { quantity: quantityD.toString(), chamberCount: chamberCount.toString(), bulkUsageMl: bulkUsage.toString(), costComponents, costTotal: costTotal.toString(), sellingPrices };

  return {
    printingMethod,
    quantity: quantityD.toString(),
    connectedChambers: spec.connectedChambers,
    chamberCount: chamberCount.toString(),
    fillMlPerChamber: effectiveFillPerChamber.toString(),
    totalFillMlPerPouch: effectiveFillPerChamber.times(spec.connectedChambers).toString(),
    fillingMethod: spec.fillingMethod,
    fillingLanes: spec.fillingLanes,
    baseProductionSpeedPerMinute: params.productionSpeedPerMinute,
    effectiveProductionSpeed: effectiveProductionSpeed.toString(),
    lanesPerCycle,
    productionRunQuantity: productionRunQuantity.toString(),
    productionHours: productionHours.toString(),
    inspectionHours: inspectionHours.toString(),
    singleConnectedFillingCostPerPiece: singleConnectedFillingCostPerPiece.toString(),
    singleConnectedProcessingCostPerPiece: singleConnectedProcessingCostPerPiece.toString(),
    connectedFillingSurchargeRate,
    liquidCount: liquidGroups.length,
    liquids: liquidCostResults,
    chambers: chamberFills.map((chamber, index) => ({
      position: index + 1,
      liquidName: chamber.liquidName,
      fillMl: chamber.fillMl,
      bulkUnitPriceYen: chamber.bulkUnitPrice,
    })),
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
    sellerProfitRate: appliesSellerProfit ? params.sellerProfitRate : "0",
    gravurePricingMode,
    ...(sascheCandidate ? { sasche: sascheCandidate } : {}),
    sascheCandidates,
    sellerProfitCost: sellerProfitCost.toString(),
    totalCostPerPiece: totalPerPiece.toString(),
    costTotal: costTotal.toString(),
    costComponents: mapValues(costComponents, String),
    costPerPieceComponents: mapValues(costComponents, (value) => roundUp1(D(value).div(quantityD)).toString()),
    sellingPrices,
    film: filmWithSellerProfit,
    copperPlateCost,
    copperPlateCostPerPiece,
    ...(gravureRoll ? {
      orderPatternCount: gravureRoll.orderPatternCount,
      // This is the length of one delivery pattern. The total deliverable
      // length remains film.effectiveLengthM; using the total here made
      // multi-pattern order-count formulas divide by the total twice.
      deliverablePatternLengthM: gravureRoll.orderPatternCount > 0
        ? D(gravureRoll.deliverableLengthM).div(gravureRoll.orderPatternCount).toString()
        : gravureRoll.deliverableLengthM,
      recommendedQuantity: gravureRoll.recommendedQuantity,
      gravure: {
        pricingMode: sascheCandidate ? "sasche" : "standard",
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
      copperPlateCount: gravureRoll.copperPlateCount,
      copperPlateUnitPriceYen: gravureRoll.copperPlateUnitPriceYen,
      copperPlateCostYen: gravureRoll.copperPlateCostYen,
      materialWidthMm: gravureRoll.materialWidthMm,
      finalHeatSealWidthMm: gravureRoll.finalHeatSealWidthMm,
      },
      gravurePricingMode: sascheCandidate ? "sasche" : "standard",
      ...(sascheCandidate ? { sasche: sascheCandidate } : {}),
      ...(sascheCandidates.length ? { sascheCandidates } : {}),
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

export function calculateSelectedCandidateCore(
  candidate: PrintCandidate,
  input: CoreCalculationInput,
): CostResult {
  const adjustedQuantity = sum(candidate.adjustedSkuQuantities.map((value) => D(value)));
  const adjustedInput: CoreCalculationInput = {
    ...input,
    spec: { ...input.spec, skuQuantities: candidate.adjustedSkuQuantities },
    quantity: adjustedQuantity.toString(),
    printingMethod: candidate.printingMethod,
  };

  if (candidate.route === "D" && candidate.filmOrders) {
    return calculatePouchCostCore({
      ...adjustedInput,
      recommendation: {
        aggregateDigitalPrice: true,
        filmOrderOverride: candidate.filmOrders.map((order) => ({ ...order })),
      },
    });
  }

  if (candidate.route === "K" && candidate.gravureRoll) {
    return calculatePouchCostCore({
      ...adjustedInput,
      recommendation: {
        aggregateDigitalPrice: false,
        suppressAutomaticSasche: true,
        gravureRollOverride: { ...candidate.gravureRoll },
      },
    });
  }

  if (candidate.route === "Y" && candidate.sasche) {
    return calculatePouchCostCore({
      ...adjustedInput,
      recommendation: {
        aggregateDigitalPrice: false,
        sascheCandidateOverride: { ...candidate.sasche },
      },
    });
  }

  return calculatePouchCostCore(adjustedInput);
}

export function calculatePouchCost(input: CalculationInput): CostResult {
  const {
    recommendationMode,
    selectedCandidateId,
    selectedCandidateTargetMargins,
    ...coreInput
  } = input;
  const recommendation: RecommendationOptions | undefined = recommendationMode
    ? {
        aggregateDigitalPrice: true,
        suppressAutomaticSasche: coreInput.printingMethod === "gravure",
      }
    : undefined;
  const original = calculatePouchCostCore({ ...coreInput, recommendation });

  if (!recommendationMode) return original;

  const params = {
    ...defaultParameters,
    ...coreInput.parameters,
    productionSpeedPerMinute: coreInput.parameters?.productionSpeedPerMinute
      ?? String(defaultProductionSpeedForFillMl(coreInput.spec.fillMlPerChamber)),
  } as CostParameters;
  const context = createPrintCandidateContext({
    spec: coreInput.spec,
    quantity: coreInput.quantity,
    parameters: params,
    gravureParameters: coreInput.gravureParameters ?? defaultGravureRollParameters(),
    printingMethod: coreInput.printingMethod,
    basisFilmOrderLengthM: original.film.orderLengthM,
    basisFilmTotalYen: original.film.filmTotal,
  });
  const candidates = buildPrintCandidates(context).map((candidate) => {
    const economics = calculateSelectedCandidateCore(candidate, coreInput);
    return {
      ...candidate,
      copperPlateTotalYen: economics.copperPlateCost,
      allInTotalCostYen: economics.costTotal,
      allInCostPerPieceYen: economics.totalCostPerPiece,
      allInDeltaYen: D(economics.costTotal).minus(D(original.costTotal)).toString(),
    };
  });
  const attach = (result: CostResult): CostResult => ({ ...result, recommendationCandidates: candidates, selectedCandidateId: selectedCandidateId ?? "" });
  if (!selectedCandidateId) return attach(original);

  const selected = candidates.find((candidate) => candidate.id === selectedCandidateId);
  if (!selected) throw validationError("candidate_not_found");

  const candidateResult = calculateSelectedCandidateCore(
    selected,
    selectedCandidateTargetMargins
      ? { ...coreInput, targetMargins: selectedCandidateTargetMargins }
      : coreInput,
  );
  return attach(candidateResult);
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
  aggregateDigitalPrice = false,
  preserveOrderOverride = false,
  skuQuantities: Decimal[],
  connectedChambers: number,
): FilmCostResult {
  if (printingMethod !== "digital") throw validationError("gravure_not_configured");
  const pitch = D(size.lengthMm).plus(size.pitchAddMm);
  const skuResults = digitalOrders.map((sku, skuIndex) => {
    const required = D(sku.requiredLengthM);
    // Excel規則: 35mm幅品・Xraラウンドは必要長が900m超で736mm幅・2倍生産に切替（検討長さ＝発注×2・200m刻み）
    const useLargeLot = Boolean(size.largeLotWebWidthMm) && required.gt(900);
    const orderLength = useLargeLot && !preserveOrderOverride
      ? Decimal.max(500, ceilTo(required.div(2), 100))
      : D(sku.orderLengthM);
    const multiplier = useLargeLot ? 2 : 1;
    const considered = orderLength.times(multiplier);
    const loss = maxD(params.lossMinM, considered.times(params.lossRate));
    const effective = considered.minus(loss);
    const actual = effective.times(1000).div(pitch).times(size.lanes).div(connectedChambers).floor();
    const pricing = actual.div(500).floor().times(500);
    if (pricing.lte(0)) throw validationError("no_priceable_quantity");
    const appliedBand: PriceBand = useLargeLot ? "571to740" : size.priceBand;
    const webWidthMm = useLargeLot ? size.largeLotWebWidthMm! : size.webWidthMm;
    const result = { skuCode: sku.skuCode, required, orderLength, multiplier, considered, appliedBand, webWidthMm, loss, effective, actual, pricing, unitPrice: D(0), baseCost: D(0) };
    // The documented formula inflates demand by loss and then subtracts loss
    // from procurement. At a rounding boundary that can leave the normalized
    // order one piece short; grow that SKU's physical order until it covers
    // its own demand. SKU demand is not fungible with another SKU's surplus.
    let guard = 0;
    while (result.actual.lt(skuQuantities[skuIndex] ?? D(0)) && guard < 10000) {
      result.orderLength = result.orderLength.plus(100);
      result.considered = result.orderLength.times(result.multiplier);
      result.loss = maxD(params.lossMinM, result.considered.times(params.lossRate));
      result.effective = result.considered.minus(result.loss);
      result.actual = result.effective.times(1000).div(pitch).times(size.lanes).div(connectedChambers).floor();
      result.pricing = result.actual.div(500).floor().times(500);
      guard += 1;
    }
    if (result.actual.lt(skuQuantities[skuIndex] ?? D(0))) {
      throw validationError("digital_sku_capacity_not_reached");
    }
    return result;
  });
  const priceTierLength = aggregateDigitalPrice
    ? sum(skuResults.map((sku) => sku.orderLength))
    : D(0);
  const skuRows = skuResults.map((sku) => {
    const unitPrice = filmUnitPrice(sku.appliedBand, aggregateDigitalPrice ? priceTierLength : sku.orderLength, params);
    const baseCost = sku.orderLength.times(unitPrice);
    return { ...sku, unitPrice, baseCost };
  });

  const required = sum(skuRows.map((sku) => sku.required));
  const orderLength = sum(skuRows.map((sku) => sku.orderLength));
  const loss = sum(skuRows.map((sku) => sku.loss));
  const effective = sum(skuRows.map((sku) => sku.effective));
  const actual = sum(skuRows.map((sku) => sku.actual));
  const pricing = sum(skuRows.map((sku) => sku.pricing));
  const baseCost = sum(skuRows.map((sku) => sku.baseCost));
  const unitPrice = orderLength.eq(0) ? D(0) : baseCost.div(orderLength);

  const anyLargeLot = skuResults.some((sku) => sku.multiplier === 2);
  const webWidth = anyLargeLot ? size.largeLotWebWidthMm ?? size.webWidthMm : size.webWidthMm;
  const shippingUnit = D(shippingUnitForWidth(webWidth, params));
  const productionEquivalentLength = sum(skuRows.map((sku) => sku.orderLength.times(sku.multiplier)));
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
    skuCosts: skuRows.map(({ skuCode, required, orderLength, multiplier, considered, appliedBand, webWidthMm, baseCost, unitPrice }) => ({
      skuCode, name: "", quantity: "", fillMlPerChamber: "", colorCount: "",
      requiredLengthM: required.toString(), orderLengthM: orderLength.toString(), filmCost: baseCost.toString(),
      unitPriceYen: unitPrice.toString(),
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

interface ResolvedChamberFill {
  liquidName: string;
  fillMl: string;
  bulkUnitPrice: string;
}

function resolveChamberFills(spec: PouchSpec): ResolvedChamberFill[] {
  if (spec.chambers) {
    if (spec.chambers.length !== spec.connectedChambers) throw validationError("invalid_chamber_fills");
    return spec.chambers.map((chamber, index) => {
      if (D(chamber.fillMl).lte(0)) throw validationError("invalid_chamber_fills");
      return {
        liquidName: chamber.liquidName?.trim() || `液体${index + 1}`,
        fillMl: chamber.fillMl,
        bulkUnitPrice: chamber.bulkUnitPrice ?? spec.bulkUnitPrice,
      };
    });
  }
  return Array.from({ length: spec.connectedChambers }, () => ({
    liquidName: "バルク",
    fillMl: spec.fillMlPerChamber,
    bulkUnitPrice: spec.bulkUnitPrice,
  }));
}

function groupChambersByLiquid(chambers: ResolvedChamberFill[]) {
  const groups = new Map<string, { name: string; unitPrice: string; fills: string[]; maxFill: Decimal }>();
  for (const chamber of chambers) {
    const key = `${chamber.liquidName} ${chamber.bulkUnitPrice}`;
    const existing = groups.get(key);
    if (existing) {
      existing.fills.push(chamber.fillMl);
      existing.maxFill = Decimal.max(existing.maxFill, D(chamber.fillMl));
    } else {
      groups.set(key, {
        name: chamber.liquidName,
        unitPrice: chamber.bulkUnitPrice,
        fills: [chamber.fillMl],
        maxFill: D(chamber.fillMl),
      });
    }
  }
  return [...groups.values()];
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
