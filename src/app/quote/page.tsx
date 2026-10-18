import { requirePageUser } from "@/lib/page-auth";
import { approverDisplayName } from "@/lib/approver-display-name";
import QuoteClient from "./quote-client";

export const dynamic = "force-dynamic";

export default async function QuotePage() {
  const user = await requirePageUser("/quote");
  return <QuoteClient approverName={approverDisplayName(user)} />;
}
