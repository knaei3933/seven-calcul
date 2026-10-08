import { notFound } from "next/navigation";
import { getFilmOrderForProofUpload } from "@/lib/film-orders";
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
  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">PROOF DATA UPLOAD</p>
        <h1>校正データ アップロード</h1>
        <p className="eta-summary">
          {order.order_number} ／ {order.product_name || "-"}<br />
          {order.printing_method === "gravure" ? "グラビア印刷" : order.printing_method === "digital" ? "デジタル印刷" : "-"}
          {order.web_width_mm ? ` ／ ${order.web_width_mm}mm` : ""}
          {order.order_length_m ? ` ／ ${Number(order.order_length_m).toLocaleString("ja-JP")}m` : ""}
        </p>
        <ProofUploadClient token={token} orderNumber={order.order_number} productName={order.product_name} />
      </section>
    </main>
  );
}
