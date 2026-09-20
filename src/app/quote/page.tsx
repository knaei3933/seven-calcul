import { requirePageUser } from "@/lib/page-auth";
import QuoteClient from "./quote-client";

export const dynamic = "force-dynamic";

export default async function QuotePage() {
  await requirePageUser("/quote");
  return <QuoteClient />;
}
