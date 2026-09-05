import { D, Decimal } from "./decimal";

export const GRAVURE_ROLL_MATERIAL_STRUCTURE = [
  { materialId: "PET", label: "PET12", thicknessMicron: 12, density: "1.40" },
  { materialId: "AL", label: "AL7", thicknessMicron: 7, density: "2.71" },
  { materialId: "PET", label: "PET12", thicknessMicron: 12, density: "1.40" },
  { materialId: "LLDPE", label: "LLDPE50", thicknessMicron: 50, density: "0.92" },
] as const;

export const GRAVURE_ROLL_DEFAULTS_KRW = {
  materialUnitPricesPerKg: {
    PET: "4300",
    AL: "10500",
    LLDPE: "4500",
  },
  printingUnitPricePerM: "19",
  laminationUnitPricePerMWithAl: "80",
  laminationUnitPricePerMWithoutAl: "65",
  newCopperPlateUnitPrice: "50",
  copperPlateWidthExtraMm: "100",
  copperPlateMinimumDiameterMm: "420",
  deliverablePatternLengthM: "5500",
  productionPatternLengthM: "6000",
  krwPer100Yen: "850",
} as const;

const krwToYen = (value: string | number | Decimal, krwPer100Yen: string | number | Decimal) =>
  D(value).times(100).div(D(krwPer100Yen));

export interface GravureRollParameters {
  petUnitPriceYenPerKg: string;
  alUnitPriceYenPerKg: string;
  lldpeUnitPriceYenPerKg: string;
  printingUnitPriceYenPerM: string;
  laminationUnitPriceYenPerMWithAl: string;
  laminationUnitPriceYenPerMWithoutAl: string;
  newCopperPlateUnitPriceYen: string;
  copperPlateWidthExtraMm: string;
  copperPlateMinimumDiameterMm: string;
  deliverablePatternLengthM: string;
  productionPatternLengthM: string;
  krwPer100Yen: string;
}

export function defaultGravureRollParameters(): GravureRollParameters {
  const rate = D(GRAVURE_ROLL_DEFAULTS_KRW.krwPer100Yen);
  const convert = (value: string) => krwToYen(value, rate).toString();
  return {
    petUnitPriceYenPerKg: convert(GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg.PET),
    alUnitPriceYenPerKg: convert(GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg.AL),
    lldpeUnitPriceYenPerKg: convert(GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg.LLDPE),
    printingUnitPriceYenPerM: convert(GRAVURE_ROLL_DEFAULTS_KRW.printingUnitPricePerM),
    laminationUnitPriceYenPerMWithAl: convert(GRAVURE_ROLL_DEFAULTS_KRW.laminationUnitPricePerMWithAl),
    laminationUnitPriceYenPerMWithoutAl: convert(GRAVURE_ROLL_DEFAULTS_KRW.laminationUnitPricePerMWithoutAl),
    newCopperPlateUnitPriceYen: convert(GRAVURE_ROLL_DEFAULTS_KRW.newCopperPlateUnitPrice),
    copperPlateWidthExtraMm: GRAVURE_ROLL_DEFAULTS_KRW.copperPlateWidthExtraMm,
    copperPlateMinimumDiameterMm: GRAVURE_ROLL_DEFAULTS_KRW.copperPlateMinimumDiameterMm,
    deliverablePatternLengthM: GRAVURE_ROLL_DEFAULTS_KRW.deliverablePatternLengthM,
    productionPatternLengthM: GRAVURE_ROLL_DEFAULTS_KRW.productionPatternLengthM,
    krwPer100Yen: GRAVURE_ROLL_DEFAULTS_KRW.krwPer100Yen,
  };
}

export interface GravureRollCostInput {
  requiredLengthM: string | number | Decimal;
  materialWidthMm: string | number | Decimal;
  colors: string | number | Decimal;
  quantity: string | number | Decimal;
  skuColorUsage?: { lengthM: string | number | Decimal; colors: string | number | Decimal }[];
  parameters: GravureRollParameters;
}

export interface GravureRollCostResult {
  requiredLengthM: string;
  orderPatternCount: number;
  deliverableLengthM: string;
  productionLengthM: string;
  lossLengthM: string;
  materialWidthMm: string;
  finalHeatSealWidthMm: string;
  materialCostYen: string;
  printingCostYen: string;
  laminationCostYen: string;
  filmCostYen: string;
  copperPlateCostYen: string;
  totalGravureCostYen: string;
  filmCostPerPieceYen: string;
  copperPlateCostPerPieceYen: string;
  recommendedQuantity: string;
  recommendedQuantityUtilization: string;
}

function positivePatternCount(value: Decimal) {
  return Math.max(1, value.toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber());
}

export function calculateGravureRollCostKRW(input: {
  requiredLengthM: string | number | Decimal;
  materialWidthMm: string | number | Decimal;
  colors: string | number | Decimal;
}) {
  const requiredLengthM = D(input.requiredLengthM);
  const materialWidthMm = D(input.materialWidthMm);
  const colors = D(input.colors);
  const patternLength = D(GRAVURE_ROLL_DEFAULTS_KRW.deliverablePatternLengthM);
  const productionLength = D(GRAVURE_ROLL_DEFAULTS_KRW.productionPatternLengthM);
  if (requiredLengthM.lte(0) || materialWidthMm.lte(0) || colors.lte(0)) throw new Error("invalid_positive_input");
  if (materialWidthMm.lt(500) || materialWidthMm.gt(1100)) throw new Error("invalid_material_width");

  const orderPatternCount = positivePatternCount(requiredLengthM.div(patternLength));
  const deliverableLengthM = patternLength.times(orderPatternCount);
  const productionLengthM = productionLength.times(orderPatternCount);
  const widthM = materialWidthMm.div(1000);

  const materialCost = GRAVURE_ROLL_MATERIAL_STRUCTURE.reduce((total, layer, index) => {
    const effectiveWidthMm = index === GRAVURE_ROLL_MATERIAL_STRUCTURE.length - 1
      ? materialWidthMm.plus(10)
      : materialWidthMm;
    const price = GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg[layer.materialId as keyof typeof GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg];
    return total.plus(
      D(layer.thicknessMicron).div(1000)
        .times(effectiveWidthMm.div(1000))
        .times(productionLengthM)
        .times(layer.density)
        .times(price),
    );
  }, D(0));

  const printingCost = widthM.times(productionLengthM).times(colors).times(GRAVURE_ROLL_DEFAULTS_KRW.printingUnitPricePerM);
  const laminationCost = widthM.times(productionLengthM).times(GRAVURE_ROLL_MATERIAL_STRUCTURE.length - 1)
    .times(GRAVURE_ROLL_DEFAULTS_KRW.laminationUnitPricePerMWithAl);
  const filmCost = materialCost.plus(printingCost).plus(laminationCost);
  const plateWidthCm = materialWidthMm.plus(GRAVURE_ROLL_DEFAULTS_KRW.copperPlateWidthExtraMm).div(10);
  const plateDiameterCm = D(GRAVURE_ROLL_DEFAULTS_KRW.copperPlateMinimumDiameterMm).div(10);
  const copperPlateCost = colors.times(plateWidthCm).times(GRAVURE_ROLL_DEFAULTS_KRW.newCopperPlateUnitPrice).times(plateDiameterCm);

  return {
    currency: "KRW" as const,
    requiredLengthM: requiredLengthM.toString(),
    orderPatternCount,
    deliverableLengthM: deliverableLengthM.toString(),
    productionLengthM: productionLengthM.toString(),
    lossLengthM: productionLengthM.minus(deliverableLengthM).toString(),
    materialWidthMm: materialWidthMm.toString(),
    finalHeatSealWidthMm: materialWidthMm.plus(10).toString(),
    materialCostKRW: materialCost.toString(),
    printingCostKRW: printingCost.toString(),
    laminationCostKRW: laminationCost.toString(),
    filmCostKRW: filmCost.toString(),
    copperPlateCostKRW: copperPlateCost.toString(),
    totalGravureCostKRW: filmCost.plus(copperPlateCost).toString(),
  };
}

export function calculateGravureRollCost(input: GravureRollCostInput): GravureRollCostResult {
  const requiredLengthM = D(input.requiredLengthM);
  const quantity = D(input.quantity);
  const materialWidthMm = D(input.materialWidthMm);
  const colors = D(input.colors);
  const params = input.parameters;
  if (quantity.lte(0) || requiredLengthM.lte(0) || materialWidthMm.lte(0) || colors.lte(0)) throw new Error("invalid_positive_input");
  const skuColorUsage = input.skuColorUsage?.map((usage) => ({
    lengthM: D(usage.lengthM),
    colors: D(usage.colors),
  }));
  if (skuColorUsage?.some((usage) => usage.lengthM.lte(0) || usage.colors.lte(0))) throw new Error("invalid_positive_input");
  if (skuColorUsage) {
    const usageLength = skuColorUsage.reduce((total, usage) => total.plus(usage.lengthM), D(0));
    if (usageLength.minus(requiredLengthM).abs().gt("0.0000001")) throw new Error("invalid_sku_length_sum");
  }

  const patternLength = D(params.deliverablePatternLengthM);
  const productionLength = D(params.productionPatternLengthM);
  const orderPatternCount = positivePatternCount(requiredLengthM.div(patternLength));
  const deliverableLengthM = patternLength.times(orderPatternCount);
  const productionLengthM = productionLength.times(orderPatternCount);
  const widthM = materialWidthMm.div(1000);
  const layers = GRAVURE_ROLL_MATERIAL_STRUCTURE;
  const materialCost = layers.reduce((total, layer, index) => {
    const unitPrice = layer.materialId === "AL"
      ? params.alUnitPriceYenPerKg
      : layer.materialId === "LLDPE"
        ? params.lldpeUnitPriceYenPerKg
        : params.petUnitPriceYenPerKg;
    const effectiveWidthMm = index === layers.length - 1 ? materialWidthMm.plus(10) : materialWidthMm;
    return total.plus(
      D(layer.thicknessMicron).div(1000)
        .times(effectiveWidthMm.div(1000))
        .times(productionLengthM)
        .times(layer.density)
        .times(unitPrice),
    );
  }, D(0));
  const printingCost = (skuColorUsage ?? [{ lengthM: requiredLengthM, colors }])
    .reduce((total, usage) => total.plus(
      widthM
        .times(productionLengthM.times(usage.lengthM).div(requiredLengthM))
        .times(usage.colors)
        .times(params.printingUnitPriceYenPerM),
    ), D(0));
  const laminationCost = widthM.times(productionLengthM).times(layers.length - 1).times(params.laminationUnitPriceYenPerMWithAl);
  const filmCostYen = materialCost.plus(printingCost).plus(laminationCost);
  const plateWidthCm = materialWidthMm.plus(D(params.copperPlateWidthExtraMm)).div(10);
  const plateDiameterCm = D(params.copperPlateMinimumDiameterMm).div(10);
  const copperPlateCostYen = colors.times(plateWidthCm).times(params.newCopperPlateUnitPriceYen).times(plateDiameterCm);

  const perPieceRequiredLength = requiredLengthM.div(quantity);
  const patternCapacity = deliverableLengthM.div(perPieceRequiredLength).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
  const utilization = deliverableLengthM.gt(0) ? requiredLengthM.div(deliverableLengthM) : D(0);
  const previousCapacity = patternLength.div(perPieceRequiredLength).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
  const recommendedQuantity = orderPatternCount > 1 && utilization.lt("0.8")
    ? previousCapacity
    : patternCapacity;

  return {
    requiredLengthM: requiredLengthM.toString(),
    orderPatternCount,
    deliverableLengthM: deliverableLengthM.toString(),
    productionLengthM: productionLengthM.toString(),
    lossLengthM: productionLengthM.minus(deliverableLengthM).toString(),
    materialWidthMm: materialWidthMm.toString(),
    finalHeatSealWidthMm: materialWidthMm.plus(10).toString(),
    materialCostYen: materialCost.toString(),
    printingCostYen: printingCost.toString(),
    laminationCostYen: laminationCost.toString(),
    filmCostYen: filmCostYen.toString(),
    copperPlateCostYen: copperPlateCostYen.toString(),
    totalGravureCostYen: filmCostYen.plus(copperPlateCostYen).toString(),
    filmCostPerPieceYen: quantity.gt(0) ? filmCostYen.div(quantity).toString() : "0",
    copperPlateCostPerPieceYen: quantity.gt(0) ? copperPlateCostYen.div(quantity).toString() : "0",
    recommendedQuantity: recommendedQuantity.toString(),
    recommendedQuantityUtilization: utilization.toString(),
  };
}
