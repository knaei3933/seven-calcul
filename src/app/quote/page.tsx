import { requirePageUser } from "@/lib/page-auth";
import { approverDisplayName } from "@/lib/approver-display-name";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";
import { newQuotationNumberPreparationPrefix } from "@/lib/quotation-creation-policy";
import QuoteClient from "./quote-client";

export const dynamic = "force-dynamic";

export default async function QuotePage() {
  const user = await requirePageUser("/quote");
  // Every new quotation follows the centralized Kanei creation policy. The UI
  // receives a non-allocating KT bucket placeholder; the server assigns the NNN.
  const ownerDomain = "kanei" as const;
  const initialQuotationNumber = newQuotationNumberPreparationPrefix();
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
