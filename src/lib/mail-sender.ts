import nodemailer from "nodemailer";
import { resolveMailRoute } from "./mail-routing";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  body: string;
  attachments?: MailAttachment[];
}

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 465),
    secure: Number(process.env.SMTP_PORT ?? 465) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export interface SendMailResult {
  messageId: string;
  recipient: string;
  recipientOverridden: boolean;
}

export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  if (!isSmtpConfigured()) throw new Error("smtp_not_configured");
  const route = resolveMailRoute(input.to);
  const transport = createTransport();
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "";
  const info = await transport.sendMail({
    from: `"パッケージラボ" <${from}>`,
    to: route.to,
    subject: input.subject,
    text: input.body,
    attachments: input.attachments,
  });
  return {
    messageId: info.messageId,
    recipient: route.to,
    recipientOverridden: route.overridden,
  };
}
