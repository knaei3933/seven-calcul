import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import { listFilmPrices, upsertFilmPrice, validateFilmPriceInput } from "@/lib/film-price-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (!isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ prices: await listFilmPrices() });
  } catch {
    return NextResponse.json({ error: "film_price_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const input = validateFilmPriceInput(await request.json());
    if (!input) return NextResponse.json({ error: "invalid_film_price" }, { status: 400 });
    const row = await upsertFilmPrice(input, user.name);
    return NextResponse.json({ price: row }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "film_price_save_failed" }, { status: 500 });
  }
}
