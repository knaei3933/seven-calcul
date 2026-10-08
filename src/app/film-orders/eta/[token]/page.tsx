import { notFound } from "next/navigation";
import { getFilmOrderForEta } from "@/lib/film-orders";
import EtaFormClient from "./eta-form-client";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

export default async function FilmOrderEtaPage({ params }: PageProps) {
  const { token } = await params;
  let order: Awaited<ReturnType<typeof getFilmOrderForEta>> = null;
  try {
    order = await getFilmOrderForEta(token);
  } catch {
    order = null;
  }
  if (!order) notFound();
  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">DELIVERY ESTIMATE</p>
        <h1>納期見込み入力</h1>
        <p className="eta-summary">
          {order.order_number} ／ {order.product_name || "-"}<br />
          {order.printing_method === "gravure" ? "グラビア印刷" : order.printing_method === "digital" ? "デジタル印刷" : "-"}
          {order.web_width_mm ? ` ／ ${order.web_width_mm}mm` : ""}
          {order.order_length_m ? ` ／ ${Number(order.order_length_m).toLocaleString("ja-JP")}m` : ""}
        </p>
        <EtaFormClient token={token} currentEtaDate={order.eta_date ?? ""} currentNote={order.eta_note ?? ""} />
      </section>
    </main>
  );
}
