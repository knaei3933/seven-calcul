import { resolveMailRoute } from "./mail-routing";
import { withRecipientSubjectPrefix } from "./mail-subject";
import { getMailSettings, resolveMailTemplate } from "./mail-settings";

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  audience?: import("./mail-subject").MailAudience;
  cc?: string[];
  templateKey?: string;
  templateVars?: Record<string, unknown>;
  configuredRecipientKey?: "design" | "seven" | "kaneiApprovals" | "supplierByLocale";
}

export interface MailSendResult {
  to: string;
  subject: string;
  dryRun: boolean;
  messageId?: string;
  error?: string;
  text?: string;
  requestedTo?: string;
  recipientOverridden?: boolean;
}

export function mailDryRun(): boolean {
  return process.env.MAIL_DRY_RUN === "true";
}

const SMTP_TIMEOUT_MS = 15_000;

/**
 * XServer SMTP でメールを送信する。
 * MAIL_DRY_RUN=true の場合は実際に送信せず、結果オブジェクトだけ返す（テスト用）。
 */
export async function sendMail(input: MailInput): Promise<MailSendResult> {
  const settings = await getMailSettings();
  let requested = input.to;
  const configured = input.configuredRecipientKey === "supplierByLocale"
    ? (/[가-힯]/u.test(input.text) ? settings.recipients.supplierKorean : settings.recipients.supplierJapanese)
    : input.configuredRecipientKey ? settings.recipients[input.configuredRecipientKey] : "";
  if (configured) requested = configured;
  const route = resolveMailRoute(requested, settings.testMode);
  const resolved = input.templateKey
    ? resolveMailTemplate(settings, input.templateKey, { subject: input.subject, body: input.text }, input.templateVars)
    : { subject: input.subject, body: input.text, cc: [] };
  const cc = [...new Set([...settings.globalCc, ...input.cc ?? [], ...resolved.cc])];
  const subject = withRecipientSubjectPrefix({
    to: requested,
    subject: resolved.subject,
    body: resolved.body,
    audience: input.audience,
  });
  const base = {
    to: route.to,
    requestedTo: route.overridden ? input.to : undefined,
    recipientOverridden: route.overridden,
    subject,
    cc,
  };
  if (mailDryRun()) {
    console.log("[mail:dry-run]", JSON.stringify(base));
    return { ...base, dryRun: true, text: input.text };
  }
  const host = process.env.SMTP_HOST ?? "sv12515.xserver.jp";
  const port = Number(process.env.SMTP_PORT ?? 465);
  const user = process.env.SMTP_USER ?? "";
  const password = process.env.SMTP_PASSWORD ?? "";
  if (!user || !password) {
    return { ...base, dryRun: false, error: "smtp_credentials_missing" };
  }
  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass: password },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM ?? user,
      to: route.to,
      subject,
      text: resolved.body,
      cc,
    });
    return { ...base, dryRun: false, messageId: info.messageId, text: input.text };
  } catch (error) {
    return { ...base, dryRun: false, error: error instanceof Error ? error.message : "smtp_error" };
  }
}
