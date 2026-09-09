import { D } from "./decimal";
import type { CostResult } from "./calculation";
import type { PrintingMethod } from "./types";

export type PurchaseOrderSnapshot = {
  printingMethod: PrintingMethod;
  pouchQuantity: string;
  filmComposition: string;
  requiredLengthM: string;
  orderLengthM: string;
  effectiveLengthM: string;
  lossM: string;
  lossRate: string;
  webWidthMm: number;
  lanes: number;
  pitchMm: string;
  prodMultiplier: number;
  colorCount: number;
  skuColorCounts: string[];
  skuOrderDetails: {
    skuCode: string;
    name: string;
    quantity: string;
    colorCount: string;
    requiredLengthM: string;
    orderLengthM: string;
    webWidthMm: number;
    multiplier: number;
  }[];
  orderPatternCount?: number;
  deliverablePatternLengthM?: string;
  productionPatternLengthM?: string;
  gravureLossM?: string;
  customMold?: {
    quantity: string;
    costYen: string;
  };
  copperPlate?: {
    quantity: number;
    plateWidthMm: string;
    diameterMm: number;
    minimumPriceYen: string;
    unitPriceYen: string;
    priceYen: string;
  };
};

export type PurchaseContext = {
  filmComposition: string;
  webWidthMm: number;
  lanes: number;
  pitchMm: string;
  prodMultiplier: number;
  colorCount: number;
  lossRate: string;
};

export function buildPurchaseOrderSnapshot(result: CostResult, context: PurchaseContext): PurchaseOrderSnapshot {
  const skuColorCounts = result.film.skuCosts.length > 0
    ? result.film.skuCosts.map((sku) => sku.colorCount)
    : [String(context.colorCount)];

  return {
    printingMethod: result.film.skuCosts.length > 0 || !result.gravure ? "digital" : "gravure",
    pouchQuantity: result.quantity,
    filmComposition: context.filmComposition,
    requiredLengthM: result.film.requiredLengthM,
    orderLengthM: result.film.orderLengthM,
    effectiveLengthM: result.film.effectiveLengthM,
    lossM: result.film.lossM,
    lossRate: context.lossRate,
    webWidthMm: result.gravure
      ? Number(result.gravure.materialWidthMm)
      : result.film.skuCosts[0]?.webWidthMm ?? context.webWidthMm,
    lanes: context.lanes,
    pitchMm: context.pitchMm,
    prodMultiplier: context.prodMultiplier,
    colorCount: context.colorCount,
    skuColorCounts,
    skuOrderDetails: result.film.skuCosts.map((sku) => ({
      skuCode: sku.skuCode,
      name: sku.name,
      quantity: sku.quantity,
      colorCount: sku.colorCount,
      requiredLengthM: sku.requiredLengthM,
      orderLengthM: sku.orderLengthM,
      webWidthMm: sku.webWidthMm,
      multiplier: sku.multiplier,
    })),
    customMold: result.customCharge ? {
      quantity: "1",
      costYen: result.customCharge,
    } : undefined,
    orderPatternCount: result.orderPatternCount,
    deliverablePatternLengthM: result.deliverablePatternLengthM,
    productionPatternLengthM: result.film.orderLengthM,
    gravureLossM: result.film.lossM,
    copperPlate: result.gravure ? {
      quantity: result.gravure.copperPlateCount,
      plateWidthMm: D(result.gravure.finalHeatSealWidthMm).minus(10).plus(100).toString(),
      diameterMm: 42,
      minimumPriceYen: "32000",
      unitPriceYen: result.gravure.copperPlateUnitPriceYen,
      priceYen: result.gravure.copperPlateCostYen,
    } : undefined,
  };
}
