import { notFound } from "next/navigation";
import { getFilmOrderForProofUpload } from "@/lib/film-orders";
import { supplierLocaleFor } from "@/lib/film-order-access";
import ProofUploadClient from "./proof-upload-client";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

export default async function FilmOrderProofUploadPage({ params }: PageProps) {
  const { token } = await params;
  let order: Awaited<ReturnType<typeof getFilmOrderForProofUpload>> = null;
  try {
    order = await getFilmOrderForProofUpload(token);
  } catch {
    order = null;
  }
  if (!order) notFound();
  const locale = supplierLocaleFor(order);
  const printing = order.printing_method === "gravure"
    ? (locale === "ko" ? "그라비아 인쇄" : "グラビア印刷")
    : order.printing_method === "digital"
      ? (locale === "ko" ? "디지털 인쇄" : "デジタル印刷")
      : "-";
  const title = locale === "ko" ? "교정 데이터 업로드" : "校正データ アップロード";
  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">PROOF DATA UPLOAD</p>
        <h1>{title}</h1>
        <p className="eta-summary">
          {order.order_number} ／ {order.product_name || "-"}<br />
          {printing}
          {order.web_width_mm ? ` ／ ${order.web_width_mm}mm` : ""}
          {order.order_length_m ? ` ／ ${Number(order.order_length_m).toLocaleString(locale === "ko" ? "ko-KR" : "ja-JP")}m` : ""}
        </p>
        <ProofUploadClient token={token} orderNumber={order.order_number} productName={order.product_name} locale={locale} />
      </section>
    </main>
  );
}
