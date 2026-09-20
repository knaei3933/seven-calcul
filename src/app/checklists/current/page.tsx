import { requirePageUser } from "@/lib/page-auth";
import CurrentChecklistClient from "./current-checklist-client";

export const dynamic = "force-dynamic";

export default async function CurrentChecklistPage() {
  await requirePageUser("/checklists/current");
  return <CurrentChecklistClient />;
}
