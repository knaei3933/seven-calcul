import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders, canViewFilmOrderRow } from "@/lib/film-order-access";
import { listDeliveryDestinations } from "@/lib/customer-store";
import { getFilmOrder } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) {
    return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  }
  const { id } = await context.params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "invalid_film_order_id" }, { status: 400 });
  }
  try {
    const order = await getFilmOrder(orderId);
    if (!order || !canViewFilmOrderRow(order.buyer_domain, user.email)) {
      return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
    }
    if (!order.customer_code) {
      return NextResponse.json({ destinations: [] });
    }
    const ownerDomain = order.buyer_domain.includes("727") ? "seven" : "kanei";
    const destinations = await listDeliveryDestinations(ownerDomain, order.customer_code);
    return NextResponse.json({ destinations });
  } catch {
    return NextResponse.json({ error: "delivery_destinations_load_failed" }, { status: 500 });
  }
}
