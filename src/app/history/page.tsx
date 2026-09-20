import { requirePageUser } from "@/lib/page-auth";
import HistoryClient from "./history-client";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const user = await requirePageUser("/history");
  return <HistoryClient currentUser={user} />;
}
