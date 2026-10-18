import { sevenChemical } from "./quotation-draft";
import { isKaneiTradeUser } from "./film-order-access";

export type IssuerContact = {
  companyName: string;
  contactName: string;
  email: string;
  telephone: string;
};

export function issuerContactForUser(user: { email: string; name: string }): IssuerContact {
  if (isKaneiTradeUser(user.email)) {
    return {
      companyName: "金井貿易株式会社",
      contactName: user.name,
      email: user.email,
      telephone: "TEL 050-3613-9673",
    };
  }
  return {
    companyName: sevenChemical.name,
    contactName: user.name,
    email: user.email,
    telephone: "TEL 072-971-0726",
  };
}
