import { NextResponse } from "next/server";
import { getFilmOrderForEta, updateEtaFromToken, updateFilmDeliveryFromToken } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const order = await getFilmOrderForEta(token, request);
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
        delivery: order.delivery,
      },
    });
  } catch {
    return NextResponse.json({ error: "invalid_eta_token" }, { status: 403 });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const origin = new URL(request.url).origin;
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const { resolveFilmOrderExternalOrigin } = await import("@/lib/film-order-origin");
    const resolvedOrigin = resolveFilmOrderExternalOrigin(
      forwardedHost ? `${forwardedProto?.split(",")[0]?.trim() ?? "https"}://${forwardedHost.split(",")[0]?.trim()}` : origin,
    );
    const body = await request.json() as {
      etaDate?: unknown;
      note?: unknown;
      kind?: unknown;
      date?: unknown;
      carrier?: unknown;
      trackingNumber?: unknown;
      documents?: unknown;
    };
    if (body.kind === "delivery") {
      if (typeof body.date !== "string" || typeof body.note !== "string") {
        return NextResponse.json({ error: "invalid_eta_input" }, { status: 400 });
      }
      const delivered = await updateFilmDeliveryFromToken(token, {
        kind: "delivery",
        date: body.date,
        note: body.note.trim().slice(0, 1000),
      }, resolvedOrigin, request);
      return NextResponse.json({
        order: {
          order_number: delivered.order_number,
          eta_date: delivered.eta_date,
          delivery: delivered.delivery,
          ship_to_status: delivered.shipTo.status,
          ship_to_company_name: delivered.shipTo.companyName,
          ship_to_address: delivered.shipTo.address,
        },
      });
    }
    if (body.kind === "shipment") {
      if (typeof body.date !== "string" || typeof body.note !== "string") {
        return NextResponse.json({ error: "invalid_eta_input" }, { status: 400 });
      }
      const shipped = await updateFilmDeliveryFromToken(token, {
        kind: "shipment",
        date: body.date,
        carrier: typeof body.carrier === "string" ? body.carrier : undefined,
        trackingNumber: typeof body.trackingNumber === "string" ? body.trackingNumber : undefined,
        note: body.note,
        documents: body.documents,
      }, resolvedOrigin, request);
      return NextResponse.json({
        order: {
          order_number: shipped.order_number,
          eta_date: shipped.eta_date,
          delivery: shipped.delivery,
          ship_to_status: shipped.shipTo.status,
          ship_to_company_name: shipped.shipTo.companyName,
          ship_to_address: shipped.shipTo.address,
        },
      });
    }
    let order;
    if (typeof body.etaDate !== "string" || typeof body.note !== "string") {
      return NextResponse.json({ error: "invalid_eta_input" }, { status: 400 });
    }
    order = await updateEtaFromToken(token, body.etaDate, body.note.trim().slice(0, 1000), resolvedOrigin, request);
    if (!order) return NextResponse.json({ error: "eta_order_not_found" }, { status: 404 });
      return NextResponse.json({
        order: {
          order_number: order.order_number,
          eta_date: order.eta_date,
          delivery: order.delivery,
        },
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : "eta_update_failed";
    const status = message === "invalid_eta_date" || message === "invalid_eta_input" ? 400
      : message === "ship_to_confirmation_required" || message === "shipment_report_required" || message === "invalid_delivery_transition" || message === "delivery_document_required" || message === "too_many_delivery_documents" || message === "film_order_state_conflict" ? 409
      : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
