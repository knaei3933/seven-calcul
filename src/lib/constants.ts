import type { CostParameters, SizeMaster, SizeKey } from "./types";
import { D } from "./decimal";

export const CALCULATION_VERSION = "2026-09.1";

/**
 * 機械チャージの算定基準（設計ドキュメント 6.3 機械関連）。
 * 機械チャージ/時間 = (取得価額÷耐用年数 + 年間電力量×電力単価) ÷ 年間稼働時間
 * ※ 月額賃借料（74,100円/月）は計算から除外（2026-09 仕様変更）。
 */
export const machineChargeBasis = {
  acquisitionCostYen: "25000000",
  usefulLifeYears: "7",
  annualElectricityKwh: "10800",
  electricityUnitPriceYen: "32",
  annualOperatingHours: "1800",
} as const;

export function machineChargePerHourFromBasis(basis: typeof machineChargeBasis = machineChargeBasis): string {
  const annualDepreciation = D(basis.acquisitionCostYen).div(basis.usefulLifeYears);
  const annualElectricity = D(basis.annualElectricityKwh).times(basis.electricityUnitPriceYen);
  return annualDepreciation.plus(annualElectricity).div(basis.annualOperatingHours).toString();
}

export function defaultProductionSpeedForFillMl(fillMl: number | string): number {
  const fill = Number(fillMl);
  if (!Number.isFinite(fill) || fill <= 0) return 100;
  if (fill < 2) return 140;
  if (fill < 3) return 120;
  if (fill < 8) return 100;
  return 80;
}

export const sizeMaster: Record<SizeKey, SizeMaster> = {
  "round-50x60": base("round-50x60", "round", "ラウンド 50×60", 50, 60, 4, 476, "lte570", 6, 1),
  "round-50x80": base("round-50x80", "round", "ラウンド 50×80", 50, 80, 4, 476, "lte570", 8, 1),
  "round-60x80": base("round-60x80", "round", "ラウンド 60×80", 60, 80, 4, 556, "lte570", 6, 1),
  "round-60x100": base("round-60x100", "round", "ラウンド 60×100", 60, 100, 4, 580, "571to740", 6, 1),
  "round-60x120": base("round-60x120", "round", "ラウンド 60×120", 60, 120, 4, 556, "lte570", 6, 1),
  "round-70x120": base("round-70x120", "round", "ラウンド 70×120", 70, 120, 4, 620, "571to740", 6, 1),
  "round-60x80-2": base("round-60x80-2", "round", "ラウンド 60×80（2連）", 60, 80, 2, 512, "lte570", 6, 1),
  "round-70x120-3": base("round-70x120-3", "round", "ラウンド 70×120（3連）", 70, 120, 1, 464, "lte570", 6, 1),
  "circle-70x70": base("circle-70x70", "circle", "丸形 70×70", 70, 70, 4, 620, "571to740", 6, 1),
  "tube-35x60": switchable("tube-35x60", "tube", "チューブ 35×60", 35, 60),
  "tube-35x80": switchable("tube-35x80", "tube", "チューブ 35×80", 35, 80),
  "tube-50x90": base("tube-50x90", "tube", "チューブ 50×90", 50, 90, 4, 476, "lte570", 6, 1),
  "tube-70x120": base("tube-70x120", "tube", "チューブ 70×120", 70, 120, 4, 620, "571to740", 6, 1),
  "bottle-35x60": switchable("bottle-35x60", "bottle", "ボトル型 35×60", 35, 60),
  "bottle-35x80": switchable("bottle-35x80", "bottle", "ボトル型 35×80", 35, 80),
  "bottle-50x90": base("bottle-50x90", "bottle", "ボトル型 50×90", 50, 90, 4, 476, "lte570", 6, 1),
  "bottle-70x120": base("bottle-70x120", "bottle", "ボトル型 70×120", 70, 120, 4, 620, "571to740", 6, 1),
  "xra-38.5x90": switchableWeb("xra-38.5x90", "xraRound", "Xraラウンド 38.5×90", 38.5, 90, 368),
  "mouthwash-45x145": base("mouthwash-45x145", "mouthWash", "マウスウォッシュ用 45×145", 45, 145, 4, 396, "lte570", 6, 1),
};

export const defaultParameters: CostParameters = {
  lossRate: "0.10",
  lossMinM: "80",
  domesticShippingPerTrip: "2000",
  overseasShippingPerTrip: "16000",
  customsThreshold: "200000",
  customsHighCharge: "6600",
  customsPerTrip: "200",
  bulkLossRate: "0.1",
  fillTestRuns: "500",
  laborPerHour: "2500",
  machineChargePerHour: machineChargePerHourFromBasis(),
  productionSpeedPerMinute: "100",
  inspectionSpeed: "1500",
  setupTime: "3",
  cleanupTime: "2",
  customPouchCharge: "400000",
  hopperInitialChargeMl: "2000",
  pressureInitialChargeMl: "8000",
  digitalFilmMinTotalM: "500",
  digitalFilmMinSkuM: "300",
  commissionRate: "0.20",
  sellerProfitRate: "0.12",
  filmUnitPrices: {
    lte570: { "500": "328", "1000": "252", "1500": "226" },
    "571to740": { "500": "365", "1000": "280", "1500": "252" },
  },
  shippingUnitsM: {
    "500": [356, 396, 464, 476, 512, 736],
    "400": [556, 580, 620],
  },
};

function base(
  key: SizeKey,
  design: SizeMaster["design"],
  label: string,
  widthMm: number,
  lengthMm: number,
  lanes: number,
  webWidthMm: number,
  priceBand: SizeMaster["priceBand"],
  pitchAddMm: number,
  prodMultiplier: number,
): SizeMaster {
  return { key, design, label, widthMm: String(widthMm), lengthMm: String(lengthMm), pitchAddMm: String(pitchAddMm), lanes, webWidthMm, priceBand, prodMultiplier };
}

function switchable(key: SizeKey, design: SizeMaster["design"], label: string, widthMm: number, lengthMm: number): SizeMaster {
  return { ...base(key, design, label, widthMm, lengthMm, 4, 356, "lte570", 6, 1), largeLotWebWidthMm: 736 };
}

function switchableWeb(key: SizeKey, design: SizeMaster["design"], label: string, widthMm: number, lengthMm: number, webWidthMm: number): SizeMaster {
  return { ...base(key, design, label, widthMm, lengthMm, 4, webWidthMm, "lte570", 6, 1), largeLotWebWidthMm: 736 };
}
