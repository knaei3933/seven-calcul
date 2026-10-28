import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { getMailSettings } from "@/lib/mail-settings";
import { sendMail } from "@/lib/mailer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const settings = await getMailSettings();
  if (!settings.testMode.enabled || !settings.testMode.recipient) {
    return NextResponse.json({ error: "test_mode_disabled" }, { status: 400 });
  }
  const result = await sendMail({
    to: settings.testMode.recipient,
    subject: "メール設定テスト / 메일 설정 테스트",
    text: [
      "메일 설정 테스트입니다.",
      `送信日時: ${new Date().toLocaleString("ja-JP")}`,
      `設定CC: ${settings.globalCc.join(", ") || "-"}`,
    ].join("\n"),
    audience: "kanei",
    cc: settings.globalCc,
    templateKey: "mail_settings_test",
    templateVars: { sentAt: new Date().toLocaleString("ja-JP"), configuredCc: settings.globalCc.join(", ") || "-" },
  });
  if (result.error) return NextResponse.json({ error: result.error, mail: result }, { status: 502 });
  return NextResponse.json({ mail: result });
}
