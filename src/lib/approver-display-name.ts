const APPROVER_DISPLAY_NAMES: Record<string, string> = {
  "kim@kanei-trade.co.jp": "石井",
};

export function approverDisplayName(user: { email: string; name: string }): string {
  const mapped = APPROVER_DISPLAY_NAMES[user.email.trim().toLowerCase()] ?? user.name;
  const shortened = mapped.replace(/[（(][^（）)]*[）)]/g, "").trim();
  return shortened || mapped;
}
