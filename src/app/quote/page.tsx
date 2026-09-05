"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { D, Decimal, parseDecimal } from "@/lib/decimal";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import {
  QUOTATION_DRAFT_KEY,
  parseQuotationDraft,
  sevenChemical,
  type QuotationDraft,
} from "@/lib/quotation-draft";
import { DEFAULT_FILM_COMPOSITION, QUOTATION_RESTORE_KEY } from "@/lib/quotation-shared";

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
  filmComposition: string;
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
  filmComposition: DEFAULT_FILM_COMPOSITION,
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

function isFiniteNumber(value: string) {
  return parseDecimal(value) !== null;
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

type EditableTextProps = {
  value: string;
  label: string;
  className?: string;
  multiline?: boolean;
  onCommit: (next: string, node: HTMLElement) => void;
};

function EditableText({ value, label, className, multiline = false, onCommit }: EditableTextProps) {
  const nodeRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = nodeRef.current;
    if (node && document.activeElement !== node && node.textContent !== value) node.textContent = value;
  }, [value]);

  const commit = (node: HTMLElement) => {
    const next = node.textContent ?? "";
    if (next !== value) onCommit(next, node);
  };

  const shared = {
    ref: (node: HTMLElement | null) => { nodeRef.current = node; },
    contentEditable: true,
    suppressContentEditableWarning: true,
    spellCheck: false,
    role: "textbox",
    tabIndex: 0,
    "aria-label": label,
    className: `sheet-editable ${multiline ? "multiline" : ""} ${className ?? ""}`,
    onBlur: (event: React.FocusEvent<HTMLElement>) => commit(event.currentTarget),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter" && !multiline) {
        event.preventDefault();
        event.currentTarget.blur();
      }
      if (event.key === "Escape") {
        event.currentTarget.textContent = value;
        event.currentTarget.blur();
      }
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(event.currentTarget);
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
  };

  return <span {...shared} />;
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
    if (!shownTotals) return false;
    setSaving(true);
    setSaveError("");
    try {
      const costUnit = D(form.fillingCostPerPiece).plus(form.filmCostPerPiece);
      const sellingUnit = D(shownTotals.pricePerPiece);
      const profitUnit = sellingUnit.minus(costUnit);
      const profitMargin = sellingUnit.gt(0) ? profitUnit.div(sellingUnit) : D(0);
      const markupRate = costUnit.gt(0) ? sellingUnit.div(costUnit) : D(0);
      const targetMargin = D(form.targetMargin);
      const profitAudit = {
        basis: "displayed-unit-price",
        quantity: form.quantity,
        totalCostPerPiece: costUnit.toString(),
        proposedPricePerPiece: sellingUnit.toString(),
        profitPerPiece: profitUnit.toString(),
        profitMarginRate: profitMargin.toString(),
        profitMarginPercent: profitMargin.times(100).toString(),
        markupRate: markupRate.toString(),
        targetMarginRate: targetMargin.toString(),
        targetMarginPercent: targetMargin.times(100).toString(),
        totalRevenue: sellingUnit.times(totals.quantity).toString(),
        totalProfit: profitUnit.times(totals.quantity).toString(),
        recordedAt: new Date().toISOString(),
      };
      const response = await fetch("/api/quotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          status: "draft",
          pricePerPiece: shownTotals.pricePerPiece.toString(),
          subtotal: shownTotals.subtotal.toString(),
          tax: shownTotals.tax.toString(),
          grandTotal: shownTotals.grandTotal.toString(),
          calculationVersion: sourceVersion ? "simulator-linked" : "manual-entry",
          resultHash: sourceVersion,
          payload: { ...form, resultHash: sourceVersion, profitAudit },
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

  const parsedQuantity = parseDecimal(form.quantity);
  const parsedTargetMargin = parseDecimal(form.targetMargin);
  const parsedTaxRatePercent = parseDecimal(form.taxRatePercent);
  const parsedFillingCost = parseDecimal(form.fillingCostPerPiece);
  const parsedFilmCost = parseDecimal(form.filmCostPerPiece);
  const parsedFilmMeterPrice = parseDecimal(form.filmMeterPrice);
  const parsedFilmOrderLength = parseDecimal(form.filmOrderLengthM);

  const valid = !!parsedQuantity && parsedQuantity.gt(0)
    && !!parsedFillingCost && parsedFillingCost.gte(0)
    && !!parsedFilmCost && parsedFilmCost.gte(0)
    && !!parsedTargetMargin && parsedTargetMargin.gt(0) && parsedTargetMargin.lt(1)
    && !!parsedTaxRatePercent && parsedTaxRatePercent.gte(0);

  const totals = (() => {
    if (!valid || !parsedQuantity || !parsedTargetMargin || !parsedTaxRatePercent || !parsedFillingCost || !parsedFilmCost || !parsedFilmMeterPrice || !parsedFilmOrderLength) return null;
    const quantity = parsedQuantity;
    const margin = parsedTargetMargin;
    const taxRate = parsedTaxRatePercent.div(100);
    const fillingSellingUnit = parsedFillingCost.div(D(1).minus(margin));
    const filmSellingUnit = parsedFilmCost.div(D(1).minus(margin));
    const filmMeterDisplayUnit = parsedFilmMeterPrice;
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
      filmOrderLength: parsedFilmOrderLength,
      roundingAdjustment,
      pricePerPiece,
      fillingAmount: fillingSellingUnit.times(quantity),
      filmAmount: filmSellingUnit.times(quantity),
      subtotal,
      tax,
      taxRate,
      grandTotal: subtotal.plus(tax),
    };
  })();

  const shownTotals = (() => {
    if (!totals) return null;
    const roundUnit = (value: typeof totals.pricePerPiece) => value.toDecimalPlaces(2, Decimal.ROUND_UP);
    const totalPriceInput = parseDecimal(form.pricePerPieceDisplay) ?? totals.pricePerPiece;
    let effectiveFillingUnit = roundUnit(totals.fillingSellingUnit);
    let effectiveFilmUnit = roundUnit(totals.filmSellingUnit);

    if (isFiniteNumber(form.pricePerPieceDisplay) && !totalPriceInput.eq(effectiveFillingUnit.plus(effectiveFilmUnit))) {
      const fillingShare = totals.pricePerPiece.gt(0)
        ? totals.fillingSellingUnit.div(totals.pricePerPiece)
        : D(0);
      effectiveFillingUnit = roundUnit(totalPriceInput.times(fillingShare));
      effectiveFilmUnit = roundUnit(totalPriceInput.minus(effectiveFillingUnit));
    }

    const fillingUnit = parseDecimal(form.fillingUnitDisplay) ?? effectiveFillingUnit;
    const filmPouchUnit = parseDecimal(form.filmPouchUnitDisplay) ?? effectiveFilmUnit;
    const fillingAmount = parseDecimal(form.fillingAmountDisplay) ?? fillingUnit.times(totals.quantity);
    const filmAmount = parseDecimal(form.filmAmountDisplay) ?? filmPouchUnit.times(totals.quantity);
    const lineTotal = fillingAmount.plus(filmAmount);
    const subtotal = parseDecimal(form.subtotalDisplay) ?? lineTotal;
    const tax = parseDecimal(form.taxDisplay) ?? subtotal.times(totals.taxRate).toDecimalPlaces(0);
    const grandTotal = parseDecimal(form.grandTotalDisplay) ?? subtotal.plus(tax);

    return {
      pricePerPiece: effectiveFillingUnit.plus(effectiveFilmUnit).toString(),
      fillingUnit: fillingUnit.toString(),
      fillingAmount: fillingAmount.toString(),
      filmUnit: (parseDecimal(form.filmUnitDisplay) ?? totals.filmMeterDisplayUnit).toString(),
      filmPouchUnit: filmPouchUnit.toString(),
      filmAmount: filmAmount.toString(),
      filmOrderLength: totals.filmOrderLength.toString(),
      adjustment: parseDecimal(form.adjustmentDisplay)?.toString()
        ?? (subtotal.minus(lineTotal).abs().lt(1)
          ? "-"
          : subtotal.minus(lineTotal).toString()),
      subtotal: subtotal.toString(),
      tax: tax.toString(),
      grandTotal: grandTotal.toString(),
    };
  })();

  const parseDisplayedNumber = (raw: string) => parseDecimal(raw.replace(/[,，]/g, "").replace(/[^\d.+-]/g, ""));
  const applyPatch = (patch: Partial<QuoteForm>) => setForm((old) => ({ ...old, ...patch }));

  const moneyDisplay = (value: string, override?: string, autoDigits = 0) => {
    if (override !== undefined) {
      const parsed = parseDecimal(override);
      if (parsed) return formatCurrency(parsed.toString(), Math.min(parsed.decimalPlaces() ?? 0, 4));
    }
    return formatCurrency(value, autoDigits);
  };

  const numberDisplay = (value: string, override?: string) => {
    if (override !== undefined && isFiniteNumber(override)) return override.trim();
    return formatNumber(value, 0);
  };

  const rejectInvalidNumber = (node: HTMLElement, fallback: string) => {
    node.textContent = fallback;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const commitSheetPrice = (raw: string, node: HTMLElement) => {
    const price = parseDisplayedNumber(raw);
    const quantity = parseDecimal(form.quantity);
    if (!price || price.lt(0) || !quantity || quantity.gt(0) === false) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.pricePerPiece ?? "0"));
      return;
    }
    const subtotal = price.times(quantity).floor();
    const tax = subtotal.times(D(form.taxRatePercent).div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    applyPatch({
      pricePerPieceDisplay: price.toString(),
      fillingUnitDisplay: "",
      fillingAmountDisplay: "",
      filmPouchUnitDisplay: "",
      filmAmountDisplay: "",
      adjustmentDisplay: "",
      subtotalDisplay: subtotal.toString(),
      taxDisplay: tax.toString(),
      grandTotalDisplay: subtotal.plus(tax).toString(),
    });
  };

  const commitLineUnit = (line: "filling" | "film", raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const unit = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || unit === null || unit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(line === "filling" ? shownTotals?.fillingUnit ?? "0" : shownTotals?.filmPouchUnit ?? "0"));
      return;
    }
    const fillingUnit = line === "filling" ? unit : D(shownTotals.fillingUnit);
    const filmUnit = line === "film" ? unit : D(shownTotals.filmPouchUnit);
    const fillingAmount = fillingUnit.times(quantity);
    const filmAmount = filmUnit.times(quantity);
    const price = fillingUnit.plus(filmUnit);
    const subtotal = price.times(quantity).floor();
    const tax = subtotal.times(D(form.taxRatePercent).div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const filmMeterUnit = line === "film"
      ? quantity.gt(0) && parseDecimal(form.filmOrderLengthM)
        ? unit.times(parseDecimal(form.filmOrderLengthM)!).div(quantity)
        : D(form.filmMeterPrice)
      : D(form.filmMeterPrice);

    applyPatch({
      pricePerPieceDisplay: price.toString(),
      fillingUnitDisplay: fillingUnit.toString(),
      fillingAmountDisplay: fillingAmount.toString(),
      filmUnitDisplay: filmMeterUnit.toString(),
      filmPouchUnitDisplay: filmUnit.toString(),
      filmAmountDisplay: filmAmount.toString(),
      adjustmentDisplay: subtotal.minus(fillingAmount).minus(filmAmount).toString(),
      subtotalDisplay: subtotal.toString(),
      taxDisplay: tax.toString(),
      grandTotalDisplay: subtotal.plus(tax).toString(),
    });
  };

  const commitLineAmount = (line: "filling" | "film", raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const amount = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || amount === null || amount.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(line === "filling" ? shownTotals?.fillingAmount ?? "0" : shownTotals?.filmAmount ?? "0"));
      return;
    }
    void commitLineUnit(line, amount.div(quantity).toString(), node);
  };

  const commitSheetSubtotal = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const subtotal = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || subtotal === null || subtotal.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.subtotal ?? "0"));
      return;
    }
    const oldPrice = D(shownTotals.pricePerPiece);
    const newPrice = subtotal.div(quantity);
    const scale = oldPrice.gt(0) ? newPrice.div(oldPrice) : D(1);
    const fillingUnit = D(shownTotals.fillingUnit).times(scale);
    const filmUnit = D(shownTotals.filmPouchUnit).times(scale);
    const fillingAmount = fillingUnit.times(quantity);
    const filmAmount = filmUnit.times(quantity);
    const tax = subtotal.times(D(form.taxRatePercent).div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

    applyPatch({
      pricePerPieceDisplay: newPrice.toString(),
      fillingUnitDisplay: fillingUnit.toString(),
      fillingAmountDisplay: fillingAmount.toString(),
      filmPouchUnitDisplay: filmUnit.toString(),
      filmAmountDisplay: filmAmount.toString(),
      adjustmentDisplay: subtotal.minus(fillingAmount).minus(filmAmount).toString(),
      subtotalDisplay: subtotal.toString(),
      taxDisplay: tax.toString(),
      grandTotalDisplay: subtotal.plus(tax).toString(),
    });
  };

  const commitSheetTax = (raw: string, node: HTMLElement) => {
    const tax = parseDisplayedNumber(raw);
    if (!shownTotals || tax === null || tax.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.tax ?? "0"));
      return;
    }
    const subtotal = D(shownTotals.subtotal);
    applyPatch({ taxDisplay: tax.toString(), grandTotalDisplay: subtotal.plus(tax).toString() });
  };

  const commitSheetGrandTotal = (raw: string, node: HTMLElement) => {
    const grandTotal = parseDisplayedNumber(raw);
    const taxRate = parseDecimal(form.taxRatePercent);
    if (!shownTotals || grandTotal === null || grandTotal.lt(0) || !taxRate || taxRate.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.grandTotal ?? "0"));
      return;
    }
    const subtotal = grandTotal.div(D(1).plus(taxRate.div(100))).floor();
    commitSheetSubtotal(subtotal.toString(), node);
    applyPatch({ grandTotalDisplay: grandTotal.toString(), taxDisplay: grandTotal.minus(subtotal).toString() });
  };

  const commitAdjustment = (raw: string, node: HTMLElement) => {
    const adjustment = parseDisplayedNumber(raw);
    if (!shownTotals || adjustment === null) {
      rejectInvalidNumber(node, shownTotals?.adjustment ?? "0");
      return;
    }
    const subtotal = D(shownTotals.fillingAmount).plus(shownTotals.filmAmount).plus(adjustment).floor();
    const tax = subtotal.times(D(form.taxRatePercent).div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    applyPatch({ adjustmentDisplay: adjustment.toString(), subtotalDisplay: subtotal.toString(), taxDisplay: tax.toString(), grandTotalDisplay: subtotal.plus(tax).toString() });
  };

  const commitQuantity = (raw: string, node: HTMLElement) => {
    const quantity = parseDisplayedNumber(raw);
    if (!quantity || quantity.lte(0)) {
      rejectInvalidNumber(node, formatNumber(form.quantity, 0));
      return;
    }
    applyPatch({
      quantity: quantity.toString(),
      fillingAmountDisplay: "",
      filmAmountDisplay: "",
      adjustmentDisplay: "",
      subtotalDisplay: "",
      taxDisplay: "",
      grandTotalDisplay: "",
    });
  };

  const commitFilmMeterUnit = (raw: string, node: HTMLElement) => {
    const meterUnit = parseDisplayedNumber(raw);
    const quantity = parseDecimal(form.quantity);
    const orderLength = parseDecimal(form.filmOrderLengthM);
    if (!shownTotals || meterUnit === null || meterUnit.lt(0) || !quantity || !quantity.gt(0) || !orderLength || orderLength.lte(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.filmUnit ?? form.filmMeterPrice));
      return;
    }
    commitLineUnit("film", meterUnit.times(orderLength).div(quantity).toString(), node);
  };


  return (
    <main className={`quote-page ${mobileDrawer ? `drawer-open drawer-${mobileDrawer}` : ""}`}>
      <section className="panel quote-toolbar" aria-labelledby="quote-toolbar-title">
        <div>
          <h1 id="quote-toolbar-title">見積書発行</h1>
          <p>中央のA4見積書を直接編集できます。金額・数量・文面をクリックしてその場で修正してください。</p>
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
                  <strong><EditableText value={form.issuerName} label="発行者名" onCommit={(next) => update("issuerName", next.trim())} /></strong>
                  <small><EditableText value={form.issuerEnglishName} label="発行者英字名" onCommit={(next) => update("issuerEnglishName", next.trim())} /></small>
                </div>
              </div>
              <address>
                <EditableText value={form.representative} label="代表者" onCommit={(next) => update("representative", next.trim())} /><br />
                <EditableText value={`${form.issuerPostalCode} ${form.issuerAddress}`} label="発行者住所" onCommit={(next) => {
                  const match = next.trim().match(/^(\S+)\s+(.+)$/);
                  applyPatch({ issuerPostalCode: match?.[1] ?? next.trim(), issuerAddress: match?.[2] ?? "" });
                }} /><br />
                <EditableText value={`${form.issuerTelephone} / ${form.issuerWebsite}`} label="電話番号とウェブサイト" onCommit={(next) => {
                  const [telephone, website] = next.split("/").map((item) => item.trim());
                  applyPatch({ issuerTelephone: telephone ?? "", issuerWebsite: website ?? "" });
                }} />
              </address>
            </div>
            <div className="document-title">
              <p className="english"><EditableText value={form.documentEnglish} label="文書英字タイトル" onCommit={(next) => update("documentEnglish", next.trim())} /></p>
              <h2><EditableText value={form.documentHeading} label="文書タイトル" onCommit={(next) => update("documentHeading", next.trim())} /></h2>
              <dl>
                <div><dt>見積番号</dt><dd>{form.quotationNumber || "-"}</dd></div>
                <div><dt>発行日</dt><dd>{form.issueDate || "-"}</dd></div>
              </dl>
            </div>
          </header>

          <section className="recipient-block">
            <p className="customer"><EditableText value={form.customerName || "得意先名未入力"} label="得意先名" onCommit={(next) => update("customerName", next.trim())} /></p>
            <p><EditableText value={`${form.customerContact ? `${form.customerContact} 御中` : "御中"}`} label="得意先担当者" onCommit={(next) => update("customerContact", next.replace(/御中$/, "").trim())} /></p>
            <p className="greeting"><EditableText value={form.greeting} label="宛先文言" multiline onCommit={(next) => update("greeting", next)} /></p>
          </section>

          {shownTotals ? (
            <>
              <section className="price-highlight">
                <div>
                  <span>お見積単価（税抜）</span>
                  <strong data-testid="quote-price-per-piece">
                    <EditableText value={moneyDisplay(shownTotals.pricePerPiece, form.pricePerPieceDisplay, 2)} label="お見積単価" className="money" onCommit={commitSheetPrice} />
                    <small> /枚</small>
                  </strong>
                </div>
                <div>
                  <span>数量</span>
                  <strong><EditableText value={numberDisplay(form.quantity)} label="数量" className="money" onCommit={commitQuantity} /><small> 枚</small></strong>
                </div>
                <div>
                  <span>税込合計</span>
                  <strong><EditableText value={moneyDisplay(shownTotals.grandTotal, form.grandTotalDisplay)} label="税込合計" className="money" onCommit={commitSheetGrandTotal} /></strong>
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
                      <strong><EditableText value={form.fillingItemName} label="充填・加工項目名" onCommit={(next) => update("fillingItemName", next.trim())} /></strong>
                      <small><EditableText value={form.fillingItemDescription} label="充填・加工説明" multiline onCommit={(next) => update("fillingItemDescription", next)} /></small>
                    </td>
                    <td data-testid="filling-unit-price"><EditableText value={moneyDisplay(shownTotals.fillingUnit, form.fillingUnitDisplay, 2)} label="充填・加工単価" className="money" onCommit={(next, node) => commitLineUnit("filling", next, node)} /></td>
                    <td><EditableText value={numberDisplay(form.quantity)} label="充填・加工数量" className="money" onCommit={commitQuantity} /> 枚</td>
                    <td><EditableText value={moneyDisplay(shownTotals.fillingAmount, form.fillingAmountDisplay)} label="充填・加工金額" className="money" onCommit={(next, node) => commitLineAmount("filling", next, node)} /></td>
                  </tr>
                  <tr>
                    <td>
                      <strong><EditableText value={form.filmItemName} label="フィルム項目名" onCommit={(next) => update("filmItemName", next.trim())} /></strong>
                      <small><EditableText value={form.filmItemDescription} label="フィルム説明" multiline onCommit={(next) => update("filmItemDescription", next)} /></small>
                      <small className="film-composition" data-testid="film-composition">構成：<EditableText value={form.filmComposition || DEFAULT_FILM_COMPOSITION} label="フィルム構成" onCommit={(next) => update("filmComposition", next.trim())} /></small>
                      <small data-testid="film-order-summary">材料参考 <EditableText value={moneyDisplay(shownTotals.filmUnit, form.filmUnitDisplay)} label="フィルムm単価" className="money" onCommit={commitFilmMeterUnit} /> /m × <span data-testid="film-order-length"><EditableText value={numberDisplay(shownTotals.filmOrderLength, form.filmOrderLengthM)} label="フィルム発注長さ" onCommit={(next) => update("filmOrderLengthM", parseDisplayedNumber(next)?.toString() ?? form.filmOrderLengthM)} /> m</span></small>
                    </td>
                    <td>
                      <strong data-testid="film-pouch-price"><EditableText value={moneyDisplay(shownTotals.filmPouchUnit, form.filmPouchUnitDisplay, 2)} label="フィルムパウチ換算単価" className="money" onCommit={(next, node) => commitLineUnit("film", next, node)} /> /枚</strong>
                      <small data-testid="film-meter-price">材料参考 <EditableText value={moneyDisplay(shownTotals.filmUnit, form.filmUnitDisplay)} label="フィルムm単価" className="money" onCommit={commitFilmMeterUnit} /> /m</small>
                    </td>
                    <td><EditableText value={numberDisplay(form.quantity)} label="フィルム数量" className="money" onCommit={commitQuantity} /> 枚</td>
                    <td><EditableText value={moneyDisplay(shownTotals.filmAmount, form.filmAmountDisplay)} label="フィルム金額" className="money" onCommit={(next, node) => commitLineAmount("film", next, node)} /></td>
                  </tr>
                  <tr>
                    <td>
                      <strong><EditableText value={form.roundingItemName} label="端数調整項目名" onCommit={(next) => update("roundingItemName", next.trim())} /></strong>
                      <small><EditableText value={form.roundingItemDescription} label="端数調整説明" multiline onCommit={(next) => update("roundingItemDescription", next)} /></small>
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td data-testid="rounding-adjustment">
                      <EditableText value={shownTotals.adjustment === "-" ? "-" : moneyDisplay(shownTotals.adjustment, form.adjustmentDisplay === "" ? undefined : form.adjustmentDisplay)} label="端数調整" className="money" onCommit={commitAdjustment} />
                    </td>
                  </tr>
                </tbody>
              </table>

              <section className="total-block">
                <div><span><EditableText value={form.subtotalLabel} label="小計ラベル" onCommit={(next) => update("subtotalLabel", next.trim())} /></span><strong><EditableText value={moneyDisplay(shownTotals.subtotal, form.subtotalDisplay)} label="小計" className="money" onCommit={commitSheetSubtotal} /></strong></div>
                <div><span><EditableText value={form.taxLabel || `消費税（${formatNumber(Number(form.taxRatePercent), 0)}%）`} label="消費税ラベル" onCommit={(next) => update("taxLabel", next.trim())} /></span><strong><EditableText value={moneyDisplay(shownTotals.tax, form.taxDisplay)} label="消費税" className="money" onCommit={commitSheetTax} /></strong></div>
                <div className="grand"><span><EditableText value={form.grandTotalLabel} label="合計ラベル" onCommit={(next) => update("grandTotalLabel", next.trim())} /></span><strong><EditableText value={moneyDisplay(shownTotals.grandTotal, form.grandTotalDisplay)} label="合計" className="money" onCommit={commitSheetGrandTotal} /></strong></div>
              </section>
            </>
          ) : (
            <p className="error sheet-error">金額計算に必要な入力が不正です。右側の編集パネルを確認してください。</p>
          )}

          <section className="terms">
            <dl>
              <div><dt>納期</dt><dd><EditableText value={form.deliveryDate || "-"} label="納期" onCommit={(next) => update("deliveryDate", next.trim())} /></dd></div>
              <div><dt>お支払条件</dt><dd><EditableText value={form.paymentTerms || "-"} label="お支払条件" onCommit={(next) => update("paymentTerms", next.trim())} /></dd></div>
              <div><dt>見積有効期限</dt><dd><EditableText value={form.validUntil || "-"} label="見積有効期限" onCommit={(next) => update("validUntil", next.trim())} /></dd></div>
            </dl>
            <p className="notes"><strong>備考</strong><EditableText value={form.notes ? ` ${form.notes}` : ""} label="備考" multiline onCommit={(next) => update("notes", next)} /></p>
          </section>

          <footer className="sheet-footer">
            <p><EditableText value={form.footerNote} label="フッター文言" multiline onCommit={(next) => update("footerNote", next)} /></p>
            <div className="approval">
              <span><EditableText value={form.issuerName} label="承認発行者名" onCommit={(next) => update("issuerName", next.trim())} /></span>
              <span className="seal" aria-hidden="true"><EditableText value={form.sealText} label="社内判文言" onCommit={(next) => update("sealText", next.trim())} /></span>
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
      <>
        {renderQuotationGuide()}
      <details className="editor-group">
        <summary>明細・金額</summary>
        <div className="editor-grid">
          <label>品名<input value={form.productName} onChange={(event) => update("productName", event.target.value)} /></label>
          <label>仕様<input value={form.sizeSummary} onChange={(event) => update("sizeSummary", event.target.value)} /></label>
          <label>数量（枚）<input inputMode="numeric" value={form.quantity} onChange={(event) => update("quantity", event.target.value)} /></label>
          <label>充填・加工 項目名<input value={form.fillingItemName} onChange={(event) => update("fillingItemName", event.target.value)} /></label>
          <label className="wide">充填・加工 説明<textarea rows={2} value={form.fillingItemDescription} onChange={(event) => update("fillingItemDescription", event.target.value)} /></label>
          <label>充填・加工 単価（空欄=自動）<input inputMode="decimal" value={form.fillingUnitDisplay} onChange={(event) => update("fillingUnitDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>充填・加工 金額（空欄=自動）<input inputMode="decimal" value={form.fillingAmountDisplay} onChange={(event) => update("fillingAmountDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>フィルム 項目名<input value={form.filmItemName} onChange={(event) => update("filmItemName", event.target.value)} /></label>
          <label className="wide">フィルム 説明<textarea rows={2} value={form.filmItemDescription} onChange={(event) => update("filmItemDescription", event.target.value)} /></label>
          <label className="wide">フィルム構成<input value={form.filmComposition} onChange={(event) => update("filmComposition", event.target.value)} placeholder={DEFAULT_FILM_COMPOSITION} /></label>
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
          <label>目標利益率（%）<input inputMode="decimal" value={isFiniteNumber(form.targetMargin) ? D(form.targetMargin).times(100).toDecimalPlaces(2, Decimal.ROUND_DOWN).toString() : ""} onChange={(event) => {
            const raw = event.target.value.trim();
            if (raw === "") {
              update("targetMargin", "");
              return;
            }
            const percent = Number(raw);
            if (Number.isFinite(percent)) update("targetMargin", (percent / 100).toString());
          }} /></label>
        </div>
      </details>
      </>
    );
  }

  function renderQuotationGuide() {
    const isPriceOverride = isFiniteNumber(form.pricePerPieceDisplay);

    return (
      <details className="editor-group calculation-guide" open data-testid="quote-calculation-guide">
        <summary>直接編集ガイド</summary>
        <div className="calc-guide">
          <p className="calc-formula">
            中央のA4用紙が入力画面です。<strong>「￥」金額・数量・品名・備考をクリック</strong>すると、表示されている文字をそのまま編集できます。
          </p>
          <ol className="calc-steps">
            <li>見積単価を <strong>￥39 → ￥8.1</strong> のように変えると、小計・消費税・合計と明細配分が自動的に更新されます。</li>
            <li>明細の単価・金額を変えた場合も、見積単価と合計が追従します。</li>
            <li>原価・利益の内部計算は保存時に記録し、帳票には表示しません。</li>
          </ol>

          <p className={`calc-mode ${isPriceOverride ? "override" : "auto"}`}>
            {isPriceOverride ? "現在：見積単価 override 中" : "現在：目標利益率による自動計算"}
          </p>
        </div>
      </details>
    );
  }
}
