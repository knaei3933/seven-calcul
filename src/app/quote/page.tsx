import { requirePageUser } from "@/lib/page-auth";
import { approverDisplayName } from "@/lib/approver-display-name";
import { issuerContactForUser } from "@/lib/issuer-contact";
import { customerOwnerDomainOf } from "@/lib/film-order-access";
import { getNextQuotationNumber } from "@/lib/quotation-store";
import QuoteClient from "./quote-client";

export const dynamic = "force-dynamic";

export default async function QuotePage() {
  const user = await requirePageUser("/quote");
  const initialQuotationNumber = await getNextQuotationNumber(customerOwnerDomainOf(user.email));
  return (
    <QuoteClient
      approverName={approverDisplayName(user)}
      issuerContact={issuerContactForUser(user)}
      initialQuotationNumber={initialQuotationNumber}
    />
  );
}
