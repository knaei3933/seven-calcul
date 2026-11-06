import { notFound } from "next/navigation";
import { getChecklistsForQuotation, getQuotation } from "@/lib/quotation-store";
import { CHECKLIST_VERSION, readCalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import { requirePageUser } from "@/lib/page-auth";
import { canViewInternalChecklist } from "@/lib/checklist-access";
import { canPerformOwnerWorkflowAction, canReadQuotation } from "@/lib/quotation-access";
import { CalculationChecklistClient } from "./checklist-client";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ quotationId: string }>;
};

export default async function ChecklistPage({ params }: PageProps) {
  const { quotationId } = await params;
  const user = await requirePageUser(`/checklists/${quotationId}`);
  const id = Number(quotationId);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const quotation = await getQuotation(id);
  if (!quotation) notFound();
  if (!canReadQuotation(user, quotation)) notFound();

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
  const checklists = savedChecklists;
  // 社内QA（金井貿易）チェックリストは金井貿易アカウントにのみ表示する。
  const visibleChecklists = canViewInternalChecklist(user.email, quotation.ownerDomain)
    ? checklists
    : checklists.filter((record) => record.audience !== "INTERNAL_QA");

  const canRebuild = canPerformOwnerWorkflowAction(user, quotation);
  const requiresExplicitRebuild = shouldRebuild && canRebuild;

  return (
    <main className="checklist-page current-checklist">
      {checklists.length === 0 && !requiresExplicitRebuild ? (
        <section className="panel">
          <p className="empty">この見積りはチェックリスト機能導入前に保存されています。新しい見積りを保存すると自動生成されます。</p>
        </section>
      ) : (
        <CalculationChecklistClient
          quotationId={id}
          quotationNumber={quotation.quotationNumber}
          customerName={quotation.customerName}
          ownerDomain={quotation.ownerDomain}
          rebuildRequired={requiresExplicitRebuild}
          canRebuild={canRebuild}
          records={visibleChecklists}
          isLegacy={checklists[0]?.checklistVersion.startsWith("legacy-")}
        />
      )}
    </main>
  );
}
