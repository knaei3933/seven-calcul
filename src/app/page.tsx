"use client";

import { createHash } from "node:crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculatePouchCost } from "@/lib/calculation";
import { defaultParameters, machineChargeBasis, sizeMaster } from "@/lib/constants";
import { displayAmount } from "@/lib/calculation";
import { D } from "@/lib/decimal";
import { defaultGravureRollParameters, type GravureRollParameters } from "@/lib/gravure-roll";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import { QUOTATION_DRAFT_KEY, buildQuotationDraft } from "@/lib/quotation-draft";
import { deriveCustomSizeMaster, shippingUnitForWidth } from "@/lib/size-calculations";
import type { CostParameters, PouchSpec, PrintingMethod, SizeKey } from "@/lib/types";

const warningLabels: Record<string, string> = {
  seven_template_unconfirmed: "Seven書式は未確認です",
  tax_rounding_unconfirmed: "税区分・端数処理は未確認です",
  digital_color_price_not_applied: "色数別単価は参考入力（印刷色数とは未連動）・仕入先確認待ち",
  custom_size_mapping_unconfirmed: "カスタム寸法の変換ルールは未設定です",
  filling_lanes_differ_from_film_lanes: "充填列数とフィルム生産列数が一致しません",
};

const TAX_ROUNDING_CONFIRMED = false;
const MARGIN_OPTIONS = ["0.4", "0.5"] as const;
type TargetMargin = (typeof MARGIN_OPTIONS)[number] | "custom";
const MACHINE_BREAKDOWN_DEFAULTS = { ...machineChargeBasis } as const;
type MachineBreakdownKey = keyof typeof MACHINE_BREAKDOWN_DEFAULTS;
const MACHINE_BREAKDOWN_LABELS: Record<MachineBreakdownKey, string> = {
  acquisitionCostYen: "設備取得価額 (円)",
  usefulLifeYears: "耐用年数 (年・定額法・残存価額0)",
  annualElectricityKwh: "年間使用電力量 (kWh/年)",
  electricityUnitPriceYen: "電力単価 (円/kWh)",
  annualOperatingHours: "年間稼働時間 (時間/年)",
};
const SIMULATOR_STATE_KEY = "pouch-simulator-state-v1";

const parameterGroups = [
  {
    title: "加工・固定費",
    fields: [
      { key: "laborPerHour", label: "人件費 / 時間 (円)", value: (params: CostParameters) => params.laborPerHour },
      { key: "productionSpeedPerMinute", label: "生産速度 (枚/分・1連基準)", value: (params: CostParameters) => params.productionSpeedPerMinute },
      { key: "inspectionSpeed", label: "検品速度 (枚/h)", value: (params: CostParameters) => params.inspectionSpeed },
      { key: "setupTime", label: "段取り時間 (h)", value: (params: CostParameters) => params.setupTime },
      { key: "cleanupTime", label: "清掃時間 (h)", value: (params: CostParameters) => params.cleanupTime },
      { key: "customPouchCharge", label: "カスタム費用 (円)", value: (params: CostParameters) => params.customPouchCharge },
      { key: "sellerProfitRate", label: "販売会社利益率 (%)", value: (params: CostParameters) => formatNumber(Number(params.sellerProfitRate) * 100, 3) },
    ] as const,
  },
  {
    title: "フィルム",
    fields: [
      { key: "lossRate", label: "フィルムロス率 (%)", value: (params: CostParameters) => formatNumber(Number(params.lossRate) * 100, 3) },
      { key: "lossMinM", label: "最小ロス (m)", value: (params: CostParameters) => params.lossMinM },
      { key: "domesticShippingPerTrip", label: "国内配送費 / 回 (円)", value: (params: CostParameters) => params.domesticShippingPerTrip },
      { key: "overseasShippingPerTrip", label: "海外配送費 / 回 (円)", value: (params: CostParameters) => params.overseasShippingPerTrip },
      { key: "customsThreshold", label: "通関料閾値 (円)", value: (params: CostParameters) => params.customsThreshold },
      { key: "customsHighCharge", label: "閾値超過時通関料 (円)", value: (params: CostParameters) => params.customsHighCharge },
      { key: "customsPerTrip", label: "通関料 / 回 (円)", value: (params: CostParameters) => params.customsPerTrip },
    ] as const,
  },
  {
    title: "バルク・試験",
    fields: [
      { key: "bulkLossRate", label: "バルクロス率 (%)", value: (params: CostParameters) => formatNumber(Number(params.bulkLossRate) * 100, 3) },
      { key: "fillTestRuns", label: "テスト充填回数 (回)", value: (params: CostParameters) => params.fillTestRuns },
      { key: "hopperInitialChargeMl", label: "ホッパ初期投入 (ml)", value: (params: CostParameters) => params.hopperInitialChargeMl },
      { key: "pressureInitialChargeMl", label: "加圧初期投入 (ml)", value: (params: CostParameters) => params.pressureInitialChargeMl },
    ] as const,
  },
];

export default function QuotationPage() {
  const initialSize = sizeMaster["round-50x60"];
  const [form, setForm] = useState({
    sizeKey: "round-50x60" as SizeKey,
    custom: false,
    widthMm: "50",
    lengthMm: "60",
    quantity: "10000",
    connected: "1" as "1" | "2" | "3" | "4",
    method: "hopper" as "hopper" | "pressure",
    lanes: "4",
    printingMethod: "digital" as PrintingMethod,
    targetMargin: "0.4" as TargetMargin,
    customMargin: "0.45",
    bulkPrice: "0",
    skuCount: "1",
    skus: [
      { name: "", quantity: "10000", fillMl: "3", colorCount: "4" },
    ],
  });
  const [parameters, setParameters] = useState<CostParameters>(defaultParameters);
  const [gravureParameters, setGravureParameters] = useState<GravureRollParameters>(() => normalizeGravureParameters(defaultGravureRollParameters()));
  const [machineBreakdown, setMachineBreakdown] = useState<Record<MachineBreakdownKey, string>>(() => ({ ...MACHINE_BREAKDOWN_DEFAULTS }));
  type ServerCalculation = { result: ReturnType<typeof calculatePouchCost>; inputSha256: string };
  const [serverResult, setServerResult] = useState<ServerCalculation | null>(null);
  const [calculatedAt, setCalculatedAt] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestOrderRef = useRef(0);
  const [simulatorStateLoaded, setSimulatorStateLoaded] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = sessionStorage.getItem(SIMULATOR_STATE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as {
            form?: Partial<typeof form>;
            parameters?: Partial<CostParameters>;
            gravureParameters?: Partial<GravureRollParameters>;
            machineBreakdown?: Partial<Record<MachineBreakdownKey, string>>;
          };
          if (saved.form) setForm((old) => ({ ...old, ...saved.form }));
          if (saved.parameters) setParameters((old) => ({ ...old, ...saved.parameters }));
          if (saved.gravureParameters) setGravureParameters(normalizeGravureParameters(saved.gravureParameters));
          if (saved.machineBreakdown) setMachineBreakdown((old) => ({ ...old, ...saved.machineBreakdown }));
        }
      } catch {
        // 저장 상태가 손상된 경우 기본값을 유지한다.
      } finally {
        setSimulatorStateLoaded(true);
      }
    });
  }, []);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((old) => ({ ...old, [key]: value }));
  const patchForm = (patch: Partial<typeof form>) => setForm((old) => ({ ...old, ...patch }));
  const standardSize = sizeMaster[form.sizeKey];
  const dimensionMismatch = !form.custom && (form.widthMm !== standardSize.widthMm || form.lengthMm !== standardSize.lengthMm);
  const customDimensionsValid = isPositiveDecimalInput(form.widthMm) && isPositiveDecimalInput(form.lengthMm);
  const effectiveSize = form.custom && customDimensionsValid
    ? deriveCustomSizeMaster(standardSize, form.widthMm, form.lengthMm)
    : standardSize;
  const effectiveMargin = form.targetMargin === "custom" ? form.customMargin : form.targetMargin;
  const marginValid = isNumericInput(effectiveMargin) && Number(effectiveMargin) > 0 && Number(effectiveMargin) < 1;
  const targetMarginList = useMemo(() => {
    const seen = new Set<number>();
    return [...MARGIN_OPTIONS, effectiveMargin]
      .filter((value) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1 || seen.has(numeric)) return false;
        seen.add(numeric);
        return true;
      })
      .sort((a, b) => Number(a) - Number(b));
  }, [effectiveMargin]);
  const skuCount = Number(form.skuCount);
  const skuInputsReady = Number.isInteger(skuCount) && skuCount > 0;
  const skuQuantitySum = form.skus.reduce((total, sku) => total + (isNumericInput(sku.quantity) ? Number(sku.quantity) : 0), 0);
  const skuQuantitiesValid = form.skus.length === skuCount
    && form.skus.every((sku) => isPositiveDecimalInput(sku.quantity) && Number.isInteger(Number(sku.quantity))
      && isPositiveDecimalInput(sku.fillMl) && isNonNegativeDecimalInput(sku.colorCount))
    && skuQuantitySum === Number(form.quantity);
  const weightedAvgFill = skuQuantitySum > 0
    ? form.skus.reduce((total, sku) => total + (isNumericInput(sku.quantity) && isNumericInput(sku.fillMl) ? Number(sku.quantity) * Number(sku.fillMl) : 0), 0) / skuQuantitySum
    : 0;
  const skuDisplayName = (index: number) => form.skus[index]?.name.trim() || `充填物${index + 1}`;
  const normalizedGravureParameters = normalizeGravureParameters(gravureParameters);
  const positive = customDimensionsValid
    && isPositiveDecimalInput(form.quantity)
    && isPositiveDecimalInput(form.lanes)
    && isNonNegativeDecimalInput(form.bulkPrice)
    && positiveParameters(parameters)
    && (form.printingMethod !== "gravure" || positiveGravureParameters(normalizedGravureParameters))
    && skuQuantitiesValid;
  const colorPriceUnapplied = true;
  const taxRoundingUnconfirmed = !TAX_ROUNDING_CONFIRMED;
  const blocker = !skuInputsReady || !skuQuantitiesValid || dimensionMismatch || !marginValid || !positive;
  const issuanceBlocker = blocker || colorPriceUnapplied || taxRoundingUnconfirmed;

  const spec = useCallback((): PouchSpec => ({
    sizeKey: form.sizeKey,
    customWidthMm: form.widthMm,
    customLengthMm: form.lengthMm,
    fillMlPerChamber: weightedAvgFill > 0 ? weightedAvgFill.toString() : "3",
    connectedChambers: Number(form.connected) as 1 | 2 | 3 | 4,
    fillingMethod: form.method,
    fillingLanes: Number(form.lanes),
    isCustom: form.custom,
    colorCount: Number(form.skus[0]?.colorCount ?? 0),
    bulkUnitPrice: form.bulkPrice,
    skuCount,
    skuQuantities: form.skus.map((sku) => sku.quantity),
    skuNames: form.skus.map((sku) => sku.name),
    skuFillMlPerChamber: form.skus.map((sku) => sku.fillMl),
    skuColorCounts: form.skus.map((sku) => sku.colorCount),
  }), [form, skuCount, weightedAvgFill]);

  const setParameter = (
    key: "lossRate" | "lossMinM" | "digitalFilmMinSkuM" | "digitalFilmMinTotalM" | "domesticShippingPerTrip" | "overseasShippingPerTrip" | "customsThreshold" | "customsHighCharge" | "customsPerTrip" | "bulkLossRate" | "fillTestRuns" | "hopperInitialChargeMl" | "pressureInitialChargeMl" | "laborPerHour" | "machineChargePerHour" | "productionSpeedPerMinute" | "inspectionSpeed" | "setupTime" | "cleanupTime" | "customPouchCharge" | "sellerProfitRate",
    rawValue: string,
    mode: "percent" | "value",
  ) => setParameters((old) => ({ ...old, [key]: mode === "percent" ? formatNumber(Number(rawValue) / 100, 6) : rawValue }));

  const setFilmUnitPrice = (band: "lte570" | "571to740", lengthBand: "500" | "1000" | "1500", rawValue: string) => setParameters((old) => ({ ...old, filmUnitPrices: { ...old.filmUnitPrices, [band]: { ...old.filmUnitPrices[band], [lengthBand]: rawValue } } }));

  const setMachineBreakdownField = (key: MachineBreakdownKey, rawValue: string) => {
    setMachineBreakdown((old) => {
      const next = { ...old, [key]: rawValue };
      if (machineBreakdownBasisValid(next)) {
        const charge = machineChargeFromBasisValues(next);
        setParameters((oldParams) => ({ ...oldParams, machineChargePerHour: charge }));
      }
      return next;
    });
  };
  const machineBreakdownValid = machineBreakdownBasisValid(machineBreakdown);
  const machineChargeFromBreakdown = machineBreakdownValid ? machineChargeFromBasisValues(machineBreakdown) : null;
  const annualDepreciation = machineBreakdownValid ? D(machineBreakdown.acquisitionCostYen).div(machineBreakdown.usefulLifeYears) : null;
  const annualElectricity = machineBreakdownValid ? D(machineBreakdown.annualElectricityKwh).times(machineBreakdown.electricityUnitPriceYen) : null;
  const depreciationPerHour = machineBreakdownValid ? D(machineBreakdown.acquisitionCostYen).div(machineBreakdown.usefulLifeYears).div(machineBreakdown.annualOperatingHours) : null;
  const electricityPerHour = machineBreakdownValid ? D(machineBreakdown.annualElectricityKwh).times(machineBreakdown.electricityUnitPriceYen).div(machineBreakdown.annualOperatingHours) : null;

  const calculationInput = useMemo(() => ({
    spec: spec(),
    quantity: form.quantity,
    printingMethod: form.printingMethod,
    targetMargins: targetMarginList,
    parameters,
    gravureParameters: normalizedGravureParameters,
  }), [spec, form.quantity, form.printingMethod, targetMarginList, parameters, normalizedGravureParameters]);

  const provisionalResult = useMemo(() => {
    if (blocker) return null;
    try { return calculatePouchCost(calculationInput); } catch { return null; }
  }, [blocker, calculationInput]);


  const inputSha256 = useMemo(() => createHash("sha256").update(JSON.stringify(calculationInput)).digest("hex"), [calculationInput]);
  const staleResult = serverResult !== null && serverResult.inputSha256 !== inputSha256;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blocker) return;
    const requestOrder = ++requestOrderRef.current;
    setPending(true);
    setServerResult(null);
    try {
      const requestedInputSha256 = inputSha256;
      const response = await fetch("/api/calculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(calculationInput) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "calculation_failed");
      if (requestOrder !== requestOrderRef.current) return;
      setServerResult({ result: payload.result, inputSha256: requestedInputSha256 });
      setCalculatedAt(new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    } catch (error) {
      if (requestOrder === requestOrderRef.current) {
        window.dispatchDebugError?.(error instanceof Error ? error.message : "calculation_failed");
      }
    } finally {
      if (requestOrder === requestOrderRef.current) setPending(false);
    }
  };

  const displayed = serverResult?.result ?? provisionalResult;
  const resultShown: ReturnType<typeof calculatePouchCost> | null = staleResult && provisionalResult ? provisionalResult : displayed;
  const customerPrice = displayed?.sellingPrices.find((price) => Number(price.margin) === Number(effectiveMargin));

  useEffect(() => {
    if (!resultShown || !customerPrice) return;
    try {
      sessionStorage.setItem(
        QUOTATION_DRAFT_KEY,
        JSON.stringify(buildQuotationDraft(resultShown, {
          widthMm: form.widthMm,
          lengthMm: form.lengthMm,
          connected: form.connected,
          skuNames: form.skus.map((sku, index) => sku.name.trim() || `充填物${index + 1}`),
          targetMargin: effectiveMargin,
          printingMethod: form.printingMethod,
        })),
      );
    } catch {
      // モード制限時は手入力用の既定見積書へフォールバックする。
    }
  }, [customerPrice, effectiveMargin, form.connected, form.lengthMm, form.printingMethod, form.skus, form.widthMm, resultShown]);

  useEffect(() => {
    if (!simulatorStateLoaded) return;
    try {
      sessionStorage.setItem(SIMULATOR_STATE_KEY, JSON.stringify({
        version: 1,
        form,
        parameters,
        gravureParameters: normalizedGravureParameters,
        machineBreakdown,
      }));
    } catch {
      // private mode 등 저장 실패 시에도 계산은 계속 동작한다.
    }
  }, [form, machineBreakdown, normalizedGravureParameters, parameters, simulatorStateLoaded]);

  const lanesPerCycle = Number(form.lanes) > 0 ? Math.max(1, Math.floor(Number(form.lanes) / Number(form.connected))) : 1;
  const effectiveProductionSpeedPerMinute = Number(form.lanes) > 0
    ? Number(parameters.productionSpeedPerMinute) * lanesPerCycle / Number(form.lanes)
    : Number(parameters.productionSpeedPerMinute);
  const effectiveProductionSpeed = effectiveProductionSpeedPerMinute * 60;
  const totalChambers = isNumericInput(form.quantity) && Number(form.quantity) > 0
    ? Number(form.quantity) * Number(form.connected)
    : null;
  const bulkUsagePreview = (() => {
    if (!(isNumericInput(form.quantity) && Number(form.quantity) > 0) || !Number.isInteger(Number(form.connected)) || Number(form.connected) <= 0) return null;
    let filledVolume = 0;
    let totalQuantity = 0;
    for (const sku of form.skus) {
      const q = Number(sku.quantity);
      const f = Number(sku.fillMl);
      if (!Number.isFinite(q) || !Number.isFinite(f)) return null;
      filledVolume += q * Number(form.connected) * f;
      totalQuantity += q;
    }
    if (totalQuantity <= 0) return null;
    const avgFill = filledVolume / totalQuantity / Number(form.connected);
    const initial = Number(form.method === "hopper" ? parameters.hopperInitialChargeMl : parameters.pressureInitialChargeMl) || 0;
    const test = Number(parameters.fillTestRuns) * Number(form.lanes) * avgFill;
    return filledVolume * (1 + (Number(parameters.bulkLossRate) || 0)) + initial + test;
  })();

  return (
    <main>
      <div className="app-shell">
        <header className="app-header">
          <div><h1>パウチ参考原価・販売価格シミュレーター</h1><p>販売数量は連結後パウチ「枚」、充填は区画「室」で計算します。</p></div>
        </header>
        <form onSubmit={submit} className="layout" noValidate data-testid="quotation-form" data-state={staleResult ? "stale" : "current"}>
          <section className="panel" aria-labelledby="input-title">
            <h2 id="input-title">見積条件</h2>
            <Field label="サイズ" htmlFor="size"><select id="size" value={form.sizeKey} onChange={(e) => { const key = e.target.value as SizeKey; const s = sizeMaster[key]; set("sizeKey", key); patchForm({ widthMm: s.widthMm, lengthMm: s.lengthMm }); }}>{Object.values(sizeMaster).map((size) => <option key={size.key} value={size.key}>{size.label}</option>)}</select></Field>
            <div className="field"><label htmlFor="custom"><input id="custom" type="checkbox" checked={form.custom} onChange={(e) => { const checked = e.target.checked; if (checked) patchForm({ custom: true }); else patchForm({ custom: false, widthMm: standardSize.widthMm, lengthMm: standardSize.lengthMm }); }} /> カスタム区分</label><p className="help">チェックすると左右幅・長さを自由入力できます。列数は選択サイズを引き継ぎ、原反幅・価格帯・配送単位は幅から自動判定します（参考計算）。</p></div>
            <div className="field-row">
              <Field label="左右幅 (mm)" htmlFor="width"><input id="width" inputMode="decimal" readOnly={!form.custom} aria-readonly={!form.custom} aria-describedby={dimensionMismatch ? "dimension-error" : undefined} value={form.widthMm} onChange={(e) => set("widthMm", e.target.value)} /></Field>
              <Field label="長さ (mm)" htmlFor="length"><input id="length" inputMode="decimal" readOnly={!form.custom} aria-readonly={!form.custom} value={form.lengthMm} onChange={(e) => set("lengthMm", e.target.value)} /></Field>
            </div>
            {dimensionMismatch ? <p className="error" id="dimension-error" role="alert">標準サイズの寸法と一致しません。カスタム区分を使用してください。</p> : null}
            {form.custom && customDimensionsValid ? (
              <p className="help" data-testid="custom-size-info">原反幅（自動）＝{effectiveSize.webWidthMm}mm ／ 価格帯＝{effectiveSize.priceBand === "lte570" ? "570mm以下" : "571〜740mm"} ／ 配送単位＝{shippingUnitForWidth(effectiveSize.webWidthMm, parameters)}m/回</p>
            ) : null}
            <div className="field-row">
              <Field label="発注数量 (枚)" htmlFor="quantity"><input id="quantity" inputMode="numeric" value={form.quantity} onChange={(e) => patchForm({ quantity: e.target.value, skus: redistributeSkus(form.skus, e.target.value) })} /></Field>
              <div className="field">
                <span>充填量（数量加重平均）</span>
                <p className="effective-speed" data-testid="avg-fill">{formatNumber(weightedAvgFill)} ml/室</p>
                <p className="help">充填量はSKUごとに設定します。ここでは平均値を表示します。</p>
              </div>
            </div>
            <div className="field" data-testid="sku-block">
              <label htmlFor="sku-count">SKU数（並列生産数）</label>
              <input id="sku-count" data-testid="sku-count" inputMode="numeric" min="1" step="1" value={form.skuCount} onChange={(e) => { const count = Math.max(0, Math.floor(Number(e.target.value) || 0)); setForm((old) => ({ ...old, skuCount: e.target.value, skus: resizeSkus(old, count) })); }} />
              <div className="sku-cards">
                {form.skus.map((sku, index) => (
                  <fieldset className="sku-card" key={index} data-testid={`sku-card-${index}`}>
                    <legend>SKU-{index + 1}</legend>
                    <Field label={`製品名（未入力時 ${skuDisplayName(index)}）`} htmlFor={`sku-name-${index}`}>
                      <input id={`sku-name-${index}`} data-testid={`sku-name-${index}`} placeholder={`充填物${index + 1}`} value={sku.name} onChange={(event) => setForm((old) => ({ ...old, skus: old.skus.map((value, i) => (i === index ? { ...value, name: event.target.value } : value)) }))} />
                    </Field>
                    <div className="sku-card-grid">
                      <Field label="発注枚数" htmlFor={`sku-quantity-${index}`}>
                        <input
                          id={`sku-quantity-${index}`}
                          data-testid={`sku-quantity-${index}`}
                          inputMode="numeric"
                          aria-invalid={!(isPositiveDecimalInput(sku.quantity) && Number.isInteger(Number(sku.quantity)))}
                          value={sku.quantity}
                          onChange={(event) => setForm((old) => ({ ...old, skus: old.skus.map((value, i) => (i === index ? { ...value, quantity: event.target.value } : value)) }))}
                        />
                      </Field>
                      <Field label="充填量 (ml/室)" htmlFor={`sku-fill-${index}`}>
                        <input
                          id={`sku-fill-${index}`}
                          data-testid={`sku-fill-${index}`}
                          inputMode="decimal"
                          aria-invalid={!isPositiveDecimalInput(sku.fillMl)}
                          value={sku.fillMl}
                          onChange={(event) => setForm((old) => ({ ...old, skus: old.skus.map((value, i) => (i === index ? { ...value, fillMl: event.target.value } : value)) }))}
                        />
                      </Field>
                      <Field label="印刷色数" htmlFor={`sku-color-${index}`}>
                        <input
                          id={`sku-color-${index}`}
                          data-testid={`sku-color-${index}`}
                          inputMode="numeric"
                          aria-invalid={!isNonNegativeDecimalInput(sku.colorCount)}
                          value={sku.colorCount}
                          onChange={(event) => setForm((old) => ({ ...old, skus: old.skus.map((value, i) => (i === index ? { ...value, colorCount: event.target.value } : value)) }))}
                        />
                      </Field>
                    </div>
                  </fieldset>
                ))}
              </div>
              <p className="help">SKUごとに製品名・発注枚数・充填量・色数を設定できます。発注枚数の合計が発注数量（{formatNumber(form.quantity)}枚）と一致する必要があります。SKU数を変更すると均等割りします（製品名 未入力時は 充填物1, 2, 3…）。</p>
              {!skuQuantitiesValid ? <p className="error" role="alert" data-testid="sku-sum-error">SKU合計 {formatNumber(skuQuantitySum)} 枚 ≠ 発注数量 {formatNumber(form.quantity)} 枚。各SKUの発注枚数を調整してください。</p> : null}
            </div>
            <fieldset className="field" id="connected"><legend>連結形式</legend><div className="radio-cards">{(["1", "2", "3", "4"] as const).map((value) => <label key={value}><input type="radio" name="connected" value={value} checked={form.connected === value} onChange={() => set("connected", value)} aria-label={`${value}連`} />{value}連</label>)}</div>
              <p className="help" data-testid="total-fill">1枚あたり総充填量（平均）＝{formatNumber(weightedAvgFill)}ml × {form.connected}＝{formatNumber(weightedAvgFill * Number(form.connected), 3)} ml</p>
              {totalChambers !== null && bulkUsagePreview !== null ? (
                <p className="help" data-testid="connected-preview">総室数＝{formatNumber(form.quantity)}枚×{form.connected}＝{formatNumber(totalChambers)} 室 ／ バルク使用量（概算）＝{formatNumber(bulkUsagePreview)} ml ／ 実効生産速度＝{formatNumber(effectiveProductionSpeedPerMinute)} 枚/分（{formatNumber(effectiveProductionSpeed)} 枚/h）</p>
              ) : null}
              {Number(form.bulkPrice) === 0 ? <p className="help">※バルク単価が0円のため、連結数を変えても金額は変化しません（使用量のみ変化）。金額に反映するには「バルク単価 (円/ml)」を入力してください。</p> : null}
            </fieldset>
            <Field label="充填方式" htmlFor="method"><select id="method" value={form.method} onChange={(e) => set("method", e.target.value as "hopper" | "pressure")}><option value="hopper">ホッパ充填（初期2,000ml）</option><option value="pressure">加圧充填（初期8,000ml）</option></select></Field>
            <div className="field-row">
              <Field label="1回の充填列数 (列)" htmlFor="lanes">
                <input id="lanes" inputMode="numeric" aria-describedby="lanes-help" value={form.lanes} onChange={(e) => set("lanes", e.target.value)} />
                <p className="help" id="lanes-help">テスト充填は500回 × 列数 × 充填量としてバルク使用量に加算します。</p>
              </Field>
            </div>
            <div className="field-row">
              <Field label="生産速度・1連基準 (枚/分)" htmlFor="production-speed">
                <input
                  id="production-speed"
                  inputMode="decimal"
                  aria-describedby="production-speed-help"
                  className={isPositiveDecimalInput(parameters.productionSpeedPerMinute) ? undefined : "invalid"}
                  value={parameters.productionSpeedPerMinute}
                  onChange={(e) => setParameter("productionSpeedPerMinute", e.target.value, "value")}
                />
                <p className="help" id="production-speed-help">機械が1分に作れる1連パウチの枚数です。例：分速40枚 → {formatNumber(40 * 60)}枚/h（×60で自動換算）。</p>
              </Field>
              <div className="field">
                <span>実効生産速度（{form.connected}連）</span>
                <p className="effective-speed" data-testid="effective-speed">{formatNumber(effectiveProductionSpeedPerMinute)} 枚/分（{formatNumber(effectiveProductionSpeed)} 枚/h）</p>
                <p className="help">{form.connected}連は1回に{lanesPerCycle}枚（{form.lanes}列÷{form.connected}連）なので、速度も比例して変わります。</p>
              </div>
            </div>
            <div className="field">
              <span id="printing-label">印刷方式</span>
              <div className="radio-cards" role="radiogroup" aria-labelledby="printing-label">
                <label><input type="radio" name="printing-method" aria-label="デジタル印刷" checked={form.printingMethod === "digital"} onChange={() => set("printingMethod", "digital")} />デジタル印刷</label>
                <label><input type="radio" name="printing-method" aria-label="グラビア印刷" checked={form.printingMethod === "gravure"} onChange={() => set("printingMethod", "gravure")} />グラビア印刷</label>
              </div>
              <p className="help">グラビア選択時はロールフィルム用の原反・印刷・ラミネート・銅版費を計算します。他の生産資源はデジタル計算と同じモデルを使います。</p>
            </div>
            <div className="field">
              <span id="margin-label">目標利益率（参考値）</span>
              <div className="radio-cards" role="radiogroup" aria-labelledby="margin-label">
                {MARGIN_OPTIONS.map((margin) => (
                  <label key={margin}>
                    <input type="radio" name="target-margin" aria-label={`利益率 ${formatNumber(Number(margin) * 100, 0)}%`} checked={form.targetMargin === margin} onChange={() => set("targetMargin", margin)} />
                    {formatNumber(Number(margin) * 100, 0)}%
                  </label>
                ))}
                <label>
                  <input type="radio" name="target-margin" aria-label="利益率 カスタム" checked={form.targetMargin === "custom"} onChange={() => set("targetMargin", "custom")} />
                  カスタム
                </label>
              </div>
              {form.targetMargin === "custom" ? (
                <Field label="カスタム利益率 (%)" htmlFor="custom-margin">
                  <input
                    id="custom-margin"
                    inputMode="decimal"
                    value={isNumericInput(form.customMargin) ? formatNumber(Number(form.customMargin) * 100, 3) : form.customMargin}
                    aria-invalid={!marginValid}
                    onChange={(e) => { const percent = Number(e.target.value); set("customMargin", e.target.value.trim() === "" ? "" : Number.isFinite(percent) ? formatNumber(percent / 100, 6) : e.target.value); }}
                  />
                </Field>
              ) : null}
            </div>
            <Field label="バルク単価 (円/ml)" htmlFor="bulk"><input id="bulk" inputMode="decimal" value={form.bulkPrice} onChange={(e) => set("bulkPrice", e.target.value)} /></Field>
            <details className="parameters" data-testid="parameters">
              <summary>計算パラメータ調整</summary>
                  {parameterGroups.map((group) => (
                <fieldset className="parameter-group" key={group.title}>
                  <legend>{group.title}</legend>
                  {group.fields.map((field) => (
                    <label key={field.key} className="parameter-label">
                      {field.label}
                      <input
                        className={isNonNegativeDecimalInput(parameters[field.key]) ? undefined : "invalid"}
                        inputMode="decimal"
                        value={field.value(parameters)}
                        onChange={(event) => setParameter(field.key, event.target.value, field.key === "lossRate" || field.key === "bulkLossRate" ? "percent" : "value")}
                      />
                    </label>
                  ))}
                  {form.printingMethod === "gravure" ? (
                    <fieldset className="parameter-group" data-testid="gravure-parameters">
                      <legend>グラビアロール</legend>
                      <label className="parameter-label">PET 単価 (円/kg)<input inputMode="decimal" value={normalizedGravureParameters.petUnitPriceYenPerKg} onChange={(e) => setGravureParameters((old) => ({ ...old, petUnitPriceYenPerKg: e.target.value }))} /></label>
                      <label className="parameter-label">AL 単価 (円/kg)<input inputMode="decimal" value={normalizedGravureParameters.alUnitPriceYenPerKg} onChange={(e) => setGravureParameters((old) => ({ ...old, alUnitPriceYenPerKg: e.target.value }))} /></label>
                      <label className="parameter-label">LLDPE 単価 (円/kg)<input inputMode="decimal" value={normalizedGravureParameters.lldpeUnitPriceYenPerKg} onChange={(e) => setGravureParameters((old) => ({ ...old, lldpeUnitPriceYenPerKg: e.target.value }))} /></label>
                      <label className="parameter-label">印刷単価 (円/m)<input inputMode="decimal" value={normalizedGravureParameters.printingUnitPriceYenPerM} onChange={(e) => setGravureParameters((old) => ({ ...old, printingUnitPriceYenPerM: e.target.value }))} /></label>
                      <label className="parameter-label">ラミ単価 AL有 (円/m)<input inputMode="decimal" value={normalizedGravureParameters.laminationUnitPriceYenPerMWithAl} onChange={(e) => setGravureParameters((old) => ({ ...old, laminationUnitPriceYenPerMWithAl: e.target.value }))} /></label>
                      <label className="parameter-label">ラミ単価 AL無 (円/m)<input inputMode="decimal" value={normalizedGravureParameters.laminationUnitPriceYenPerMWithoutAl} onChange={(e) => setGravureParameters((old) => ({ ...old, laminationUnitPriceYenPerMWithoutAl: e.target.value }))} /></label>
                      <label className="parameter-label">新規銅版単価 (円)<input inputMode="decimal" value={normalizedGravureParameters.newCopperPlateUnitPriceYen} onChange={(e) => setGravureParameters((old) => ({ ...old, newCopperPlateUnitPriceYen: e.target.value }))} /></label>
                      <label className="parameter-label">標準納品パターン (m)<input inputMode="decimal" readOnly value={formatNumber(normalizedGravureParameters.deliverablePatternLengthM)} /></label>
                      <label className="parameter-label">標準製作ロット (m)<input inputMode="decimal" readOnly value={formatNumber(normalizedGravureParameters.productionPatternLengthM)} /></label>
                      <label className="parameter-label">小幅閾値 (mm)<input inputMode="decimal" value={normalizedGravureParameters.smallWidthThresholdMm} onChange={(e) => setGravureParameters((old) => ({ ...old, smallWidthThresholdMm: e.target.value }))} /></label>
                      <label className="parameter-label">小幅納品パターン (m)<input inputMode="decimal" value={normalizedGravureParameters.smallWidthOrderPatternLengthM} onChange={(e) => setGravureParameters((old) => ({ ...old, smallWidthOrderPatternLengthM: e.target.value }))} /></label>
                      <label className="parameter-label">小幅製作ロット (m)<input inputMode="decimal" value={normalizedGravureParameters.smallWidthProductionPatternLengthM} onChange={(e) => setGravureParameters((old) => ({ ...old, smallWidthProductionPatternLengthM: e.target.value }))} /></label>
                      <label className="parameter-label">小幅固定製造単価 (원/m)<input inputMode="decimal" value={normalizedGravureParameters.smallWidthManufacturerUnitPriceKRWPerM} onChange={(e) => setGravureParameters((old) => ({ ...old, smallWidthManufacturerUnitPriceKRWPerM: e.target.value }))} /></label>
                      <label className="parameter-label">海外配送単位 (m)<input inputMode="decimal" value={normalizedGravureParameters.overseasShippingUnitM} onChange={(e) => setGravureParameters((old) => ({ ...old, overseasShippingUnitM: e.target.value }))} /></label>
                      <label className="parameter-label">海外配送費 / 回 (円)<input inputMode="decimal" value={normalizedGravureParameters.overseasShippingPerTripYen} onChange={(e) => setGravureParameters((old) => ({ ...old, overseasShippingPerTripYen: e.target.value }))} /></label>
                      <label className="parameter-label">製造マージン率 (%)<input inputMode="decimal" value={formatNumber(Number(normalizedGravureParameters.manufacturerMarginRate) * 100, 3)} onChange={(e) => setGravureParameters((old) => ({ ...old, manufacturerMarginRate: formatNumber(Number(e.target.value) / 100, 6) }))} /></label>
                      <label className="parameter-label">관세율 (%)<input inputMode="decimal" value={formatNumber(Number(normalizedGravureParameters.customsRate) * 100, 3)} onChange={(e) => setGravureParameters((old) => ({ ...old, customsRate: formatNumber(Number(e.target.value) / 100, 6) }))} /></label>
                      <label className="parameter-label">為替 (100円=원)<input inputMode="decimal" value={normalizedGravureParameters.krwPer100Yen} onChange={(e) => setGravureParameters((old) => ({ ...old, krwPer100Yen: e.target.value }))} /></label>
                      <p className="help">初期値は100円=850원で換算しました。固定構成は PET12+AL7+PET12+LLDPE50 です。</p>
                    </fieldset>
                  ) : null}
                  {group.title === "加工・固定費" ? (
                    <div className="machine-breakdown" data-testid="machine-breakdown">
                      <p className="help">
                        機械チャージ＝(年間減価償却＋年間電気代＋年間賃借料)÷年間稼働時間で自動計算します。
                        6項目すべて設計ドキュメント6.3「機械関連」の初期値です。
                      </p>
                      {(Object.keys(MACHINE_BREAKDOWN_LABELS) as MachineBreakdownKey[]).map((key) => (
                        <label key={key} className="parameter-label">
                          {MACHINE_BREAKDOWN_LABELS[key]}
                          <input
                            className={key === "usefulLifeYears" || key === "annualOperatingHours"
                              ? (Number(machineBreakdown[key]) > 0 ? undefined : "invalid")
                              : (isNonNegativeDecimalInput(machineBreakdown[key]) ? undefined : "invalid")}
                            inputMode="decimal"
                            value={machineBreakdown[key]}
                            onChange={(event) => setMachineBreakdownField(key, event.target.value)}
                          />
                        </label>
                      ))}
                      <p className="machine-breakdown-result" data-testid="machine-charge-result">
                        機械チャージ（自動計算）＝({annualDepreciation ? formatCurrency(displayAmount(annualDepreciation.toString())) : "-"}＋{annualElectricity ? formatCurrency(displayAmount(annualElectricity.toString())) : "-"})÷{formatNumber(machineBreakdown.annualOperatingHours)}h
                        {machineChargeFromBreakdown ? <>＝<strong>{formatCurrency(displayAmount(machineChargeFromBreakdown))} /時間</strong></> : "＝-"}
                      </p>
                    </div>
                  ) : null}
                  {group.title === "フィルム" ? (
                    <div className="film-price-table" data-testid="film-price-table">
                      <div className="film-price-row head" role="row">
                        <span>価格帯 / 発注長</span>
                        <span>500m帯</span>
                        <span>1000m帯</span>
                        <span>1500m帯</span>
                      </div>
                      {(["lte570", "571to740"] as const).map((band) => (
                        <div className="film-price-row" role="row" key={band}>
                          <span>{band === "lte570" ? "570mm以下" : "571〜740mm"}</span>
                          {(["500", "1000", "1500"] as const).map((lengthBand) => (
                            <input
                              key={lengthBand}
                              aria-label={`${band === "lte570" ? "570mm以下" : "571〜740mm"} ${lengthBand}m帯 単価 (円/m)`}
                              className={isNonNegativeDecimalInput(parameters.filmUnitPrices[band][lengthBand]) ? undefined : "invalid"}
                              inputMode="decimal"
                              value={parameters.filmUnitPrices[band][lengthBand]}
                              onChange={(event) => setFilmUnitPrice(band, lengthBand, event.target.value)}
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </fieldset>
              ))}
              <button className="button secondary small" type="button" onClick={() => { setParameters(defaultParameters); setMachineBreakdown({ ...MACHINE_BREAKDOWN_DEFAULTS }); }}>初期値に戻す</button>
            </details>
          </section>
          <section className="panel" aria-labelledby="result-title">
            <p className="input-summary" data-testid="input-summary">{`${form.widthMm}×${form.lengthMm} / ${form.connected}連 / ${formatNumber(form.quantity)}枚 / SKU ${form.skuCount}件（${form.skus.map((sku, index) => `${skuDisplayName(index)} ${formatNumber(sku.quantity)}枚`).join("＋")}）`}</p>
            <div className="result-header" data-testid="server-result" data-state={staleResult ? "stale" : pending ? "calculating" : serverResult ? "calculated" : "provisional"}><h2 id="result-title">原価・利益試算</h2><span>{pending ? "計算中" : staleResult ? "再計算が必要" : serverResult ? `サーバー計算済み ${calculatedAt ?? ""}` : "入力変更中の参考計算"}</span></div>
            {!resultShown ? <div className="empty">条件を整えると暫定計算を表示します。</div> : pending ? <div className="skeleton" aria-live="polite"><div /><div style={{ width: "70%" }} /><div style={{ width: "45%" }} /></div> : (
              <>
                <p className="total-label">発注数量 {formatNumber(resultShown.quantity)} 枚 基準・1枚あたり原価</p>
                <p className="total">
                  {formatCurrency(displayAmount(resultShown.totalCostPerPiece))}<span className="help"> / 枚</span>
                  <span className="total-sub">総原価 <strong>{formatCurrency(displayAmount(resultShown.costTotal))}</strong> ／ 参考: フィルム発注 {formatNumber(resultShown.film.orderLengthM)}m で製造可能 {formatNumber(resultShown.film.actualQuantity)} 枚（余剰 ≈ {formatNumber(String(Math.max(0, Number(resultShown.film.actualQuantity) - Number(resultShown.quantity))))} 枚）</span>
                </p>
                <p className="help">{form.printingMethod === "gravure"
                  ? `グラビアは幅${formatNumber(normalizedGravureParameters.smallWidthThresholdMm)}mm以下は${formatNumber(normalizedGravureParameters.smallWidthOrderPatternLengthM)}m納品・${formatNumber(normalizedGravureParameters.smallWidthProductionPatternLengthM)}m製作、その他は5,500m納品・6,000m製作パターンで計算します。現在 ${formatNumber(resultShown.orderPatternCount ?? 1)} パターン（納品 ${formatNumber(resultShown.deliverablePatternLengthM ?? "0")}m / 製作 ${formatNumber(resultShown.film.orderLengthM)}m）です。推奨発注数量は ${formatNumber(resultShown.recommendedQuantity ?? resultShown.quantity)} 枚です。`
                  : "「単価計算用数量」は発注したフィルムから実際に作れる枚数（ロス控除後・500枚単位）です。フィルム発注を100m単位で切り上げるため、発注枚数より多くなることがあります。"}</p>
                <div className="cost-breakdown">
                  <details className="cost-block" data-testid="cost-processing">
                    <summary><h3>① 加工費（人件費・機械）</h3><span className="subtotal">{formatCurrency(displayAmount(resultShown.costComponents.variableProcessing))}<small>（{formatCurrency(displayAmount(resultShown.costPerPieceComponents.variableProcessing))} /枚）</small></span></summary>
                    <table className="table breakdown-table">
                      <thead><tr><th scope="col">項目</th><th scope="col">単価</th><th scope="col">1枚あたり</th><th scope="col">金額</th></tr></thead>
                      <tbody>
                        <tr><td>生産人件費</td><td>{formatCurrency(displayAmount(parameters.laborPerHour))} /h</td><td>生産 {formatNumber(resultShown.productionHours)}h</td><td>{formatCurrency(displayAmount(D(parameters.laborPerHour).times(resultShown.productionHours).toString()))}</td></tr>
                        <tr><td>検品人件費</td><td>{formatCurrency(displayAmount(parameters.laborPerHour))} /h</td><td>検品 {formatNumber(resultShown.inspectionHours)}h（稼働生産数 {formatNumber(resultShown.productionRunQuantity)}枚 ÷ {formatNumber(parameters.inspectionSpeed)}枚/h）</td><td>{formatCurrency(displayAmount(D(parameters.laborPerHour).times(resultShown.inspectionHours).toString()))}</td></tr>
                        <tr><td>機械費（減価償却＋電気代・稼働分）</td><td>{formatCurrency(displayAmount(parameters.machineChargePerHour))} /h</td><td>生産 {formatNumber(resultShown.productionHours)}h</td><td>{formatCurrency(displayAmount(D(parameters.machineChargePerHour).times(resultShown.productionHours).toString()))}</td></tr>
                      </tbody>
                    </table>
                    <p className="chain">実効生産速度＝基準 {formatNumber(resultShown.baseProductionSpeedPerMinute)}枚/分 × 60 ＝ {formatNumber(Number(resultShown.baseProductionSpeedPerMinute) * 60)}枚/h（1連基準）× {resultShown.lanesPerCycle}／{form.lanes}列 ＝ {formatNumber(resultShown.effectiveProductionSpeed)} 枚/h（{formatNumber(Number(resultShown.effectiveProductionSpeed) / 60)} 枚/分・{form.connected}連は1回に{resultShown.lanesPerCycle}枚）</p>
                    <p className="chain">生産時間＝稼働生産数 ÷ 実効速度 ＝ {formatNumber(resultShown.productionRunQuantity)}枚 ÷ {formatNumber(resultShown.effectiveProductionSpeed)}枚/h ＝ {formatNumber(resultShown.productionHours)}h。稼働生産数は発注 {formatNumber(resultShown.quantity)}枚 ÷ (1−ロス{formatNumber(Number(parameters.lossRate) * 100, 3)}%)＝ロス分のパウチも実際に機械へ流すための数です。</p>
                  </details>
                  <details className="cost-block" data-testid="cost-fixed">
                    <summary><h3>② 段取り・清掃費（ロット1回ごとの固定費）</h3><span className="subtotal">{formatCurrency(displayAmount(resultShown.costComponents.fixedLot))}<small>（{formatCurrency(displayAmount(resultShown.costPerPieceComponents.fixedLot))} /枚）</small></span></summary>
                    <table className="table breakdown-table">
                      <thead><tr><th scope="col">項目</th><th scope="col">時間</th><th scope="col">単価</th><th scope="col">金額</th></tr></thead>
                      <tbody>
                        <tr><td>固定人件費</td><td>{formatNumber(parameters.setupTime)}h ＋ {formatNumber(parameters.cleanupTime)}h</td><td>{formatCurrency(displayAmount(parameters.laborPerHour))} /h</td><td>{formatCurrency(displayAmount(D(parameters.laborPerHour).times(D(parameters.setupTime).plus(parameters.cleanupTime)).toString()))}</td></tr>
                        <tr><td>機械費のうち減価償却</td><td>{formatNumber(D(parameters.setupTime).plus(parameters.cleanupTime).toString())}h</td><td>{depreciationPerHour ? formatCurrency(displayAmount(depreciationPerHour.toString())) : "-"} /h</td><td>{depreciationPerHour ? formatCurrency(displayAmount(depreciationPerHour.times(D(parameters.setupTime).plus(parameters.cleanupTime)).toString())) : "-"}</td></tr>
                        <tr><td>機械費のうち電気代</td><td>{formatNumber(D(parameters.setupTime).plus(parameters.cleanupTime).toString())}h</td><td>{electricityPerHour ? formatCurrency(displayAmount(electricityPerHour.toString())) : "-"} /h</td><td>{electricityPerHour ? formatCurrency(displayAmount(electricityPerHour.times(D(parameters.setupTime).plus(parameters.cleanupTime)).toString())) : "-"}</td></tr>
                        <tr><td>合計（ロット1回）</td><td>{formatNumber(D(parameters.setupTime).plus(parameters.cleanupTime).toString())}h</td><td>—</td><td>{formatCurrency(displayAmount(resultShown.costComponents.fixedLot))}</td></tr>
                      </tbody>
                    </table>
                    <p className="chain">この費用は、ロットを始めるときの準備と終わったあとの清掃にかかる費用です。{formatNumber(D(parameters.setupTime).plus(parameters.cleanupTime).toString())}時間のあいだ、作業員の人件費がかかり、機械も占有して動くため、機械費（減価償却と電気代）も時間に比例して加算します。発注数量に関係なく、ロット1回ごとに固定で発生します。</p>
                    {resultShown ? (
                      <p className="chain" data-testid="machine-time-chain">
                        機械費は稼働時間に比例します。このロットで機械を占有する時間は、段取り・清掃 {formatNumber(D(parameters.setupTime).plus(parameters.cleanupTime).toString())}時間と生産 {formatNumber(resultShown.productionHours)}時間（稼働生産数 {formatNumber(resultShown.productionRunQuantity)}枚 ÷ 実効速度 {formatNumber(resultShown.effectiveProductionSpeed)}枚/時）を合わせた {formatNumber(Number(resultShown.productionHours) + Number(parameters.setupTime) + Number(parameters.cleanupTime))}時間です。よって機械費合計は {formatCurrency(displayAmount(D(resultShown.productionHours).plus(D(parameters.setupTime).plus(parameters.cleanupTime)).times(parameters.machineChargePerHour).toString()))} になります。生産分は①の機械費の行に、段取り・清掃分はこの表に含めています。
                      </p>
                    ) : null}
                  </details>
                  <details className="cost-block" data-testid="cost-film">
                    <summary><h3>③ フィルム費用</h3><span className="subtotal">{formatCurrency(displayAmount(resultShown.costComponents.film))}<small>（{formatCurrency(displayAmount(resultShown.costPerPieceComponents.film))} /枚）</small></span></summary>
                    <table className="table breakdown-table">
                      <thead><tr><th scope="col">項目</th><th scope="col">単価</th><th scope="col">数量</th><th scope="col">金額</th></tr></thead>
                      <tbody>
                        <tr><td>フィルム代</td><td>{formatCurrency(displayAmount(resultShown.film.unitPrice))} /m</td><td>{formatNumber(resultShown.film.orderLengthM)} m</td><td>{formatCurrency(displayAmount(form.printingMethod === "gravure" ? resultShown.film.filmTotal : resultShown.film.filmBaseCost))}</td></tr>
                        {form.printingMethod !== "gravure" ? (
                          <>
                            <tr><td>国内配送</td><td>{formatCurrency(displayAmount(parameters.domesticShippingPerTrip))} /回</td><td>{formatNumber(resultShown.film.shippingTrips)} 回</td><td>{formatCurrency(displayAmount(resultShown.film.domesticShipping))}</td></tr>
                            <tr><td>海外配送</td><td>{formatCurrency(displayAmount(parameters.overseasShippingPerTrip))} /回</td><td>{formatNumber(resultShown.film.shippingTrips)} 回</td><td>{formatCurrency(displayAmount(resultShown.film.overseasShipping))}</td></tr>
                            <tr><td>通関料</td><td>—</td><td>—</td><td>{formatCurrency(displayAmount(resultShown.film.customs))}</td></tr>
                          </>
                        ) : (
                          null
                        )}
                      </tbody>
                    </table>
                    <div className="chain-steps" data-testid="film-loss-chain">
                      {(() => {
                        const f = resultShown.film;
                        const sumRounded = f.skuCosts.reduce((total, sku) => total + Math.ceil(Number(sku.requiredLengthM) / 100) * 100, 0);
                        return (
                          <>
                            {form.printingMethod === "gravure" ? (
                              <>
                                <p>① 必要納品長は合計 {formatNumber(f.requiredLengthM)}m です。</p>
                                {resultShown.gravure?.smallWidthTier ? (
                                  <p>② パウチ幅が小幅閾値以下のため、{formatNumber(normalizedGravureParameters.smallWidthOrderPatternLengthM)}m納品・{formatNumber(normalizedGravureParameters.smallWidthProductionPatternLengthM)}m製作パターンを使います。発注パターン {formatNumber(resultShown.orderPatternCount ?? 1)} 回 → 納品可能 {formatNumber(f.effectiveLengthM)}m / 製作 {formatNumber(f.orderLengthM)}m です。</p>
                                ) : (
                                  <p>② 5,500m発注パターンへ切り上げます。発注パターン {formatNumber(resultShown.orderPatternCount ?? 1)} 回 → 納品可能 {formatNumber(f.effectiveLengthM)}m / 製作 {formatNumber(f.orderLengthM)}m です。</p>
                                )}
                                <p>③ 製作長 {formatNumber(f.orderLengthM)}m の中にロス {formatNumber(f.lossM)}m が含まれます。</p>
                                {resultShown.gravure?.smallWidthTier ? (
                                  <>
                                    <p>④ <strong>フィルム代＝小幅固定製造単価×製作長＋通関料＋海外配送費＋販売会社利益</strong>＝원{formatNumber(normalizedGravureParameters.smallWidthManufacturerUnitPriceKRWPerM)}/m×{formatNumber(f.orderLengthM)}m＋{formatCurrency(displayAmount(f.customs))}＋{formatCurrency(displayAmount(f.overseasShipping))}＋{formatCurrency(displayAmount(resultShown.sellerProfitCost))}＝{formatCurrency(displayAmount(f.filmTotal))}。銅版費は別計上します。</p>
                                    <p>⑤ 通関料＝固定製造者販売価格 {formatCurrency(displayAmount(resultShown.gravure?.customsBaseCostYen ?? "0"))} × {formatNumber(Number(normalizedGravureParameters.customsRate) * 100, 1)}%＝{formatCurrency(displayAmount(resultShown.gravure?.customsCostYen ?? "0"))}。</p>
                                  </>
                                ) : (
                                  <>
                                    <p>④ <strong>フィルム代＝原材料費＋印刷費＋ラミネート費＋製造マージン＋通関料＋海外配送費＋販売会社利益</strong>＝{formatCurrency(displayAmount((resultShown.gravure?.materialCostYen ?? "0").toString()))}＋{formatCurrency(displayAmount(resultShown.gravure?.printingCostYen ?? "0"))}＋{formatCurrency(displayAmount(resultShown.gravure?.laminationCostYen ?? "0"))}＋{formatCurrency(displayAmount(resultShown.gravure?.manufacturerMarginCostYen ?? "0"))}＋{formatCurrency(displayAmount(f.customs))}＋{formatCurrency(displayAmount(f.overseasShipping))}＋{formatCurrency(displayAmount(resultShown.sellerProfitCost))}＝{formatCurrency(displayAmount(f.filmTotal))}。銅版費は色数×銅版幅×外径で別計上します。</p>
                                    <p>⑤ 製造マージン＝フィルム製造原価 {formatCurrency(displayAmount((resultShown.gravure?.filmCostYen ?? "0").toString()))} × {formatNumber(Number(normalizedGravureParameters.manufacturerMarginRate) * 100, 1)}%＝{formatCurrency(displayAmount(resultShown.gravure?.manufacturerMarginCostYen ?? "0"))}。通関料＝製造マージン込製造者販売価格 {formatCurrency(displayAmount(resultShown.gravure?.customsBaseCostYen ?? "0"))} × {formatNumber(Number(normalizedGravureParameters.customsRate) * 100, 1)}%＝{formatCurrency(displayAmount(resultShown.gravure?.customsCostYen ?? "0"))} です。</p>
                                  </>
                                )}
                                <p>⑥ 販売会社利益＝フィルム費用基準 {formatCurrency(displayAmount(resultShown.sellerProfitBaseCost))} × {formatNumber(Number(parameters.sellerProfitRate) * 100, 1)}%＝{formatCurrency(displayAmount(resultShown.sellerProfitCost))}。この金額はフィルム費用に含めます。</p>
                                <p>⑦ 海外配送はロスを含めず、納品可能長基準で計算します。ceil(納品可能長 {formatNumber(f.effectiveLengthM)}m ÷ {formatNumber(normalizedGravureParameters.overseasShippingUnitM)}m)×{formatCurrency(displayAmount(normalizedGravureParameters.overseasShippingPerTripYen))}＝{formatNumber(f.shippingTrips)}回×{formatCurrency(displayAmount(normalizedGravureParameters.overseasShippingPerTripYen))}＝{formatCurrency(displayAmount(f.overseasShipping))}。この金額は上記のフィルムm単価に含めて表示します。</p>
                                <p>⑧ 現在入力の稼働率は {formatNumber(Number(resultShown.gravure ? D(resultShown.film.requiredLengthM).div(resultShown.deliverablePatternLengthM ?? "1").times(100) : 0), 1)}% です。80%未満では前パターンの推奨数量を表示します。</p>
                              </>
                            ) : (
                              <>
                                <p>① 必要な生産長さは合計 {formatNumber(f.requiredLengthM)}m です。計算式は「発注枚数 ÷ (1−ロス率) × ピッチ ÷ 生産列数」です。</p>
                                <p>② SKUごとに 100m単位へ切り上げます。切り上げ後の合計は {formatNumber(String(sumRounded))}m です。</p>
                                <p>③ 最低発注ルールを適用します。各SKUは {formatNumber(parameters.digitalFilmMinSkuM)}m 以上、合計は {formatNumber(parameters.digitalFilmMinTotalM)}m 以上のため、発注長さは {formatNumber(f.orderLengthM)}m{Number(f.orderLengthM) > sumRounded ? " になります（最低値を満たすまで切り上げました）" : " です（切り上げ後の長さがそのまま使えます）"}。</p>
                                <p>④ フィルムのロス {formatNumber(f.lossM)}m を差し引きます。ロスは{f.skuCosts.some((sku) => sku.multiplier === 2) ? "生産検討長さ（発注×2倍）" : "発注長さ"}の {formatNumber(Number(parameters.lossRate) * 100, 3)}% で、最低 {formatNumber(parameters.lossMinM)}m を保証します。差し引いたあとの有効長は {formatNumber(f.effectiveLengthM)}m です。</p>
                                <p>⑤ 参考として、有効なフィルム長から作れる枚数は {formatNumber(f.actualQuantity)}枚 です。計算は「有効 {formatNumber(f.effectiveLengthM)}m ÷ ピッチ × 列数」で、価格計算は500枚単位の {formatNumber(f.pricingQuantity)}枚 を使います。</p>
                                <p>⑥ <strong>見積書のフィルム単価は発注枚数基準</strong>です。計算式は「フィルム費用合計 ÷ 発注枚数 {formatNumber(resultShown.quantity)}枚」です。実際に作れる枚数との差（約{formatNumber(String(Math.max(0, Number(f.actualQuantity) - Number(resultShown.quantity))))}枚）は、発注者が負担する余剰生産分です。</p>
                                <p>⑦ 販売会社利益＝フィルム費用基準 {formatCurrency(displayAmount(resultShown.sellerProfitBaseCost))} × {formatNumber(Number(parameters.sellerProfitRate) * 100, 1)}%＝{formatCurrency(displayAmount(resultShown.sellerProfitCost))}。この金額はフィルム費用とm単価に含めます。</p>
                              </>
                            )}
                            {form.printingMethod !== "gravure" && f.skuCosts.some((sku) => sku.multiplier === 2) ? (
                              <p>⑦ 幅35mmおよびXraラウンドで必要長さが900mを超えたため、幅736mm・2倍生産へ自動的に切り替えました。この場合の生産検討長さは「発注×2倍」、送り単位は200m、価格帯は571〜740mm、ロスは検討長さの10%で計算します。</p>
                            ) : null}
                          </>
                        );
                      })()}
                    </div>
                  </details>
                  {form.printingMethod === "gravure" ? (
                    <details className="cost-block" data-testid="cost-copper">
                      <summary><h3>③-2 新規銅版費</h3><span className="subtotal">{formatCurrency(displayAmount(resultShown.costComponents.copperPlate))}<small>（{formatCurrency(displayAmount(resultShown.costPerPieceComponents.copperPlate))} /枚）</small></span></summary>
                      <table className="table breakdown-table">
                        <thead><tr><th scope="col">項目</th><th scope="col">計算</th><th scope="col">金額</th></tr></thead>
                        <tbody>
                          <tr><td>新規銅版</td><td>色数 × (原反幅+100mm) × ¥{formatNumber(normalizedGravureParameters.newCopperPlateUnitPriceYen)} × 42cm</td><td>{formatCurrency(displayAmount(resultShown.costComponents.copperPlate))}</td></tr>
                        </tbody>
                      </table>
                      <p className="chain">常に新規銅版を作成する前提です。版費はロット固定費として全発注数量に配賦します。</p>
                    </details>
                  ) : null}
                  <details className="cost-block" data-testid="cost-bulk">
                    <summary><h3>④ バルク費用（液体材料）</h3><span className="subtotal">{formatCurrency(displayAmount(resultShown.costComponents.bulk))}<small>（{formatCurrency(displayAmount(resultShown.costPerPieceComponents.bulk))} /枚）</small></span></summary>
                    <table className="table breakdown-table">
                      <thead><tr><th scope="col">項目</th><th scope="col">単価</th><th scope="col">数量</th><th scope="col">金額</th></tr></thead>
                      <tbody>
                        <tr><td>充填分（SKUごとの充填量を合計し、ロス{formatNumber(Number(parameters.bulkLossRate) * 100, 3)}%を含みます・{formatNumber(resultShown.chamberCount)}室）</td><td>{formatCurrency(displayAmount(form.bulkPrice))} /ml</td><td>{formatNumber(bulkFillMlOf(resultShown).toString())} ml</td><td>{formatCurrency(displayAmount(bulkFillMlOf(resultShown).times(form.bulkPrice).toString()))}</td></tr>
                        <tr><td>初期投入（{form.method === "hopper" ? "ホッパ" : "加圧"}）</td><td>{formatCurrency(displayAmount(form.bulkPrice))} /ml</td><td>{formatNumber(resultShown.initialChargeMl)} ml</td><td>{formatCurrency(displayAmount(D(resultShown.initialChargeMl).times(form.bulkPrice).toString()))}</td></tr>
                        <tr><td>テスト充填</td><td>{formatCurrency(displayAmount(form.bulkPrice))} /ml</td><td data-testid="test-fill">{formatNumber(resultShown.testFillMl)} ml</td><td>{formatCurrency(displayAmount(D(resultShown.testFillMl).times(form.bulkPrice).toString()))}</td></tr>
                        <tr><td>使用量合計</td><td>—</td><td data-testid="bulk-usage">{formatNumber(resultShown.bulkUsageMl)} ml</td><td>{formatCurrency(displayAmount(resultShown.costComponents.bulk))}</td></tr>
                      </tbody>
                    </table>
                  </details>
                  <details className="cost-block" data-testid="cost-custom">
                    <summary><h3>⑤ カスタム費用</h3><span className="subtotal">{formatCurrency(displayAmount(resultShown.costComponents.custom))}</span></summary>
                    <p className="chain">カスタム区分（自由なサイズ）を選択したときは、ロット1回あたり {formatCurrency(displayAmount(parameters.customPouchCharge))} を加算します。標準サイズの場合は ¥0 です。</p>
                  </details>
                </div>
                {resultShown.film.skuCosts.length > 1 ? (
                  <table className="table"><caption className="help">SKU別フィルム発注内訳</caption><thead><tr><th scope="col">SKU / 製品名</th><th scope="col">発注枚数</th><th scope="col">充填量</th><th scope="col">色数</th><th scope="col">生産</th><th scope="col">必要</th><th scope="col">発注</th><th scope="col">フィルム費</th></tr></thead><tbody>
                    {resultShown.film.skuCosts.map((sku, index) => <tr key={index}><td>{sku.skuCode}<br /><span className="help">{sku.name}</span></td><td>{sku.quantity ? `${formatNumber(sku.quantity)} 枚` : "-"}</td><td>{sku.fillMlPerChamber ? `${formatNumber(sku.fillMlPerChamber)}ml` : "-"}</td><td>{sku.colorCount || sku.colorCount === "0" ? `${formatNumber(sku.colorCount)}色` : "-"}</td><td>{sku.webWidthMm ? `${sku.webWidthMm}mm×${sku.multiplier}` : "-"}</td><td>{formatNumber(sku.requiredLengthM)}m</td><td>{formatNumber(sku.orderLengthM)}m</td><td>{formatCurrency(displayAmount(sku.filmCost))}</td></tr>)}
                  </tbody></table>
                ) : null}
                <p className="help">検算差額：{formatCurrency(resultShown.audit.componentReconciliationDifference)}（内訳合計と総原価の整合確認）</p>
                {resultShown.film.orderAdjustment !== "none" ? (
                  <p className="warning" role="status">
                    {resultShown.film.orderAdjustment === "minimum_sku_allocation"
                      ? "生産必要長が供給最低値未満のため、各SKUを最低発注長へ自動補正しました。"
                      : "合計供給最低値未満のため、最低発注長になるよう自動配分しました。"}
                  </p>
                ) : null}
                <table className="table"><caption className="help">利益率別 販売単価・売上・利益</caption><thead><tr><th scope="col">利益率</th><th scope="col">販売単価</th><th scope="col">売上計</th><th scope="col">利益額</th></tr></thead><tbody>{resultShown.sellingPrices.map((p) => <tr key={p.margin} className={Number(p.margin) === Number(effectiveMargin) ? "selected-margin" : undefined}><td>{formatNumber(Number(p.margin) * 100, 0)}%{Number(p.margin) === Number(effectiveMargin) ? "（適用中）" : ""}</td><td>{formatCurrency(displayAmount(p.pricePerPiece))}</td><td>{formatCurrency(displayAmount(p.totalSales))}</td><td>{formatCurrency(displayAmount(p.profit))}</td></tr>)}</tbody></table>
                <details className="formula-panel" data-testid="calculation-formula">
                  <summary>計算のしくみを表示</summary>
                  <div className="formula-group">
                    <h4>すべての費用に共通する値</h4>
                    <table className="table formula-vars"><tbody>
                      <tr><th scope="row">発注枚数</th><td>{formatNumber(form.quantity)} 枚</td><td>連結したあとのパウチ1個を「1枚」として数えた発注数です。</td></tr>
                      <tr><th scope="row">連結形式</th><td>{form.connected} 連</td><td>パウチ1個の中にある室（区画）の数です。室数は「発注枚数 × 連結数」で計算します。</td></tr>
                      <tr><th scope="row">充填量</th><td>SKU別設定（平均 {formatNumber(weightedAvgFill)} ml/室）</td><td>1室に入れる液体材料の量です。SKUごとに変えられます。使用量の計算には、発注枚数で重みづけした平均値を使います。</td></tr>
                      <tr><th scope="row">充填列数</th><td>{form.lanes} 列</td><td>1回に同時に充填できる列の数です。試験充填の量を計算するときにも使います。</td></tr>
                      <tr><th scope="row">テスト充填回数</th><td>{formatNumber(parameters.fillTestRuns)} 回</td><td>ロットを始める前に行う試験充填の回数です。実際の生産枚数には数えません。</td></tr>
                      <tr><th scope="row">初期投入量</th><td>{form.method === "hopper" ? formatNumber(parameters.hopperInitialChargeMl) : formatNumber(parameters.pressureInitialChargeMl)} ml</td><td>{form.method === "hopper" ? "ホッパ充填のラインに、生産前に投入しておく液体の量です。" : "加圧充填のラインに、生産前に投入しておく液体の量です。"}</td></tr>
                      <tr><th scope="row">バルクロス率</th><td>{formatNumber(Number(parameters.bulkLossRate) * 100, 3)}%</td><td>充填作業で出る液体材料のロスの割合です。</td></tr>
                      <tr><th scope="row">バルク単価</th><td>{formatCurrency(displayAmount(form.bulkPrice))} /ml</td><td>液体材料1mlあたりの仕入れ価格です。</td></tr>
                    </tbody></table>
                    <p>室数＝発注枚数×{form.connected}</p>
                    <p>テスト充填＝{formatNumber(parameters.fillTestRuns)}回×{form.lanes}列×平均充填量{formatNumber(weightedAvgFill)}ml</p>
                    <p>バルク使用量＝（すべてのSKUの充填分を合計）×(1＋{formatNumber(Number(parameters.bulkLossRate) * 100, 3)}%)＋初期投入量＋試験充填量。1SKUの充填分は「発注枚数×{form.connected}室×そのSKUの充填量」で計算します。</p>
                  </div>
                  <div className="formula-group">
                    <h4>加工費（人件費・機械）と販売価格</h4>
                    <table className="table formula-vars"><tbody>
                      <tr><th scope="row">人件費</th><td>{formatCurrency(displayAmount(parameters.laborPerHour))} /時間</td><td>生産と検品の両方にかかる人件費の単価です。それぞれの工程にかかる時間に応じて、1枚あたりに割り当てます。</td></tr>
                      <tr><th scope="row">機械チャージ</th><td>{formatCurrency(displayAmount(parameters.machineChargePerHour))} /時間</td><td>充填機を1時間動かすための単価です。年間の減価償却費と電気代を年間稼働時間で割って計算します。生産時間に応じた1枚あたりの費用と、段取り・清掃時間の固定費の両方に使います。</td></tr>
                      <tr><th scope="row">生産速度</th><td>{formatNumber(parameters.productionSpeedPerMinute)} 枚/分（1連基準・時給換算 {formatNumber(Number(parameters.productionSpeedPerMinute) * 60)} 枚/h）</td><td>1分あたりに作れる1連パウチの枚数です。60倍すると1時間あたりの枚数になり、連結形式によって実効速度が変わります。</td></tr>
                      <tr><th scope="row">稼働生産数</th><td>{resultShown ? formatNumber(resultShown.productionRunQuantity) : "-"} 枚</td><td>「発注枚数 ÷ (1−ロス率)」で計算します。ロス分のパウチも実際には機械へ流すため、生産時間はこの数で計算します。</td></tr>
                      <tr><th scope="row">実効生産速度</th><td>{resultShown ? `${formatNumber(Number(resultShown.effectiveProductionSpeed) / 60)} 枚/分（${formatNumber(resultShown.effectiveProductionSpeed)} 枚/h）` : "-"}</td><td>{form.lanes}列÷{form.connected}連＝1回に{lanesPerCycle}枚作れるため、「基準速度×{lanesPerCycle}／{form.lanes}」で計算します。{form.connected}連は、1個を充填するために必要な室数ぶん列を占有します。</td></tr>
                      <tr><th scope="row">検品速度</th><td>{formatNumber(parameters.inspectionSpeed)} 枚/h</td><td>検品にかかる人件費を1枚あたりに割り当てるときの分母です。</td></tr>
                      <tr><th scope="row">段取り・清掃時間</th><td>{formatNumber(parameters.setupTime)}h ＋ {formatNumber(parameters.cleanupTime)}h</td><td>ロット開始前の準備と、終了後の清掃にかかる時間です。発注数量に関係なく、ロットごとに固定で発生します。</td></tr>
                      <tr><th scope="row">カスタム費用</th><td>{formatCurrency(displayAmount(parameters.customPouchCharge))}</td><td>カスタム区分を選択したときに、ロット1回だけ加算する費用です。</td></tr>
                      <tr><th scope="row">販売会社利益率</th><td>{formatNumber(Number(parameters.sellerProfitRate) * 100, 1)}%</td><td>フィルム費用に対して加算し、Seven化学向けの取得原価に含めます。</td></tr>
                    </tbody></table>
                    <p>① 年間減価償却費＝設備取得価額÷耐用年数＝{formatCurrency(displayAmount(machineBreakdown.acquisitionCostYen))}÷{formatNumber(machineBreakdown.usefulLifeYears)}年＝{annualDepreciation ? formatCurrency(displayAmount(annualDepreciation.toString())) : "-"} /年（定額法・残存価額0）</p>
                    <p>② 年間電気代＝年間使用電力量×電力単価＝{formatNumber(machineBreakdown.annualElectricityKwh)}kWh×{formatNumber(machineBreakdown.electricityUnitPriceYen)}円/kWh＝{annualElectricity ? formatCurrency(displayAmount(annualElectricity.toString())) : "-"} /年（月{annualElectricity ? formatCurrency(displayAmount(annualElectricity.div(12).toString())) : "-"}）</p>
                    <p>機械チャージ＝(①＋②)÷年間稼働時間＝({annualDepreciation ? formatCurrency(displayAmount(annualDepreciation.toString())) : "-"}＋{annualElectricity ? formatCurrency(displayAmount(annualElectricity.toString())) : "-"})÷{formatNumber(machineBreakdown.annualOperatingHours)}h/年＝<strong>{formatCurrency(displayAmount(parameters.machineChargePerHour))} /時間</strong></p>
                    <p>初期値は「設備取得価額2,500万円・耐用年数7年・年間使用電力量10,800kWh×電力単価32円・年間稼働時間1,800時間」です。月額賃借料74,100円/月はこの計算には含めません。金額は「計算パラメータ調整＞加工・固定費＞機械チャージ内訳」で変更でき、変更すると機械チャージと原価へ自動的に反映されます。</p>
                    <p>生産時間＝稼働生産数÷実効速度＝{resultShown ? formatNumber(resultShown.productionRunQuantity) : "-"}枚÷{formatNumber(resultShown ? Number(resultShown.effectiveProductionSpeed) : 0)}枚/h＝{resultShown ? formatNumber(resultShown.productionHours) : "-"}h（検品時間＝稼働生産数{formatNumber(resultShown ? resultShown.productionRunQuantity : "-")}枚÷{formatNumber(parameters.inspectionSpeed)}枚/h＝{resultShown ? formatNumber(resultShown.inspectionHours) : "-"}h）</p>
                    <p>変動加工費＝人件費×(生産時間＋検品時間)＋機械チャージ×生産時間＝{formatNumber(parameters.laborPerHour)}×({resultShown ? formatNumber(resultShown.productionHours) : "-"}＋{resultShown ? formatNumber(resultShown.inspectionHours) : "-"})h＋{formatNumber(parameters.machineChargePerHour)}×{resultShown ? formatNumber(resultShown.productionHours) : "-"}h</p>
                    <p>ロット固定＝({formatNumber(parameters.setupTime)}＋{formatNumber(parameters.cleanupTime)})h×({formatNumber(parameters.laborPerHour)}＋{formatNumber(parameters.machineChargePerHour)})円/h</p>
                    <p>カスタム費用＝{form.custom ? formatCurrency(displayAmount(parameters.customPouchCharge)) : "0"}（カスタム区分時のみ）</p>
                    <p>販売会社利益＝フィルム費用 {formatCurrency(displayAmount(resultShown.sellerProfitBaseCost))} × {formatNumber(Number(parameters.sellerProfitRate) * 100, 1)}%＝{formatCurrency(displayAmount(resultShown.sellerProfitCost))}（フィルム費用に含む）。</p>
                    <p>総原価＝フィルム＋バルク＋変動加工＋ロット固定</p>
                    <p>販売単価＝総原価/枚÷(1−利益率)</p>
                  </div>
                  <div className="formula-group">
                    <h4>フィルム費用</h4>
                    <table className="table formula-vars"><tbody>
                      <tr><th scope="row">原反幅</th><td>{effectiveSize.webWidthMm} mm</td><td>{form.custom ? "カスタムの左右幅から、1列あたりのフィルム原反幅を自動で求めます。" : "サイズマスタに登録された確定値です。"}</td></tr>
                      <tr><th scope="row">価格帯</th><td>{effectiveSize.priceBand === "lte570" ? "570mm以下" : "571〜740mm"}</td><td>原反幅で判定します。単価は「計算パラメータ調整＞価格帯別フィルム単価」で確認・変更できます。</td></tr>
                      <tr><th scope="row">適用m単価</th><td>{formatCurrency(displayAmount(resultShown.film.unitPrice))} /m</td><td>発注長さ（500m・1000m・1500mの帯）と価格帯から決まります。</td></tr>
                      <tr><th scope="row">ピッチ加算</th><td>{formatNumber(effectiveSize.pitchAddMm)} mm</td><td>製品の長さに加えるシールや運送のための余白です。ピッチ＝製品長さ＋ピッチ加算です。</td></tr>
                      <tr><th scope="row">生産列数</th><td>{effectiveSize.lanes} 列</td><td>フィルム原反を何列並べて生産するかを表します。サイズマスタに登録された確定値です。</td></tr>
                      <tr><th scope="row">フィルムロス率</th><td>{formatNumber(Number(parameters.lossRate) * 100, 3)}%</td><td>印刷や搬送で出るフィルムロスの割合です。発注長さに対して計算します。</td></tr>
                      <tr><th scope="row">最小ロス</th><td>{formatNumber(parameters.lossMinM)} m</td><td>ロス率によらず、必ず確保する最低のロス長です。</td></tr>
                      <tr><th scope="row">SKU最低発注</th><td>各SKU≥{formatNumber(parameters.digitalFilmMinSkuM)}m／合計≥{formatNumber(parameters.digitalFilmMinTotalM)}m</td><td>この長さに満たない場合は、最低発注長へ自動的に修正します。</td></tr>
                      <tr><th scope="row">国内・海外配送</th><td>{formatCurrency(displayAmount(parameters.domesticShippingPerTrip))} ＋ {formatCurrency(displayAmount(parameters.overseasShippingPerTrip))} /回</td><td>配送単位（{shippingUnitLabel(effectiveSize.webWidthMm, parameters)}m/回）ごとに回数を切り上げて、費用に含めます。</td></tr>
                      <tr><th scope="row">通関料</th><td>{formatCurrency(displayAmount(parameters.customsPerTrip))} /回</td><td>フィルム費が{formatCurrency(displayAmount(parameters.customsThreshold))}を超える場合は、回数に関係なく一括{formatCurrency(displayAmount(parameters.customsHighCharge))}を適用します。</td></tr>
                    </tbody></table>
                    <p>必要生産長さ＝発注枚数÷(1−{formatNumber(Number(parameters.lossRate) * 100, 3)}%)×({form.lengthMm}＋{formatNumber(effectiveSize.pitchAddMm)}mm)÷1000÷{effectiveSize.lanes}列</p>
                    <p>SKU別必要長さ＝各SKUの発注枚数÷(1−{formatNumber(Number(parameters.lossRate) * 100, 3)}%)×ピッチ÷1000÷{effectiveSize.lanes}列。SKU別に100m切上げ、各SKU≥{formatNumber(parameters.digitalFilmMinSkuM)}m・合計≥{formatNumber(parameters.digitalFilmMinTotalM)}m</p>
                    <p>SKU別フィルム費＝発注長さ×{formatCurrency(displayAmount(resultShown.film.unitPrice))}/m</p>
                    <p>配送回数＝ceil(必要生産長さ×{effectiveSize.prodMultiplier}÷{shippingUnitLabel(effectiveSize.webWidthMm, parameters)}m)</p>
                    <p>フィルム総額＝SKUフィルム費合計＋国内配送＋海外配送＋通関料</p>
                  </div>
                  <p className="help">表示は小数第2位四捨五入、内部計算はDecimal精度を維持します。</p>
                </details>
              </>
            )}
          </section>
          <section className="panel" aria-labelledby="validation-title">
            <h2 id="validation-title">検証・出力プレビュー</h2>
            <div className={issuanceBlocker ? "blocker" : "warning"} role={issuanceBlocker ? "alert" : "status"}>
              <strong>{issuanceBlocker ? "確定見積不可" : "参考計算（未確認項目あり）"}</strong>
              <ul>{issuanceBlocker ? blockers() : warningCodes().map((code) => <li key={code}>{warningLabels[code]}</li>)}</ul>
            </div>
            <div className={staleResult ? "quote-sheet provisional-quote stale-result" : "quote-sheet provisional-quote"}>
              <h3>お見積書（プレビュー）</h3>
              <p className="quote-gate" data-testid="quote-gate">参考見積・色数別単価は参考入力（印刷色数とは未連動）・仕入先確認待ち / 税・切上げ規則未確定のため発行・確定不可</p>
              <p className="help">宛先・発行日・有効期限はSeven書式確定後に設定します。</p>
              <dl><div><dt>品名</dt><dd>パウチ製品</dd></div><div><dt>数量</dt><dd>{formatNumber(form.quantity)} 枚</dd></div><div><dt>適用利益率</dt><dd>{formatNumber(Number(effectiveMargin) * 100, 3)}%（参考値）</dd></div><div><dt>単価</dt><dd>{customerPrice ? formatCurrency(customerPrice.pricePerPiece) : "-"}</dd></div></dl>
              <div className="quote-total"><span>参考税抜金額</span><span data-testid="customer-total">{customerPrice ? formatCurrency(displayAmount(customerPrice.totalSales)) : "-"}</span></div>
            </div>
            <button className="button" type="submit" data-testid="calculate-desktop" disabled={blocker || pending}>{pending ? "計算中..." : "サーバーで再計算する"}</button>
            <div className="action-note"><strong>サーバー計算済み</strong>は参照計算を意味し、見積確定ではありません。</div>
          </section>
          <div className="mobile-actions" data-testid="mobile-actions">
            <button className="button" type="submit" disabled={blocker || pending}>{pending ? "計算中..." : "サーバーで再計算する"}</button>
          </div>
        </form>
      </div>
    </main>
  );

  function blockers() {
    const items = [...(positive ? [] : ["正の数値を入力してください"])];
    if (!marginValid) items.push("利益率は0〜100%の間で入力してください");
    if (dimensionMismatch) items.push("標準サイズ寸法不一致");
    if (!skuInputsReady) items.push("SKU数は1以上の整数で入力してください");
    if (!skuQuantitiesValid) items.push("SKU別発注枚数の合計を発注数量に合わせてください");
    return items.map((item, i) => <li key={i}>{item}</li>);
  }
  function warningCodes() { return displayed?.warnings ?? ["seven_template_unconfirmed", "tax_rounding_unconfirmed", "digital_color_price_not_applied"]; }
}

function bulkFillMlOf(result: ReturnType<typeof calculatePouchCost>) { return D(result.bulkUsageMl).minus(result.initialChargeMl).minus(result.testFillMl); }
function redistributeSkuQuantities(total: string, count: number): string[] {
  const totalNumber = Number(total);
  if (!Number.isInteger(totalNumber) || totalNumber <= 0 || count <= 0) return [];
  const base = Math.floor(totalNumber / count);
  const remainder = totalNumber - base * count;
  return Array.from({ length: count }, (_, index) => String(base + (index < remainder ? 1 : 0)));
}

interface SkuEntry { name: string; quantity: string; fillMl: string; colorCount: string; }

function redistributeSkus(skus: SkuEntry[], total: string): SkuEntry[] {
  const quantities = redistributeSkuQuantities(total, skus.length);
  if (quantities.length === 0) return skus;
  return skus.map((sku, index) => ({ ...sku, quantity: quantities[index] }));
}

function resizeSkus(form: { skus: SkuEntry[]; quantity: string }, count: number): SkuEntry[] {
  if (count <= 0) return [];
  const quantities = redistributeSkuQuantities(form.quantity, count);
  const template = form.skus[0];
  return Array.from({ length: count }, (_, index) => form.skus[index] ?? {
    name: "",
    quantity: quantities[index] ?? template?.quantity ?? "",
    fillMl: template?.fillMl ?? "3",
    colorCount: template?.colorCount ?? "4",
  }).map((sku, index2) => ({ ...sku, quantity: quantities[index2] ?? sku.quantity }));
}
function isNumericInput(value: string) { return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)); }
function normalizeGravureParameters(value?: Partial<GravureRollParameters> | null): GravureRollParameters {
  const defaults = defaultGravureRollParameters();
  return (Object.keys(defaults) as (keyof GravureRollParameters)[]).reduce<GravureRollParameters>((normalized, key) => {
    const candidate = value?.[key];
    normalized[key] = typeof candidate === "string" ? candidate : defaults[key];
    return normalized;
  }, { ...defaults });
}
function machineBreakdownBasisValid(basis: Record<MachineBreakdownKey, string>) {
  return Object.entries(basis).every(([key, value]) => isNumericInput(value) && (key === "usefulLifeYears" || key === "annualOperatingHours" ? Number(value) > 0 : Number(value) >= 0));
}
function machineChargeFromBasisValues(basis: Record<MachineBreakdownKey, string>) {
  const annualDepreciation = D(basis.acquisitionCostYen).div(basis.usefulLifeYears);
  const annualElectricity = D(basis.annualElectricityKwh).times(basis.electricityUnitPriceYen);
  return annualDepreciation.plus(annualElectricity).div(basis.annualOperatingHours).toString();
}
function isPositiveDecimalInput(value: string) { return isNumericInput(value) && Number(value) > 0; }
function positiveDecimal(value: string) { return isPositiveDecimalInput(value); }
function isNonNegativeDecimalInput(value: string) { return isNumericInput(value) && Number(value) >= 0; }
function shippingUnitLabel(webWidthMm: number, parameters: CostParameters) { return shippingUnitForWidth(webWidthMm, parameters); }
function positiveParameters(parameters: CostParameters) {
  return positiveDecimal(parameters.lossRate) && Number(parameters.lossRate) < 1
    && positiveDecimal(parameters.lossMinM) && positiveDecimal(parameters.digitalFilmMinSkuM) && positiveDecimal(parameters.digitalFilmMinTotalM)
    && positiveDecimal(parameters.domesticShippingPerTrip) && positiveDecimal(parameters.overseasShippingPerTrip)
    && positiveDecimal(parameters.customsThreshold) && positiveDecimal(parameters.customsHighCharge) && positiveDecimal(parameters.customsPerTrip)
    && isNonNegativeDecimalInput(parameters.bulkLossRate) && Number(parameters.bulkLossRate) < 1 && positiveDecimal(parameters.fillTestRuns)
    && positiveDecimal(parameters.hopperInitialChargeMl) && positiveDecimal(parameters.pressureInitialChargeMl)
    && positiveDecimal(parameters.laborPerHour) && positiveDecimal(parameters.machineChargePerHour) && positiveDecimal(parameters.productionSpeedPerMinute) && positiveDecimal(parameters.inspectionSpeed)
    && positiveDecimal(parameters.setupTime) && positiveDecimal(parameters.cleanupTime) && positiveDecimal(parameters.customPouchCharge)
    && isNonNegativeDecimalInput(parameters.sellerProfitRate) && Number(parameters.sellerProfitRate) < 1
    && Object.values(parameters.filmUnitPrices).every((lengthPrices) => Object.values(lengthPrices).every(positiveDecimal));
}
function positiveGravureParameters(parameters: GravureRollParameters) {
  const nonNegative = (value: string) => isNumericInput(value) && Number(value) >= 0;
  const positive = (value: string) => isPositiveDecimalInput(value);
  return nonNegative(parameters.petUnitPriceYenPerKg)
    && nonNegative(parameters.alUnitPriceYenPerKg)
    && nonNegative(parameters.lldpeUnitPriceYenPerKg)
    && nonNegative(parameters.printingUnitPriceYenPerM)
    && nonNegative(parameters.laminationUnitPriceYenPerMWithAl)
    && nonNegative(parameters.laminationUnitPriceYenPerMWithoutAl)
    && nonNegative(parameters.newCopperPlateUnitPriceYen)
    && positive(parameters.copperPlateWidthExtraMm)
    && positive(parameters.copperPlateMinimumDiameterMm)
    && positive(parameters.deliverablePatternLengthM)
    && positive(parameters.productionPatternLengthM)
    && positive(parameters.overseasShippingUnitM)
    && nonNegative(parameters.overseasShippingPerTripYen)
    && nonNegative(parameters.manufacturerMarginRate) && Number(parameters.manufacturerMarginRate) < 1
    && nonNegative(parameters.customsRate)
    && positive(parameters.smallWidthThresholdMm)
    && positive(parameters.smallWidthOrderPatternLengthM)
    && positive(parameters.smallWidthProductionPatternLengthM)
    && nonNegative(parameters.smallWidthManufacturerUnitPriceKRWPerM)
    && positive(parameters.krwPer100Yen);
}
function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) { return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}</div>; }
declare global { interface Window { dispatchDebugError?: (message: string) => void; } }
