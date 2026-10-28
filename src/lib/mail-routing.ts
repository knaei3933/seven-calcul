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
export function resolveMailRoute(
  address: string,
  settingsOverride?: { enabled?: boolean; recipient?: string },
): MailRoute {
  const requested = address.trim();
  const configuredRecipient = settingsOverride?.recipient?.trim();
  const configuredEnabled = settingsOverride?.enabled === true;
  const environmentRecipient = process.env.MAIL_RECIPIENT_OVERRIDE?.trim();
  const useConfigured = configuredEnabled && Boolean(configuredRecipient);
  const override = useConfigured ? configuredRecipient : environmentRecipient;
  const enabled = useConfigured || (!configuredEnabled && Boolean(environmentRecipient));
  if (!override || !enabled) return { to: requested, overridden: false };
  if (!MAIL_ADDRESS_PATTERN.test(override)) {
    throw new Error("invalid_mail_recipient_override");
  }
  return { to: override, overridden: true };
}
