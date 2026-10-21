import { notFound } from "next/navigation";
import { getFilmOrderForSupplierPurchaseOrder } from "@/lib/film-orders";
import { supplierLocaleFor } from "@/lib/film-order-access";
import PurchaseOrderPrintButton from "./print-button";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

const TEXT = {
  ko: {
    eyebrow: "FILM PURCHASE ORDER",
    title: "필름 발주서",
    issuer: "발주자",
    supplier: "공급자",
    orderSummary: "발주 요약",
    productionSpec: "제작 사양",
    orderNumber: "발주번호",
    quotationNumber: "견적번호",
    issueDate: "발주일",
    product: "품목",
    customer: "최종 고객",
    printing: "인쇄 방식",
    pouchQuantity: "파우치 수량",
    filmComposition: "필름 구성",
    webWidth: "원단 폭",
    orderLength: "발주 길이",
    requiredLength: "필요 길이",
    colorCount: "색상 수",
    lanes: "동시 치수",
    pitch: "피치",
    patternCount: "조 패턴 수",
    skuDetails: "SKU별 발주 내역",
    sku: "SKU",
    skuName: "품목명",
    skuQuantity: "수량",
    skuColor: "색상",
    skuWidth: "원단 폭",
    skuLength: "발주 길이",
    print: "인쇄",
    etaNote: "납기 전망은 별도 등록 페이지에서 입력해 주십시오.",
    confidential: "본 문서는 지정 공급자 전용입니다. 무단 전재·공유를 금지합니다.",
    digital: "디지털 인쇄",
    gravure: "그라비아 인쇄",
  },
  ja: {
    eyebrow: "FILM PURCHASE ORDER",
    title: "フィルム発注書",
    issuer: "発注者",
    supplier: "供給者",
    orderSummary: "発注概要",
    productionSpec: "製作仕様",
    orderNumber: "発注番号",
    quotationNumber: "見積番号",
    issueDate: "発注日",
    product: "品名",
    customer: "最終顧客",
    printing: "印刷方式",
    pouchQuantity: "パウチ数量",
    filmComposition: "フィルム構成",
    webWidth: "原反幅",
    orderLength: "発注長",
    requiredLength: "必要長",
    colorCount: "色数",
    lanes: "取数",
    pitch: "ピッチ",
    patternCount: "パターン数",
    skuDetails: "SKU別発注内容",
    sku: "SKU",
    skuName: "品名",
    skuQuantity: "数量",
    skuColor: "色数",
    skuWidth: "原反幅",
    skuLength: "発注長",
    print: "印刷",
    etaNote: "納期見込みは専用登録ページから入力してください。",
    confidential: "本書は指定サプライヤー専用です。無断転載・共有はご遠慮ください。",
    digital: "デジタル印刷",
    gravure: "グラビア印刷",
  },
} as const;

function dateText(value: string | null, locale: "ko" | "ja"): string {
  if (!value) return "-";
  return new Date(value).toLocaleDateString(locale === "ko" ? "ko-KR" : "ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

function numberText(value: unknown, unit: string, locale: "ko" | "ja"): string {
  if (value === null || value === undefined || value === "") return "-";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return `${parsed.toLocaleString(locale === "ko" ? "ko-KR" : "ja-JP")}${unit}`;
}

export default async function SupplierPurchaseOrderPage({ params }: PageProps) {
  const { token } = await params;
  let order: Awaited<ReturnType<typeof getFilmOrderForSupplierPurchaseOrder>> | null = null;
  try {
    order = await getFilmOrderForSupplierPurchaseOrder(token);
  } catch {
    order = null;
  }
  if (!order) notFound();

  const locale = supplierLocaleFor(order);
  const t = TEXT[locale];
  const purchaseOrder = order.purchaseOrder;
  const printing = order.printing_method === "gravure" ? t.gravure : order.printing_method === "digital" ? t.digital : "-";
  const summary = [
    [t.orderNumber, order.order_number],
    [t.quotationNumber, order.quotation_number],
    [t.issueDate, dateText(order.po_sent_at, locale)],
    [t.product, order.product_name || "-"],
    [t.customer, order.customer_name || "-"],
  ] as const;
  const specs = [
    [t.printing, printing],
    [t.pouchQuantity, numberText(order.pouch_quantity, locale === "ko" ? "개" : "枚", locale)],
    [t.filmComposition, order.film_composition || purchaseOrder?.filmComposition || "-"],
    [t.webWidth, (order.web_width_mm || purchaseOrder?.webWidthMm) ? `${Number(order.web_width_mm || purchaseOrder?.webWidthMm)}mm` : "-"],
    [t.orderLength, numberText(order.order_length_m || purchaseOrder?.orderLengthM, "m", locale)],
    [t.requiredLength, numberText(purchaseOrder?.requiredLengthM, "m", locale)],
    [t.colorCount, purchaseOrder?.colorCount != null ? String(purchaseOrder.colorCount) : "-"],
    [t.lanes, purchaseOrder?.lanes != null ? String(purchaseOrder.lanes) : "-"],
    [t.pitch, purchaseOrder?.pitchMm ? `${purchaseOrder.pitchMm}mm` : "-"],
    ...(purchaseOrder?.orderPatternCount
      ? [[t.patternCount, String(purchaseOrder.orderPatternCount)] as const]
      : []),
  ] as const;

  return (
    <main className="supplier-po-page">
      <article className="supplier-po-sheet" aria-label={t.title}>
        <header className="supplier-po-header">
          <div>
            <p className="supplier-po-eyebrow">{t.eyebrow}</p>
            <h1>{t.title}</h1>
          </div>
          <div className="supplier-po-title-meta">
            <strong>{order.order_number}</strong>
            <span>{dateText(order.po_sent_at, locale)}</span>
          </div>
        </header>

        <section className="supplier-po-parties">
          <div>
            <h2>{t.issuer}</h2>
            <p><strong>Package Lab</strong></p>
            <p>shapepouch@package-lab.com</p>
          </div>
          <div>
            <h2>{t.supplier}</h2>
            <p><strong>{order.supplier_name || "-"}</strong></p>
            <p>{order.supplier_email || "-"}</p>
          </div>
        </section>

        <section className="supplier-po-section">
          <h2>{t.orderSummary}</h2>
          <dl className="supplier-po-grid">
            {summary.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </section>

        <section className="supplier-po-section">
          <h2>{t.productionSpec}</h2>
          <dl className="supplier-po-grid">
            {specs.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </section>

        {purchaseOrder?.skuOrderDetails?.length ? (
          <section className="supplier-po-section">
            <h2>{t.skuDetails}</h2>
            <div className="supplier-po-table-wrap">
              <table className="supplier-po-table">
                <thead>
                  <tr>
                    <th>{t.sku}</th><th>{t.skuName}</th><th>{t.skuQuantity}</th>
                    <th>{t.skuColor}</th><th>{t.skuWidth}</th><th>{t.skuLength}</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseOrder.skuOrderDetails.map((sku) => (
                    <tr key={`${sku.skuCode}-${sku.name}-${sku.orderLengthM}`}>
                      <td>{sku.skuCode}</td>
                      <td>{sku.name}</td>
                      <td>{numberText(sku.quantity, locale === "ko" ? "개" : "枚", locale)}</td>
                      <td>{sku.colorCount}</td>
                      <td>{sku.webWidthMm}mm</td>
                      <td>{numberText(sku.orderLengthM, "m", locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <footer className="supplier-po-footer">
          <p>{t.etaNote}</p>
          <p>{t.confidential}</p>
        </footer>
      </article>
      <PurchaseOrderPrintButton label={t.print} />
    </main>
  );
}
