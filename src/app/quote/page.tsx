import { requirePageUser } from "@/lib/page-auth";
import { approverDisplayName } from "@/lib/approver-display-name";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";
import { getNextQuotationNumber } from "@/lib/quotation-store";
import QuoteClient from "./quote-client";

export const dynamic = "force-dynamic";

export default async function QuotePage() {
  const user = await requirePageUser("/quote");
  // All customer-facing pouch quotations are issued under Seven Chemical.
  const ownerDomain = "seven" as const;
  const initialQuotationNumber = await getNextQuotationNumber(ownerDomain);
  const ownerProfile = quotationOwnerProfile(ownerDomain)!;
  const issuerEmail = isKaneiTradeUser(user.email)
    ? "shapepouch@package-lab.com"
    : user.email;
  return (
    <QuoteClient
      approverName={approverDisplayName(user)}
      issuerContact={{
        companyName: ownerProfile.legalName,
        contactName: approverDisplayName(user),
        email: issuerEmail,
        telephone: "",
      }}
      initialQuotationNumber={initialQuotationNumber}
      ownerDomain={ownerDomain}
      ownerProfile={ownerProfile}
    />
  );
}
