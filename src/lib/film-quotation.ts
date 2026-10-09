import { D } from "./decimal";

export const kaneiTrade = {
  name: "金井貿易株式会社",
  englishName: "KANAI TRADING CO., LTD.",
  postalCode: "〒673-0892",
  address: "兵庫県明石市本町2-1-29 みなとメゾン明石本町2F",
  telephone: "TEL 050-3613-9673",
  fax: "",
  email: "kim@kanei-trade.co.jp",
  representative: "代表取締役",
} as const;

export interface FilmQuotationData {
  quotationNumber: string;
  pouchQuotationNumber: string;
  productName: string;
  quantity: string;
  issueDate: string;
  validUntil: string;
  items: { description: string; webWidthMm: string; orderLengthM: string; unitPriceYenPerM: string; amountYen: string }[];
  subtotal: string;
  tax: string;
  grandTotal: string;
  notes: string[];
}

export function buildFilmQuotationFromRecord(record: {
  quotationNumber: string;
  issueDate: string;
  validUntil: string;
  productName: string;
  quantity: string;
  payload: Record<string, unknown>;
}): FilmQuotationData | null {
  const payload = record.payload as {
    filmOrderLengthM?: string;
    calculationFilmTotal?: string;
    filmUnitDisplay?: string;
    calculationChecklistSnapshot?: {
      film?: { orderLengthM?: string; filmTotal?: string; unitPrice?: string; requiredLengthM?: string };
      materialWidthMm?: string;
      skus?: { name?: string; quantity?: string }[];
    };
    purchaseOrder?: { webWidthMm?: number; filmComposition?: string };
  };
  const snapshot = payload.calculationChecklistSnapshot;
  const orderLength = snapshot?.film?.orderLengthM ?? payload.filmOrderLengthM;
  if (!orderLength || Number(orderLength) <= 0) return null;

  const filmTotal = snapshot?.film?.filmTotal ?? payload.calculationFilmTotal ?? "0";
  const unitPrice = snapshot?.film?.unitPrice ?? payload.filmUnitDisplay ?? "0";
  const webWidth = String(payload.purchaseOrder?.webWidthMm ?? snapshot?.materialWidthMm ?? "");
  const composition = payload.purchaseOrder?.filmComposition ?? "PET12+AL7+PET12+LLDPE50μ";
  const skuNames = snapshot?.skus?.map((s) => s.name).filter(Boolean) ?? [];
  const productLabel = record.productName || skuNames.join("・") || "パウチ製品";

  const now = new Date(record.issueDate);
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");

  const subtotalD = D(filmTotal);
  const taxD = subtotalD.times("0.1").toDecimalPlaces(0);
  const grandD = subtotalD.plus(taxD);

  return {
    quotationNumber: `K-${yy}${mm}-001`,
    pouchQuotationNumber: record.quotationNumber,
    productName: productLabel,
    quantity: record.quantity,
    issueDate: record.issueDate,
    validUntil: record.validUntil,
    items: [{
      description: `${productLabel}用 フィルム（${composition}）`,
      webWidthMm: webWidth,
      orderLengthM: orderLength,
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
