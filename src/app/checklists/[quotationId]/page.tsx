import { notFound } from "next/navigation";
import {
  createChecklistsForQuotation,
  createLegacyChecklistsForQuotation,
  getChecklistsForQuotation,
  getQuotation,
} from "@/lib/quotation-store";
import { CHECKLIST_VERSION, readCalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import { printingMethodOf } from "@/lib/quotation-history";
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

  const savedChecklists = await getChecklistsForQuotation(id);
  const payloadSnapshot = readCalculationChecklistSnapshot(quotation.payload.calculationChecklistSnapshot);
  if (payloadSnapshot) payloadSnapshot.checklistVersion = CHECKLIST_VERSION;
  const hasLegacyChecklists = savedChecklists.length > 0
    && savedChecklists.every((record) => record.checklistVersion.startsWith("legacy-"));
  const hasOutdatedChecklists = savedChecklists.length > 0
    && savedChecklists.some((record) => record.checklistVersion !== CHECKLIST_VERSION);
  const hasStaleResultHash = savedChecklists.length > 0
    && !!payloadSnapshot
    && savedChecklists.some((record) => record.snapshot?.resultHash !== payloadSnapshot.resultHash);
  const shouldRebuild = savedChecklists.length === 0
    || hasLegacyChecklists
    || (!!payloadSnapshot && (hasOutdatedChecklists || hasStaleResultHash));
  const checklists = shouldRebuild
    ? payloadSnapshot
      ? await createChecklistsForQuotation(quotation, payloadSnapshot)
      : await createLegacyChecklistsForQuotation(quotation, printingMethodOf(quotation))
    : savedChecklists;

  return (
    <main className="checklist-page">
      <section className="panel checklist-header">
        <h1>計算確認チェックリスト</h1>
        <p>{quotation.quotationNumber} ／ {quotation.customerName || "-"} ／ {quotation.productName}</p>
        <p className="help">
          このページは計算根拠の確認記録です。チェック完了しても見積発行や成約処理を自動的に禁止/解除しません。
        </p>
        {checklists[0]?.checklistVersion.startsWith("legacy-") ? (
          <p className="warning">
            この見積りはチェックリスト機能導入前に保存されています。保存済み見積り情報から計算根拠を再構築して表示しています。
          </p>
        ) : null}
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
