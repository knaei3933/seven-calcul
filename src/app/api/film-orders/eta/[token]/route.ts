import { NextResponse } from "next/server";
import { getFilmOrderForEta, updateEtaFromToken } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const order = await getFilmOrderForEta(token);
    if (!order) return NextResponse.json({ error: "eta_order_not_found" }, { status: 404 });
    return NextResponse.json({
      order: {
        order_number: order.order_number,
        product_name: order.product_name,
        printing_method: order.printing_method,
        film_composition: order.film_composition,
        order_length_m: order.order_length_m,
        web_width_mm: order.web_width_mm,
        eta_date: order.eta_date,
        eta_note: order.eta_note,
      },
    });
  } catch {
    return NextResponse.json({ error: "invalid_eta_token" }, { status: 403 });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const body = await request.json() as { etaDate?: unknown; note?: unknown };
    if (typeof body.etaDate !== "string" || typeof body.note !== "string") {
      return NextResponse.json({ error: "invalid_eta_input" }, { status: 400 });
    }
    const order = await updateEtaFromToken(token, body.etaDate, body.note.trim().slice(0, 1000));
    if (!order) return NextResponse.json({ error: "eta_order_not_found" }, { status: 404 });
    return NextResponse.json({ order: { order_number: order.order_number, eta_date: order.eta_date } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "eta_update_failed";
    const status = message === "invalid_eta_date" || message === "invalid_eta_input" ? 400 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
