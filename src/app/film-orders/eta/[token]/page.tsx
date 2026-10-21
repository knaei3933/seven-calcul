import { notFound } from "next/navigation";
import { getFilmOrderForEta } from "@/lib/film-orders";
import { supplierLocaleFor } from "@/lib/film-order-access";
import EtaFormClient from "./eta-form-client";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ token: string }> };

const TEXT = {
  ko: {
    eyebrow: "DELIVERY ESTIMATE",
    title: "납기 전망 입력",
    digital: "디지털 인쇄",
    gravure: "그라비아 인쇄",
  },
  ja: {
    eyebrow: "DELIVERY ESTIMATE",
    title: "納期見込み入力",
    digital: "デジタル印刷",
    gravure: "グラビア印刷",
  },
} as const;

export default async function FilmOrderEtaPage({ params }: PageProps) {
  const { token } = await params;
  let order: Awaited<ReturnType<typeof getFilmOrderForEta>> = null;
  try {
    order = await getFilmOrderForEta(token);
  } catch {
    order = null;
  }
  if (!order) notFound();
  const locale = supplierLocaleFor(order);
  const t = TEXT[locale];
  const printing = order.printing_method === "gravure"
    ? t.gravure
    : order.printing_method === "digital"
      ? t.digital
      : "-";
  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">{t.eyebrow}</p>
        <h1>{t.title}</h1>
        <p className="eta-summary">
          {order.order_number} ／ {order.product_name || "-"}<br />
          {printing}
          {order.web_width_mm ? ` ／ ${order.web_width_mm}mm` : ""}
          {order.order_length_m ? ` ／ ${Number(order.order_length_m).toLocaleString(locale === "ko" ? "ko-KR" : "ja-JP")}m` : ""}
        </p>
        <EtaFormClient
          token={token}
          currentEtaDate={order.eta_date ?? ""}
          currentNote={order.eta_note ?? ""}
          delivery={order.delivery}
          locale={locale}
        />
      </section>
    </main>
  );
}
