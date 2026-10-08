import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";
import { listFilmOrders, syncFilmOrdersFromQuotations } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  try {
    const created = await syncFilmOrdersFromQuotations(user.email);
    const orders = await listFilmOrders();
    return NextResponse.json({ created, orders });
  } catch {
    return NextResponse.json({ error: "film_order_list_failed" }, { status: 500 });
  }
}
