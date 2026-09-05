export type Design = "round" | "circle" | "tube" | "bottle" | "xraRound" | "mouthWash";
export type SizeKey =
  | "round-50x60"
  | "round-50x80"
  | "round-60x80"
  | "round-60x100"
  | "round-60x120"
  | "round-70x120"
  | "round-60x80-2"
  | "round-70x120-3"
  | "circle-70x70"
  | "tube-35x60"
  | "tube-35x80"
  | "tube-50x90"
  | "tube-70x120"
  | "bottle-35x60"
  | "bottle-35x80"
  | "bottle-50x90"
  | "bottle-70x120"
  | "xra-38.5x90"
  | "mouthwash-45x145";

export type PriceBand = "lte570" | "571to740";
export type FillingMethod = "hopper" | "pressure";
export type PrintingMethod = "digital" | "gravure";
export type FilmPriceMode = "color_specific" | "common_fallback";

export interface SizeMaster {
  key: SizeKey;
  design: Design;
  label: string;
  widthMm: DecimalValue;
  lengthMm: DecimalValue;
  pitchAddMm: DecimalValue;
  lanes: number;
  webWidthMm: number;
  largeLotWebWidthMm?: number;
  priceBand: PriceBand;
  prodMultiplier: number;
}

export interface PouchSpec {
  sizeKey: SizeKey;
  customWidthMm?: DecimalValue;
  customLengthMm?: DecimalValue;
  fillMlPerChamber: DecimalValue;
  connectedChambers: 1 | 2 | 3 | 4;
  fillingMethod: FillingMethod;
  fillingLanes: number;
  isCustom: boolean;
  colorCount: number;
  bulkUnitPrice: DecimalValue;
  skuCount: number;
  skuQuantities?: DecimalValue[];
  skuNames?: string[];
  skuFillMlPerChamber?: DecimalValue[];
  skuColorCounts?: DecimalValue[];
}

export interface CostParameters {
  lossRate: DecimalValue;
  lossMinM: DecimalValue;
  domesticShippingPerTrip: DecimalValue;
  overseasShippingPerTrip: DecimalValue;
  customsThreshold: DecimalValue;
  customsHighCharge: DecimalValue;
  customsPerTrip: DecimalValue;
  bulkLossRate: DecimalValue;
  fillTestRuns: DecimalValue;
  laborPerHour: DecimalValue;
  machineChargePerHour: DecimalValue;
  productionSpeedPerMinute: DecimalValue;
  inspectionSpeed: DecimalValue;
  setupTime: DecimalValue;
  cleanupTime: DecimalValue;
  customPouchCharge: DecimalValue;
  hopperInitialChargeMl: DecimalValue;
  pressureInitialChargeMl: DecimalValue;
  digitalFilmMinTotalM: DecimalValue;
  digitalFilmMinSkuM: DecimalValue;
  commissionRate: DecimalValue;
  sellerProfitRate: DecimalValue;
  filmUnitPrices: Record<PriceBand, Record<"500" | "1000" | "1500", DecimalValue>>;
  shippingUnitsM: Record<"500" | "400", number[]>;
}

export type DecimalValue = string;
export type QuotationStatus = "draft" | "sent" | "approved" | "rejected" | "expired";
