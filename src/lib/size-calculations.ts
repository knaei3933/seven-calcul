import Decimal from "decimal.js";
import { defaultParameters } from "./constants";
import { D } from "./decimal";
import type { CostParameters, PriceBand, SizeMaster } from "./types";

export function calculateRequiredProductionLength(
  size: SizeMaster,
  quantity: string | number | Decimal,
  lossRate: string = defaultParameters.lossRate,
): Decimal {
  const pitch = D(size.lengthMm).plus(size.pitchAddMm);
  return D(quantity)
    .div(D(1).minus(lossRate))
    .times(pitch)
    .div(1000)
    .div(size.lanes);
}

/**
 * 確定済みサイズマスタの「原反幅 ÷ 列数」から求めた1列あたり原反幅の基準点。
 * 35mm→356/4=89, 38.5mm→368/4=92, 45mm→396/4=99, 50mm→476/4=119, 60mm→556/4=139, 70mm→620/4=155
 */
const PER_LANE_WEB_ANCHORS: ReadonlyArray<{ widthMm: number; perLaneMm: number }> = [
  { widthMm: 35, perLaneMm: 89 },
  { widthMm: 38.5, perLaneMm: 92 },
  { widthMm: 45, perLaneMm: 99 },
  { widthMm: 50, perLaneMm: 119 },
  { widthMm: 60, perLaneMm: 139 },
  { widthMm: 70, perLaneMm: 155 },
];

function perLaneWebWidth(widthMm: Decimal): Decimal {
  const first = PER_LANE_WEB_ANCHORS[0];
  const last = PER_LANE_WEB_ANCHORS[PER_LANE_WEB_ANCHORS.length - 1];
  if (widthMm.lte(first.widthMm)) return D(first.perLaneMm);
  if (widthMm.gte(last.widthMm)) return D(last.perLaneMm);
  for (let index = 1; index < PER_LANE_WEB_ANCHORS.length; index += 1) {
    const prev = PER_LANE_WEB_ANCHORS[index - 1];
    const next = PER_LANE_WEB_ANCHORS[index];
    if (widthMm.lte(next.widthMm)) {
      const ratio = widthMm.minus(prev.widthMm).div(next.widthMm - prev.widthMm);
      return D(prev.perLaneMm).plus(ratio.times(next.perLaneMm - prev.perLaneMm));
    }
  }
  return D(last.perLaneMm);
}

export function deriveCustomSizeMaster(base: SizeMaster, widthMm: string, lengthMm: string): SizeMaster {
  const perLane = perLaneWebWidth(D(widthMm));
  const webWidthMm = perLane.times(base.lanes).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  const priceBand: PriceBand = webWidthMm <= 570 ? "lte570" : "571to740";
  return {
    ...base,
    widthMm: D(widthMm).toString(),
    lengthMm: D(lengthMm).toString(),
    webWidthMm,
    largeLotWebWidthMm: base.largeLotWebWidthMm,
    priceBand,
  };
}

export function shippingUnitForWidth(webWidthMm: number, params: CostParameters): "400" | "500" {
  if (params.shippingUnitsM["500"].includes(webWidthMm)) return "500";
  if (params.shippingUnitsM["400"].includes(webWidthMm)) return "400";
  return webWidthMm < 530 ? "500" : "400";
}
