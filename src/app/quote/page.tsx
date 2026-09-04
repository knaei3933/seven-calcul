"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { D } from "@/lib/decimal";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import {
  QUOTATION_DRAFT_KEY,
  parseQuotationDraft,
  sevenChemical,
  type QuotationDraft,
} from "@/lib/quotation-draft";
import { QUOTATION_RESTORE_KEY } from "@/lib/quotation-shared";

type QuoteForm = {
  quotationNumber: string;
  issueDate: string;
  validUntil: string;
  customerName: string;
  customerContact: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  fillingCostPerPiece: string;
  filmCostPerPiece: string;
  filmMeterPrice: string;
  filmOrderLengthM: string;
  targetMargin: string;
  taxRatePercent: string;
  deliveryDate: string;
  paymentTerms: string;
  notes: string;
};

const defaultQuote: QuoteForm = {
  quotationNumber: "",
  issueDate: "",
  validUntil: "",
  customerName: "",
  customerContact: "",
  productName: "パウチ製品",
  sizeSummary: "50×60mm / 1連",
  quantity: "10000",
  fillingCostPerPiece: "0",
  filmCostPerPiece: "0",
  filmMeterPrice: "0",
  filmOrderLengthM: "0",
  targetMargin: "0.4",
  taxRatePercent: "10",
  deliveryDate: "ご注文後の別途ご相談",
  paymentTerms: "御見積時にお相談いたします",
  notes: "上記金額には充填・加工費とフィルム費用を含みます。仕様変更時は再度お見積りいたします。",
};

function isPositiveNumber(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export default function PrintableQuotationPage() {
  const router = useRouter();
  const [form, setForm] = useState<QuoteForm>(defaultQuote);
  const [sourceVersion, setSourceVersion] = useState("");
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    try {
      const restoreRaw = sessionStorage.getItem(QUOTATION_RESTORE_KEY);
      if (restoreRaw) {
        const restored = JSON.parse(restoreRaw) as Partial<QuoteForm> & { resultHash?: unknown };
        const restoredForm = { ...defaultQuote };
        (Object.keys(defaultQuote) as (keyof QuoteForm)[]).forEach((key) => {
          const value = restored[key];
          if (typeof value === "string") restoredForm[key] = value;
        });
        // eslint-disable-next-line react-hooks/set-state-in-effect -- 履歴復元はSSR後にしか読めないsessionStorage値を反映する意図的な初期化です。
        setForm(restoredForm);
        setSourceVersion(typeof restored.resultHash === "string" ? restored.resultHash : "");
        sessionStorage.removeItem(QUOTATION_RESTORE_KEY);
        setStorageLoaded(true);
        return;
      }

      const raw = sessionStorage.getItem(QUOTATION_DRAFT_KEY);
      const draft = parseQuotationDraft(JSON.parse(raw ?? "null"));
      if (draft) {
        setForm((old) => ({
          ...old,
          productName: draft.productSummary,
          sizeSummary: draft.sizeSummary,
          quantity: draft.quantity,
          fillingCostPerPiece: draft.fillingCostPerPiece,
          filmCostPerPiece: draft.filmCostPerPiece,
          filmMeterPrice: draft.filmMeterPrice,
          filmOrderLengthM: draft.filmOrderLengthM,
          targetMargin: draft.targetMargin,
        }));
        setSourceVersion(draft.resultHash);
      }
    } catch {
      // 편집 값은 유지하고 기본 견적서를 표시한다.
    }

    const now = new Date();
    const valid = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    setForm((old) => ({
      ...old,
      issueDate: old.issueDate || isoDate(now),
      validUntil: old.validUntil || isoDate(valid),
      quotationNumber: old.quotationNumber || `S7-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-001`,
    }));
    setStorageLoaded(true);
  }, []);

  const update = <K extends keyof QuoteForm>(key: K, value: QuoteForm[K]) =>
    setForm((old) => ({ ...old, [key]: value }));

  const saveToHistory = async () => {
    if (!totals) return false;
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch("/api/quotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          status: "draft",
          pricePerPiece: totals.pricePerPiece.toString(),
          subtotal: totals.subtotal.toString(),
          tax: totals.tax.toString(),
          grandTotal: totals.grandTotal.toString(),
          calculationVersion: sourceVersion ? "simulator-linked" : "manual-entry",
          resultHash: sourceVersion,
          payload: { ...form, resultHash: sourceVersion },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "save_failed");
      setSavedAt(new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }));
      return true;
    } catch {
      setSaveError("履歴DBに保存できませんでした。テスト環境ではデータが保持されない場合があります。");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const printPdf = async () => {
    // テスト環境では履歴DBが一時的な場合があるため、PDF出力は保存結果に依存させない。
    void saveToHistory();
    window.print();
  };

  const valid = isPositiveNumber(form.quantity)
    && isPositiveNumber(form.fillingCostPerPiece)
    && isPositiveNumber(form.filmCostPerPiece)
    && Number(form.targetMargin) > 0
    && Number(form.targetMargin) < 1
    && Number(form.taxRatePercent) >= 0;

  const totals = (() => {
    if (!valid) return null;
    const quantity = D(form.quantity);
    const margin = D(form.targetMargin);
    const taxRate = D(form.taxRatePercent).div(100);
    const fillingSellingUnit = D(form.fillingCostPerPiece).div(D(1).minus(margin));
    const filmSellingUnit = D(form.filmCostPerPiece).div(D(1).minus(margin));
    const filmMeterDisplayUnit = D(form.filmMeterPrice);
    const pricePerPiece = fillingSellingUnit.plus(filmSellingUnit);
    const subtotalBeforeAdjustment = pricePerPiece.times(quantity);
    const subtotal = subtotalBeforeAdjustment.floor();
    const roundingAdjustment = subtotal.minus(subtotalBeforeAdjustment);
    const tax = subtotal.times(taxRate).toDecimalPlaces(0);
    return {
      quantity,
      fillingSellingUnit,
      filmSellingUnit,
      filmMeterDisplayUnit,
      filmOrderLength: D(form.filmOrderLengthM),
      roundingAdjustment,
      pricePerPiece,
      fillingAmount: fillingSellingUnit.times(quantity),
      filmAmount: filmSellingUnit.times(quantity),
      subtotal,
      tax,
      grandTotal: subtotal.plus(tax),
    };
  })();

  return (
    <main className="quote-page">
      <nav className="top-menu" aria-label="メインメニュー">
        <div className="menu-brand">
          <span className="logo-mark" aria-hidden="true">7</span>
          <span>セブン化学 <small>Quotation Suite</small></span>
        </div>
        <div className="menu-links">
          <Link href="/">原価シミュレーター</Link>
          <Link href="/quote" aria-current="page">見積書発行</Link>
          <Link href="/history">見積履歴</Link>
        </div>
      </nav>

      <section className="panel quote-toolbar" aria-labelledby="quote-toolbar-title">
        <div>
          <h1 id="quote-toolbar-title">見積書発行</h1>
          <p>原価シミュレーターの計算結果を取り込み、A4の信頼性ある見積書としてPDF出力できます。</p>
          <p className="help" data-testid="quote-source">
            {sourceVersion ? `原価計算結果連携済み / 計算ID ${sourceVersion.slice(0, 12)}` : "原価シミュレーター未連携。手入力または「原価値を取込」後に出力できます。"}
          </p>
        </div>
        <div className="toolbar-actions no-print">
          <button className="button secondary" type="button" onClick={() => router.push("/")}>シミュレーターから取込</button>
          <button className="button secondary" type="button" data-testid="save-history" disabled={!valid || saving} onClick={() => void saveToHistory()}>{saving ? "保存中..." : savedAt ? `履歴保存済 ${savedAt}` : "履歴に保存"}</button>
          <button className="button" type="button" data-testid="print-pdf" disabled={!valid || saving} onClick={() => void printPdf()}>PDF出力（A4）</button>
        </div>
        {saveError ? <p className="error" role="alert" data-testid="save-error">{saveError}</p> : null}
      </section>

      <section className="panel quote-editor no-print" aria-labelledby="quote-editor-title">
        <h2 id="quote-editor-title">見積書編集</h2>
        {!storageLoaded ? <p className="help">入力欄を準備しています。</p> : null}
        <div className="editor-grid">
          <label>見積番号<input value={form.quotationNumber} onChange={(event) => update("quotationNumber", event.target.value)} /></label>
          <label>発行日<input type="date" value={form.issueDate} onChange={(event) => update("issueDate", event.target.value)} /></label>
          <label>有効期限<input type="date" value={form.validUntil} onChange={(event) => update("validUntil", event.target.value)} /></label>
          <label>得意先名<input value={form.customerName} onChange={(event) => update("customerName", event.target.value)} placeholder="株式会社◯◯" /></label>
          <label>得意先担当者<input value={form.customerContact} onChange={(event) => update("customerContact", event.target.value)} placeholder="◯◯様" /></label>
          <label>品名<input value={form.productName} onChange={(event) => update("productName", event.target.value)} /></label>
          <label>仕様<input value={form.sizeSummary} onChange={(event) => update("sizeSummary", event.target.value)} /></label>
          <label>数量（枚）<input inputMode="numeric" value={form.quantity} onChange={(event) => update("quantity", event.target.value)} /></label>
          <label>充填・加工 原価 / 枚<input inputMode="decimal" value={form.fillingCostPerPiece} onChange={(event) => update("fillingCostPerPiece", event.target.value)} /></label>
          <label>フィルム 原価 / 枚<input inputMode="decimal" value={form.filmCostPerPiece} onChange={(event) => update("filmCostPerPiece", event.target.value)} /></label>
          <label>フィルム m単価<input inputMode="decimal" value={form.filmMeterPrice} onChange={(event) => update("filmMeterPrice", event.target.value)} /></label>
          <label>フィルム発注長さ (m)<input inputMode="decimal" value={form.filmOrderLengthM} onChange={(event) => update("filmOrderLengthM", event.target.value)} /></label>
          <label>適用利益率（内部管理）<input inputMode="decimal" value={form.targetMargin} onChange={(event) => update("targetMargin", event.target.value)} /></label>
          <label>消費税率（%）<input inputMode="decimal" value={form.taxRatePercent} onChange={(event) => update("taxRatePercent", event.target.value)} /></label>
          <label>納期<input value={form.deliveryDate} onChange={(event) => update("deliveryDate", event.target.value)} /></label>
          <label>お支払条件<input value={form.paymentTerms} onChange={(event) => update("paymentTerms", event.target.value)} /></label>
          <label className="wide">備考<textarea rows={3} value={form.notes} onChange={(event) => update("notes", event.target.value)} /></label>
        </div>
        {!valid ? <p className="error">数量・原価・利益率・税率を正しく入力してください。</p> : null}
      </section>

      <article className="a4-sheet" aria-label="お見積書A4プレビュー">
        <header className="sheet-header">
          <div className="issuer">
            <div className="issuer-logo">
              <span className="logo-mark large" aria-hidden="true">7</span>
              <div>
                <strong>{sevenChemical.name}</strong>
                <small>{sevenChemical.englishName}</small>
              </div>
            </div>
            <address>
              {sevenChemical.representative}<br />
              {sevenChemical.postalCode} {sevenChemical.address}<br />
              {sevenChemical.telephone} / {sevenChemical.website}
            </address>
          </div>
          <div className="document-title">
            <p className="english">QUOTATION</p>
            <h2>お見積書</h2>
            <dl>
              <div><dt>見積番号</dt><dd>{form.quotationNumber || "-"}</dd></div>
              <div><dt>発行日</dt><dd>{form.issueDate || "-"}</dd></div>
            </dl>
          </div>
        </header>

        <section className="recipient-block">
          <p className="customer">{form.customerName || "得意先名未入力"}</p>
          {form.customerContact ? <p>{form.customerContact} 御中</p> : null}
          <p className="greeting">平素より格別のお引き立てを賜り、厚く御礼申し上げます。下記の通りお見積りを申し上げます。</p>
        </section>

        {totals ? (
          <>
            <section className="price-highlight">
              <div>
                <span>お見積単価（税抜）</span>
                <strong data-testid="quote-price-per-piece">{formatCurrency(totals.pricePerPiece.toString(), 0)}<small> /枚</small></strong>
              </div>
              <div>
                <span>数量</span>
                <strong>{formatNumber(totals.quantity.toString(), 0)} 枚</strong>
              </div>
              <div>
                <span>税込合計</span>
                <strong>{formatCurrency(totals.grandTotal.toString(), 0)}</strong>
              </div>
            </section>

            <table className="quote-table">
              <thead>
                <tr>
                  <th scope="col">品名・仕様</th>
                  <th scope="col">単価</th>
                  <th scope="col">数量</th>
                  <th scope="col">金額</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>充填・加工費</strong>
                    <small>バルク充填および加工に必要な一式</small>
                  </td>
                  <td>{formatCurrency(totals.fillingSellingUnit.toString(), 0)}</td>
                  <td>{formatNumber(form.quantity, 0)} 枚</td>
                  <td>{formatCurrency(totals.fillingAmount.toString(), 0)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>フィルム費用</strong>
                    <small>パウチフィルム製作・物流に必要な一式</small>
                  </td>
                  <td>
                    <strong data-testid="film-meter-price">{formatCurrency(totals.filmMeterDisplayUnit.toString(), 0)} /m</strong>
                    <small data-testid="film-pouch-price">パウチ換算 {formatCurrency(totals.filmSellingUnit.toString(), 0)} /枚</small>
                  </td>
                  <td><span data-testid="film-order-length">{formatNumber(totals.filmOrderLength.toString(), 0)} m</span></td>
                  <td>{formatCurrency(totals.filmAmount.toString(), 0)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>端数調整</strong>
                    <small>円未満の端数を切捨てて合計金額を整数円に調整します。</small>
                  </td>
                  <td>—</td>
                  <td>—</td>
                  <td data-testid="rounding-adjustment">{totals.roundingAdjustment.abs().lt(1) ? "-" : formatCurrency(totals.roundingAdjustment.toString(), 0)}</td>
                </tr>
              </tbody>
            </table>

            <section className="total-block">
              <div><span>小計（税抜）</span><strong>{formatCurrency(totals.subtotal.toString(), 0)}</strong></div>
              <div><span>消費税（{formatNumber(Number(form.taxRatePercent), 0)}%）</span><strong>{formatCurrency(totals.tax.toString(), 0)}</strong></div>
              <div className="grand"><span>合計（税込）</span><strong>{formatCurrency(totals.grandTotal.toString(), 0)}</strong></div>
            </section>
          </>
        ) : (
          <p className="error sheet-error">金額計算に必要な入力が不正です。編集欄を確認してください。</p>
        )}

        <section className="terms">
          <dl>
            <div><dt>納期</dt><dd>{form.deliveryDate || "-"}</dd></div>
            <div><dt>お支払条件</dt><dd>{form.paymentTerms || "-"}</dd></div>
            <div><dt>見積有効期限</dt><dd>{form.validUntil || "-"}</dd></div>
          </dl>
          <p className="notes"><strong>備考</strong>{form.notes ? ` ${form.notes}` : ""}</p>
        </section>

        <footer className="sheet-footer">
          <p>本お見積りに関するご不明点は、下記連絡先までお気軽にお問い合わせください。</p>
          <div className="approval">
            <span>{sevenChemical.name}</span>
            <span className="seal" aria-hidden="true">検討済</span>
          </div>
        </footer>
      </article>
    </main>
  );
}
