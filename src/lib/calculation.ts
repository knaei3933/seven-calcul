import { createHash } from "node:crypto";
import { CALCULATION_VERSION, defaultParameters, sizeMaster } from "./constants";
import { D, Decimal, ceilTo, eq, maxD, sum } from "./decimal";
import { QuotationValidationError, validateDigitalFilmOrder } from "./digital-film";
import type { CostParameters, FilmPriceMode, PouchSpec, PrintingMethod, QuotationStatus, SizeMaster } from "./types";

export interface CostResult {
  quantity: string;
  connectedChambers: 1 | 2 | 3 | 4;
  chamberCount: string;
  fillMlPerChamber: string;
  totalFillMlPerPouch: string;
  fillingMethod: PouchSpec["fillingMethod"];
  fillingLanes: number;
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
  totalCostPerPiece: string;
  costTotal: string;
  costComponents: Record<"film" | "bulk" | "variableProcessing" | "fixedLot" | "custom", string>;
  costPerPieceComponents: Record<"film" | "bulk" | "variableProcessing" | "fixedLot" | "custom", string>;
  sellingPrices: { margin: string; pricePerPiece: string; totalSales: string; profit: string }[];
  film: FilmCostResult;
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
}

export interface CalculationInput {
  spec: PouchSpec;
  quantity: string;
  printingMethod: PrintingMethod;
  parameters?: Partial<CostParameters>;
}

export function calculatePouchCost({ spec, quantity, printingMethod, parameters }: CalculationInput): CostResult {
  const params = { ...defaultParameters, ...parameters } as CostParameters;
  const quantityD = D(quantity);
  if (quantityD.lte(0) || D(spec.fillMlPerChamber).lte(0) || spec.fillingLanes <= 0) throw validationError("invalid_positive_input");

  const size = getSizeMaster(spec);
  const digitalValidation = validateDigitalFilmOrder(
    spec.skuRequiredLengthsM.map((requiredLengthM, index) => ({ skuCode: `SKU-${index + 1}`, requiredLengthM })),
    params,
  );
  if (!digitalValidation.valid) throw new QuotationValidationError("digital_film_order_invalid", digitalValidation);

  const film = calculateFilmCost(size, printingMethod, params, digitalValidation);
  const initialCharge = initialChargeMl(spec, params);
  const testFill = D(params.fillTestRuns).times(spec.fillingLanes).times(spec.fillMlPerChamber);
  const chamberCount = quantityD.times(spec.connectedChambers);
  const bulkUsage = chamberCount.times(spec.fillMlPerChamber).times(D(1).plus(params.bulkLossRate)).plus(initialCharge).plus(testFill);
  const bulkCost = bulkUsage.times(spec.bulkUnitPrice);
  const bulkPerPiece = bulkCost.div(quantityD);

  const variableLabor = D(params.laborPerHour).div(params.productionSpeed).plus(D(params.laborPerHour).div(params.inspectionSpeed));
  const machineVariable = D(params.machineChargePerHour).div(params.productionSpeed);
  const variableProcessing = variableLabor.plus(machineVariable);
  const variableTotal = variableProcessing.times(quantityD);
  const fixedLot = D(params.setupTime).plus(params.cleanupTime).times(D(params.laborPerHour).plus(params.machineChargePerHour));
  const fixedPerPiece = fixedLot.div(quantityD);
  const customCharge = spec.isCustom ? D(params.customPouchCharge) : D(0);

  const costComponents = { film: film.filmTotal, bulk: bulkCost, variableProcessing: variableTotal, fixedLot, custom: customCharge };
  const costTotal = sum(Object.values(costComponents));
  const totalPerPiece = D(costTotal).div(quantityD);
  const reconciliation = costTotal.minus(sum(Object.values(costComponents)));

  const sellingPrices = [0.15, 0.2, 0.3].map((margin) => {
    const price = totalPerPiece.div(D(1).minus(margin));
    return { margin: String(margin), pricePerPiece: price.toString(), totalSales: price.times(quantityD).toString(), profit: D(price).minus(totalPerPiece).times(quantityD).toString() };
  });

  const warnings = unresolvedWarnings(spec, size, params);
  const serializedInput = JSON.stringify({ spec, quantity, printingMethod, params });
  const result = { quantity: quantityD.toString(), chamberCount: chamberCount.toString(), bulkUsageMl: bulkUsage.toString(), costComponents, costTotal: costTotal.toString(), sellingPrices };

  return {
    quantity: quantityD.toString(),
    connectedChambers: spec.connectedChambers,
    chamberCount: chamberCount.toString(),
    fillMlPerChamber: spec.fillMlPerChamber,
    totalFillMlPerPouch: D(spec.fillMlPerChamber).times(spec.connectedChambers).toString(),
    fillingMethod: spec.fillingMethod,
    fillingLanes: spec.fillingLanes,
    bulkLossRate: params.bulkLossRate,
    initialChargeMl: initialCharge.toString(),
    testFillMl: testFill.toString(),
    bulkUsageMl: bulkUsage.toString(),
    bulkCost: bulkCost.toString(),
    bulkCostPerPiece: bulkPerPiece.toString(),
    materialCostPerPiece: D(film.filmCostPerPiece).plus(bulkPerPiece).toString(),
    variableLaborPerPiece: variableLabor.toString(),
    machineVariablePerPiece: machineVariable.toString(),
    variableProcessingPerPiece: variableProcessing.toString(),
    variableProcessingTotal: variableTotal.toString(),
    fixedLotCost: fixedLot.toString(),
    fixedCostPerPiece: fixedPerPiece.toString(),
    customCharge: customCharge.toString(),
    totalCostPerPiece: totalPerPiece.toString(),
    costTotal: costTotal.toString(),
    costComponents: mapValues(costComponents, String),
    costPerPieceComponents: mapValues(costComponents, (value) => D(value).div(quantityD).toString()),
    sellingPrices,
    film,
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

export function getSizeMaster(spec: PouchSpec): SizeMaster {
  if (spec.isCustom && (!spec.customWidthMm || !spec.customLengthMm)) throw validationError("custom_size_mapping_unconfirmed");
  const size = sizeMaster[spec.sizeKey];
  if (!size) throw validationError("size_not_found");
  if (!eq(size.widthMm, spec.customWidthMm ?? size.widthMm) || !eq(size.lengthMm, spec.customLengthMm ?? size.lengthMm)) {
    throw validationError("standard_size_dimensions_mismatch");
  }
  return size;
}

function calculateFilmCost(
  size: SizeMaster,
  printingMethod: PrintingMethod,
  params: CostParameters,
  digitalValidation: ReturnType<typeof validateDigitalFilmOrder>,
): FilmCostResult {
  if (printingMethod !== "digital") throw validationError("gravure_not_configured");
  const pitch = D(size.lengthMm).plus(size.pitchAddMm);
  const skuResults = digitalValidation.orderLengths.map((sku) => {
    const required = D(sku.requiredLengthM);
    const orderLength = D(sku.orderLengthM);
    const loss = maxD(params.lossMinM, orderLength.times(params.lossRate));
    const effective = orderLength.minus(loss);
    const actual = effective.times(1000).div(pitch).floor().times(size.lanes);
    const pricing = actual.div(500).floor().times(500);
    if (pricing.lte(0)) throw validationError("no_priceable_quantity");
    const unitPrice = filmUnitPrice(size.priceBand, orderLength, params);
    const baseCost = orderLength.times(unitPrice);
    return { required, orderLength, loss, effective, actual, pricing, unitPrice, baseCost };
  });

  const required = sum(skuResults.map((sku) => sku.required));
  const orderLength = sum(skuResults.map((sku) => sku.orderLength));
  const loss = sum(skuResults.map((sku) => sku.loss));
  const effective = sum(skuResults.map((sku) => sku.effective));
  const actual = sum(skuResults.map((sku) => sku.actual));
  const pricing = sum(skuResults.map((sku) => sku.pricing));
  const baseCost = sum(skuResults.map((sku) => sku.baseCost));
  const unitPrice = orderLength.eq(0) ? D(0) : baseCost.div(orderLength);

  const useLargeLot = Boolean(size.largeLotWebWidthMm) && orderLength.gte(1000);
  const webWidth = useLargeLot ? size.largeLotWebWidthMm! : size.webWidthMm;
  const shippingUnit = params.shippingUnitsM["500"].includes(webWidth) ? 500 : 400;
  const shippingTrips = ceilTo(orderLength.times(size.prodMultiplier), shippingUnit);
  const domestic = shippingTrips.times(params.domesticShippingPerTrip);
  const overseas = shippingTrips.times(params.overseasShippingPerTrip);
  const customs = baseCost.gt(params.customsThreshold) ? D(params.customsHighCharge) : shippingTrips.times(params.customsPerTrip);
  const total = baseCost.plus(domestic).plus(overseas).plus(customs);
  const perPiece = total.div(pricing);

  return {
    requiredLengthM: required.toString(), orderLengthM: orderLength.toString(), lossM: loss.toString(), effectiveLengthM: effective.toString(),
    actualQuantity: actual.toString(), pricingQuantity: pricing.toString(), unitPrice: unitPrice.toString(), filmBaseCost: baseCost.toString(),
    domesticShipping: domestic.toString(), overseasShipping: overseas.toString(), customs: customs.toString(), filmTotal: total.toString(), filmCostPerPiece: perPiece.toString(),
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
