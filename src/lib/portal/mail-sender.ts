import { resolveMailRoute } from "@/lib/mail-routing";
import { withRecipientSubjectPrefix } from "@/lib/mail-subject";
import { getMailSettings } from "@/lib/mail-settings";

export interface PortalMailMessage {
  to: string;
  subject: string;
  body: string;
  templateKey?: string;
  templateVars?: Record<string, unknown>;
}

export interface PortalMailSendResult {
  messageId?: string;
  recipient?: string;
  recipientOverridden?: boolean;
  dryRun?: boolean;
}

export type PortalMailSender = (
  message: PortalMailMessage,
) => Promise<PortalMailSendResult>;

export function createPortalMailSender(): PortalMailSender {
  if (process.env.MAIL_DRY_RUN === "true") {
    return async (message) => {
      const route = resolveMailRoute(message.to);
      // Never log the message body: portal confirmation bodies contain raw codes.
      console.info("[portal-mail:dry-run]", JSON.stringify({
        recipientOverridden: route.overridden,
        subject: message.subject,
      }));
      return {
        recipient: route.to,
        recipientOverridden: route.overridden,
        dryRun: true,
      };
    };
  }

  return async (message) => {
    const { sendMail } = await import("@/lib/mail-sender");
    const route = resolveMailRoute(message.to);
    const result = await sendMail({
      to: message.to,
      subject: withRecipientSubjectPrefix({
        to: message.to,
        subject: message.subject,
        body: message.body,
        audience: "customer",
      }),
      body: message.body,
      cc: (await getMailSettings()).globalCc,
      templateKey: message.templateKey,
      templateVars: message.templateVars,
    });
    return {
      messageId: result.messageId,
      recipient: route.to,
      recipientOverridden: route.overridden,
    };
  };
}
