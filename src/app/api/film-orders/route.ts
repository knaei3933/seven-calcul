import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";
import { serializeFilmOrderForActor } from "@/lib/film-order-disclosure";
import { listFilmOrderSummaries, syncFilmOrdersFromQuotations } from "@/lib/film-orders";
import { driveConfigured } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  // Role-admin is a read-disclosure supervisor. Mutation ownership is still checked
  // separately against the order's durable buyer domain.
  if (user.role !== "admin" && !canViewFilmOrders(user.email)) {
    return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  }
  try {
    const created = await syncFilmOrdersFromQuotations(user.email);
    const orders = await listFilmOrderSummaries(user.email, user.role);
    return NextResponse.json({
      created,
      orders: orders.map((order) => serializeFilmOrderForActor(order, user.email, user.role)),
      driveConfigured: driveConfigured(),
    });
  } catch {
    return NextResponse.json({ error: "film_order_list_failed" }, { status: 500 });
  }
}
