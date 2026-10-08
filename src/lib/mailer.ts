export interface MailInput {
  to: string;
  subject: string;
  text: string;
}

export interface MailSendResult {
  to: string;
  subject: string;
  dryRun: boolean;
  messageId?: string;
  error?: string;
}

export function mailDryRun(): boolean {
  return process.env.MAIL_DRY_RUN === "true";
}

/**
 * XServer SMTP でメールを送信する。
 * MAIL_DRY_RUN=true の場合は実際に送信せず、結果オブジェクトだけ返す（テスト用）。
 */
export async function sendMail(input: MailInput): Promise<MailSendResult> {
  const base = { to: input.to, subject: input.subject };
  if (mailDryRun()) {
    console.log("[mail:dry-run]", JSON.stringify(base));
    return { ...base, dryRun: true };
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
    });
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM ?? user,
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    return { ...base, dryRun: false, messageId: info.messageId };
  } catch (error) {
    return { ...base, dryRun: false, error: error instanceof Error ? error.message : "smtp_error" };
  }
}
