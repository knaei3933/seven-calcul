import { requirePageUser } from "@/lib/page-auth";
import { approverDisplayName } from "@/lib/approver-display-name";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";
import type { ResolvedQuoteOwnerDomain } from "@/lib/quote-owner-profiles";
import { getNextQuotationNumber } from "@/lib/quotation-store";
import QuoteClient from "./quote-client";

export const dynamic = "force-dynamic";

const KANEI_ISSUER_CONTACT_EMAIL = "shapepouch@package-lab.com";

export default async function QuotePage() {
  const user = await requirePageUser("/quote");
  // 충진견적서는 발행자와 무관하게 Seven Chemical이 문서 소유자다.
  // 카네이 계정은 담당자 이름/발행 메일만 발행 맥락으로 반영한다.
  const ownerDomain: ResolvedQuoteOwnerDomain = "seven";
  const initialQuotationNumber = await getNextQuotationNumber(ownerDomain);
  const ownerProfile = quotationOwnerProfile(ownerDomain)!;
  const issuerEmail = isKaneiTradeUser(user.email)
    ? KANEI_ISSUER_CONTACT_EMAIL
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
