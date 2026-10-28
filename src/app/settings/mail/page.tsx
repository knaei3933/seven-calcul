import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import MailSettingsClient from "./mail-settings-client";

export const dynamic = "force-dynamic";

export default async function MailSettingsPage() {
  const user = await getCurrentUser();
  if (!user || !isKaneiTradeUser(user.email)) redirect("/");
  return <MailSettingsClient currentUser={user} />;
}
