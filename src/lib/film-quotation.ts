import { D, Decimal, parseDecimal } from "./decimal";

export const kaneiTrade = {
  name: "金井貿易株式会社",
  englishName: "KANAI TRADING CO., LTD.",
  divisionName: "Epackage-Lab",
  divisionLabel: "フィルム販売事業部",
  postalCode: "〒673-0892",
  address: "兵庫県明石市本町2-1-29 みなとメゾン明石本町2F",
  telephone: "TEL 050-3613-9673",
  fax: "",
  email: "kim@kanei-trade.co.jp",
  representative: "代表取締役 金 乾雄",
} as const;

export interface FilmQuotationData {
  quotationNumber: string;
  pouchQuotationNumber: string;
  endCustomerName: string;
  productName: string;
  filmComposition: string;
  printingMethodLabel: string;
  colorCountLabel: string;
  quantity: string;
  issueDate: string;
  validUntil: string;
  items: { description: string; specification: string; webWidthMm: string; orderLengthM: string; unitPriceYenPerM: string; amountYen: string }[];
  subtotal: string;
  tax: string;
  grandTotal: string;
  notes: string[];
}

export function filmQuotationNumberFor(
  pouchQuotationNumber: string,
  issuedAt: string | Date = new Date(),
): string {
  const source = pouchQuotationNumber.trim();
  const legacyMatch = /^S7-(\d{6})-(\d+)$/u.exec(source);
  if (legacyMatch) return `K-${legacyMatch[1]}-${legacyMatch[2].padStart(3, "0")}-F`;

  const sourceId = source.replace(/^S7-/u, "").replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 32);
  return `K-${sourceId || Date.now().toString(36).toUpperCase()}-F`;
}

export function buildFilmQuotationFromRecord(record: {
  quotationNumber: string;
  customerName?: string;
  filmOrderLengthM?: string;
  filmMeterPrice?: string;
  issueDate: string;
  validUntil: string;
  productName: string;
  quantity: string;
  payload: Record<string, unknown>;
}): FilmQuotationData | null {
  const payload = record.payload as {
    filmOrderLengthM?: string;
    filmComposition?: string;
    printingMethod?: string;
    calculationFilmTotal?: string;
    filmUnitDisplay?: string;
    calculationChecklistSnapshot?: {
      printingMethod?: string;
      film?: { orderLengthM?: string; filmTotal?: string; unitPrice?: string; requiredLengthM?: string };
      materialWidthMm?: string;
      skus?: { name?: string; quantity?: string; colorCount?: string }[];
    };
    purchaseOrder?: {
      printingMethod?: string;
      webWidthMm?: number;
      filmComposition?: string;
      colorCount?: number;
      skuOrderDetails?: { name?: string; colorCount?: string }[];
    };
  };
  const snapshot = payload.calculationChecklistSnapshot;
  const orderLength = snapshot?.film?.orderLengthM ?? payload.filmOrderLengthM ?? record.filmOrderLengthM;
  const orderLengthD = parseDecimal(orderLength);
  if (!orderLengthD || orderLengthD.lte(0)) return null;

  const storedFilmTotal = snapshot?.film?.filmTotal ?? payload.calculationFilmTotal;
  // 明細の単価は物流・通関費を含む総額換算にする。snapshot.unitPrice は材料単価のみのケースがある。
  const materialUnitPrice = snapshot?.film?.unitPrice ?? payload.filmUnitDisplay ?? record.filmMeterPrice ?? "0";
  const materialUnitD = parseDecimal(materialUnitPrice);
  const materialUnit = materialUnitD && materialUnitD.gt(0) ? materialUnitD : D(0);
  const storedTotalD = parseDecimal(storedFilmTotal);
  const storedTotal = storedTotalD && storedTotalD.gt(0) ? storedTotalD : null;
  const filmTotalD = storedTotal ?? (
    materialUnit.gt(0)
      ? materialUnit.times(orderLengthD).toDecimalPlaces(0, Decimal.ROUND_CEIL)
      : D(0)
  );
  const filmTotal = filmTotalD.toString();
  const unitPrice = filmTotalD.gt(0)
    ? filmTotalD.div(orderLengthD).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString()
    : materialUnit.toString();
  const webWidth = String(payload.purchaseOrder?.webWidthMm ?? snapshot?.materialWidthMm ?? "");
  const composition = (typeof payload.filmComposition === "string" && payload.filmComposition.trim())
    || payload.purchaseOrder?.filmComposition
    || "PET12+AL7+PET12+LLDPE50μ";
  const skuNames = [
    ...(payload.purchaseOrder?.skuOrderDetails ?? []).map((sku) => sku.name),
    ...(snapshot?.skus ?? []).map((sku) => sku.name),
  ].filter(Boolean);
  const productLabel = record.productName || skuNames[0] || snapshot?.skus?.map((sku) => sku.name).filter(Boolean).join("・") || "パウチ製品";
  const endCustomerName = record.customerName?.trim() || "";

  const rawPrintingMethod = payload.purchaseOrder?.printingMethod
    ?? snapshot?.printingMethod
    ?? payload.printingMethod
    ?? "digital";
  const printingMethodLabel = rawPrintingMethod === "gravure" ? "グラビア印刷（ロール）" : "デジタル印刷";

  const colorValues = [
    ...(payload.purchaseOrder?.skuOrderDetails ?? []).map((sku) => Number(sku.colorCount)),
    ...(snapshot?.skus ?? []).map((sku) => Number(sku.colorCount)),
  ].filter((count) => Number.isFinite(count) && count > 0);
  if (colorValues.length === 0) {
    const purchaseColorCount = Number(payload.purchaseOrder?.colorCount);
    if (Number.isFinite(purchaseColorCount) && purchaseColorCount > 0) colorValues.push(purchaseColorCount);
  }
  const uniqueColorValues = [...new Set(colorValues)];
  const colorCountLabel = uniqueColorValues.length === 0
    ? "要確認"
    : uniqueColorValues.length === 1
      ? `${uniqueColorValues[0]}色`
      : `SKU別（${uniqueColorValues.map((count) => `${count}色`).join("・")}）`;

  const subtotalD = D(filmTotal).toDecimalPlaces(0, Decimal.ROUND_CEIL);
  const taxD = subtotalD.times("0.1").toDecimalPlaces(0, Decimal.ROUND_CEIL);
  const grandD = subtotalD.plus(taxD);

  return {
    quotationNumber: filmQuotationNumberFor(record.quotationNumber, record.issueDate),
    pouchQuotationNumber: record.quotationNumber,
    endCustomerName,
    productName: productLabel,
    filmComposition: composition,
    printingMethodLabel,
    colorCountLabel,
    quantity: record.quantity,
    issueDate: record.issueDate,
    validUntil: record.validUntil,
    items: [{
      description: "異形パウチ専用フィルム",
      specification: [
        `商品名：${endCustomerName ? `${endCustomerName}／${productLabel}` : productLabel}`,
        `フィルム構成：${composition}`,
        `印刷方式：${printingMethodLabel}`,
        `印刷色数：${colorCountLabel}`,
        `単価条件：フィルム製作・国内輸送・海外輸送・通関費込み`,
      ].join("\n"),
      webWidthMm: webWidth,
      orderLengthM: orderLengthD.toString(),
      unitPriceYenPerM: unitPrice,
      amountYen: filmTotal,
    }],
    subtotal: subtotalD.toString(),
    tax: taxD.toString(),
    grandTotal: grandD.toString(),
    notes: [
      `パウチ見積書 ${record.quotationNumber} 対応`,
      `対象製品：${productLabel}（${Number(record.quantity).toLocaleString("ja-JP")}枚）`,
      "納期：ご注文後、3〜4週間（データ確定後）",
      "お支払い：月末締め翌月末払い",
      "有効期限経過後は再度お見積りいたします",
    ],
  };
}
