import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { getFilmOrder, saveDeliveryNoteDraft } from "@/lib/film-orders";
import { canViewFilmOrderRow } from "@/lib/film-order-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const order = await getFilmOrder(id);
  if (!order) return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
  if (!canViewFilmOrderRow(order.buyer_domain, user.email, user.role)) {
    return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  }
  return NextResponse.json({ draft: order.deliveryNoteDraft, updatedAt: order.delivery_note_updated_at, updatedBy: order.delivery_note_updated_by });
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const order = await saveDeliveryNoteDraft(id, body, user.email);
    return NextResponse.json({ draft: order.deliveryNoteDraft, updatedAt: order.delivery_note_updated_at, updatedBy: order.delivery_note_updated_by });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delivery_note_save_failed";
    const status = message === "film_order_actor_forbidden" ? 403
      : message === "invalid_status_transition" ? 409
        : message === "invalid_delivery_note" ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
