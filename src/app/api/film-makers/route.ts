import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { createFilmMaker, listFilmMakers } from "@/lib/film-maker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) {
    return NextResponse.json({ error: "film_maker_admin_required" }, { status: 403 });
  }
  try {
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get("includeInactive") !== "false";
    return NextResponse.json({ makers: await listFilmMakers(includeInactive) });
  } catch {
    return NextResponse.json({ error: "film_maker_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) {
    return NextResponse.json({ error: "film_maker_admin_required" }, { status: 403 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const maker = await createFilmMaker({
      makerCode: String(body.makerCode ?? ""),
      companyName: String(body.companyName ?? ""),
      contactName: String(body.contactName ?? ""),
      email: String(body.email ?? ""),
      language: body.language === "ko" ? "ko" : body.language === "ja" ? "ja" : "" as never,
      printMethod: body.printMethod === "gravure" ? "gravure" : body.printMethod === "digital" ? "digital" : "" as never,
      procurementRoute: body.procurementRoute === "K" ? "K" : body.procurementRoute === "Y" ? "Y" : "" as never,
      isActive: body.isActive !== false,
      note: String(body.note ?? ""),
    }, user.email);
    return NextResponse.json({ maker }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "film_maker_create_failed";
    const status = message.startsWith("invalid_film_maker_") || ["internal_film_maker_rejected", "duplicate_film_maker_code"].includes(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
