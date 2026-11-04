import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { deactivateFilmMaker, updateFilmMaker } from "@/lib/film-maker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function forbidden(): NextResponse {
  return NextResponse.json({ error: "film_maker_admin_required" }, { status: 403 });
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return forbidden();
  const { id } = await context.params;
  const makerId = Number(id);
  if (!Number.isInteger(makerId) || makerId <= 0) {
    return NextResponse.json({ error: "invalid_film_maker_id" }, { status: 400 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.isActive === false) {
      const maker = await deactivateFilmMaker(makerId, user.email);
      if (!maker) return NextResponse.json({ error: "film_maker_not_found" }, { status: 404 });
      return NextResponse.json({ maker });
    }
    const maker = await updateFilmMaker(makerId, {
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
    if (!maker) return NextResponse.json({ error: "film_maker_not_found" }, { status: 404 });
    return NextResponse.json({ maker });
  } catch (error) {
    const message = error instanceof Error ? error.message : "film_maker_update_failed";
    const status = message.startsWith("invalid_film_maker_") || ["internal_film_maker_rejected", "duplicate_film_maker_code"].includes(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return forbidden();
  const { id } = await context.params;
  const makerId = Number(id);
  if (!Number.isInteger(makerId) || makerId <= 0) {
    return NextResponse.json({ error: "invalid_film_maker_id" }, { status: 400 });
  }
  try {
    const maker = await deactivateFilmMaker(makerId, user.email);
    if (!maker) return NextResponse.json({ error: "film_maker_not_found" }, { status: 404 });
    return NextResponse.json({ maker });
  } catch {
    return NextResponse.json({ error: "film_maker_deactivate_failed" }, { status: 500 });
  }
}
