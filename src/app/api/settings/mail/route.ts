import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { getMailSettings, MAIL_TEMPLATES, saveMailSettings } from "@/lib/mail-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ settings: await getMailSettings(), templates: MAIL_TEMPLATES });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const settings = await saveMailSettings(await request.json(), user.email);
    return NextResponse.json({ settings });
  } catch (error) {
    const message = error instanceof Error ? error.message : "save_failed";
    const status = message.startsWith("invalid_") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
