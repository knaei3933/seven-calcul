import type { QuotationOwnerDomain } from "./quotation-shared";

export type ResolvedQuoteOwnerDomain = Exclude<QuotationOwnerDomain, "unresolved">;

export type QuoteOwnerProfile = {
  ownerDomain: ResolvedQuoteOwnerDomain;
  legalName: string;
  portalBrandName: string;
  englishName: string;
  representative: string;
  postalCode: string;
  address: string;
  telephone: string;
  fax: string;
  website: string;
  logoUrl: string;
  logoAlt: string;
  documentHeading: string;
  documentEnglish: string;
  defaultContactEmail: string;
  defaultContactTelephone: string;
  brandLabel: string;
  approvalIntro: string;
  approvalActionLabel: string;
  approvalFooterNote: string;
};

const DEFAULT_KANEI_PROFILE: QuoteOwnerProfile = {
  ownerDomain: "kanei",
  legalName: "金井貿易株式会社",
  portalBrandName: "カネイトレード",
  englishName: "KANAI TRADING CO., LTD.",
  representative: "代表取締役 金 乾雄",
  postalCode: "〒673-0892",
  address: "兵庫県明石市本町2-1-29 みなとメゾン明石本町2F",
  telephone: "TEL 050-3613-9673",
  fax: "",
  website: "https://package-lab.com/",
  logoUrl: "/api/brand-assets/kanei-trade-logo.png",
  logoAlt: "金井貿易ロゴ",
  documentHeading: "お見積書",
  documentEnglish: "QUOTATION",
  defaultContactEmail: "shapepouch@package-lab.com",
  defaultContactTelephone: "TEL 050-3613-9673",
  brandLabel: "Kanei Trade",
  approvalIntro:
    "金井貿易が作成したお見積書をご確認のうえ、承認してください。承認記録は金井貿易の担当者に共有されます。",
  approvalActionLabel: "このお見積書を承認する",
  approvalFooterNote:
    "本お見積書に関するご連絡は、金井貿易の下記担当窓口までお願いいたします。",
};

export const DEFAULT_KANEI_QUOTE_PROFILE = DEFAULT_KANEI_PROFILE;

const DEFAULT_SEVEN_PROFILE: QuoteOwnerProfile = {
  ownerDomain: "seven",
  legalName: "株式会社セブン化学",
  portalBrandName: "株式会社セブン化学",
  englishName: "SEVEN CHEMICAL CO., LTD.",
  representative: "代表取締役社長 吾藤 靖",
  postalCode: "〒582-0017",
  address: "大阪府柏原市太平寺1丁目12番1号",
  telephone: "TEL 072-971-0726",
  fax: "FAX 072-971-5800",
  website: "https://7chemical.co.jp/",
  logoUrl: "/seven-chemical-logo.png",
  logoAlt: "セブン化學ロゴ",
  documentHeading: "お見積書",
  documentEnglish: "QUOTATION",
  defaultContactEmail: "gotou@727.co.jp",
  defaultContactTelephone: "",
  brandLabel: "Seven Chemical",
  approvalIntro:
    "セブン化学が作成したお見積書をご確認のうえ、承認してください。承認記録はセブン化学の担当者に共有されます。",
  approvalActionLabel: "このお見積書を承認する",
  approvalFooterNote:
    "本お見積書に関するご連絡は、セブン化学の下記担当窓口までお願いいたします。",
};

export const DEFAULT_SEVEN_QUOTE_PROFILE = DEFAULT_SEVEN_PROFILE;

function configured(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

const CONFIGURABLE_PROFILE_FIELDS = [
  ["legalName", "LEGAL_NAME"],
  ["portalBrandName", "PORTAL_BRAND_NAME"],
  ["englishName", "ENGLISH_NAME"],
  ["postalCode", "POSTAL_CODE"],
  ["address", "ADDRESS"],
  ["telephone", "TELEPHONE"],
  ["fax", "FAX"],
  ["website", "WEBSITE"],
  ["logoUrl", "LOGO_URL"],
  ["defaultContactEmail", "CONTACT_EMAIL"],
  ["defaultContactTelephone", "CONTACT_TELEPHONE"],
  ["brandLabel", "BRAND_LABEL"],
] as const;

function profileWithEnvironmentOverrides(
  profile: QuoteOwnerProfile,
  ownerPrefix: "KANEI" | "SEVEN",
): QuoteOwnerProfile {
  return CONFIGURABLE_PROFILE_FIELDS.reduce<QuoteOwnerProfile>((owner, [field, suffix]) => ({
    ...owner,
    [field]: configured(`QUOTE_OWNER_${ownerPrefix}_${suffix}`, owner[field]),
  }), profile);
}

export function quotationOwnerProfile(
  ownerDomain: QuotationOwnerDomain,
): QuoteOwnerProfile | null {
  if (ownerDomain === "kanei") {
    return profileWithEnvironmentOverrides(DEFAULT_KANEI_PROFILE, "KANEI");
  }
  if (ownerDomain === "seven") {
    return profileWithEnvironmentOverrides(DEFAULT_SEVEN_PROFILE, "SEVEN");
  }
  return null;
}
