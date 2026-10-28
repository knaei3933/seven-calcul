export type MailAudience = "seven" | "kanei" | "customer" | "supplier" | "designer" | "unknown";

const HANGUL_PATTERN = /[가-힯]/u;

type MailLocale = "ja" | "ko";

function mailLocaleFromBody(body: string): MailLocale {
  return HANGUL_PATTERN.test(body) ? "ko" : "ja";
}

function inferMailAudience(to: string, body: string): Exclude<MailAudience, "unknown"> {
  const address = to.trim().toLowerCase();
  if (address.endsWith("@727.co.jp")) return "seven";
  if (address.endsWith("@kanei-trade.co.jp") || address === "design@package-lab.com") return "kanei";
  return mailLocaleFromBody(body) === "ko" ? "supplier" : "customer";
}

const LABELS: Record<MailLocale, Record<Exclude<MailAudience, "unknown">, string>> = {
  ja: {
    seven: "セブン化学",
    kanei: "金井貿易",
    customer: "お客様",
    supplier: "フィルムメーカー",
    designer: "デザイン担当",
  },
  ko: {
    seven: "세븐화학",
    kanei: "카네이무역",
    customer: "고객",
    supplier: "세중산업/이패키지",
    designer: "디자인 담당",
  },
};

export function withRecipientSubjectPrefix(input: {
  to: string;
  subject: string;
  body?: string;
  audience?: MailAudience;
}): string {
  const audience = input.audience && input.audience !== "unknown"
    ? input.audience
    : inferMailAudience(input.to, input.body ?? "");
  const label = LABELS[mailLocaleFromBody(input.body ?? "")][audience];
  const prefix = `[${label}]`;
  return input.subject.startsWith(prefix) ? input.subject : `${prefix}${input.subject}`;
}
