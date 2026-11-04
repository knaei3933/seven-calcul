import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { listActiveFilmMakerSelections } from "@/lib/film-maker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  // この projection は連絡先を含めない。Seven/customer/匿名は業務対象外。
  if (!isKaneiTradeUser(user.email)) {
    return NextResponse.json({ error: "film_maker_selection_forbidden" }, { status: 403 });
  }
  const url = new URL(request.url);
  try {
    const selections = await listActiveFilmMakerSelections(
      url.searchParams.get("procurementRoute") ?? "",
      url.searchParams.get("printMethod") ?? "",
    );
    return NextResponse.json({ selections });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("invalid_film_maker_")
      ? error.message
      : "film_maker_selection_failed";
    return NextResponse.json({ error: message }, { status: message.startsWith("invalid_film_maker_") ? 400 : 500 });
  }
}
