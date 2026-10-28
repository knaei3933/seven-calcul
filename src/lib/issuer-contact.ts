import { sevenChemical } from "./quotation-draft";
import { isKaneiTradeUser } from "./film-order-access";

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
  if (user.email.trim().toLowerCase() === "kim@kanei-trade.co.jp") {
    return {
      companyName: "",
      contactName: shortIssuerContactName(user.name),
      email: "shapepouch@package-lab.com",
      telephone: "TEL 050-3613-9673",
    };
  }
  if (isKaneiTradeUser(user.email)) {
    return {
      companyName: "金井貿易株式会社",
      contactName: shortIssuerContactName(user.name),
      email: user.email,
      telephone: "TEL 050-3613-9673",
    };
  }
  // 세븐화학 계정에는 개인 전화번호 데이터가 없다. 대표번호를 담당 TEL로 재노출하지 않는다.
  return {
    companyName: sevenChemical.name,
    contactName: shortIssuerContactName(user.name),
    email: user.email,
    telephone: "",
  };
}
