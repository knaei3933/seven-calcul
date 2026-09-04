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
  documentEnglish: string;
  documentHeading: string;
  issuerName: string;
  issuerEnglishName: string;
  representative: string;
  issuerPostalCode: string;
  issuerAddress: string;
  issuerTelephone: string;
  issuerWebsite: string;
  greeting: string;
  productName: string;
  sizeSummary: string;
  fillingItemName: string;
  fillingItemDescription: string;
  fillingUnitDisplay: string;
  fillingAmountDisplay: string;
  filmItemName: string;
  filmItemDescription: string;
  filmUnitDisplay: string;
  filmPouchUnitDisplay: string;
  filmAmountDisplay: string;
  roundingItemName: string;
  roundingItemDescription: string;
  adjustmentDisplay: string;
  pricePerPieceDisplay: string;
  subtotalLabel: string;
  subtotalDisplay: string;
  taxLabel: string;
  taxDisplay: string;
  grandTotalLabel: string;
  grandTotalDisplay: string;
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
  sealText: string;
  footerNote: string;
};

const defaultQuote: QuoteForm = {
  quotationNumber: "",
  issueDate: "",
  validUntil: "",
  customerName: "",
  customerContact: "",
  documentEnglish: "QUOTATION",
  documentHeading: "お見積書",
  issuerName: sevenChemical.name,
  issuerEnglishName: sevenChemical.englishName,
  representative: sevenChemical.representative,
  issuerPostalCode: sevenChemical.postalCode,
  issuerAddress: sevenChemical.address,
  issuerTelephone: sevenChemical.telephone,
  issuerWebsite: sevenChemical.website,
  greeting: "平素より格別のお引き立てを賜り、厚く御礼申し上げます。下記の通りお見積りを申し上げます。",
  productName: "パウチ製品",
  sizeSummary: "50×60mm / 1連",
  fillingItemName: "充填・加工費",
  fillingItemDescription: "バルク充填および加工に必要な一式",
  fillingUnitDisplay: "",
  fillingAmountDisplay: "",
  filmItemName: "フィルム費用",
  filmItemDescription: "パウチフィルム製作・物流に必要な一式",
  filmUnitDisplay: "",
  filmPouchUnitDisplay: "",
  filmAmountDisplay: "",
  roundingItemName: "端数調整",
  roundingItemDescription: "円未満の端数を切捨てて合計金額を整数円に調整します。",
  adjustmentDisplay: "",
  pricePerPieceDisplay: "",
  subtotalLabel: "小計（税抜）",
  subtotalDisplay: "",
  taxLabel: "",
  taxDisplay: "",
  grandTotalLabel: "合計（税込）",
  grandTotalDisplay: "",
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
  sealText: "検討済",
  footerNote: "本お見積りに関するご不明点は、下記連絡先までお気軽にお問い合わせください。",
};

function isPositiveNumber(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

function isFiniteNumber(value: string) {
  return value.trim() !== "" && Number.isFinite(Number(value));
}

function editedNumber(value: string, fallback: string) {
  return isFiniteNumber(value) ? value.trim() : fallback;
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
  const [mobileDrawer, setMobileDrawer] = useState<"left" | "right" | null>(null);
  const [isMobileWorkspace, setIsMobileWorkspace] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1200px)");
    const update = () => setIsMobileWorkspace(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!mobileDrawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileDrawer(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileDrawer]);

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

  const shownTotals = totals ? {
    pricePerPiece: editedNumber(form.pricePerPieceDisplay, totals.pricePerPiece.toString()),
    fillingUnit: editedNumber(form.fillingUnitDisplay, totals.fillingSellingUnit.toString()),
    fillingAmount: editedNumber(form.fillingAmountDisplay, totals.fillingAmount.toString()),
    filmUnit: editedNumber(form.filmUnitDisplay, totals.filmMeterDisplayUnit.toString()),
    filmPouchUnit: editedNumber(form.filmPouchUnitDisplay, totals.filmSellingUnit.toString()),
    filmAmount: editedNumber(form.filmAmountDisplay, totals.filmAmount.toString()),
    filmOrderLength: totals.filmOrderLength.toString(),
    adjustment: isFiniteNumber(form.adjustmentDisplay)
      ? form.adjustmentDisplay.trim()
      : (totals.roundingAdjustment.abs().lt(1) ? "-" : totals.roundingAdjustment.toString()),
    subtotal: editedNumber(form.subtotalDisplay, totals.subtotal.toString()),
    tax: editedNumber(form.taxDisplay, totals.tax.toString()),
    grandTotal: editedNumber(form.grandTotalDisplay, totals.grandTotal.toString()),
  } : null;


  return (
    <main className={`quote-page ${mobileDrawer ? `drawer-open drawer-${mobileDrawer}` : ""}`}>
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
          <p>左端は宛先・基本情報、右端は明細・金額を直接編集できます。</p>
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

      <div className={`quote-workspace ${mobileDrawer ? `drawer-open drawer-${mobileDrawer}` : ""}`}>
        <aside
          className="panel quote-side quote-side-left no-print"
          id="quote-editor-left"
          data-testid="quote-editor-left"
          aria-label="見積書基本編集"
          inert={isMobileWorkspace && mobileDrawer !== "left" ? true : undefined}
        >
          <div className="side-header">
            <span className="side-kicker">LEFT</span>
            <h2>基本・宛先</h2>
            <button className="side-close" type="button" onClick={() => setMobileDrawer(null)}>閉じる</button>
          </div>
          <div className="side-body">{renderEditorGroups("left")}</div>
        </aside>

        <article className="a4-sheet" aria-label="お見積書A4プレビュー" id="quote-preview">
          <header className="sheet-header">
            <div className="issuer">
              <div className="issuer-logo">
                <span className="logo-mark large" aria-hidden="true">7</span>
                <div>
                  <strong>{form.issuerName}</strong>
                  <small>{form.issuerEnglishName}</small>
                </div>
              </div>
              <address>
                {form.representative}<br />
                {form.issuerPostalCode} {form.issuerAddress}<br />
                {form.issuerTelephone} / {form.issuerWebsite}
              </address>
            </div>
            <div className="document-title">
              <p className="english">{form.documentEnglish}</p>
              <h2>{form.documentHeading}</h2>
              <dl>
                <div><dt>見積番号</dt><dd>{form.quotationNumber || "-"}</dd></div>
                <div><dt>発行日</dt><dd>{form.issueDate || "-"}</dd></div>
              </dl>
            </div>
          </header>

          <section className="recipient-block">
            <p className="customer">{form.customerName || "得意先名未入力"}</p>
            {form.customerContact ? <p>{form.customerContact} 御中</p> : null}
            <p className="greeting">{form.greeting}</p>
          </section>

          {shownTotals ? (
            <>
              <section className="price-highlight">
                <div>
                  <span>お見積単価（税抜）</span>
                  <strong data-testid="quote-price-per-piece">{formatCurrency(shownTotals.pricePerPiece, 0)}<small> /枚</small></strong>
                </div>
                <div>
                  <span>数量</span>
                  <strong>{formatNumber(form.quantity, 0)} 枚</strong>
                </div>
                <div>
                  <span>税込合計</span>
                  <strong>{formatCurrency(shownTotals.grandTotal, 0)}</strong>
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
                      <strong>{form.fillingItemName}</strong>
                      <small>{form.fillingItemDescription}</small>
                    </td>
                    <td data-testid="filling-unit-price">{formatCurrency(shownTotals.fillingUnit, 0)}</td>
                    <td>{formatNumber(form.quantity, 0)} 枚</td>
                    <td>{formatCurrency(shownTotals.fillingAmount, 0)}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>{form.filmItemName}</strong>
                      <small>{form.filmItemDescription}</small>
                    </td>
                    <td>
                      <strong data-testid="film-meter-price">{formatCurrency(shownTotals.filmUnit, 0)} /m</strong>
                      <small data-testid="film-pouch-price">パウチ換算 {formatCurrency(shownTotals.filmPouchUnit, 0)} /枚</small>
                    </td>
                    <td><span data-testid="film-order-length">{formatNumber(shownTotals.filmOrderLength, 0)} m</span></td>
                    <td>{formatCurrency(shownTotals.filmAmount, 0)}</td>
                  </tr>
                  <tr>
                    <td>
                      <strong>{form.roundingItemName}</strong>
                      <small>{form.roundingItemDescription}</small>
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td data-testid="rounding-adjustment">{shownTotals.adjustment === "-" ? "-" : formatCurrency(shownTotals.adjustment, 0)}</td>
                  </tr>
                </tbody>
              </table>

              <section className="total-block">
                <div><span>{form.subtotalLabel}</span><strong>{formatCurrency(shownTotals.subtotal, 0)}</strong></div>
                <div><span>{form.taxLabel || `消費税（${formatNumber(Number(form.taxRatePercent), 0)}%）`}</span><strong>{formatCurrency(shownTotals.tax, 0)}</strong></div>
                <div className="grand"><span>{form.grandTotalLabel}</span><strong>{formatCurrency(shownTotals.grandTotal, 0)}</strong></div>
              </section>
            </>
          ) : (
            <p className="error sheet-error">金額計算に必要な入力が不正です。右側の編集パネルを確認してください。</p>
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
            <p>{form.footerNote}</p>
            <div className="approval">
              <span>{form.issuerName}</span>
              <span className="seal" aria-hidden="true">{form.sealText}</span>
            </div>
          </footer>
        </article>

        <aside
          className="panel quote-side quote-side-right no-print"
          id="quote-editor-right"
          data-testid="quote-editor-right"
          aria-label="見積書金額編集"
          inert={isMobileWorkspace && mobileDrawer !== "right" ? true : undefined}
        >
          <div className="side-header">
            <span className="side-kicker">RIGHT</span>
            <h2>明細・金額</h2>
            <button className="side-close" type="button" onClick={() => setMobileDrawer(null)}>閉じる</button>
          </div>
          <div className="side-body">{renderEditorGroups("right")}</div>
        </aside>
      </div>

      <div className="quote-edge-handles no-print" aria-label="見積書編集クイック操作">
        <button type="button" onClick={() => setMobileDrawer("left")} aria-expanded={mobileDrawer === "left"}>基本</button>
        <button className="print-button" type="button" disabled={!valid || saving} onClick={() => void printPdf()}>PDF</button>
        <button type="button" onClick={() => setMobileDrawer("right")} aria-expanded={mobileDrawer === "right"}>金額</button>
      </div>

      {isMobileWorkspace && mobileDrawer ? (
        <div className="quote-drawer-overlay no-print" onClick={() => setMobileDrawer(null)} aria-hidden="true" />
      ) : null}
    </main>
  );

  function renderEditorGroups(position: "left" | "right") {
    if (position === "left") {
      return (
        <>
          <details className="editor-group" open>
            <summary>基本情報・宛先</summary>
            <div className="editor-grid">
              <label>見積番号<input value={form.quotationNumber} onChange={(event) => update("quotationNumber", event.target.value)} /></label>
              <label>発行日<input type="date" value={form.issueDate} onChange={(event) => update("issueDate", event.target.value)} /></label>
              <label>有効期限<input type="date" value={form.validUntil} onChange={(event) => update("validUntil", event.target.value)} /></label>
              <label>文書タイトル<input value={form.documentHeading} onChange={(event) => update("documentHeading", event.target.value)} /></label>
              <label>文書英字タイトル<input value={form.documentEnglish} onChange={(event) => update("documentEnglish", event.target.value)} /></label>
              <label>得意先名<input value={form.customerName} onChange={(event) => update("customerName", event.target.value)} placeholder="株式会社◯◯" /></label>
              <label>得意先担当者<input value={form.customerContact} onChange={(event) => update("customerContact", event.target.value)} placeholder="◯◯様" /></label>
              <label className="wide">宛先文言<textarea rows={4} value={form.greeting} onChange={(event) => update("greeting", event.target.value)} /></label>
            </div>
          </details>

          <details className="editor-group" open>
            <summary>発行者情報</summary>
            <div className="editor-grid">
              <label>発行者名<input value={form.issuerName} onChange={(event) => update("issuerName", event.target.value)} /></label>
              <label>発行者英字名<input value={form.issuerEnglishName} onChange={(event) => update("issuerEnglishName", event.target.value)} /></label>
              <label>代表者<input value={form.representative} onChange={(event) => update("representative", event.target.value)} /></label>
              <label>郵便番号<input value={form.issuerPostalCode} onChange={(event) => update("issuerPostalCode", event.target.value)} /></label>
              <label className="wide">住所<input value={form.issuerAddress} onChange={(event) => update("issuerAddress", event.target.value)} /></label>
              <label>電話番号<input value={form.issuerTelephone} onChange={(event) => update("issuerTelephone", event.target.value)} /></label>
              <label>ウェブサイト<input value={form.issuerWebsite} onChange={(event) => update("issuerWebsite", event.target.value)} /></label>
            </div>
          </details>

          <details className="editor-group">
            <summary>条件・備考・社内判</summary>
            <div className="editor-grid">
              <label>納期<input value={form.deliveryDate} onChange={(event) => update("deliveryDate", event.target.value)} /></label>
              <label>お支払条件<input value={form.paymentTerms} onChange={(event) => update("paymentTerms", event.target.value)} /></label>
              <label className="wide">備考<textarea rows={4} value={form.notes} onChange={(event) => update("notes", event.target.value)} /></label>
              <label>社内判文言<input value={form.sealText} onChange={(event) => update("sealText", event.target.value)} /></label>
              <label className="wide">フッター文言<textarea rows={3} value={form.footerNote} onChange={(event) => update("footerNote", event.target.value)} /></label>
            </div>
          </details>
        </>
      );
    }

    return (
      <details className="editor-group" open>
        <summary>明細・金額</summary>
        <div className="editor-grid">
          <label>品名<input value={form.productName} onChange={(event) => update("productName", event.target.value)} /></label>
          <label>仕様<input value={form.sizeSummary} onChange={(event) => update("sizeSummary", event.target.value)} /></label>
          <label>数量（枚）<input inputMode="numeric" value={form.quantity} onChange={(event) => update("quantity", event.target.value)} /></label>
          <label>充填・加工 項目名<input value={form.fillingItemName} onChange={(event) => update("fillingItemName", event.target.value)} /></label>
          <label className="wide">充填・加工 説明<textarea rows={2} value={form.fillingItemDescription} onChange={(event) => update("fillingItemDescription", event.target.value)} /></label>
          <label>充填・加工 原価 / 枚<input inputMode="decimal" value={form.fillingCostPerPiece} onChange={(event) => update("fillingCostPerPiece", event.target.value)} /></label>
          <label>充填・加工 単価（空欄=自動）<input inputMode="decimal" value={form.fillingUnitDisplay} onChange={(event) => update("fillingUnitDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>充填・加工 金額（空欄=自動）<input inputMode="decimal" value={form.fillingAmountDisplay} onChange={(event) => update("fillingAmountDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>フィルム 項目名<input value={form.filmItemName} onChange={(event) => update("filmItemName", event.target.value)} /></label>
          <label className="wide">フィルム 説明<textarea rows={2} value={form.filmItemDescription} onChange={(event) => update("filmItemDescription", event.target.value)} /></label>
          <label>フィルム 原価 / 枚<input inputMode="decimal" value={form.filmCostPerPiece} onChange={(event) => update("filmCostPerPiece", event.target.value)} /></label>
          <label>フィルム m単価<input inputMode="decimal" value={form.filmMeterPrice} onChange={(event) => update("filmMeterPrice", event.target.value)} /></label>
          <label>フィルム発注長さ (m)<input inputMode="decimal" value={form.filmOrderLengthM} onChange={(event) => update("filmOrderLengthM", event.target.value)} /></label>
          <label>フィルム m単価表示（空欄=自動）<input inputMode="decimal" value={form.filmUnitDisplay} onChange={(event) => update("filmUnitDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>フィルム パウチ換算（空欄=自動）<input inputMode="decimal" value={form.filmPouchUnitDisplay} onChange={(event) => update("filmPouchUnitDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>フィルム 金額（空欄=自動）<input inputMode="decimal" value={form.filmAmountDisplay} onChange={(event) => update("filmAmountDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>端数調整 項目名<input value={form.roundingItemName} onChange={(event) => update("roundingItemName", event.target.value)} /></label>
          <label className="wide">端数調整 説明<textarea rows={2} value={form.roundingItemDescription} onChange={(event) => update("roundingItemDescription", event.target.value)} /></label>
          <label>端数調整 金額（空欄=自動）<input inputMode="decimal" value={form.adjustmentDisplay} onChange={(event) => update("adjustmentDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>見積単価 / 枚（空欄=自動）<input inputMode="decimal" value={form.pricePerPieceDisplay} onChange={(event) => update("pricePerPieceDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>小計ラベル<input value={form.subtotalLabel} onChange={(event) => update("subtotalLabel", event.target.value)} /></label>
          <label>小計（空欄=自動）<input inputMode="decimal" value={form.subtotalDisplay} onChange={(event) => update("subtotalDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>消費税ラベル（空欄=自動）<input value={form.taxLabel} onChange={(event) => update("taxLabel", event.target.value)} placeholder={`消費税（${formatNumber(Number(form.taxRatePercent), 0)}%）`} /></label>
          <label>消費税率（%）<input inputMode="decimal" value={form.taxRatePercent} onChange={(event) => update("taxRatePercent", event.target.value)} /></label>
          <label>消費税（空欄=自動）<input inputMode="decimal" value={form.taxDisplay} onChange={(event) => update("taxDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>合計ラベル<input value={form.grandTotalLabel} onChange={(event) => update("grandTotalLabel", event.target.value)} /></label>
          <label>合計（空欄=自動）<input inputMode="decimal" value={form.grandTotalDisplay} onChange={(event) => update("grandTotalDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>適用利益率（内部管理）<input inputMode="decimal" value={form.targetMargin} onChange={(event) => update("targetMargin", event.target.value)} /></label>
        </div>
      </details>
    );
  }
}
