"use client";

import { useCallback, useMemo, useState } from "react";
import { calculatePouchCost } from "@/lib/calculation";
import { validateDigitalFilmOrder } from "@/lib/digital-film";
import { defaultParameters, sizeMaster } from "@/lib/constants";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import type { PouchSpec, PrintingMethod, QuotationStatus, SizeKey } from "@/lib/types";

const warningLabels: Record<string, string> = {
  seven_template_unconfirmed: "Seven書式は未確認です",
  tax_rounding_unconfirmed: "税区分・端数処理は未確認です",
  digital_color_price_not_applied: "色数別価格 未適用",
  custom_size_mapping_unconfirmed: "カスタム寸法の変換ルールは未設定です",
  filling_lanes_differ_from_film_lanes: "充填列数とフィルム生産列数が一致しません",
};

export default function QuotationPage() {
  const [form, setForm] = useState({
    sizeKey: "mouthwash-45x145" as SizeKey,
    custom: false,
    widthMm: "45",
    lengthMm: "145",
    fillMl: "30",
    quantity: "10000",
    connected: "1" as "1" | "2" | "3" | "4",
    method: "hopper" as "hopper" | "pressure",
    lanes: "4",
    colorCount: "4",
    bulkPrice: "0.37",
    sku1: "500",
    sku2: "",
    status: "draft" as QuotationStatus,
  });
  const [result, setResult] = useState<ReturnType<typeof calculatePouchCost> | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((old) => ({ ...old, [key]: value }));

  const skuLengths = useMemo(() => [form.sku1, form.sku2].filter((value) => value.trim() !== ""), [form.sku1, form.sku2]);
  const skuValidation = useMemo(() => validateDigitalFilmOrder(
    skuLengths.map((requiredLengthM, index) => ({ skuCode: `SKU-${index + 1}`, requiredLengthM })),
    defaultParameters,
  ), [skuLengths]);
  const standardSize = sizeMaster[form.sizeKey];
  const dimensionMismatch = !form.custom && (form.widthMm !== standardSize.widthMm || form.lengthMm !== standardSize.lengthMm);
  const positive = Number(form.fillMl) > 0 && Number(form.quantity) > 0 && Number(form.lanes) > 0 && Number(form.colorCount) > 0 && Number(form.bulkPrice) > 0;
  const blocker = !skuValidation.valid || form.custom || dimensionMismatch || !positive;

  const spec = useCallback((quantity: string): PouchSpec => ({
    sizeKey: form.sizeKey,
    customWidthMm: form.widthMm,
    customLengthMm: form.lengthMm,
    fillMlPerChamber: form.fillMl,
    connectedChambers: Number(form.connected) as 1 | 2 | 3 | 4,
    fillingMethod: form.method,
    fillingLanes: Number(form.lanes),
    isCustom: form.custom,
    colorCount: Number(form.colorCount),
    bulkUnitPrice: form.bulkPrice,
    skuRequiredLengthsM: skuLengths,
  }), [form, skuLengths]);

  const provisionalResult = useMemo(() => {
    if (blocker) return null;
    try { return calculatePouchCost({ spec: spec(form.quantity), quantity: form.quantity, printingMethod: "digital" }); } catch { return null; }
  }, [blocker, spec, form.quantity]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (blocker) return;
    setPending(true);
    setResult(null);
    try {
      const response = await fetch("/api/calculate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spec: spec(form.quantity), quantity: form.quantity, printingMethod: "digital" as PrintingMethod }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "calculation_failed");
      setResult(payload.result);
    } catch (error) {
      setResult(provisionalResult);
      window.dispatchDebugError?.(error instanceof Error ? error.message : "calculation_failed");
    } finally { setPending(false); }
  };

  const displayed = result ?? provisionalResult;
  const commission = displayed ? approvedCommission(displayed.sellingPrices[1].totalSales, form.status) : null;
  const customerPrice = displayed?.sellingPrices[1];

  return (
    <main>
      <div className="app-shell">
        <header className="app-header">
          <div><h1>パウチ見積計算</h1><p>販売数量は連結後パウチ「枚」、充填は区画「室」で計算します。</p></div>
          <span className="version-badge">Decimal計算コア 2026-09.1</span>
        </header>
        <form onSubmit={submit} className="layout" noValidate data-testid="quotation-form">
          <section className="panel" aria-labelledby="input-title">
            <h2 id="input-title">見積条件</h2>
            <Field label="サイズ" htmlFor="size"><select id="size" value={form.sizeKey} onChange={(e) => { const key = e.target.value as SizeKey; const s = sizeMaster[key]; setForm((old) => ({ ...old, sizeKey: key, widthMm: s.widthMm, lengthMm: s.lengthMm })); }}>{Object.values(sizeMaster).map((size) => <option key={size.key} value={size.key}>{size.label}</option>)}</select></Field>
            <div className="field"><label htmlFor="custom"><input id="custom" type="checkbox" checked={form.custom} onChange={(e) => set("custom", e.target.checked)} /> カスタム区分</label>{form.custom ? <p className="error" id="custom-error">列数・原反幅・価格帯の変換ルール未設定のため確定見積禁止です。</p> : null}</div>
            <div className="field-row">
              <Field label="左右幅 (mm)" htmlFor="width"><input id="width" inputMode="decimal" aria-describedby={dimensionMismatch ? "dimension-error" : undefined} value={form.widthMm} onChange={(e) => set("widthMm", e.target.value)} /></Field>
              <Field label="長さ (mm)" htmlFor="length"><input id="length" inputMode="decimal" value={form.lengthMm} onChange={(e) => set("lengthMm", e.target.value)} /></Field>
            </div>
            {dimensionMismatch ? <p className="error" id="dimension-error" role="alert">標準サイズの寸法と一致しません。カスタム区分を使用してください。</p> : null}
            <div className="field-row">
              <Field label="充填量 (ml/室)" htmlFor="fill"><input id="fill" inputMode="decimal" value={form.fillMl} onChange={(e) => set("fillMl", e.target.value)} /></Field>
              <Field label="発注数量 (枚)" htmlFor="quantity"><input id="quantity" inputMode="numeric" value={form.quantity} onChange={(e) => set("quantity", e.target.value)} /></Field>
            </div>
            <fieldset className="field" id="connected"><legend>連結形式</legend><div className="radio-cards">{(["1", "2", "3", "4"] as const).map((value) => <label key={value}><input type="radio" name="connected" value={value} checked={form.connected === value} onChange={() => set("connected", value)} aria-label={`${value}連`} />{value}連</label>)}</div><p className="help" data-testid="total-fill">1枚あたり総充填量＝{formatNumber(Number(form.fillMl) * Number(form.connected), 3)} ml</p></fieldset>
            <Field label="充填方式" htmlFor="method"><select id="method" value={form.method} onChange={(e) => set("method", e.target.value as "hopper" | "pressure")}><option value="hopper">ホッパ充填（初期2,000ml）</option><option value="pressure">加圧充填（初期8,000ml）</option></select></Field>
            <div className="field-row">
              <Field label="充填列数 (列)" htmlFor="lanes"><input id="lanes" inputMode="numeric" value={form.lanes} onChange={(e) => set("lanes", e.target.value)} /></Field>
              <Field label="印刷色数" htmlFor="colors"><input id="colors" inputMode="numeric" value={form.colorCount} onChange={(e) => set("colorCount", e.target.value)} /></Field>
            </div>
            <Field label="バルク単価 (円/ml)" htmlFor="bulk"><input id="bulk" inputMode="decimal" value={form.bulkPrice} onChange={(e) => set("bulkPrice", e.target.value)} /></Field>
            <div className="field"><label>SKU別必要長さ (m)</label><div className="sku-list">
              <div className="sku-row"><input id="sku1" aria-label="SKU1必要長さ (m)" inputMode="decimal" value={form.sku1} onChange={(e) => set("sku1", e.target.value)} />{skuValidation.orderLengths[0] ? <span className="help">発注{skuValidation.orderLengths[0].orderLengthM}m</span> : null}</div>
              <div className="sku-row"><input id="sku2" aria-label="SKU2必要長さ (m)" inputMode="decimal" value={form.sku2} onChange={(e) => set("sku2", e.target.value)} />{skuValidation.orderLengths[1] ? <span className="help">発注{skuValidation.orderLengths[1].orderLengthM}m</span> : null}</div>
            </div><p className="help">100m単位切上げ、合計{skuValidation.totalM}m（最低500m・各SKU300m）</p></div>
          </section>
          <section className="panel" aria-labelledby="result-title">
            <div className="result-header"><h2 id="result-title">原価・利益試算</h2><span>{pending ? "計算中" : result ? "サーバー確定" : "暫定計算"}</span></div>
            {!displayed ? <div className="empty">条件を整えると暫定計算を表示します。</div> : pending ? <div className="skeleton" aria-live="polite"><div /><div style={{ width: "70%" }} /><div style={{ width: "45%" }} /></div> : (
              <>
                <p className="total">{formatCurrency(displayed.totalCostPerPiece)}<span className="help"> / 枚</span></p>
                <dl><div><dt>総原価</dt><dd>{formatCurrency(displayed.costTotal)}</dd></div><div><dt>充填対象</dt><dd>{formatNumber(displayed.chamberCount)} 室</dd></div><div><dt>バルク使用量</dt><dd data-testid="bulk-usage">{formatNumber(displayed.bulkUsageMl)} ml</dd></div></dl>
                <div className="cards">{Object.entries(displayed.costComponents).map(([key, value]) => <div className="metric" key={key}><span>{componentLabel(key)}</span><strong>{formatCurrency(value)}</strong></div>)}</div>
                <table className="table"><caption className="help">単価計算用数量・フィルム内訳</caption><tbody>
                  <tr><th scope="row">単価計算用数量</th><td>{formatNumber(displayed.film.pricingQuantity)} 枚</td></tr>
                  <tr><th scope="row">フィルム発注</th><td>{formatNumber(displayed.film.orderLengthM)} m</td></tr>
                  <tr><th scope="row">フィルムm単価</th><td>{formatCurrency(displayed.film.unitPrice)}</td></tr>
                  <tr><th scope="row">検算差額</th><td>{formatCurrency(displayed.audit.componentReconciliationDifference)}</td></tr>
                </tbody></table>
                <table className="table"><caption className="help">利益率別販売単価</caption><thead><tr><th scope="col">利益率</th><th scope="col">単価</th><th scope="col">売上</th></tr></thead><tbody>{displayed.sellingPrices.map((p) => <tr key={p.margin}><td>{formatNumber(Number(p.margin) * 100, 0)}%</td><td>{formatCurrency(p.pricePerPiece)}</td><td>{formatCurrency(p.totalSales)}</td></tr>)}</tbody></table>
              </>
            )}
          </section>
          <section className="panel" aria-labelledby="validation-title">
            <h2 id="validation-title">検証・出力プレビュー</h2>
            <div className={blocker ? "blocker" : "warning"} role={blocker ? "alert" : "status"}>
              <strong>{blocker ? "確定見積不可" : "暫定計算（未確認項目あり）"}</strong>
              <ul>{blocker ? blockers() : warningCodes().map((code) => <li key={code}>{warningLabels[code]}</li>)}</ul>
            </div>
            {skuValidation.corrections.length ? <div className="blocker"><strong>デジタル発注修正案</strong><ul>{skuValidation.corrections.map((c, i) => <li key={i}>{c.message}：{c.suggestedLengthsM.join("m / ")}m</li>)}</ul></div> : null}
            <div className="quote-sheet">
              <h3>お見積書（プレビュー）</h3>
              <p className="help">宛先・発行日・有効期限はSeven書式確定後に設定します。</p>
              <dl><div><dt>品名</dt><dd>パウチ製品</dd></div><div><dt>数量</dt><dd>{formatNumber(form.quantity)} 枚</dd></div><div><dt>単価</dt><dd>{customerPrice ? formatCurrency(customerPrice.pricePerPiece) : "-"}</dd></div></dl>
              <div className="quote-total"><span>税抜金額</span><span data-testid="customer-total">{customerPrice ? formatCurrency(customerPrice.totalSales) : "-"}</span></div>
            </div>
            <button className="button" type="submit" disabled={blocker || pending}>{pending ? "計算中..." : "計算して確定"}</button>
            <p className="help">デジタル最小発注・原価構成・Decimal検算を通過するまで確定できません。</p>
          </section>
        </form>
      </div>
    </main>
  );

  function blockers() {
    const items = [...(positive ? [] : ["正の数値を入力してください"])];
    if (form.custom) items.push("カスタム寸法変換ルール未設定");
    if (dimensionMismatch) items.push("標準サイズ寸法不一致");
    if (!skuValidation.valid) items.push(skuValidation.reason === "total_min" ? `合計${skuValidation.totalM}mが500m未満` : `SKU ${skuValidation.shortSkus?.join(", ")}が300m未満`);
    return items.map((item, i) => <li key={i}>{item}</li>);
  }
  function warningCodes() { return displayed?.warnings ?? ["seven_template_unconfirmed", "tax_rounding_unconfirmed", "digital_color_price_not_applied"]; }
}

function componentLabel(key: string) { return ({ film: "フィルム", bulk: "バルク", variableProcessing: "変動加工", fixedLot: "ロット固定", custom: "カスタム" } as Record<string, string>)[key] ?? key; }
function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) { return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}</div>; }
function approvedCommission(amount: string, status: QuotationStatus) { return { status, amount: status === "approved" ? String(Number(amount) * 0.2) : null }; }
declare global { interface Window { dispatchDebugError?: (message: string) => void; } }
