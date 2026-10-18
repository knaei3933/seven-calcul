const MAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface MailRoute {
  to: string;
  overridden: boolean;
}

/**
 * Test-only safety valve. When configured, every mailer uses this address
 * instead of the business address so integration testing cannot reach an
 * external customer or supplier.
 */
export function resolveMailRoute(address: string): MailRoute {
  const requested = address.trim();
  const override = process.env.MAIL_RECIPIENT_OVERRIDE?.trim();
  if (!override) return { to: requested, overridden: false };
  if (!MAIL_ADDRESS_PATTERN.test(override)) {
    throw new Error("invalid_mail_recipient_override");
  }
  return { to: override, overridden: true };
}
