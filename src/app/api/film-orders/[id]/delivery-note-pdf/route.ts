import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { getFilmOrder, saveDeliveryNoteDraft } from "@/lib/film-orders";
import { canViewFilmOrderRow } from "@/lib/film-order-access";
import { generateFilmDeliveryNotePdf } from "@/lib/film-delivery-note-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const order = await getFilmOrder(id);
  if (!order) return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
  if (!canViewFilmOrderRow(order.buyer_domain, user.email, user.role)) {
    return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  }
  const body = await request.json() as Record<string, unknown>;
  const saved = await saveDeliveryNoteDraft(id, body, user.email);
  const pdf = await generateFilmDeliveryNotePdf(saved.deliveryNoteDraft, saved.order_number);
  const fileName = `${saved.order_number}_納品書.pdf`;
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(pdf.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
