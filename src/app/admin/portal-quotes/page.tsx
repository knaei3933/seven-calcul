import { redirect } from "next/navigation";
import { requireAdminPageUser } from "@/lib/page-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import PortalQuotesClient from "./portal-quotes-client";

export const dynamic = "force-dynamic";

export default async function PortalQuotesPage() {
  const user = await requireAdminPageUser("/admin/portal-quotes");
  if (!isKaneiTradeUser(user.email)) redirect("/");
  return <PortalQuotesClient />;
}
