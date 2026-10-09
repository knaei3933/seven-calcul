import nodemailer from "nodemailer";

export interface SendMailInput {
  to: string;
  subject: string;
  body: string;
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

export async function sendMail(input: SendMailInput): Promise<{ messageId: string }> {
  if (!isSmtpConfigured()) throw new Error("smtp_not_configured");
  const transport = createTransport();
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "";
  const info = await transport.sendMail({
    from: `"パッケージラボ" <${from}>`,
    to: input.to,
    subject: input.subject,
    text: input.body,
  });
  return { messageId: info.messageId };
}
