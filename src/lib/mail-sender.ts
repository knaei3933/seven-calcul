import nodemailer from "nodemailer";
import { resolveMailRoute } from "./mail-routing";
import { withRecipientSubjectPrefix } from "./mail-subject";
import { getMailSettings, resolveMailTemplate } from "./mail-settings";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string[];
  templateKey?: string;
  templateVars?: Record<string, unknown>;
  attachments?: MailAttachment[];
}

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && (process.env.SMTP_PASSWORD || process.env.SMTP_PASS));
}

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: Number(process.env.SMTP_PORT ?? 465) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD || process.env.SMTP_PASS,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 15_000,
  });
}

export interface SendMailResult {
  messageId: string;
  recipient: string;
  recipientOverridden: boolean;
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (!isSmtpConfigured()) throw new Error("smtp_not_configured");
  const settings = await getMailSettings();
  const route = resolveMailRoute(input.to, settings.testMode);
  const resolved = input.templateKey
    ? resolveMailTemplate(settings, input.templateKey, { subject: input.subject, body: input.body }, input.templateVars)
    : { subject: input.subject, body: input.body, cc: [] };
  const cc = [...new Set([...settings.globalCc, ...input.cc ?? [], ...resolved.cc])];
  const subject = withRecipientSubjectPrefix({
    to: input.to,
    subject: resolved.subject,
    body: resolved.body,
    audience: "customer",
  });
  const transport = createTransport();
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "";
  const info = await transport.sendMail({
    from: `"パッケージラボ" <${from}>`,
    to: route.to,
    text: resolved.body,
    subject,
    cc,
    attachments: input.attachments,
  });
  return {
    messageId: info.messageId,
    recipient: route.to,
    recipientOverridden: route.overridden,
  };
}
