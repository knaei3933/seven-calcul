import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";
import { getMailSettings } from "@/lib/mail-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const settings = await getMailSettings();
  return NextResponse.json({
    enabled: settings.testMode.enabled,
    recipient: settings.testMode.recipient,
  });
}
