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
import {
  DEFAULT_FILM_COMPOSITION,
  QUOTATION_RESTORE_KEY,
  SIMULATOR_STALE_STATUS_KEY,
} from "@/lib/quotation-shared";
import { clampGravureFilmMeterUnit, COPPER_TARGET_MARGIN } from "@/lib/quotation-pricing";

const LAST_CHECKLIST_URL_KEY = "pouch-last-checklist-url-v1";
import type { PurchaseOrderSnapshot } from "@/lib/purchase-order";
import type { CalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import type { CalculationInput } from "@/lib/calculation";

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
  bulkItemName: string;
  bulkItemDescription: string;
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
  sascheCandidateId: string;
  sascheCandidatesJson: string;
  sascheOverToleranceReason: string;
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
  skuNames: string[];
  fillingCostPerPiece: string;
  bulkCostPerPiece: string;
  bulkUnitDisplay: string;
  bulkAmountDisplay: string;
  pricingFillingCostPerPiece: string;
  filmCostPerPiece: string;
  filmMeterPrice: string;
  filmOrderLengthM: string;
  calculationFilmTotal: string;
  targetMargin: string;
  taxRatePercent: string;
  deliveryDate: string;
  paymentTerms: string;
  notes: string;
  sealText: string;
  footerNote: string;
  purchaseOrderJson: string;
  calculationRequestJson: string;
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
  bulkItemName: "バルク費用",
  bulkItemDescription: "充填液体材料（貴社支給の場合は金額表示なし）",
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
  sascheCandidateId: "",
  sascheCandidatesJson: "[]",
  sascheOverToleranceReason: "",
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
  skuNames: [],
  fillingCostPerPiece: "0",
  bulkCostPerPiece: "0",
  bulkUnitDisplay: "",
  bulkAmountDisplay: "",
  pricingFillingCostPerPiece: "",
  filmCostPerPiece: "0",
  filmMeterPrice: "0",
  filmOrderLengthM: "0",
  calculationFilmTotal: "0",
  targetMargin: "0.4",
  taxRatePercent: "10",
  deliveryDate: "ご注文後の別途ご相談",
  paymentTerms: "御見積時にお相談いたします",
  notes: [
    "上記金額には充填・加工費・フィルム費用および該当する初期費用（銅版・金型）を含みます。仕様変更時は再度お見積りいたします。",
    "ご入金およびデータ入稿後に正式受注処理となります。",
    "バルク支給時の容器処分費用が発生する場合は実費を請求いたします。",
    "お振込手数料は御社負担にてお願い申し上げます。",
    "金型・版は受注より1年間保管いたします。",
    "【出来高について】",
    "1. 製造工程の特性上、最終的な出来高はご注文数量に対し±10%程度の過不足が生じる場合があります。",
    "2. 過不足が10%以内の場合は、実際の出来高数量にて納品し、ご注文数量にて請求いたします（過不足に対する返金・追加請求は行いません）。",
    "3. 過不足が10%を超えた場合のみ、超過分×充填単価にて不足分は返金、過剰分は追加請求いたします。",
  ].join("\n"),
  sealText: "検討済",
  footerNote: "本お見積りに関するご不明点は、下記連絡先までお気軽にお問い合わせください。",
  purchaseOrderJson: "",
  calculationRequestJson: "",
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
  const quoteFitRef = useRef<HTMLDivElement | null>(null);
  const [form, setForm] = useState<QuoteForm>(defaultQuote);
  const [sourceVersion, setSourceVersion] = useState("");
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [savedRecordId, setSavedRecordId] = useState<number | null>(null);
  const [checklistUrl, setChecklistUrl] = useState("");
  const [checklistOpening, setChecklistOpening] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [issueSuccessMessage, setIssueSuccessMessage] = useState("");
  const [quoteDraftStale, setQuoteDraftStale] = useState(false);
  const [selectedCandidateShortage, setSelectedCandidateShortage] = useState(false);
  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrderSnapshot | null>(null);
  const [calculationChecklistSnapshot, setCalculationChecklistSnapshot] = useState<CalculationChecklistSnapshot | null>(null);
  const [customerMasterStatus, setCustomerMasterStatus] = useState<{ loading: boolean; message: string; saving: boolean }>({
    loading: false,
    message: "",
    saving: false,
  });

  const loadCustomerMaster = async () => {
    const code = form.customerCode.trim();
    if (!code) {
      setCustomerMasterStatus({ loading: false, message: "顧客コードを入力してください。", saving: false });
      return;
    }
    setCustomerMasterStatus({ loading: true, message: "", saving: false });
    try {
      const response = await fetch(`/api/customers/${encodeURIComponent(code)}`);
      const payload = await response.json();
      if (!response.ok || !payload.customer) throw new Error("not_found");
      const customer = payload.customer as {
        customerCode: string; customerName: string; customerPostalCode?: string;
        customerAddress?: string; customerContact?: string; customerTelephone?: string; customerEmail?: string;
      };
      applyPatch({
        customerCode: customer.customerCode,
        customerName: customer.customerName || "",
        customerPostalCode: customer.customerPostalCode || "",
        customerAddress: customer.customerAddress || "",
        customerContact: customer.customerContact || "",
        customerTelephone: customer.customerTelephone || "",
        customerEmail: customer.customerEmail || "",
      });
      setCustomerMasterStatus({ loading: false, message: `顧客コード ${code} を読み込みました。`, saving: false });
    } catch {
      setCustomerMasterStatus({ loading: false, message: "登録されていない顧客コードです。入力後に保存できます。", saving: false });
    }
  };

  const saveCustomerMaster = async () => {
    const code = form.customerCode.trim();
    if (!code || !form.customerName.trim()) {
      setCustomerMasterStatus({ loading: false, message: "保存には顧客コードと会社名が必要です。", saving: false });
      return;
    }
    setCustomerMasterStatus((old) => ({ ...old, saving: true, message: "" }));
    try {
      const response = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerCode: code,
          customerName: form.customerName,
          customerPostalCode: form.customerPostalCode,
          customerAddress: form.customerAddress,
          customerContact: form.customerContact,
          customerTelephone: form.customerTelephone,
          customerEmail: form.customerEmail,
        }),
      });
      if (!response.ok) throw new Error();
      setCustomerMasterStatus({ loading: false, message: `顧客コード ${code} を保存しました。`, saving: false });
    } catch {
      setCustomerMasterStatus({ loading: false, message: "顧客マスタを保存できませんでした。", saving: false });
    }
  };

  useEffect(() => {
    const MM_TO_PX = 96 / 25.4;
    const PRINT_SHEET_HEIGHT_MM = 296;
    const ensureMeasureHost = () => {
      let host = document.querySelector<HTMLElement>("#quote-print-measure-host");
      if (!host) {
        host = document.createElement("div");
        host.id = "quote-print-measure-host";
        host.setAttribute("aria-hidden", "true");
        document.body.appendChild(host);
      }
      return host;
    };
    const fitForPrint = () => {
      const content = quoteFitRef.current;
      const sheet = content?.closest<HTMLElement>(".a4-sheet");
      if (!content || !sheet) return;
      content.style.removeProperty("--quote-a4-fit-scale");
      // 인쇄 CSS 적용 시점이 브라우저마다 달라도 같은 결과가 나오도록,
      // 실제 인쇄 폭(209mm)으로 클론을 렌더링해 높이를 측정한다.
      const host = ensureMeasureHost();
      document.body.dataset.quotePrintMeasure = "1";
      const clone = sheet.cloneNode(true) as HTMLElement;
      clone.removeAttribute("id");
      clone.style.removeProperty("--quote-a4-fit-scale");
      host.replaceChildren(clone);
      const cloneFit = clone.querySelector<HTMLElement>(".quote-a4-fit");
      const cloneStyle = getComputedStyle(clone);
      const reserved = (["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth"] as const)
        .reduce((total, key) => total + (Number.parseFloat(cloneStyle[key]) || 0), 0);
      const budgetPx = PRINT_SHEET_HEIGHT_MM * MM_TO_PX - reserved;
      const measuredPx = cloneFit ? Math.max(cloneFit.scrollHeight, cloneFit.offsetHeight) : 0;
      const scale = measuredPx > budgetPx && budgetPx > 0 ? budgetPx / measuredPx : 1;
      content.style.setProperty("--quote-a4-fit-scale", scale.toFixed(5));
      host.replaceChildren();
      delete document.body.dataset.quotePrintMeasure;
    };
    const resetFit = () => quoteFitRef.current?.style.removeProperty("--quote-a4-fit-scale");
    window.addEventListener("beforeprint", fitForPrint);
    window.addEventListener("afterprint", resetFit);
    return () => {
      window.removeEventListener("beforeprint", fitForPrint);
      window.removeEventListener("afterprint", resetFit);
    };
  }, []);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorageはSSR後にしか読めない意図的な復元処理です。
      setQuoteDraftStale(Boolean(sessionStorage.getItem(SIMULATOR_STALE_STATUS_KEY)));
      const restoreRaw = sessionStorage.getItem(QUOTATION_RESTORE_KEY);
      if (restoreRaw) {
        const checklistUrl = sessionStorage.getItem(LAST_CHECKLIST_URL_KEY) ?? "";
        setChecklistUrl(checklistUrl);
        const restored = JSON.parse(restoreRaw) as Partial<QuoteForm> & {
          resultHash?: unknown;
          calculationRequest?: CalculationInput;
          purchaseOrder?: PurchaseOrderSnapshot;
          purchaseOrderJson?: string;
          calculationChecklistSnapshot?: CalculationChecklistSnapshot;
          selectedCandidateShortage?: boolean;
        };
        const restoredForm = { ...defaultQuote };
        (Object.keys(defaultQuote) as (keyof QuoteForm)[]).forEach((key) => {
          const value = restored[key];
          if (typeof value === "string" && !Array.isArray(restoredForm[key])) restoredForm[key] = value as never;
        });
        if (Array.isArray(restored.skuNames) && restored.skuNames.every((name) => typeof name === "string")) {
          restoredForm.skuNames = restored.skuNames as string[];
        }
        restoredForm.calculationRequestJson = restored.calculationRequest
          ? JSON.stringify(restored.calculationRequest)
          : "";
        setForm(restoredForm);
        try {
          const rawPurchaseOrder = restored.purchaseOrderJson ?? (restored.purchaseOrder ? JSON.stringify(restored.purchaseOrder) : "");
          const rawChecklistSnapshot = restored.calculationChecklistSnapshot;
          setCalculationChecklistSnapshot(rawChecklistSnapshot ? rawChecklistSnapshot as CalculationChecklistSnapshot : null);
          setPurchaseOrder(rawPurchaseOrder ? JSON.parse(rawPurchaseOrder) as PurchaseOrderSnapshot : null);
        } catch { setPurchaseOrder(null); }
        setSourceVersion(typeof restored.resultHash === "string" ? restored.resultHash : "");
        setSelectedCandidateShortage(restored.selectedCandidateShortage === true);
        sessionStorage.removeItem(QUOTATION_RESTORE_KEY);
        setStorageLoaded(true);
        return;
      }

      const raw = sessionStorage.getItem(QUOTATION_DRAFT_KEY);
      const draft = parseQuotationDraft(JSON.parse(raw ?? "null"));
      setChecklistUrl(sessionStorage.getItem(LAST_CHECKLIST_URL_KEY) ?? "");
      if (draft) {
        setSelectedCandidateShortage(draft.selectedCandidateShortage === true);
        setForm((old) => ({
          ...old,
          productName: draft.productSummary,
          sizeSummary: draft.sizeSummary,
          quantity: draft.quantity,
          skuNames: draft.skuNamesRaw ?? [],
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
          bulkCostPerPiece: draft.bulkCostPerPiece ?? "0",
          bulkUnitDisplay: "",
          bulkAmountDisplay: "",
          pricingFillingCostPerPiece: draft.pricingFillingCostPerPiece ?? "",
          printingMethod: draft.printingMethod ?? "digital",
          copperPlateCostPerPiece: draft.copperPlateCostPerPiece ?? "0",
          sascheCandidateId: draft.sascheCandidate?.id ?? "",
          sascheCandidatesJson: JSON.stringify(draft.sascheCandidates ?? []),
          sascheOverToleranceReason: draft.sascheOverToleranceReason ?? "",
          copperColorCount: draft.copperColorCount ?? old.copperColorCount,
          orderPatternCount: draft.orderPatternCount ?? "0",
          deliverablePatternLengthM: draft.deliverablePatternLengthM ?? "0",
          recommendedQuantity: draft.recommendedQuantity ?? "",
          filmCostPerPiece: draft.filmCostPerPiece,
          filmMeterPrice: draft.filmMeterPrice,
          filmOrderLengthM: draft.filmOrderLengthM,
          calculationFilmTotal: draft.calculationFilmTotal,
          targetMargin: draft.targetMargin,
          purchaseOrderJson: draft.purchaseOrder ? JSON.stringify(draft.purchaseOrder) : "",
          calculationRequestJson: draft.calculationRequest ? JSON.stringify(draft.calculationRequest) : "",
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
    bulkUnitDisplay: "",
    bulkAmountDisplay: "",
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
    if (!issueReady) {
      setSaveError(`発行に必要な情報が不足しています：${missingIssueFields.join("・")}`);
      return false;
    }
    setSaving(true);
    setSaveError("");
    try {
      const savedPurchaseOrder = purchaseOrder
        ? {
          ...purchaseOrder,
          customMold: D(form.customLotCost).gt(0)
            ? { quantity: form.customQuantity, costYen: form.customLotCost }
            : undefined,
        }
        : purchaseOrder;
      const customQuantity = D(form.customQuantity || "1");
      const costUnit = D(form.fillingCostPerPiece).plus(D(form.bulkCostPerPiece || "0")).plus(form.filmCostPerPiece).plus(form.copperPlateCostPerPiece).plus(D(form.customLotCost).div(customQuantity));
      const sellingUnit = totals.quantity.gt(0)
        ? D(shownTotals.subtotal).div(totals.quantity)
        : D(shownTotals.pricePerPiece);
      const profitUnit = sellingUnit.minus(costUnit);
      const profitMargin = sellingUnit.gt(0) ? profitUnit.div(sellingUnit) : D(0);
      const markupRate = costUnit.gt(0) ? profitUnit.div(costUnit) : D(0);
      const targetMargin = D(form.targetMargin);
      const profitAudit = {
        basis: "displayed-subtotal",
        printingMethod: form.printingMethod,
        quantity: form.quantity,
        fillingCostPerPiece: form.fillingCostPerPiece,
        filmCostPerPiece: form.filmCostPerPiece,
        copperPlateCostPerPiece: form.copperPlateCostPerPiece,
        customLotCost: form.customLotCost,
        totalCostPerPiece: costUnit.toString(),
        proposedPricePerPiece: sellingUnit.toString(),
        linePricePerPiece: shownTotals.pricePerPiece.toString(),
        adjustment: shownTotals.adjustment === "-" ? "0" : shownTotals.adjustment.toString(),
        profitPerPiece: profitUnit.toString(),
        profitMarginRate: profitMargin.toString(),
        profitMarginPercent: profitMargin.times(100).toString(),
        markupRate: markupRate.toString(),
        targetMarginRate: targetMargin.toString(),
        targetMarginPercent: targetMargin.times(100).toString(),
        copperTargetMarginRate: COPPER_TARGET_MARGIN.toString(),
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
          productName: form.skuNames.filter((name) => name.trim()).join(" / ") || form.productName,
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
            sascheCandidate: calculationChecklistSnapshot?.sascheCandidate,
            sascheCandidates: calculationChecklistSnapshot?.sascheCandidates,
            customUnitDisplay: shownTotals.customUnit,
            customAmountDisplay: shownTotals.customAmount,
            calculationRequest: form.calculationRequestJson
              ? JSON.parse(form.calculationRequestJson) as CalculationInput
              : undefined,
            purchaseOrder: savedPurchaseOrder,
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
      setIssueSuccessMessage(`見積書を発行しました（${form.quotationNumber || payload.record.quotationNumber}）。履歴からPDF出力・メール作成ができます。`);
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
    // フォント置換による折り返し変化を避け、印刷フィット測定を正確にする。
    try {
      await document.fonts.ready;
    } catch {
      // fonts API 未対応環境ではそのまま印刷する。
    }
    window.print();
  };

  const parsedQuantity = parseDecimal(form.quantity);
  const parsedTargetMargin = parseDecimal(form.targetMargin);
  const parsedTaxRatePercent = parseDecimal(form.taxRatePercent);
  const parsedFillingCost = parseDecimal(form.fillingCostPerPiece);
  // 시뮬레이터 연결 견적은 1연 기준 충전 원가 × 연결 가산률을 가격 기준으로 사용.
  const parsedPricingFillingCost = parseDecimal(form.pricingFillingCostPerPiece) ?? parsedFillingCost;
  // 벌크 원가(지급 시 0＝견적 라인 없음).
  const parsedBulkCost = parseDecimal(form.bulkCostPerPiece) ?? D(0);
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
  // 발행 필수: 회사명·우편번호·전화번호·주소 + 전 SKU 제품명.
  const missingIssueFields: string[] = [];
  if (!form.customerName.trim()) missingIssueFields.push("会社名");
  if (!form.customerPostalCode.trim()) missingIssueFields.push("郵便番号");
  if (!form.customerTelephone.trim()) missingIssueFields.push("電話番号");
  if (!form.customerAddress.trim()) missingIssueFields.push("住所");
  form.skuNames.forEach((name, index) => {
    if (!name.trim()) missingIssueFields.push(`製品名（SKU-${index + 1}）`);
  });
  const issueReady = valid && missingIssueFields.length === 0;
  const linkedQuoteActionsDisabled = !valid || saving || quoteDraftStale;
  const issueButtonDisabled = !issueReady || saving || quoteDraftStale;

  const totals = (() => {
    if (!valid || !parsedQuantity || !parsedTargetMargin || !parsedTaxRatePercent || !parsedFillingCost || !parsedFilmCost || !parsedCopperCost || !parsedCustomLotCost || !parsedCustomQuantity || !parsedFilmMeterPrice || !parsedFilmOrderLength) return null;
    const quantity = parsedQuantity;
    const margin = parsedTargetMargin;
    const taxRate = parsedTaxRatePercent.div(100);
    const fillingSellingUnit = (parsedPricingFillingCost ?? parsedFillingCost).div(D(1).minus(parsedTargetMargin ?? D(0)));
    const bulkSellingUnit = parsedBulkCost.div(D(1).minus(parsedTargetMargin ?? D(0)));
    const copperSellingUnit = parsedCopperCost.div(D(1).minus(COPPER_TARGET_MARGIN));
    const filmSellingUnit = parsedFilmCost.div(D(1).minus(parsedTargetMargin ?? D(0)));
    const customLotSaleBase = parsedCustomLotCost
      .div(parsedCustomQuantity)
      .div(D(1).minus(parsedTargetMargin ?? D(0)));
    const customSellingUnit = ceilTo(customLotSaleBase, 1000);
    const customSaleTotal = customSellingUnit.times(parsedCustomQuantity);
    const customSalePerPiece = customSaleTotal.div(quantity);
    const filmMeterDisplayUnit = parsedFilmMeterPrice;
    // 目標総額にフィルム販売額を含めないと、充填・加工の残額計算が不正になる。
    const pricePerPiece = fillingSellingUnit.plus(bulkSellingUnit).plus(copperSellingUnit).plus(filmSellingUnit).plus(customSalePerPiece);
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
      bulkSellingUnit,
      copperAmount: copperSellingUnit.times(quantity),
      subtotal,
      tax,
      taxRate,
      grandTotal: subtotal.plus(tax),
    };
  })();

  const shownTotals = (() => {
    if (!totals) return null;
    // 見積単価（充填・加工／フィルムm単価）は小数第1位で切り上げる。
    const roundUnit = (value: typeof totals.pricePerPiece) => value.toDecimalPlaces(1, Decimal.ROUND_UP);
    const totalPriceInput = parseDecimal(form.pricePerPieceDisplay) ?? totals.pricePerPiece;
    const targetTotal = totalPriceInput.times(totals.quantity);
    const parsedCopperColorCount = parseDecimal(form.copperColorCount);
    const copperColorCount = parsedCopperColorCount && parsedCopperColorCount.gte(0)
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
    const customUnit = customUnitOverride ?? totals.customUnit;

    const isGravure = form.printingMethod === "gravure";
    let fillingUnit: Decimal;
    let filmMeterUnit: Decimal;
    // バルク販売単価＝バルク原価÷(1−利益率)。原価0（客給）なら0でライン非表示。
    const bulkUnit = parseDecimal(form.bulkUnitDisplay) ?? roundUnit(totals.bulkSellingUnit);
    const bulkAmount = parseDecimal(form.bulkAmountDisplay) ?? bulkUnit.times(totals.quantity);
    if (isGravure) {
      // グラビアの客提示フィルムm単価は90〜220円の帯に制限する。
      // 帯によって生じた差額は充填・加工単価で補う。
      const provisionalFillingUnit = (parsedPricingFillingCost ?? parsedFillingCost ?? D(0))
        .div(D(1).minus(parsedTargetMargin ?? D(0)));
      const provisionalFillingAmount = provisionalFillingUnit.times(totals.quantity);
      const residualFilmAmount = Decimal.max(
        targetTotal.minus(provisionalFillingAmount).minus(bulkAmount).minus(copperAmount),
        0,
      );
      const residualMeterUnit = totals.filmOrderLength.gt(0)
        ? residualFilmAmount.div(totals.filmOrderLength)
        : D(0);
      filmMeterUnit = parseDecimal(form.filmUnitDisplay)
        ?? clampGravureFilmMeterUnit(residualMeterUnit).toDecimalPlaces(1, Decimal.ROUND_UP);
      const bandedFilmAmount = filmMeterUnit.times(totals.filmOrderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      fillingUnit = parseDecimal(form.fillingUnitDisplay)
        ?? (totals.quantity.gt(0)
          ? roundUnit(Decimal.max(targetTotal.minus(bandedFilmAmount).minus(bulkAmount).minus(copperAmount), 0).div(totals.quantity))
          : D(0));
    } else {
      const requestedFilmMeterUnit = parseDecimal(form.filmUnitDisplay)
        ?? recommendedFilmMeterUnit(form.filmOrderLengthM);
      filmMeterUnit = clampFilmMeterUnit(requestedFilmMeterUnit);
      const filmAmount = filmMeterUnit.times(totals.filmOrderLength);
      const remainingFillingAmount = Decimal.max(targetTotal.minus(filmAmount).minus(bulkAmount).minus(copperAmount), 0);
      fillingUnit = parseDecimal(form.fillingUnitDisplay)
        ?? (totals.quantity.gt(0)
          ? roundUnit(remainingFillingAmount.div(totals.quantity))
          : D(0));
    }
    // フィルム金額は円単位で確定する（円未満は四捨五入）。m単価は小数第1位の切り上げ値を表示する。
    const filmAmount = filmMeterUnit.times(totals.filmOrderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const bulkUnitFinal = bulkUnit;
    const bulkAmountFinal = bulkAmount;
    const fillingAmount = parseDecimal(form.fillingAmountDisplay) ?? fillingUnit.times(totals.quantity);
    const customAmount = parseDecimal(form.customAmountDisplay) ?? customUnit.times(customQuantity);
    const filmPouchUnit = totals.quantity.gt(0) ? filmAmount.div(totals.quantity) : D(0);
    const lineTotal = fillingAmount.plus(bulkAmountFinal).plus(filmAmount).plus(copperAmount).plus(customAmount);
    const adjustment = form.adjustmentDisplay.trim() === "" ? "-" : form.adjustmentDisplay;
    const adjustmentAmount = adjustment === "-" ? D(0) : D(adjustment);
    const subtotal = parseDecimal(form.subtotalDisplay) ?? lineTotal.plus(adjustmentAmount);
    const tax = parseDecimal(form.taxDisplay) ?? subtotal.times(totals.taxRate).toDecimalPlaces(0);
    const grandTotal = parseDecimal(form.grandTotalDisplay) ?? subtotal.plus(tax);

    return {
      pricePerPiece: (totals.quantity.gt(0) ? lineTotal.div(totals.quantity) : D(0)).toString(),
      fillingUnit: fillingUnit.toString(),
      fillingAmount: fillingAmount.toString(),
      bulkUnit: bulkUnitFinal.toString(),
      bulkAmount: bulkAmountFinal.toString(),
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

  const selectedSascheCandidate = (calculationChecklistSnapshot?.sascheCandidates ?? [])
    .find((candidate) => candidate.id === form.sascheCandidateId) ?? null;
  const candidateQuantityReductionRatio = selectedSascheCandidate
    ? Number(selectedSascheCandidate.quantityReductionRatio)
    : 0;
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

  const selectSascheCandidate = (candidateId: string) => {
    const candidate = (calculationChecklistSnapshot?.sascheCandidates ?? [])
      .find((item) => item.id === candidateId);
    if (!candidate) {
      applyPatch({ sascheCandidateId: candidateId });
      return;
    }
    const currentQuantity = parseDecimal(calculationChecklistSnapshot?.quantity ?? form.quantity);
    const adjustedQuantity = parseDecimal(candidate.adjustedQuantity);
    const quantity = adjustedQuantity && adjustedQuantity.gt(0) ? adjustedQuantity : currentQuantity;
    if (!quantity || !quantity.gt(0) || !currentQuantity || !currentQuantity.gt(0)) return;

    // 充填・加工費は数量により再配賦する。固定ロット・初期投入・試験充填は固定、
    // 変動加工と本体/ロスバルクは数量比例。
    const snapshot = calculationChecklistSnapshot;
    let fillingCostPerPiece = form.fillingCostPerPiece;
    if (snapshot) {
      const variableProcessing = D(snapshot.variableProcessingTotal);
      const fixedLot = D(snapshot.fixedLotCost);
      const bulkUnitPrice = D(snapshot.bulkUnitPrice ?? "0");
      const fixedBulkMl = D(snapshot.bulkInitialChargeMl ?? "0").plus(snapshot.bulkTestFillMl ?? "0");
      const fixedBulkCost = fixedBulkMl.times(bulkUnitPrice);
      const variableBulkCost = Decimal.max(D(snapshot.bulkCost).minus(fixedBulkCost), D(0));
      const quantityRatio = quantity.div(currentQuantity);
      const newProcessingTotal = variableProcessing.times(quantityRatio)
        .plus(fixedLot)
        .plus(variableBulkCost.times(quantityRatio))
        .plus(fixedBulkCost);
      fillingCostPerPiece = newProcessingTotal.div(quantity).toString();
    }

    applyPatch({
      sascheCandidateId: candidate.id,
      sascheOverToleranceReason: "",
      quantity: candidate.adjustedQuantity,
      filmOrderLengthM: candidate.outputLengthM,
      filmMeterPrice: candidate.filmUnitPriceYen,
      filmCostPerPiece: D(candidate.filmTotalYen).div(quantity).toString(),
      copperPlateCostPerPiece: D(candidate.plateTotalYen).div(quantity).toString(),
      copperColorCount: String(candidate.colorCount),
      fillingCostPerPiece,
      fillingUnitDisplay: "",
      bulkUnitDisplay: "",
      bulkAmountDisplay: "",
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
    const bulkAmount = D(shownTotals!.bulkAmount);
    const copperAmount = D(shownTotals!.copperAmount);
    const customAmount = D(shownTotals!.customAmount);
    const filmAmount = Decimal.max(price.times(quantity).minus(fillingAmount).minus(bulkAmount).minus(copperAmount).minus(customAmount), 0);
    applyLineTotals(fillingUnit, filmAmount, copperAmount, customAmount, bulkAmount);
  };

  const applyLineTotals = (fillingUnit: Decimal, filmAmount: Decimal, copperAmount: Decimal, customAmount: Decimal, bulkAmount?: Decimal): Decimal | null => {
    const quantity = parseDecimal(form.quantity);
    const customQuantity = parseDecimal(form.customQuantity) ?? D(1);
    const orderLength = parseDecimal(form.filmOrderLengthM);
    const copperColorCount = parseDecimal(form.copperColorCount) ?? D(1);
    if (!quantity || !quantity.gt(0) || !orderLength || !orderLength.gt(0)) return null;
    const fillingAmount = fillingUnit.times(quantity);
    const filmMeterUnit = form.printingMethod === "gravure"
      ? filmAmount.div(orderLength)
      : clampFilmMeterUnit(filmAmount.div(orderLength));
    const clampedFilmAmount = filmMeterUnit.times(orderLength).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const displayFilmMeterUnit = orderLength.gt(0) ? clampedFilmAmount.div(orderLength) : filmMeterUnit;
    const filmPouchUnit = clampedFilmAmount.div(quantity);
    const copperUnit = copperAmount.div(quantity);
    const customUnit = customQuantity.gt(0) ? customAmount.div(customQuantity) : D(0);
    const bulkUnit = quantity.gt(0) ? (bulkAmount ?? D(0)).div(quantity) : D(0);
    const lineTotal = fillingAmount.plus(bulkAmount ?? D(0)).plus(clampedFilmAmount).plus(copperAmount).plus(customAmount);
    const price = lineTotal.div(quantity);
    const subtotal = lineTotal;
    const tax = subtotal.times(D(form.taxRatePercent).div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    applyPatch({
      pricePerPieceDisplay: price.toString(),
      fillingUnitDisplay: fillingUnit.toString(),
      fillingAmountDisplay: fillingAmount.toString(),
      bulkUnitDisplay: bulkUnit.toString(),
      bulkAmountDisplay: (bulkAmount ?? D(0)).toString(),
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
    return subtotal;
  };

  const commitFillingUnit = (raw: string, node: HTMLElement) => {
    const unit = parseDisplayedNumber(raw);
    if (!shownTotals || unit === null || unit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.fillingUnit ?? "0", undefined, 2));
      return;
    }
    applyLineTotals(unit, D(shownTotals.filmAmount), D(shownTotals.copperAmount), D(shownTotals.customAmount), D(shownTotals.bulkAmount));
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

  const commitBulkUnit = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const unit = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || unit === null || unit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.bulkUnit ?? "0", undefined, 2));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), D(shownTotals.filmAmount), D(shownTotals.copperAmount), D(shownTotals.customAmount), unit.times(quantity));
  };

  const commitBulkAmount = (raw: string, node: HTMLElement) => {
    const amount = parseDisplayedNumber(raw);
    if (!shownTotals || amount === null || amount.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.bulkAmount ?? "0"));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), D(shownTotals.filmAmount), D(shownTotals.copperAmount), D(shownTotals.customAmount), amount);
  };

  const commitFilmMeterUnit = (raw: string, node: HTMLElement) => {
    const orderLength = parseDecimal(form.filmOrderLengthM);
    const meterUnit = parseDisplayedNumber(raw);
    if (!shownTotals || !orderLength || !orderLength.gt(0) || meterUnit === null || meterUnit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.filmUnit ?? "0"));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), meterUnit.times(orderLength), D(shownTotals.copperAmount), D(shownTotals.customAmount), D(shownTotals.bulkAmount));
  };

  const commitFilmPouchUnit = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.quantity);
    const pouchUnit = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || pouchUnit === null || pouchUnit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.filmPouchUnit ?? "0", undefined, 2));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), pouchUnit.times(quantity), D(shownTotals.copperAmount), D(shownTotals.customAmount), D(shownTotals.bulkAmount));
  };

  const commitFilmAmount = (raw: string, node: HTMLElement) => {
    const amount = parseDisplayedNumber(raw);
    if (!shownTotals || amount === null || amount.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.filmAmount ?? "0"));
      return;
    }
    applyLineTotals(D(shownTotals.fillingUnit), amount, D(shownTotals.copperAmount), D(shownTotals.customAmount), D(shownTotals.bulkAmount));
  };

  const commitCopperUnit = (raw: string, node: HTMLElement) => {
    const quantity = parseDecimal(form.copperColorCount);
    const unit = parseDisplayedNumber(raw);
    if (!shownTotals || !quantity || !quantity.gt(0) || unit === null || unit.lt(0)) {
      rejectInvalidNumber(node, moneyDisplay(shownTotals?.copperUnit ?? "0", undefined, 2));
      return;
    }
    const copperAmount = unit.times(quantity);
    applyLineTotals(D(shownTotals.fillingUnit), D(shownTotals.filmAmount), copperAmount, D(shownTotals.customAmount), D(shownTotals.bulkAmount));
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
      bulkUnitDisplay: "",
      bulkAmountDisplay: "",
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
    applyLineTotals(D(shownTotals.fillingUnit), D(shownTotals.filmAmount), D(shownTotals.copperAmount), customAmount, D(shownTotals.bulkAmount));
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
      bulkUnitDisplay: "",
      bulkAmountDisplay: "",
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
    const customAmount = D(shownTotals.customAmount);
    const bulkAmount = D(shownTotals.bulkAmount);
    const fixedTotal = copperAmount.plus(customAmount).plus(bulkAmount);
    const variableTarget = Decimal.max(subtotal.minus(fixedTotal), D(0));
    const oldVariableTotal = D(shownTotals.fillingAmount).plus(shownTotals.filmAmount);
    const fillingShare = oldVariableTotal.gt(0) ? D(shownTotals.fillingAmount).div(oldVariableTotal) : D(1);
    const filmShare = oldVariableTotal.gt(0) ? D(shownTotals.filmAmount).div(oldVariableTotal) : D(0);
    const fillingAmount = variableTarget.times(fillingShare);
    const filmAmount = variableTarget.times(filmShare);
    const lineTotal = applyLineTotals(
      quantity.gt(0) ? fillingAmount.div(quantity) : D(0),
      filmAmount,
      copperAmount,
      customAmount,
      bulkAmount,
    );
    if (!lineTotal) return;
    const adjustment = subtotal.minus(lineTotal);
    const adjustedTax = subtotal.times(D(form.taxRatePercent).div(100)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    applyPatch({
      adjustmentDisplay: adjustment.eq(0) ? "-" : adjustment.toString(),
      subtotalDisplay: subtotal.toString(),
      taxDisplay: adjustedTax.toString(),
      grandTotalDisplay: subtotal.plus(adjustedTax).toString(),
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
      bulkUnitDisplay: "",
      bulkAmountDisplay: "",
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
    <main className="quote-page">
      <section className="quote-header" aria-labelledby="quote-toolbar-title">
        <div className="quote-header-top">
          <div className="quote-header-title">
            <h1 id="quote-toolbar-title">見積書発行</h1>
            <div className="quote-status-chips">
              {sourceVersion ? (
                <span className="chip chip-ok" title={sourceVersion}>
                  連携済み
                </span>
              ) : (
                <span className="chip chip-muted">未連携</span>
              )}
              {quoteDraftStale ? <span className="chip chip-warn">要再計算</span> : null}
              {selectedCandidateShortage ? <span className="chip chip-info">数量調整</span> : null}
              {issueReady ? <span className="chip chip-ok">発行可能</span> : <span className="chip chip-warn">入力不足</span>}
            </div>
          </div>
          <div className="toolbar-actions no-print">
            <button className="button secondary" type="button" onClick={() => router.push("/")}>シミュレーターから取込</button>
            <button className="btn-issue" type="button" data-testid="save-history" disabled={issueButtonDisabled} onClick={() => void saveToHistory()}>
              {saving ? "発行中..." : savedAt ? `発行済 ${savedAt}` : "見積書を発行"}
            </button>
            <button className="button" type="button" data-testid="print-pdf" disabled={linkedQuoteActionsDisabled} onClick={() => void printPdf()}>PDF出力（A4）</button>
            <button className="button secondary" type="button" disabled={linkedQuoteActionsDisabled || checklistOpening} title="現在の見積内容を保存し、計算確認チェックリストを開きます" data-testid="open-checklist" onClick={() => void openChecklist()}>
              {checklistOpening ? "作成中..." : "計算確認チェックリスト"}
            </button>
          </div>
        </div>
        <div className="quote-header-meta">
          {issueReady ? null : (
            <p className="issue-missing" role="status" data-testid="issue-missing-fields">不足：{missingIssueFields.join("・")}</p>
          )}
          {quoteDraftStale ? (
            <p className="header-alert" role="alert" data-testid="stale-quote-warning">この見積書は古くなっています。シミュレーターの条件が変わったため、再計算してください。</p>
          ) : null}
          {selectedCandidateShortage ? (
            <p className="header-alert" role="alert" data-testid="shortage-quote-warning">数量調整プランが選択されています。元の発注数が必要な場合は「元の数量へ戻る」を実行してください。</p>
          ) : null}
          {saveError ? <p className="error" role="alert" data-testid="save-error">{saveError}</p> : null}
          {issueSuccessMessage ? (
            <p className="issue-success" role="status" data-testid="issue-success">{issueSuccessMessage} <button className="button secondary small" type="button" onClick={() => router.push("/history")}>履歴を見る</button></p>
          ) : null}
        </div>
      </section>

      {!issueReady ? (
        <section className="issue-required-fields" data-testid="issue-required-fields" aria-labelledby="issue-fields-title">
          <div className="issue-fields-grid">
            <label className={form.customerName.trim() ? "filled" : "required"}>
              会社名 ★
              <input value={form.customerName} onChange={(e) => update("customerName", e.target.value)} placeholder="株式会社◯◯" />
            </label>
            <label className={form.customerPostalCode.trim() ? "filled" : "required"}>
              郵便番号 ★
              <input value={form.customerPostalCode} onChange={(e) => update("customerPostalCode", e.target.value)} placeholder="123-4567" />
            </label>
            <label className={form.customerTelephone.trim() ? "filled" : "required"}>
              電話番号 ★
              <input value={form.customerTelephone} onChange={(e) => update("customerTelephone", e.target.value)} placeholder="03-1234-5678" />
            </label>
            <label className={form.customerAddress.trim() ? "filled" : "required wide"}>
              住所 ★
              <input value={form.customerAddress} onChange={(e) => update("customerAddress", e.target.value)} placeholder="東京都◯◯区..." />
            </label>
            {form.skuNames.map((name, index) => (
              <label key={index} className={name.trim() ? "filled wide" : "required wide"}>
                製品名（SKU-{index + 1}）★
                <input value={name} onChange={(e) => setForm((old) => ({ ...old, skuNames: old.skuNames.map((v, i) => i === index ? e.target.value : v) }))} placeholder="製品名を入力" />
              </label>
            ))}
          </div>
          <p className="help">★付きの項目をすべて入力すると「見積書を発行」ボタンが有効になります。</p>
        </section>
      ) : null}

      <div className="sheet-scroll">
          <article className="a4-sheet" aria-label="お見積書A4プレビュー" id="quote-preview">
          <div className="quote-a4-fit" ref={quoteFitRef}>
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

          <section className="quote-spec" aria-labelledby="quote-spec-title" data-testid="quote-spec">
            <h3 id="quote-spec-title">お見積製品仕様</h3>
            <dl>
              <div><dt>品名</dt><dd><EditableText value={form.productName} label="見積品名" onCommit={(next) => update("productName", next.trim())} /></dd></div>
              <div><dt>パウチ仕様</dt><dd><EditableText value={form.sizeSummary} label="パウチ仕様" onCommit={(next) => update("sizeSummary", next.trim())} /></dd></div>
              <div><dt>数量</dt><dd><EditableText value={numberDisplay(form.quantity)} label="見積数量" className="money" onCommit={commitQuantity} /> 枚</dd></div>
              <div><dt>充填仕様</dt><dd>{calculationChecklistSnapshot
                ? (calculationChecklistSnapshot.chambers && calculationChecklistSnapshot.chambers.length > 1
                  ? `${calculationChecklistSnapshot.chambers.map((chamber) => `${chamber.position}室:${chamber.liquidName} ${formatNumber(chamber.fillMl)}ml`).join("／")} ＝ ${formatNumber(calculationChecklistSnapshot.totalFillMlPerPouch)}ml/枚（${calculationChecklistSnapshot.fillingMethod === "pressure" ? "加圧充填" : "ホッパ充填"}）`
                  : `${formatNumber(calculationChecklistSnapshot.fillMlPerChamber)}ml/室 × ${calculationChecklistSnapshot.connectedChambers}室 ＝ ${formatNumber(calculationChecklistSnapshot.totalFillMlPerPouch)}ml/枚（${calculationChecklistSnapshot.fillingMethod === "pressure" ? "加圧充填" : "ホッパ充填"}）`)
                : "-"}</dd></div>
              <div><dt>フィルム構成</dt><dd><EditableText value={form.filmComposition || DEFAULT_FILM_COMPOSITION} label="フィルム構成" onCommit={(next) => update("filmComposition", next.trim())} /></dd></div>
              {calculationChecklistSnapshot?.skus?.length ? (
                <div><dt>SKU</dt><dd>{calculationChecklistSnapshot.skus.map((sku, index) => `${form.skuNames[index]?.trim() || sku.name} ／ ${formatNumber(sku.quantity)}枚`).join("　")}</dd></div>
              ) : null}
            </dl>
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
                  {D(shownTotals.bulkAmount).gt(0) ? (
                    <tr data-testid="bulk-line">
                      <td>
                        <strong><EditableText value={form.bulkItemName} label="バルク項目名" onCommit={(next) => update("bulkItemName", next.trim())} /></strong>
                        <small><EditableText value={form.bulkItemDescription} label="バルク説明" multiline onCommit={(next) => update("bulkItemDescription", next)} /></small>
                      </td>
                      <td data-testid="bulk-unit-price"><EditableText value={moneyDisplay(shownTotals.bulkUnit, form.bulkUnitDisplay, 2)} label="バルク販売単価" className="money" onCommit={commitBulkUnit} /> /枚</td>
                      <td><EditableText value={numberDisplay(form.quantity)} label="バルク数量" className="money" onCommit={commitQuantity} /> 枚</td>
                      <td><EditableText value={moneyDisplay(shownTotals.bulkAmount, form.bulkAmountDisplay)} label="バルク金額" className="money" onCommit={commitBulkAmount} /></td>
                    </tr>
                  ) : null}
                  <tr>
                    <td>
                      <strong><EditableText value={form.filmItemName} label="フィルム項目名" onCommit={(next) => update("filmItemName", next.trim())} /></strong>
                      <small><EditableText value={form.filmItemDescription} label="フィルム説明" multiline onCommit={(next) => update("filmItemDescription", next)} /></small>
                      <small className="film-printing" data-testid="film-printing-method">印刷方式：{form.printingMethod === "gravure" ? "グラビア印刷" : "デジタル印刷"}</small>
                      <small className="film-composition" data-testid="film-composition">構成：<EditableText value={form.filmComposition || DEFAULT_FILM_COMPOSITION} label="フィルム構成" onCommit={(next) => update("filmComposition", next.trim())} /></small>
                      <small>フィルム金額は円未満を四捨五入します。</small>
                      {calculationChecklistSnapshot?.sascheCandidate ? (
                        <small className="film-composition">
                          採用条件：{calculationChecklistSnapshot.sascheCandidate.laneCount}丁 /
                          {calculationChecklistSnapshot.sascheCandidate.printTierM}m印刷 /
                          幅{formatNumber(calculationChecklistSnapshot.sascheCandidate.matchedWidthMm, 0)}mm
                        </small>
                      ) : null}
                    </td>
                    <td>
                      <strong data-testid="film-meter-price"><EditableText value={moneyDisplay(shownTotals.filmUnit, form.filmUnitDisplay, 2)} label="フィルム販売m単価" className="money" onCommit={commitFilmMeterUnit} /> /m</strong>
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
                        bulkUnitDisplay: "",
                        bulkAmountDisplay: "",
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
                  {shownTotals && D(shownTotals.customAmount).gt(0) ? (
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
                  {shownTotals && D(shownTotals.copperAmount).gt(0) ? (
                    <tr>
                      <td>
                      <strong><EditableText value={form.copperItemName} label="銅版費項目名" onCommit={(next) => update("copperItemName", next.trim())} /></strong>
                      <small><EditableText value={form.copperItemDescription} label="銅版費説明" multiline onCommit={(next) => update("copperItemDescription", next)} /></small>
                      <small className="film-composition">印刷色1色につき新規銅版1本を作成します。</small>
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
          </div>
          </article>
      </div>


    </main>
  );

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
            {isPriceOverride ? "現在：見積単価 override 中" : "現在：自動計算（銅版は10%固定・他項目は目標利益率）"}
          </p>
        </div>
      </details>
    );
  }
}
