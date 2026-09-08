import { notFound } from "next/navigation";
import { getChecklistsForQuotation, getQuotation } from "@/lib/quotation-store";
import { CalculationChecklistClient } from "./checklist-client";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ quotationId: string }>;
};

export default async function ChecklistPage({ params }: PageProps) {
  const { quotationId } = await params;
  const id = Number(quotationId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const quotation = await getQuotation(id);
  if (!quotation) notFound();

  const checklists = await getChecklistsForQuotation(id);

  return (
    <main className="checklist-page">
      <section className="panel checklist-header">
        <h1>計算確認チェックリスト</h1>
        <p>{quotation.quotationNumber} ／ {quotation.customerName || "-"} ／ {quotation.productName}</p>
        <p className="help">
          このページは計算根拠の確認記録です。チェック完了しても見積発行や成約処理を自動的に禁止/解除しません。
        </p>
      </section>

      {checklists.length === 0 ? (
        <section className="panel">
          <p className="empty">この見積りはチェックリスト機能導入前に保存されています。新しい見積りを保存すると自動生成されます。</p>
        </section>
      ) : (
        <CalculationChecklistClient
          quotationId={id}
          quotationNumber={quotation.quotationNumber}
          customerName={quotation.customerName}
          records={checklists}
        />
      )}
    </main>
  );
}
