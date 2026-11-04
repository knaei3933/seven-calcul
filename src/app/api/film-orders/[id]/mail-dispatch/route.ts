import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser, canViewFilmOrderRow, canViewFilmOrders } from "@/lib/film-order-access";
import { serializeFilmOrderForActor } from "@/lib/film-order-disclosure";
import {
  cancelFilmOrderMailForActor,
  retryFilmOrderMailDispatch,
} from "@/lib/film-order-mail-lifecycle";
import { getFilmOrder } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function statusForError(message: string): number {
  if (message === "authentication_required" || message === "film_order_mail_cancel_forbidden") return 403;
  if (message === "film_order_mail_dispatch_not_found") return 404;
  if (message === "film_order_mail_retry_not_available") return 409;
  return 500;
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "invalid_film_order_id" }, { status: 400 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });

  let body: { operation?: unknown; dispatchGroupId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const operation = body.operation;
  const dispatchGroupId = typeof body.dispatchGroupId === "string" ? body.dispatchGroupId.trim() : "";
  if ((operation !== "cancel" && operation !== "retry") || !dispatchGroupId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const order = await getFilmOrder(orderId);
  if (!order || !canViewFilmOrderRow(order.buyer_domain, user.email)) {
    return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
  }

  try {
    if (operation === "cancel") {
      const result = await cancelFilmOrderMailForActor(orderId, dispatchGroupId, user.email);
      const refreshed = await getFilmOrder(orderId);
      if (!refreshed) throw new Error("film_order_not_found");
      return NextResponse.json({
        ...result,
        order: serializeFilmOrderForActor(refreshed, user.email),
      });
    }
    if (!isKaneiTradeUser(user.email)) {
      return NextResponse.json({ error: "film_order_mail_retry_forbidden" }, { status: 403 });
    }
    const result = await retryFilmOrderMailDispatch(orderId, dispatchGroupId, user.email);
    const refreshed = await getFilmOrder(orderId);
    if (!refreshed) throw new Error("film_order_not_found");
    return NextResponse.json({
      ...result,
      order: serializeFilmOrderForActor(refreshed, user.email),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "film_order_mail_dispatch_failed";
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
