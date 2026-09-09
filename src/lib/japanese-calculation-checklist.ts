import { D } from "./decimal";
import type { CalculationChecklistSnapshot, ChecklistItem } from "./calculation-checklist";

function number(value: unknown, maximumFractionDigits = 2): string {
  const raw = typeof value === "number" ? String(value) : String(value ?? "");
  const numeric = D(raw.trim() === "" ? 0 : raw);
  const fixed = numeric.toFixed(maximumFractionDigits);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  const [integer, decimal] = trimmed.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decimal ? `${grouped}.${decimal}` : grouped;
}

function percent(value: unknown, maximumFractionDigits = 2): string {
  const raw = String(value ?? "");
  return `${number(D(raw.trim() === "" ? 0 : raw).times(100), maximumFractionDigits)}%`;
}

export function buildJapaneseChecklistItems(snapshot: CalculationChecklistSnapshot): ChecklistItem[] {
  const p = snapshot.parameters;
  const skus = snapshot.skus ?? [];
  const pouchWidth = snapshot.pouchWidthMm ?? snapshot.widthMm;
  const pouchLength = snapshot.pouchLengthMm ?? snapshot.lengthMm;
  const pitch = snapshot.pitchMm;
  const pitchAdd = snapshot.pitchAddMm
    ?? (pitch && pouchLength ? D(pitch).minus(D(pouchLength)).toString() : "0");
  const materialWidth = snapshot.materialWidthMm ?? snapshot.widthMm;
  const isGravure = Boolean(snapshot.gravure);
  const items: ChecklistItem[] = [];
  const add = (
    id: string,
    category: string,
    variable: string,
    explanation: string,
    inputs: string,
    formula: string,
    substitution: string,
    result: string,
    unit?: string,
  ) => {
    items.push({
      id, category, variable, explanation, inputs, formula, substitution, result, unit,
      accepted: false, checkedAt: null, checkedBy: null,
    });
  };

  const basic = "基本条件";
  add("basic.quantity", basic, "発注数量", "連結後のパウチ1枚単位の発注数量です。", `発注数量 = ${number(snapshot.quantity)}`, "入力値をそのまま使用します。", `入力 = ${number(snapshot.quantity)}`, number(snapshot.quantity), "枚");
  add("basic.connected", basic, "連結形式", "パウチ1枚あたりの充填室数です。", `連結数 = ${snapshot.connectedChambers}`, "入力値をそのまま使用します。", `入力 = ${snapshot.connectedChambers}`, String(snapshot.connectedChambers), "連");
  add("basic.size", basic, "パウチサイズ", "入力されたパウチの左右幅・長さです。原反幅とは別の値です。", `左右幅 = ${number(pouchWidth)} mm／長さ = ${number(pouchLength)} mm`, "入力値を確認します。", `入力サイズ = ${number(pouchWidth)} × ${number(pouchLength)} mm`, `${number(pouchWidth)} × ${number(pouchLength)}`, "mm");
  add("basic.pitch", basic, "製造ピッチ", "パウチ長さにピッチ加算を加えた製造上の間隔です。", `パウチ長さ = ${number(pouchLength)} mm／ピッチ加算 = ${number(pitchAdd)} mm`, "パウチ長さ + ピッチ加算", `${number(pouchLength)} + ${number(pitchAdd)} = ${number(pitch)}`, number(pitch), "mm");
  add("basic.chambers", basic, "総室数", "発注数量の合計充填室数です。", `発注数量 = ${number(snapshot.quantity)}／連結数 = ${snapshot.connectedChambers}`, "発注数量 × 連結数", `${number(snapshot.quantity)} × ${snapshot.connectedChambers}`, number(D(snapshot.quantity).times(snapshot.connectedChambers)), "室");
  add("basic.fill", basic, "充填量", "SKU数量で加重平均した1室あたり充填量です。", skus.length ? skus.map((sku) => `${sku.name}: ${number(sku.quantity)}枚 × ${number(sku.fillMlPerChamber)}ml`).join("／") : `充填量 = ${number(snapshot.fillMlPerChamber)} ml`, "Σ(SKU数量 × 充填量) ÷ Σ(SKU数量)", "SKU条件の加重平均", number(snapshot.fillMlPerChamber), "ml");
  add("basic.total-fill", basic, "1枚総充填量", "連結室を含むパウチ1枚の総充填量です。", `充填量 = ${number(snapshot.fillMlPerChamber)} ml／連結数 = ${snapshot.connectedChambers}`, "充填量 × 連結数", `${number(snapshot.fillMlPerChamber)} × ${snapshot.connectedChambers}`, number(snapshot.totalFillMlPerPouch), "ml");

  const production = "生産条件";
  add("production.base-speed", production, "基準生産速度", "1連基準の分毎生産速度です。", `入力速度 = ${number(p.productionSpeedPerMinute)} 枚/分`, "入力値または充填量ルール", `入力 = ${number(p.productionSpeedPerMinute)}`, number(snapshot.baseProductionSpeedPerMinute), "枚/分");
  add("production.lanes", production, "同時充填列数", "充填機の同時処理列数です。", `充填列数 = ${snapshot.fillingLanes}列`, "入力値をそのまま使用します。", `入力 = ${snapshot.fillingLanes}`, String(snapshot.fillingLanes), "列");
  add("production.effective-speed", production, "実効生産速度", "連結形式を反映した1時間あたり速度です。", `基準速度 = ${number(snapshot.baseProductionSpeedPerMinute)}枚/分／1回充填列数 = ${snapshot.lanesPerCycle}／総列数 = ${snapshot.fillingLanes}`, "基準速度 × 60 × (1回充填列数 ÷ 総列数)", `${number(snapshot.baseProductionSpeedPerMinute)} × 60 × (${snapshot.lanesPerCycle} ÷ ${snapshot.fillingLanes})`, number(snapshot.effectiveProductionSpeed), "枚/h");
  const lossRate = percent(p.lossRate);
  add("production.run-quantity", production, "稼働生産数量", "フィルムロス分を含めて製造する数量です。", `発注数量 = ${number(snapshot.quantity)}枚／フィルムロス率 = ${lossRate}`, "発注数量 ÷ (1 − ロス率)", `${number(snapshot.quantity)} ÷ (1 − ${p.lossRate})`, number(snapshot.productionRunQuantity), "枚");
  add("production.production-hours", production, "生産時間", "稼働生産数量の製造に必要な時間です。", `稼働生産数量 = ${number(snapshot.productionRunQuantity)}枚／実効速度 = ${number(snapshot.effectiveProductionSpeed)}枚/h`, "稼働生産数量 ÷ 実効生産速度", `${number(snapshot.productionRunQuantity)} ÷ ${number(snapshot.effectiveProductionSpeed)}`, number(snapshot.productionHours), "h");
  add("production.inspection-hours", production, "検品時間", "稼働生産数量を検品する時間です。", `稼働生産数量 = ${number(snapshot.productionRunQuantity)}枚／検品速度 = ${number(p.inspectionSpeed)}枚/h`, "稼働生産数量 ÷ 検品速度", `${number(snapshot.productionRunQuantity)} ÷ ${number(p.inspectionSpeed)}`, number(snapshot.inspectionHours), "h");

  const processing = "充填・加工費";
  const productionLabor = D(p.laborPerHour).times(snapshot.productionHours);
  const inspectionLabor = D(p.laborPerHour).times(snapshot.inspectionHours);
  const machineVariable = D(p.machineChargePerHour).times(snapshot.productionHours);
  add("processing.production-labor", processing, "生産人件費", "生産時間に対する人件費です。", `人件費 = ${number(p.laborPerHour)}円/h／生産時間 = ${number(snapshot.productionHours)}h`, "人件費単価 × 生産時間", `${number(p.laborPerHour)} × ${number(snapshot.productionHours)}`, number(productionLabor), "円");
  add("processing.inspection-labor", processing, "検品人件費", "検品時間に対する人件費です。", `人件費 = ${number(p.laborPerHour)}円/h／検品時間 = ${number(snapshot.inspectionHours)}h`, "人件費単価 × 検品時間", `${number(p.laborPerHour)} × ${number(snapshot.inspectionHours)}`, number(inspectionLabor), "円");
  add("processing.machine", processing, "機械変動費", "生産稼働に比例する機械チャージです。", `機械チャージ = ${number(p.machineChargePerHour)}円/h／生産時間 = ${number(snapshot.productionHours)}h`, "機械チャージ × 生産時間", `${number(p.machineChargePerHour)} × ${number(snapshot.productionHours)}`, number(machineVariable), "円");
  add("processing.variable-total", processing, "変動加工費", "生産人件費・検品人件費・機械変動費の合計です。", `生産人件費 = ${number(productionLabor)}円／検品人件費 = ${number(inspectionLabor)}円／機械費 = ${number(machineVariable)}円`, "生産人件費 + 検品人件費 + 機械費", `${number(productionLabor)} + ${number(inspectionLabor)} + ${number(machineVariable)}`, number(snapshot.variableProcessingTotal), "円");
  add("processing.fixed-lot", processing, "段取り・清掃費", "ロット1回の段取りと清掃に必要な固定費です。", `段取り = ${number(p.setupTime)}h／清掃 = ${number(p.cleanupTime)}h／人件費 = ${number(p.laborPerHour)}円/h／機械チャージ = ${number(p.machineChargePerHour)}円/h`, "(段取り + 清掃) × (人件費 + 機械チャージ)", `(${number(p.setupTime)} + ${number(p.cleanupTime)}) × (${number(p.laborPerHour)} + ${number(p.machineChargePerHour)})`, number(snapshot.fixedLotCost), "円");
  add("processing.custom", processing, "カスタム費用", "カスタムサイズ・金型などの追加ロット費用です。", `カスタム単価設定 = ${number(p.customPouchCharge)}円`, "カスタム適用時は設定額、標準時は0円", snapshot.customCharge === "0" ? "標準サイズのため0円" : `適用 = ${number(p.customPouchCharge)}円`, number(snapshot.customCharge), "円");

  const bulk = "バルク費用";
  add("bulk.unit-price", bulk, "バルク単価", "液内容1mlあたりの単価です。", `バルク単価 = ${number(snapshot.bulkUnitPrice)}円/ml`, "入力値をそのまま使用します。", `入力 = ${number(snapshot.bulkUnitPrice)}`, number(snapshot.bulkUnitPrice), "円/ml");
  add("bulk.usage", bulk, "バルク使用量", "本体充填・ロス・初期投入・テスト充填を含む使用量です。", `総室数 = ${number(snapshot.chamberCount ?? D(snapshot.quantity).times(snapshot.connectedChambers))}室／充填量 = ${number(snapshot.fillMlPerChamber)}ml／バルクロス率 = ${percent(snapshot.bulkLossRate)}／初期投入 = ${number(snapshot.bulkInitialChargeMl ?? 0)}ml／テスト = ${number(snapshot.bulkTestFillMl ?? 0)}ml`, "総室数 × 充填量 × (1 + ロス率) + 初期投入 + テスト充填", "各入力値に基づいて合算", number(snapshot.bulkUsageMl), "ml");
  add("bulk.cost", bulk, "バルク費用", "バルク使用量に対する費用です。", `使用量 = ${number(snapshot.bulkUsageMl)}ml／単価 = ${number(snapshot.bulkUnitPrice)}円/ml`, "使用量 × バルク単価", `${number(snapshot.bulkUsageMl)} × ${number(snapshot.bulkUnitPrice)}`, number(snapshot.bulkCost), "円");

  const film = "フィルム費用";
  skus.forEach((sku, index) => {
    add(`film.sku.${index}`, film, `SKU-${index + 1} 条件`, `${sku.name}の発注条件と必要長です。`, `SKU名 = ${sku.name}／数量 = ${number(sku.quantity)}枚／充填量 = ${number(sku.fillMlPerChamber)}ml／色数 = ${sku.colorCount}色`, "SKU数量に応じて必要長を計算します。", `必要長 = ${number(sku.requiredLengthM)}m`, number(sku.requiredLengthM), "m");
  });
  add("film.required-length", film, "必要フィルム長", "全SKUの必要フィルム長合計です。", skus.length ? skus.map((sku) => `${sku.name}: ${number(sku.requiredLengthM)}m`).join(" + ") : `必要長 = ${number(snapshot.film.requiredLengthM)}m`, "SKU別必要長の合計", "SKU別必要長を合算", number(snapshot.film.requiredLengthM), "m");
  if (!isGravure) {
  add("film.order-length", film, "フィルム発注長", "発注単位・最小ロットを考慮した発注長です。", `必要長 = ${number(snapshot.film.requiredLengthM)}m`, "SKU別発注長の合計", "SKU別発注長を合算", number(snapshot.film.orderLengthM), "m");
  add("film.loss", film, "フィルムロス", "ロス率と最小ロスを比較して大きい方を適用します。", `ロス率 = ${lossRate}／最小ロス = ${number(p.lossMinM)}m`, "MAX(最小ロス, 対象長 × ロス率)", `MAX(${number(p.lossMinM)}, 対象長 × ${p.lossRate})`, number(snapshot.film.lossM), "m");
  add("film.effective-length", film, "有効フィルム長", "ロスを除いて製造に使える長さです。", `対象長 = ${number(snapshot.film.orderLengthM)}m／ロス = ${number(snapshot.film.lossM)}m`, "対象長 − ロス", `${number(snapshot.film.orderLengthM)} − ${number(snapshot.film.lossM)}`, number(snapshot.film.effectiveLengthM), "m");
    add("film.unit-price", film, "適用フィルム単価", "原反幅と発注長の価格帯から選択したデジタル用単価です。", `原反幅 = ${number(materialWidth)}mm／発注長 = ${number(snapshot.film.orderLengthM)}m`, "価格表から選択", `適用帯 = ${snapshot.film.skuCosts[0]?.appliedBand ?? "-"}`, number(snapshot.film.unitPrice), "円/m");
    add("film.base-cost", film, "フィルム本体費", "発注長に対するフィルム本体費用です。", `発注長 = ${number(snapshot.film.orderLengthM)}m／単価 = ${number(snapshot.film.unitPrice)}円/m`, "発注長 × 単価", `${number(snapshot.film.orderLengthM)} × ${number(snapshot.film.unitPrice)}`, number(snapshot.film.filmBaseCost), "円");
    add("film.shipping-trips", film, "配送回数", "原反幅別の配送単位長で必要回数を切り上げます。", `生産換算長 = ${number(snapshot.film.orderLengthM)}m／原反幅 = ${number(materialWidth)}mm`, "生産換算長 ÷ 配送単位長 の切り上げ", "配送単位は原反幅設定を使用", String(snapshot.film.shippingTrips), "回");
    add("film.domestic-shipping", film, "国内配送費", "国内輸送費用です。", `回数 = ${snapshot.film.shippingTrips}回／単価 = ${number(p.domesticShippingPerTrip)}円/回`, "回数 × 国内配送単価", `${snapshot.film.shippingTrips} × ${number(p.domesticShippingPerTrip)}`, number(snapshot.film.domesticShipping), "円");
    add("film.overseas-shipping", film, "海外配送費", "海外輸送費用です。", `回数 = ${snapshot.film.shippingTrips}回／単価 = ${number(p.overseasShippingPerTrip)}円/回`, "回数 × 海外配送単価", `${snapshot.film.shippingTrips} × ${number(p.overseasShippingPerTrip)}`, number(snapshot.film.overseasShipping), "円");
    add("film.customs", film, "通関料", "閾値超過時は固定額、未満は回数×単価です。", `本体費 = ${number(snapshot.film.filmBaseCost)}円／閾値 = ${number(p.customsThreshold)}円`, "閾値超過: 固定額／未満: 回数 × 回単価", snapshot.film.customs === p.customsHighCharge ? `閾値超過 = ${number(p.customsHighCharge)}円` : `${snapshot.film.shippingTrips} × ${number(p.customsPerTrip)}`, number(snapshot.film.customs), "円");
    add("film.total", film, "フィルム費用合計", "本体費と物流・通関費用の合計です。", `本体費 = ${number(snapshot.film.filmBaseCost)}円／国内 = ${number(snapshot.film.domesticShipping)}円／海外 = ${number(snapshot.film.overseasShipping)}円／通関 = ${number(snapshot.film.customs)}円`, "本体費 + 国内配送 + 海外配送 + 通関料", `${number(snapshot.film.filmBaseCost)} + ${number(snapshot.film.domesticShipping)} + ${number(snapshot.film.overseasShipping)} + ${number(snapshot.film.customs)}`, number(snapshot.film.filmTotal), "円");
  }


  const margin = "原価・販売価格";
  add("margin.cost-total", margin, "総原価", "全費用項目の合計です。", `フィルム = ${number(snapshot.film.filmTotal)}円／バルク = ${number(snapshot.bulkCost)}円／変動加工 = ${number(snapshot.variableProcessingTotal)}円／固定 = ${number(snapshot.fixedLotCost)}円／カスタム = ${number(snapshot.customCharge)}円`, "各費用の合計", "全費用項目を合算", number(snapshot.costTotal), "円");
  add("margin.cost-per-piece", margin, "総原価 /枚", "発注数量で割った1枚あたり総原価です。", `総原価 = ${number(snapshot.costTotal)}円／発注数量 = ${number(snapshot.quantity)}枚`, "総原価 ÷ 発注数量", `${number(snapshot.costTotal)} ÷ ${number(snapshot.quantity)}`, number(snapshot.totalCostPerPiece), "円");
  snapshot.sellingPrices.forEach((price, index) => {
    add(`margin.selling-price.${index}`, margin, `販売単価 ${percent(price.margin)}参考`, "目標利益率を反映した参考販売単価です。", `総原価/枚 = ${number(snapshot.totalCostPerPiece)}円／目標利益率 = ${percent(price.margin)}`, "総原価/枚 ÷ (1 − 利益率)", `${number(snapshot.totalCostPerPiece)} ÷ (1 − ${price.margin})`, number(price.pricePerPiece), "円");
  });

  if (snapshot.gravure) {
    const g = snapshot.gravure;
    const gp = snapshot.gravureParameters;
    const gravure = "グラビアフィルム・銅版";
    const productionPatternLength = gp?.productionPatternLengthM ?? snapshot.productionPatternLengthM;
    const deliverablePatternLength = gp?.deliverablePatternLengthM ?? snapshot.deliverablePatternLengthM;
    add("gravure.pattern-count", gravure, "発注パターン数", "必要長を納品パターン長で切り上げた回数です。", `必要長 = ${number(snapshot.film.requiredLengthM)}m／納品パターン = ${number(deliverablePatternLength)}m`, "ceil(必要長 ÷ 納品パターン長)", `${number(snapshot.film.requiredLengthM)} ÷ ${number(deliverablePatternLength)} の切り上げ`, String(snapshot.orderPatternCount), "回");
    add("gravure.material-width", gravure, "原反幅", "グラビア製造に適用する原反幅です。パウチ左右幅ではありません。", `パウチ左右幅 = ${number(pouchWidth)}mm／原反幅 = ${number(g.materialWidthMm)}mm`, "最小500mmまたはサイズ基準幅", `適用幅 = ${number(g.materialWidthMm)}mm`, number(g.materialWidthMm), "mm");
    add("gravure.production-length", gravure, "製作長", "発注パターンに対応する製作長です。", `パターン数 = ${snapshot.orderPatternCount}回／製作パターン = ${number(productionPatternLength)}m`, "パターン数 × 製作パターン長", `${snapshot.orderPatternCount} × ${number(productionPatternLength)}`, number(snapshot.film.orderLengthM), "m");
    add("gravure.deliverable-length", gravure, "納品可能長", "ロスを除いて納品できる長さです。", `パターン数 = ${snapshot.orderPatternCount}回／納品パターン = ${number(deliverablePatternLength)}m`, "パターン数 × 納品パターン長", `${snapshot.orderPatternCount} × ${number(deliverablePatternLength)}`, number(snapshot.film.effectiveLengthM), "m");
    add("gravure.loss-length", gravure, "グラビア製作ロス", "製作長と納品可能長の差です。", `製作長 = ${number(snapshot.film.orderLengthM)}m／納品可能長 = ${number(snapshot.film.effectiveLengthM)}m`, "製作長 − 納品可能長", `${number(snapshot.film.orderLengthM)} − ${number(snapshot.film.effectiveLengthM)}`, number(snapshot.film.lossM), "m");
    add("gravure.material-cost", gravure, "原材料費", "PET・AL・LLDPE各層の原材料費です。小幅固定単価適用時は0円として固定単価側に含めます。", `製作長 = ${number(snapshot.film.orderLengthM)}m／原反幅 = ${number(g.materialWidthMm)}mm`, "Σ(層厚 × 幅 × 長さ × 比重 × 原料単価)", "層構成とグラビア単価を使用", number(g.materialCostYen), "円");
    add("gravure.printing-cost", gravure, "印刷費", "色数と製作長に応じたグラビア印刷費です。", `製作長 = ${number(snapshot.film.orderLengthM)}m／幅 = ${number(g.materialWidthMm)}mm／色数 = ${g.copperPlateCount}色／単価 = ${number(gp?.printingUnitPriceYenPerM ?? 0)}円/m`, "幅m × 製作長 × 色数 × 印刷単価", "SKU別色数条件を加重計算", number(g.printingCostYen), "円");
    add("gravure.lamination-cost", gravure, "ラミネート費", "ラミネート加工費です。", `製作長 = ${number(snapshot.film.orderLengthM)}m／幅 = ${number(g.materialWidthMm)}mm／回数 = ${snapshot.gravure ? 3 : 0}回／単価 = ${number(gp?.laminationUnitPriceYenPerMWithAl ?? 0)}円/m`, "幅m × 製作長 × ラミ回数 × 単価", `${number(D(g.materialWidthMm).div(1000))} × ${number(snapshot.film.orderLengthM)} × 3 × ${number(gp?.laminationUnitPriceYenPerMWithAl ?? 0)}`, number(g.laminationCostYen), "円");
    add("gravure.manufacturer-margin", gravure, "製造マージン", "製造者販売価格に含まれるマージンです。", `フィルム製造費 = ${number(g.filmCostYen)}円／率 = ${percent(gp?.manufacturerMarginRate ?? 0.2)}`, "フィルム製造費 × 製造マージン率", `${number(g.filmCostYen)} × ${gp?.manufacturerMarginRate ?? "0.2"}`, number(g.manufacturerMarginCostYen), "円");
    add("gravure.film-cost", gravure, "製造者販売価格", "原材料・印刷・ラミネートと製造マージンを含みます。", `フィルム製造費 = ${number(g.filmCostYen)}円／製造マージン = ${number(g.manufacturerMarginCostYen)}円`, "フィルム製造費 + 製造マージン", `${number(g.filmCostYen)} + ${number(g.manufacturerMarginCostYen)}`, number(g.customsBaseCostYen), "円");
    add("gravure.customs", gravure, "通関料", "製造者販売価格基準の通関費用です。", `基準価格 = ${number(g.customsBaseCostYen)}円／税率 = ${percent(gp?.customsRate ?? 0.05)}`, "製造者販売価格 × 税率", `${number(g.customsBaseCostYen)} × ${gp?.customsRate ?? "0.05"}`, number(g.customsCostYen), "円");
    add("gravure.shipping", gravure, "海外配送費", "納品可能長基準の海外配送費です。", `回数 = ${g.shippingTrips}回／単価 = ${number(gp?.overseasShippingPerTripYen ?? 11000)}円/回`, "回数 × 海外配送単価", `${g.shippingTrips} × ${number(gp?.overseasShippingPerTripYen ?? 11000)}`, number(g.overseasShippingCostYen), "円");
    add("gravure.seller-adjustment", gravure, "供給価格調整", "カネイ貿易供給価格としてフィルム費用へ含める調整額です。", `フィルム費用基準 = ${number(D(g.customsBaseCostYen).plus(D(g.customsCostYen)).plus(D(g.overseasShippingCostYen)))}円／調整率 = ${percent(p.sellerProfitRate)}`, "フィルム費用基準 × 調整率", `${number(D(g.customsBaseCostYen).plus(D(g.customsCostYen)).plus(D(g.overseasShippingCostYen)))} × ${p.sellerProfitRate}`, number(snapshot.sellerProfitCost), "円");
    add("gravure.film-total", gravure, "フィルム費用合計", "製造者販売価格・通関・海外配送・供給価格調整を含みます。", `製造者販売価格 = ${number(g.customsBaseCostYen)}円／通関 = ${number(g.customsCostYen)}円／海外配送 = ${number(g.overseasShippingCostYen)}円／供給調整 = ${number(snapshot.sellerProfitCost)}円`, "製造者販売価格 + 通関料 + 海外配送費 + 供給価格調整", `${number(g.customsBaseCostYen)} + ${number(g.customsCostYen)} + ${number(g.overseasShippingCostYen)} + ${number(snapshot.sellerProfitCost)}`, number(snapshot.film.filmTotal), "円");
    if (g.copperPlateCostYen) {
      add("gravure.copper-plate-unit", gravure, "新規銅版単価", "1色1本の新規銅版単価です。", `版幅 = ${number(D(g.materialWidthMm).plus(gp?.copperPlateWidthExtraMm ?? 100))}cm÷10／外径 = ${number(gp?.copperPlateMinimumDiameterMm ?? 420)}cm`, "MAX(¥32,000, 版幅cm × 単価 × 外径cm)", "各色1本ごとに最小額を保証", number(g.copperPlateUnitPriceYen), "円/色");
      add("gravure.copper-plate", gravure, "新規銅版費", "色数に応じた新規銅版費用です。", `銅版単価 = ${number(g.copperPlateUnitPriceYen)}円/色／色数 = ${g.copperPlateCount}色`, "銅版単価 × 色数", `${number(g.copperPlateUnitPriceYen)} × ${g.copperPlateCount}`, number(g.copperPlateCostYen), "円");
    }
  }

  return items;
}
