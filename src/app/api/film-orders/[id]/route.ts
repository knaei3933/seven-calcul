import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders, canPerformFilmOrderAction } from "@/lib/film-order-access";
import { getFilmOrder } from "@/lib/film-orders";
import { runFilmOrderAction, type FilmOrderAction } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };



function statusForError(message: string): number {
  if (message === "film_order_not_found") return 404;
  if (message === "invalid_status_transition") return 409;
  if (message.startsWith("invalid_") || message === "re_proof_comment_required" || message === "unknown_action") return 400;
  return 500;
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "invalid_film_order_id" }, { status: 400 });
  }
  try {
    const body = await request.json() as { action?: unknown };
    const action = typeof body.action === "string" ? body.action as FilmOrderAction : null;
    if (!action) {
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
    const order = await getFilmOrder(orderId);
    if (!order) return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
    if (!canPerformFilmOrderAction(action, user.email, order.buyer_domain)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    let origin = new URL(request.url).origin;
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    if (forwardedHost) origin = `${forwardedProto ?? "https"}://${forwardedHost}`;
    const result = await runFilmOrderAction(
      orderId,
      action,
      { ...(body as Parameters<typeof runFilmOrderAction>[2]), origin },
      user.email,
    );
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "film_order_action_failed";
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
