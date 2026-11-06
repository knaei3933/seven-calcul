import { isKaneiTradeUser } from "./film-order-access";
import { quotationOwnerProfile } from "./quote-owner-profiles";
import { quotationOwnerDomainOf } from "./quotation-shared";

export type IssuerContact = {
  companyName: string;
  contactName: string;
  email: string;
  telephone: string;
};

export function shortIssuerContactName(name: string): string {
  const shortened = name.replace(/[（(][^（）)]*[）)]/g, "").trim();
  return shortened || name.trim();
}

export function issuerContactForUser(user: { email: string; name: string }): IssuerContact {
  const profile = quotationOwnerProfile(quotationOwnerDomainOf(user.email));
  if (!profile) {
    return {
      companyName: "",
      contactName: shortIssuerContactName(user.name),
      email: "",
      telephone: "",
    };
  }
  if (user.email.trim().toLowerCase() === "kim@kanei-trade.co.jp") {
    return {
      companyName: profile.legalName,
      contactName: shortIssuerContactName(user.name),
      email: profile.defaultContactEmail,
      telephone: profile.defaultContactTelephone,
    };
  }
  if (isKaneiTradeUser(user.email)) {
    return {
      companyName: profile.legalName,
      contactName: shortIssuerContactName(user.name),
      email: user.email,
      telephone: profile.defaultContactTelephone,
    };
  }
  // 세븐화학 계정에는 개인 전화번호 데이터가 없다. 대표번호를 담당 TEL로 재노출하지 않는다.
  return {
    companyName: profile.legalName,
    contactName: shortIssuerContactName(user.name),
    email: user.email,
    telephone: profile.defaultContactTelephone,
  };
}
