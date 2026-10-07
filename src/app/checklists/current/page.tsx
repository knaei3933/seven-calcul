import { requirePageUser } from "@/lib/page-auth";
import { canViewInternalChecklist } from "@/lib/checklist-access";
import CurrentChecklistClient from "./current-checklist-client";

export const dynamic = "force-dynamic";

export default async function CurrentChecklistPage() {
  const user = await requirePageUser("/checklists/current");
  return <CurrentChecklistClient canViewInternal={canViewInternalChecklist(user.email)} />;
}
