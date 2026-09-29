import { D } from "./decimal";
import type { CostResult } from "./calculation";
import type { PrintingMethod } from "./types";
import {
  defaultGravureRollParameters,
  GRAVURE_ROLL_COPPER_PLATE_MINIMUM_YEN,
  type GravureRollParameters,
} from "./gravure-roll";

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
  webWidthsMm?: number[];
  filmCostYen?: string;
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
	  skuOrderLengthsM?: string[];
	  procurementRoute?: "Y" | "K";
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
    // Legacy serialized contract. The value is centimeters despite the name.
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
  gravureParameters?: GravureRollParameters;
};

export function activeMaterialWidthMm(result: CostResult, fallback?: number): number | null {
  const width = result.gravure?.materialWidthMm ?? result.film.skuCosts[0]?.webWidthMm ?? fallback;
  return width == null ? null : Number(width);
}

export function buildPurchaseOrderSnapshot(result: CostResult, context: PurchaseContext): PurchaseOrderSnapshot {
  const skuColorCounts = result.film.skuCosts.length > 0
    ? result.film.skuCosts.map((sku) => sku.colorCount)
    : [String(context.colorCount)];
  const activeWidthMm = activeMaterialWidthMm(result, context.webWidthMm);
  const webWidthsMm = result.film.skuCosts.length > 0
    ? result.film.skuCosts.map((sku) => sku.webWidthMm)
    : activeWidthMm == null ? [] : [activeWidthMm];

  return {
    printingMethod: result.film.skuCosts.length > 0 || !result.gravure ? "digital" : "gravure",
    pouchQuantity: result.quantity,
    filmComposition: context.filmComposition,
    requiredLengthM: result.film.requiredLengthM,
    orderLengthM: result.film.orderLengthM,
    effectiveLengthM: result.film.effectiveLengthM,
    lossM: result.film.lossM,
    lossRate: context.lossRate,
    webWidthMm: activeWidthMm ?? context.webWidthMm,
    webWidthsMm,
    filmCostYen: result.film.filmTotal,
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
	    skuOrderLengthsM: result.sasche?.skuOutputLengthsM,
	    procurementRoute: result.sasche ? "Y" : result.gravure ? "K" : undefined,
    customMold: result.customCharge ? {
      quantity: "1",
      costYen: result.customCharge,
    } : undefined,
    orderPatternCount: result.orderPatternCount,
    deliverablePatternLengthM: result.deliverablePatternLengthM,
    productionPatternLengthM: result.film.orderLengthM,
    gravureLossM: result.film.lossM,
    copperPlate: result.gravure && result.gravure.copperPlateCount > 0 ? {
      quantity: result.gravure.copperPlateCount,
      plateWidthMm: D(result.gravure.materialWidthMm).plus(
        (context.gravureParameters ?? defaultGravureRollParameters()).copperPlateWidthExtraMm,
      ).toString(),
      diameterMm: D((context.gravureParameters ?? defaultGravureRollParameters()).copperPlateMinimumDiameterMm)
        .div(10)
        .toNumber(),
      minimumPriceYen: GRAVURE_ROLL_COPPER_PLATE_MINIMUM_YEN,
      unitPriceYen: result.gravure.copperPlateUnitPriceYen,
      priceYen: result.gravure.copperPlateCostYen,
    } : undefined,
  };
}
