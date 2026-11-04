import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/page-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import LegacyReconciliationClient from "../legacy-reconciliation-client";

export const dynamic = "force-dynamic";

export default async function LegacyReconciliationPage() {
  const user = await requirePageUser("/film-makers/legacy-reconciliation");
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) redirect("/history");
  return <LegacyReconciliationClient adminEmail={user.email} />;
}
