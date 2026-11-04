import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders, canViewFilmOrderRow } from "@/lib/film-order-access";
import { filmOrderDisclosureAudience } from "@/lib/film-order-disclosure";
import { getFilmOrder } from "@/lib/film-orders";
import {
  listFilmOrderMailOutboxForAudience,
  listFilmOrderMailOutboxForKanei,
} from "@/lib/film-order-mail-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "invalid_film_order_id" }, { status: 400 });
  }
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  const order = await getFilmOrder(orderId);
  if (!order || !canViewFilmOrderRow(order.buyer_domain, user.email)) {
    return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
  }
  try {
    const audience = filmOrderDisclosureAudience(user.email);
    const envelopes = audience === "kanei"
      ? await listFilmOrderMailOutboxForKanei(orderId, user.email)
      : await listFilmOrderMailOutboxForAudience(orderId, "seven", user.email, user.email);
    return NextResponse.json({ envelopes });
  } catch {
    return NextResponse.json({ error: "film_order_mail_outbox_forbidden" }, { status: 403 });
  }
}
