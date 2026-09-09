"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ceilTo, D, Decimal, parseDecimal } from "@/lib/decimal";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import {
  QUOTATION_DRAFT_KEY,
  parseQuotationDraft,
  sevenChemical,
  type QuotationDraft,
} from "@/lib/quotation-draft";
import { DEFAULT_FILM_COMPOSITION, QUOTATION_RESTORE_KEY } from "@/lib/quotation-shared";

const LAST_CHECKLIST_URL_KEY = "pouch-last-checklist-url-v1";
import type { PurchaseOrderSnapshot } from "@/lib/purchase-order";
import type { CalculationChecklistSnapshot } from "@/lib/calculation-checklist";

type QuoteForm = {
  quotationNumber: string;
  issueDate: string;
  validUntil: string;
  customerName: string;
  customerContact: string;
  customerCode: string;
  customerPostalCode: string;
  customerAddress: string;
  customerTelephone: string;
  customerEmail: string;
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
  customItemName: string;
  customItemDescription: string;
  customLotCost: string;
  customQuantity: string;
  customUnitDisplay: string;
  customAmountDisplay: string;
  printingMethod: string;
  copperItemName: string;
  copperItemDescription: string;
  copperUnitDisplay: string;
  copperAmountDisplay: string;
  copperPlateCostPerPiece: string;
  copperColorCount: string;
  orderPatternCount: string;
  deliverablePatternLengthM: string;
  recommendedQuantity: string;
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
  purchaseOrderJson: string;
};

const defaultQuote: QuoteForm = {
  quotationNumber: "",
  issueDate: "",
  validUntil: "",
  customerName: "",
  customerContact: "",
  customerCode: "",
  customerPostalCode: "",
  customerAddress: "",
  customerTelephone: "",
  customerEmail: "",
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
  customItemName: "金型費用",
  customItemDescription: "カスタム金型制作一式（ロット1回）",
  customLotCost: "0",
  customQuantity: "1",
  customUnitDisplay: "",
  customAmountDisplay: "",
  printingMethod: "digital",
  copperItemName: "新規銅版費",
  copperItemDescription: "グラビア印刷用新規銅版一式（版費は発注数量へ配賦）",
  copperUnitDisplay: "",
  copperAmountDisplay: "",
  copperPlateCostPerPiece: "0",
  copperColorCount: "0",
  orderPatternCount: "0",
  deliverablePatternLengthM: "0",
  recommendedQuantity: "",
  filmItemName: "フィルム費用",
  filmItemDescription: "発注ロットに応じた単価を適用したフィルム製作・物流の一式",
  filmComposition: DEFAULT_FILM_COMPOSITION,
  filmUnitDisplay: "",
  filmPouchUnitDisplay: "",
  filmAmountDisplay: "",
  roundingItemName: "端数調整",
  roundingItemDescription: "合計金額に端数が生じた場合のみ調整します。",
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
  purchaseOrderJson: "",
};

function isFiniteNumber(value: string) {
  return parseDecimal(value) !== null;
}

const FILM_METER_PRICE_MIN = D(380);
const FILM_METER_PRICE_MAX = D(480);

function recommendedFilmMeterUnit(orderLength: string) {
  const length = D(orderLength);
  if (length.gte(1500)) return D(380);
  if (length.gte(1000)) return D(410);
  if (length.gte(500)) return D(450);
  return D(480);
}

function clampFilmMeterUnit(value: Decimal) {
  return Decimal.min(FILM_METER_PRICE_MAX, Decimal.max(FILM_METER_PRICE_MIN, value));
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
  const [savedRecordId, setSavedRecordId] = useState<number | null>(null);
  const [checklistUrl, setChecklistUrl] = useState("");
  const [checklistOpening, setChecklistOpening] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [mobileDrawer, setMobileDrawer] = useState<"left" | "right" | null>(null);
  const [isMobileWorkspace, setIsMobileWorkspace] = useState(false);
  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrderSnapshot | null>(null);
  const [calculationChecklistSnapshot, setCalculationChecklistSnapshot] = useState<CalculationChecklistSnapshot | null>(null);

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
        const checklistUrl = sessionStorage.getItem(LAST_CHECKLIST_URL_KEY) ?? "";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorageはSSR後にしか読めない意図的な復元処理です。
      setChecklistUrl(checklistUrl);
      const restored = JSON.parse(restoreRaw) as Partial<QuoteForm> & {
          resultHash?: unknown;
          purchaseOrder?: PurchaseOrderSnapshot;
          purchaseOrderJson?: string;
          calculationChecklistSnapshot?: CalculationChecklistSnapshot;
        };
        const restoredForm = { ...defaultQuote };
        (Object.keys(defaultQuote) as (keyof QuoteForm)[]).forEach((key) => {
          const value = restored[key];
          if (typeof value === "string") restoredForm[key] = value;
        });
        setForm(restoredForm);
        try {
          const rawPurchaseOrder = restored.purchaseOrderJson ?? (restored.purchaseOrder ? JSON.stringify(restored.purchaseOrder) : "");
          const rawChecklistSnapshot = restored.calculationChecklistSnapshot;
          setCalculationChecklistSnapshot(rawChecklistSnapshot ? rawChecklistSnapshot as CalculationChecklistSnapshot : null);
          setPurchaseOrder(rawPurchaseOrder ? JSON.parse(rawPurchaseOrder) as PurchaseOrderSnapshot : null);
        } catch { setPurchaseOrder(null); }
        setSourceVersion(typeof restored.resultHash === "string" ? restored.resultHash : "");
        sessionStorage.removeItem(QUOTATION_RESTORE_KEY);
        setStorageLoaded(true);
        return;
      }

      const raw = sessionStorage.getItem(QUOTATION_DRAFT_KEY);
      const draft = parseQuotationDraft(JSON.parse(raw ?? "null"));
      setChecklistUrl(sessionStorage.getItem(LAST_CHECKLIST_URL_KEY) ?? "");
      if (draft) {
        setForm((old) => ({
          ...old,
          productName: draft.productSummary,
          sizeSummary: draft.sizeSummary,
          quantity: draft.quantity,
          customerName: draft.customerName ?? old.customerName,
          customerCode: draft.customerCode ?? old.customerCode,
          customerPostalCode: draft.customerPostalCode ?? old.customerPostalCode,
          customerAddress: draft.customerAddress ?? old.customerAddress,
          customerContact: draft.customerContact ?? old.customerContact,
          customerTelephone: draft.customerTelephone ?? old.customerTelephone,
          customerEmail: draft.customerEmail ?? old.customerEmail,
          customLotCost: draft.customLotCost ?? "0",
          customQuantity: draft.customQuantity ?? "1",
          fillingCostPerPiece: draft.fillingCostPerPiece,
          printingMethod: draft.printingMethod ?? "digital",
          copperPlateCostPerPiece: draft.copperPlateCostPerPiece ?? "0",
          copperColorCount: draft.copperColorCount ?? old.copperColorCount,
          orderPatternCount: draft.orderPatternCount ?? "0",
          deliverablePatternLengthM: draft.deliverablePatternLengthM ?? "0",
          recommendedQuantity: draft.recommendedQuantity ?? "",
          filmCostPerPiece: draft.filmCostPerPiece,
          filmMeterPrice: draft.filmMeterPrice,
          filmOrderLengthM: draft.filmOrderLengthM,
          targetMargin: draft.targetMargin,
          purchaseOrderJson: draft.purchaseOrder ? JSON.stringify(draft.purchaseOrder) : "",
        }));
        setPurchaseOrder(draft.purchaseOrder ?? null);
        setCalculationChecklistSnapshot(draft.calculationChecklistSnapshot ?? null);
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

  const updateTargetMargin = (value: string) => applyPatch({
    targetMargin: value,
    // 利益率変更後の手動表示値は古いため、自動計算へ戻す。
    fillingUnitDisplay: "",
    fillingAmountDisplay: "",
    filmUnitDisplay: "",
    filmPouchUnitDisplay: "",
    filmAmountDisplay: "",
    copperUnitDisplay: "",
    copperAmountDisplay: "",
    customUnitDisplay: "",
    customAmountDisplay: "",
    pricePerPieceDisplay: "",
    adjustmentDisplay: "",
    subtotalDisplay: "",
    taxDisplay: "",
    grandTotalDisplay: "",
  });

  const saveToHistory = async (): Promise<string | false> => {
    if (!totals) return false;
    if (!shownTotals) return false;
    setSaving(true);
    setSaveError("");
    try {
      const customQuantity = D(form.customQuantity || "1");
      const costUnit = D(form.fillingCostPerPiece).plus(form.filmCostPerPiece).plus(form.copperPlateCostPerPiece).plus(D(form.customLotCost).div(customQuantity));
      const sellingUnit = D(shownTotals.pricePerPiece);
      const profitUnit = sellingUnit.minus(costUnit);
      const profitMargin = sellingUnit.gt(0) ? profitUnit.div(sellingUnit) : D(0);
      const markupRate = costUnit.gt(0) ? profitUnit.div(costUnit) : D(0);
      const targetMargin = D(form.targetMargin);
      const profitAudit = {
        basis: "displayed-unit-price",
        printingMethod: form.printingMethod,
        quantity: form.quantity,
        fillingCostPerPiece: form.fillingCostPerPiece,
        filmCostPerPiece: form.filmCostPerPiece,
        copperPlateCostPerPiece: form.copperPlateCostPerPiece,
        customLotCost: form.customLotCost,
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
          filmCostPerPiece: D(form.filmCostPerPiece).plus(form.copperPlateCostPerPiece).toString(),
          pricePerPiece: shownTotals.pricePerPiece.toString(),
          subtotal: shownTotals.subtotal.toString(),
          tax: shownTotals.tax.toString(),
          grandTotal: shownTotals.grandTotal.toString(),
          calculationVersion: sourceVersion ? "simulator-linked" : "manual-entry",
          resultHash: sourceVersion,
          payload: {
            ...form,
            // 見積書に実際に表示された値を履歴用スナップショットとして固定する。
            // 自動計算値はform上は空欄のため、表示用に確定した値を上書きする。
            fillingUnitDisplay: shownTotals.fillingUnit,
            fillingAmountDisplay: shownTotals.fillingAmount,
            copperUnitDisplay: shownTotals.copperColorUnit,
            copperColorCount: shownTotals.copperColorCount,
            copperAmountDisplay: shownTotals.copperAmount,
            customUnitDisplay: shownTotals.customUnit,
            customAmountDisplay: shownTotals.customAmount,
            purchaseOrder: purchaseOrder,
            calculationChecklistSnapshot: calculationChecklistSnapshot,
            filmUnitDisplay: shownTotals.filmUnit,
            filmPouchUnitDisplay: shownTotals.filmPouchUnit,
            filmAmountDisplay: shownTotals.filmAmount,
            adjustmentDisplay: shownTotals.adjustment,
            pricePerPieceDisplay: shownTotals.pricePerPiece,
            subtotalDisplay: shownTotals.subtotal,
            taxDisplay: shownTotals.tax,
            grandTotalDisplay: shownTotals.grandTotal,
            resultHash: sourceVersion,
            profitAudit,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "save_failed");
      const checklistUrl = `/checklists/${payload.record.id}`;
      setSavedRecordId(Number(payload.record.id));
      setChecklistUrl(checklistUrl);
      sessionStorage.setItem(LAST_CHECKLIST_URL_KEY, checklistUrl);
      setSavedAt(new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }));
      return checklistUrl;
    } catch {
      setSaveError("履歴DBに保存できませんでした。テスト環境ではデータが保持されない場合があります。");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const openChecklist = async () => {
    if (!valid || checklistOpening) return;
    setChecklistOpening(true);
    const url = await saveToHistory();
    setChecklistOpening(false);
    if (url) window.location.assign(url);
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
  const parsedCopperCost = parseDecimal(form.copperPlateCostPerPiece);
  const parsedCustomLotCost = parseDecimal(form.customLotCost);
  const parsedCustomQuantity = parseDecimal(form.customQuantity);
  const parsedFilmMeterPrice = parseDecimal(form.filmMeterPrice);
  const parsedFilmOrderLength = parseDecimal(form.filmOrderLengthM);

  const valid = !!parsedQuantity && parsedQuantity.gt(0)
    && !!parsedFillingCost && parsedFillingCost.gte(0)
    && !!parsedFilmCost && parsedFilmCost.gte(0)
    && !!parsedCopperCost && parsedCopperCost.gte(0)
  && !!parsedCustomLotCost && parsedCustomLotCost.gte(0)
  && !!parsedCustomQuantity && parsedCustomQuantity.gt(0)
    && !!parsedTargetMargin && parsedTargetMargin.gt(0) && parsedTargetMargin.lt(1)
    && !!parsedTaxRatePercent && parsedTaxRatePercent.gte(0);

  const totals = (() => {
    if (!valid || !parsedQuantity || !parsedTargetMargin || !parsedTaxRatePercent || !parsedFillingCost || !parsedFilmCost || !parsedCopperCost || !parsedCustomLotCost || !parsedCustomQuantity || !parsedFilmMeterPrice || !parsedFilmOrderLength) return null;
    const quantity = parsedQuantity;
    const margin = parsedTargetMargin;
    const taxRate = parsedTaxRatePercent.div(100);
    const fillingSellingUnit = parsedFillingCost.div(D(1).minus(parsedTargetMargin ?? D(0)));
    const copperSellingUnit = parsedCopperCost.div(D(1).minus(parsedTargetMargin ?? D(0)));
    const filmSellingUnit = parsedFilmCost.div(D(1).minus(parsedTargetMargin ?? D(0)));
    const customLotSaleBase = parsedCustomLotCost
      .div(parsedCustomQuantity)
      .div(D(1).minus(parsedTargetMargin ?? D(0)));
    const customSellingUnit = ceilTo(customLotSaleBase, 1000);
    const customSaleTotal = customSellingUnit.times(parsedCustomQuantity);
    const customSalePerPiece = customSaleTotal.div(quantity);
    const filmMeterDisplayUnit = parsedFilmMeterPrice;
    // 目標総額にフィルム販売額を含めないと、充填・加工の残額計算が不正になる。
    const pricePerPiece = fillingSellingUnit.plus(copperSellingUnit).plus(filmSellingUnit).plus(customSalePerPiece);
    const subtotalBeforeAdjustment = pricePerPiece.times(quantity);
    const subtotal = subtotalBeforeAdjustment.floor();
    const roundingAdjustment = subtotal.minus(subtotalBeforeAdjustment);
    const tax = subtotal.times(taxRate).toDecimalPlaces(0);
    return {
      quantity,
      fillingSellingUnit,
      copperSellingUnit,
      filmSellingUnit,
      customSalePerPiece,
      customUnit: customSellingUnit,
      customSaleTotal,
      filmMeterDisplayUnit,
      filmOrderLength: parsedFilmOrderLength,
      roundingAdjustment,
      pricePerPiece,
      fillingAmount: fillingSellingUnit.times(quantity),
      copperAmount: copperSellingUnit.times(quantity),
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
    const targetTotal = totalPriceInput.times(totals.quantity);
    const parsedCopperColorCount = parseDecimal(form.copperColorCount);
    const copperColorCount = parsedCopperColorCount && parsedCopperColorCount.gt(0)
      ? parsedCopperColorCount
      : purchaseOrder?.colorCount && purchaseOrder.colorCount > 0
        ? D(purchaseOrder.colorCount)
        : D(1);
    const copperColorUnit = parseDecimal(form.copperUnitDisplay)
      ?? (copperColorCount.gt(0)
        ? totals.copperSellingUnit.times(totals.quantity).div(copperColorCount).toDecimalPlaces(0, Decimal.ROUND_CEIL)
        : D(0));
    const copperAmount = parseDecimal(form.copperAmountDisplay) ?? copperColorUnit.times(copperColorCount);
    const copperUnit = totals.quantity.gt(0) ? copperAmount.div(totals.quantity) : D(0);
    const customQuantity = parseDecimal(form.customQuantity) ?? D(1);
    const customUnitOverride = parseDecimal(form.customUnitDisplay);
    const customUnit = customUnitOverride
      ? ceilTo(customUnitOverride, 1000)
      : totals.customUnit;

    const isGravure = form.printingMethod === "gravure";
    let fillingUnit: Decimal;
    let filmMeterUnit: Decimal;
    if (isGravure) {
      // 그라비아는 길이가 5,500m 단위라 디지털용 380~480엔/m 밴드를 적용하지 않는다.
      // 충전·가공 판매금액을 먼저 확보하고, 잔액을 m당 판매단가로 환산한다.
      fillingUnit = parseDecimal(form.fillingUnitDisplay)
        ?? (totals.quantity.gt(0)
          ? roundUnit((parsedFillingCost ?? D(0)).div(D(1).minus(parsedTargetMargin ?? D(0))))
          : D(0));
      const provisionalFillingAmount = fillingUnit.times(totals.quantity);
      const residualFilmAmount = Decimal.max(
        targetTotal.minus(provisionalFillingAmount).minus(copperAmount),
        0,
      );
      filmMeterUnit = parseDecimal(form.filmUnitDisplay)
        ?? (totals.filmOrderLength.gt(0)
          ? residualFilmAmount.div(totals.filmOrderLength).toDecimalPlaces(2, Decimal.ROUND_UP)
          : D(0));
    } else {
      const requestedFilmMeterUnit = parseDecimal(form.filmUnitDisplay)
        ?? recommendedFilmMeterUnit(form.filmOrderLengthM);
      filmMeterUnit = clampFilmMeterUnit(requestedFilmMeterUnit);
      const filmAmount = filmMeterUnit.times(totals.filmOrderLength);
      const remainingFillingAmount = Decimal.max(targetTotal.minus(filmAmount).minus(copperAmount), 0);
      fillingUnit = parseDecimal(form.fillingUnitDisplay)
        ?? (totals.quantity.gt(0)
          ? roundUnit(remainingFillingAmount.div(totals.quantity))
          : D(0));
    }
    // フィルム金額は円単位で確定する。円未満は四捨五入し、単価は換算値を表示する。
    const filmAmount = filmMeterUnit.times(totals.filmOrderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    if (totals.filmOrderLength.gt(0)) {
      filmMeterUnit = filmAmount.div(totals.filmOrderLength);
    }
    const fillingAmount = parseDecimal(form.fillingAmountDisplay) ?? fillingUnit.times(totals.quantity);
    const customAmount = parseDecimal(form.customAmountDisplay) ?? customUnit.times(customQuantity);
    const filmPouchUnit = totals.quantity.gt(0) ? filmAmount.div(totals.quantity) : D(0);
    const lineTotal = fillingAmount.plus(filmAmount).plus(copperAmount).plus(customAmount);
    const adjustment = form.adjustmentDisplay.trim() === "" ? "-" : form.adjustmentDisplay;
    const adjustmentAmount = adjustment === "-" ? D(0) : D(adjustment);
    const subtotal = parseDecimal(form.subtotalDisplay) ?? lineTotal.plus(adjustmentAmount);
    const tax = parseDecimal(form.taxDisplay) ?? subtotal.times(totals.taxRate).toDecimalPlaces(0);
    const grandTotal = parseDecimal(form.grandTotalDisplay) ?? subtotal.plus(tax);

    return {
      pricePerPiece: (totals.quantity.gt(0) ? lineTotal.div(totals.quantity) : D(0)).toString(),
      fillingUnit: fillingUnit.toString(),
      fillingAmount: fillingAmount.toString(),
      copperUnit: copperUnit.toString(),
      copperAmount: copperAmount.toString(),
      copperColorCount: copperColorCount.toString(),
      copperColorUnit: copperColorUnit.toString(),
      customUnit: customUnit.toString(),
      customAmount: customAmount.toString(),
      customQuantity: customQuantity.toString(),
      filmUnit: filmMeterUnit.toString(),
      filmPouchUnit: filmPouchUnit.toString(),
      filmAmount: filmAmount.toString(),
      filmOrderLength: totals.filmOrderLength.toString(),
      adjustment,
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
    const fillingUnit = D(shownTotals!.fillingUnit);
    const fillingAmount = fillingUnit.times(quantity);
    const copperAmount = D(shownTotals!.copperAmount);
    const customAmount = D(shownTotals!.customAmount);
    const filmAmount = Decimal.max(price.times(quantity).minus(fillingAmount).minus(copperAmount).minus(customAmount), 0);
    applyLineTotals(fillingUnit, filmAmount, copperAmount, customAmount);
  };

  const applyLineTotals = (fillingUnit: Decimal, filmAmount: Decimal, copperAmount: Decimal, customAmount: Decimal) => {
    const quantity = parseDecimal(form.quantity);
    const orderLength = parseDecimal(form.filmOrderLengthM);
    const copperColorCount = parseDecimal(form.copperColorCount) ?? D(1);
    if (!quantity || !quantity.gt(0) || !orderLength || !orderLength.gt(0)) return;
    const fillingAmount = fillingUnit.times(quantity);
    const filmMeterUnit = form.printingMethod === "gravure"
      ? filmAmount.div(orderLength)
      : clampFilmMeterUnit(filmAmount.div(orderLength));
    const clampedFilmAmount = filmMeterUnit.times(orderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const displayFilmMeterUnit = orderLength.gt(0) ? clampedFilmAmount.div(orderLength) : filmMeterUnit;
    const filmPouchUnit = clampedFilmAmount.div(quantity);
    const copperUnit = copperAmount.div(quantity);
    const customUnit = customAmount.div(quantity);
    const lineTotal = fillingAmount.plus(clampedFilmAmount).plus(copperAmount).plus(customAmount);
    const price = lineTotal.div(quantity);
    const subtotal = lineTotal;
    const tax = subtotal.times(D(form.taxRatePercent).div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    applyPatch({
      pricePerPieceDisplay: price.toString(),
      fillingUnitDisplay: fillingUnit.toString(),
      fillingAmountDisplay: fillingAmount.toString(),
      filmUnitDisplay: displayFilmMeterUnit.toString(),
      filmPouchUnitDisplay: filmPouchUnit.toString(),
      filmAmountDisplay: clampedFilmAmount.toString(),
      copperUnitDisplay: copperColorCount.gt(0) ? copperAmount.div(copperColorCount).toString() : copperUnit.toString(),
      copperAmountDisplay: copperAmount.toString(),
      customUnitDisplay: customUnit.toString(),
      customAmountDisplay: customAmount.toString(),
      adjustmentDisplay: "-",
      subtotalDisplay: subtotal.toString(),
      taxDisplay: tax.toString(),
      grandTotalDisplay: subtotal.plus(tax).toString(),
    });
  };

  const commitFillingUnit = (raw: string, node: HTMLElement) => {
    const unit = parseDisplayedNumber(raw);
    if (!shownTotals || unit === null || unit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.fillingUnit ?? "0", undefined, 2));
      return;
    }
    applyLineTotals(unit, D(shownTotals.filmAmount), D(shownTotals.copperAmount), D(shownTotals.customAmount));
  };

  const commitFillingAmount = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const amount = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || amount === null || amount.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.fillingAmount ?? "0"));
      return;
    }
    commitFillingUnit(amount.div(quantity).toString(), node);
  };

  const commitFilmMeterUnit = (raw: string, node: HTMLElement) => {
    const orderLength = parseDecimal(form.filmOrderLengthM);
    const meterUnit = parseDisplayedNumber(raw);
    if (!shownTotals || !orderLength || !orderLength.gt(0) || meterUnit === null || meterUnit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.filmUnit ?? "0"));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), meterUnit.times(orderLength), D(shownTotals.copperAmount), D(shownTotals.customAmount));
  };

  const commitFilmPouchUnit = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const pouchUnit = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || pouchUnit === null || pouchUnit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.filmPouchUnit ?? "0", undefined, 2));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), pouchUnit.times(quantity), D(shownTotals.copperAmount), D(shownTotals.customAmount));
  };

  const commitFilmAmount = (raw: string, node: HTMLElement) => {
    const amount = parseDisplayedNumber(raw);
    if (!shownTotals || amount === null || amount.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.filmAmount ?? "0"));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), amount, D(shownTotals.copperAmount), D(shownTotals.customAmount));
  };

  const commitCopperUnit = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.copperColorCount);
    const unit = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || unit === null || unit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.copperUnit ?? "0", undefined, 2));
      return;
    }
    const copperAmount = unit.times(quantity);
    applyLineTotals(D(shownTotals.fillingUnit), D(shownTotals.filmAmount), copperAmount, D(shownTotals.customAmount));
  };

  const commitCopperAmount = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.copperColorCount);
    const amount = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || amount === null || amount.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.copperAmount ?? "0"));
      return;
    }
    commitCopperUnit(amount.div(quantity).toString(), node);
  };

  const commitCopperColorQuantity = (raw: string, node: HTMLElement) => {
    const quantity = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0)) {
      rejectInvalidNumber(node, numberDisplay(form.copperColorCount));
      return;
    }
    applyPatch({
      copperColorCount: quantity.toString(),
      copperUnitDisplay: "",
      copperAmountDisplay: "",
      fillingUnitDisplay: "",
      fillingAmountDisplay: "",
      filmUnitDisplay: "",
      filmPouchUnitDisplay: "",
      filmAmountDisplay: "",
      adjustmentDisplay: "",
      subtotalDisplay: "",
      taxDisplay: "",
      grandTotalDisplay: "",
    });
  };

  const commitCustomUnit = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.customQuantity);
    const unit = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || unit === null || unit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.customUnit ?? "0", undefined, 2));
      return;
    }
    const customAmount = unit.times(quantity);
    applyLineTotals(D(shownTotals.fillingUnit), D(shownTotals.filmAmount), D(shownTotals.copperAmount), customAmount);
  };

  const commitCustomAmount = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.customQuantity);
    const amount = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || amount === null || amount.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.customAmount ?? "0"));
      return;
    }
    commitCustomUnit(amount.div(quantity).toString(), node);
  };

  const commitCustomQuantity = (raw: string, node: HTMLElement) => {
    const quantity = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0)) {
      rejectInvalidNumber(node, formatNumber(form.customQuantity, 0));
      return;
    }
    applyPatch({
      customQuantity: quantity.toString(),
      customUnitDisplay: "",
      customAmountDisplay: "",
      fillingUnitDisplay: "",
      fillingAmountDisplay: "",
      filmUnitDisplay: "",
      filmPouchUnitDisplay: "",
      filmAmountDisplay: "",
      copperUnitDisplay: "",
      copperAmountDisplay: "",
      adjustmentDisplay: "",
      subtotalDisplay: "",
      taxDisplay: "",
      grandTotalDisplay: "",
    });
  };

  const commitSheetSubtotal = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const subtotal = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || subtotal === null || subtotal.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.subtotal ?? "0"));
      return;
    }
    const copperAmount = D(shownTotals.copperAmount);
    const oldVariableTotal = D(shownTotals.fillingAmount).plus(shownTotals.filmAmount);
    const oldLineTotal = oldVariableTotal.plus(copperAmount);
    const fillingShare = oldLineTotal.gt(0) ? D(shownTotals.fillingAmount).div(oldLineTotal) : D(1);
    const filmShare = oldLineTotal.gt(0) ? D(shownTotals.filmAmount).div(oldLineTotal) : D(0);
    const fillingAmount = subtotal.times(fillingShare);
    const filmAmount = subtotal.times(filmShare);
    applyLineTotals(quantity.gt(0) ? fillingAmount.div(quantity) : D(0), filmAmount, copperAmount, D(shownTotals.customAmount));
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
    const subtotal = D(shownTotals.fillingAmount).plus(shownTotals.filmAmount).plus(shownTotals.copperAmount).plus(shownTotals.customAmount).plus(adjustment).floor();
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
      fillingUnitDisplay: "",
      fillingAmountDisplay: "",
      filmUnitDisplay: "",
      filmPouchUnitDisplay: "",
      filmAmountDisplay: "",
      copperUnitDisplay: "",
      copperAmountDisplay: "",
      customUnitDisplay: "",
      customAmountDisplay: "",
      adjustmentDisplay: "",
      subtotalDisplay: "",
      taxDisplay: "",
      grandTotalDisplay: "",
    });
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
          <button
            className="button secondary"
            type="button"
            disabled={!valid || saving || checklistOpening}
            title="現在の見積内容を保存し、計算確認チェックリストを開きます"
            data-testid="open-checklist"
            onClick={() => void openChecklist()}
          >
            {checklistOpening ? "チェックリスト作成中..." : "計算確認チェックリスト"}
          </button>
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

        <div className="sheet-scroll">
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
            <p className="customer-postal"><EditableText value={form.customerPostalCode || "〒"} label="得意先郵便番号" onCommit={(next) => update("customerPostalCode", next.trim())} /></p>
            <p className="customer-address"><EditableText value={form.customerAddress || "得意先住所未入力"} label="得意先住所" onCommit={(next) => update("customerAddress", next.trim())} /></p>
            <p className="customer"><EditableText value={form.customerName || "得意先名未入力"} label="得意先名" onCommit={(next) => update("customerName", next.trim())} /></p>
            <p><EditableText value={`${form.customerContact ? `${form.customerContact} 御中` : "御中"}`} label="得意先担当者" onCommit={(next) => update("customerContact", next.replace(/御中$/, "").trim())} /></p>
            <p className="help">顧客コード: {form.customerCode || "-"} ／ メール: {form.customerEmail || "-"}</p>
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
                    <td data-testid="filling-unit-price"><EditableText value={moneyDisplay(shownTotals.fillingUnit, form.fillingUnitDisplay, 2)} label="充填・加工単価" className="money" onCommit={commitFillingUnit} /></td>
                    <td><EditableText value={numberDisplay(form.quantity)} label="充填・加工数量" className="money" onCommit={commitQuantity} /> 枚</td>
                    <td><EditableText value={moneyDisplay(shownTotals.fillingAmount, form.fillingAmountDisplay)} label="充填・加工金額" className="money" onCommit={commitFillingAmount} /></td>
                  </tr>
                  <tr>
                    <td>
                      <strong><EditableText value={form.filmItemName} label="フィルム項目名" onCommit={(next) => update("filmItemName", next.trim())} /></strong>
                      <small><EditableText value={form.filmItemDescription} label="フィルム説明" multiline onCommit={(next) => update("filmItemDescription", next)} /></small>
                      <small className="film-composition" data-testid="film-composition">構成：<EditableText value={form.filmComposition || DEFAULT_FILM_COMPOSITION} label="フィルム構成" onCommit={(next) => update("filmComposition", next.trim())} /></small>
                      <small>フィルム金額は円未満を四捨五入します。</small>
                    </td>
                    <td>
                      <strong data-testid="film-meter-price"><EditableText value={moneyDisplay(shownTotals.filmUnit, form.filmUnitDisplay)} label="フィルム販売m単価" className="money" onCommit={commitFilmMeterUnit} /> /m</strong>
                      <small data-testid="film-pouch-price">パウチ換算 <EditableText value={moneyDisplay(shownTotals.filmPouchUnit, form.filmPouchUnitDisplay, 2)} label="フィルムパウチ換算単価" className="money" onCommit={(next, node) => commitFilmPouchUnit(next, node)} /> /枚</small>
                    </td>
                    <td><span data-testid="film-order-length"><EditableText value={numberDisplay(shownTotals.filmOrderLength, form.filmOrderLengthM)} label="フィルム発注長さ" onCommit={(next, node) => {
                      const length = parseDisplayedNumber(next);
                      if (!length || !length.gt(0)) {
                        rejectInvalidNumber(node, numberDisplay(form.filmOrderLengthM));
                        return;
                      }
                      applyPatch({
                        filmOrderLengthM: length.toString(),
                        fillingUnitDisplay: "",
                        fillingAmountDisplay: "",
                        filmUnitDisplay: "",
                        filmPouchUnitDisplay: "",
                        filmAmountDisplay: "",
                        adjustmentDisplay: "",
                        subtotalDisplay: "",
                        taxDisplay: "",
                        grandTotalDisplay: "",
                      });
                    }} /> m</span></td>
                    <td><EditableText value={moneyDisplay(shownTotals.filmAmount, form.filmAmountDisplay)} label="フィルム金額" className="money" onCommit={commitFilmAmount} /></td>
                  </tr>
                  {Number(form.customLotCost) > 0 ? (
                    <tr>
                      <td>
                        <strong><EditableText value={form.customItemName} label="金型項目名" onCommit={(next) => update("customItemName", next.trim())} /></strong>
                        <small><EditableText value={form.customItemDescription} label="金型説明" multiline onCommit={(next) => update("customItemDescription", next)} /></small>
                      </td>
                      <td><EditableText value={moneyDisplay(shownTotals.customUnit, form.customUnitDisplay, 0)} label="金型単価" className="money" onCommit={commitCustomUnit} /> /式</td>
                      <td><EditableText value={numberDisplay(form.customQuantity)} label="金型数量" className="money" onCommit={commitCustomQuantity} /> 式</td>
                      <td><EditableText value={moneyDisplay(shownTotals.customAmount, form.customAmountDisplay, 0)} label="金型金額" className="money" onCommit={commitCustomAmount} /></td>
                    </tr>
                  ) : null}
                  {form.printingMethod === "gravure" ? (
                    <tr>
                      <td>
                      <strong><EditableText value={form.copperItemName} label="銅版費項目名" onCommit={(next) => update("copperItemName", next.trim())} /></strong>
                      <small><EditableText value={form.copperItemDescription} label="銅版費説明" multiline onCommit={(next) => update("copperItemDescription", next)} /></small>
                      <small className="film-composition">銅版単価は目標利益率を反映した供給価格です（最低¥32,000/色）。</small>
                      </td>
                      <td><EditableText value={moneyDisplay(shownTotals.copperColorUnit, form.copperUnitDisplay, 0)} label="銅版費単価" className="money" onCommit={commitCopperUnit} /> /色</td>
                      <td><EditableText value={numberDisplay(form.copperColorCount)} label="銅版費数量" className="money" onCommit={commitCopperColorQuantity} /> 色</td>
                      <td><EditableText value={moneyDisplay(shownTotals.copperAmount, form.copperAmountDisplay)} label="銅版費金額" className="money" onCommit={commitCopperAmount} /></td>
                    </tr>
                  ) : null}
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
        </div>

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
              <label>顧客コード<input value={form.customerCode} onChange={(event) => update("customerCode", event.target.value)} /></label>
              <label>得意先名<input value={form.customerName} onChange={(event) => update("customerName", event.target.value)} placeholder="株式会社◯◯" /></label>
              <label>得意先郵便番号<input value={form.customerPostalCode} onChange={(event) => update("customerPostalCode", event.target.value)} /></label>
              <label className="wide">得意先住所<input value={form.customerAddress} onChange={(event) => update("customerAddress", event.target.value)} /></label>
              <label>得意先担当者<input value={form.customerContact} onChange={(event) => update("customerContact", event.target.value)} placeholder="◯◯様" /></label>
              <label>得意先電話番号<input value={form.customerTelephone} onChange={(event) => update("customerTelephone", event.target.value)} /></label>
              <label>得意先メールアドレス<input value={form.customerEmail} onChange={(event) => update("customerEmail", event.target.value)} /></label>
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
          <label>金型 原価（ロット合計）<input inputMode="decimal" value={form.customLotCost} onChange={(event) => update("customLotCost", event.target.value)} /></label>
          <label>金型 数量（式）<input inputMode="decimal" value={form.customQuantity} onChange={(event) => update("customQuantity", event.target.value)} /></label>
          <label>金型 単価（空欄=自動）<input inputMode="decimal" value={form.customUnitDisplay} onChange={(event) => update("customUnitDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>金型 金額（空欄=自動）<input inputMode="decimal" value={form.customAmountDisplay} onChange={(event) => update("customAmountDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>金型 項目名<input value={form.customItemName} onChange={(event) => update("customItemName", event.target.value)} /></label>
          <label className="wide">金型 説明<textarea rows={2} value={form.customItemDescription} onChange={(event) => update("customItemDescription", event.target.value)} /></label>
          <label>銅版費 原価 / 枚<input inputMode="decimal" value={form.copperPlateCostPerPiece} onChange={(event) => update("copperPlateCostPerPiece", event.target.value)} /></label>
          <label>銅版費 単価 /色（空欄=自動）<input inputMode="decimal" value={form.copperUnitDisplay} onChange={(event) => update("copperUnitDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>銅版費 色数<input inputMode="decimal" value={form.copperColorCount} onChange={(event) => update("copperColorCount", event.target.value)} /></label>
          <label>銅版費 金額（空欄=自動）<input inputMode="decimal" value={form.copperAmountDisplay} onChange={(event) => update("copperAmountDisplay", event.target.value)} placeholder="自動計算" /></label>
          <label>銅版費 項目名<input value={form.copperItemName} onChange={(event) => update("copperItemName", event.target.value)} /></label>
          <label className="wide">銅版費 説明<textarea rows={2} value={form.copperItemDescription} onChange={(event) => update("copperItemDescription", event.target.value)} /></label>
          <label>フィルム 項目名<input value={form.filmItemName} onChange={(event) => update("filmItemName", event.target.value)} /></label>
          <label className="wide">フィルム 説明<textarea rows={2} value={form.filmItemDescription} onChange={(event) => update("filmItemDescription", event.target.value)} /></label>
          <label className="wide">フィルム構成<input value={form.filmComposition} onChange={(event) => update("filmComposition", event.target.value)} placeholder={DEFAULT_FILM_COMPOSITION} /></label>
          <label>フィルム 仕入m単価（参考）<input inputMode="decimal" value={form.filmMeterPrice} onChange={(event) => update("filmMeterPrice", event.target.value)} /></label>
          <label>フィルム発注長さ (m)<input inputMode="decimal" value={form.filmOrderLengthM} onChange={(event) => update("filmOrderLengthM", event.target.value)} /></label>
          <label>フィルム 販売m単価（380〜480 / 空欄=発注長別自動）<input inputMode="decimal" value={form.filmUnitDisplay} onChange={(event) => update("filmUnitDisplay", event.target.value)} placeholder="自動：500m=450 / 1,000m=410 / 1,500m=380" /></label>
          <label>フィルム パウチ換算（参考・空欄=自動）<input inputMode="decimal" value={form.filmPouchUnitDisplay} onChange={(event) => update("filmPouchUnitDisplay", event.target.value)} placeholder="自動計算" /></label>
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
              updateTargetMargin("");
              return;
            }
            const percent = Number(raw);
            if (Number.isFinite(percent)) updateTargetMargin((percent / 100).toString());
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
