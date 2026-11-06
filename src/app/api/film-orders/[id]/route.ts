import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders, canPerformFilmOrderAction, canViewFilmOrderRow } from "@/lib/film-order-access";
import { serializeFilmOrderActionForActor, serializeFilmOrderForActor } from "@/lib/film-order-disclosure";
import { getFilmOrder } from "@/lib/film-orders";
import { runFilmOrderAction, type FilmOrderAction } from "@/lib/film-orders";
import { resolveFilmOrderExternalOrigin } from "@/lib/film-order-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILM_ORDER_ORIGIN_REQUIRED_ACTIONS = new Set([
  "register-receiving",
  "send-proof-notice",
  "rotate-supplier-proof-token",
  "register-proof",
  "send-customer-proof-review",
  "record-customer-proof-approval",
  "approve",
  "request-re-proof",
  "send-po",
  "resend-supplier-links",
  "resend-receiving-notice",
  "request-production-plan",
  "request-ship-to-registration",
  "ship-to-registered",
  "request-customer-design-upload",
  "request-customer-design-correction",
  "customer-design-received",
  "production-plan-request",
  "update-eta",
  "report-shipment",
  "report-delivery",
  "confirm-film-receipt",
  "customer-proof-decision",
  "preview-supplier-po",
]);

function originRequiresDeploymentAllowlist(action: string): boolean {
  return FILM_ORDER_ORIGIN_REQUIRED_ACTIONS.has(action);
}

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const orderId = Number(id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "invalid_film_order_id" }, { status: 400 });
  }
  const isAdminRead = user.role === "admin";
  if (!isAdminRead && !canViewFilmOrders(user.email)) {
    return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  }
  try {
    const order = await getFilmOrder(orderId);
    if (!order || !(isAdminRead || canViewFilmOrderRow(order.buyer_domain, user.email))) {
      return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
    }
    return NextResponse.json({ order: serializeFilmOrderForActor(order, user.email, user.role) });
  } catch {
    return NextResponse.json({ error: "film_order_get_failed" }, { status: 500 });
  }
}



function statusForError(message: string): number {
  if (message === "film_order_not_found") return 404;
  if (message === "invalid_status_transition") return 409;
  if (message === "ship_to_confirmation_required") return 409;
  if (
    message === "film_order_state_conflict"
    || message === "film_order_resend_conflict"
    || message === "legacy_supplier_history_conflict"
  ) return 409;
  if (message === "maker_data_packet_required" || message === "supplier_destination_missing") return 400;
  if (
    message.startsWith("invalid_")
    || message === "re_proof_comment_required"
    || message === "unknown_action"
    || message === "upload_guide_acknowledgement_required"
    || message === "sample_bulk_not_required"
    || message === "sample_bulk_quantity_required"
    || message === "sample_bulk_quantity_mismatch"
    || message === "sample_bulk_adjustment_reason_required"
    || message === "customer_design_confirmation_required"
    || message === "customer_design_file_required"
    || message === "customer_design_correction_reason_required"
    || message === "customer_design_not_required_reason_required"
    || message === "customer_proof_approval_required"
    || message === "customer_proof_evidence_required"
    || message === "customer_proof_correction_reason_required"
    || message === "korean_supplier_message_required"
    || message === "japanese_supplier_message_required"
    || message === "japanese_customer_message_required"
    || message === "customer_proof_file_required"
    || message === "customer_proof_pdf_required"
    || message === "delivery_report_required"
    || message === "shipment_report_required"
    || message === "invalid_delivery_transition"
    || message === "ship_to_not_registered"
    || message === "invalid_ship_to"
    || message === "invalid_production_plan_date"
    || message === "invalid_production_plan_range"
    || message === "delivery_destination_not_found"
    || message === "customer_code_required"
    || message === "invalid_film_maker_id"
    || message === "film_maker_not_found"
    || message === "film_maker_route_mismatch"
    || message === "film_maker_print_method_mismatch"
    || message === "film_maker_language_mismatch"
    || message === "legacy_exempt_reason_required"
    || message === "film_order_external_origin_not_allowed"
    || message === "sample_bulk_quantity_mismatch"
  ) return 400;
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
    const body = await request.json() as { action?: unknown; mailMode?: unknown; origin?: unknown };
    const action = typeof body.action === "string" ? body.action as FilmOrderAction : null;
    if (!action) {
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
    const order = await getFilmOrder(orderId);
    if (!order) return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
    if (!canPerformFilmOrderAction(action, user.email, order.buyer_domain)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    const originRequiresAllowlist = originRequiresDeploymentAllowlist(action);
    let origin = "";
    if (originRequiresAllowlist) {
      origin = new URL(request.url).origin;
      const forwardedHost = request.headers.get("x-forwarded-host");
      const forwardedProto = request.headers.get("x-forwarded-proto");
      if (forwardedHost) origin = `${forwardedProto ?? "https"}://${forwardedHost}`;
      origin = resolveFilmOrderExternalOrigin(body.origin ?? origin);
    } else if (typeof body.origin === "string") {
      origin = body.origin.trim();
    }
    const result = await runFilmOrderAction(
      orderId,
      action,
      { ...(body as Parameters<typeof runFilmOrderAction>[2]), origin, mailMode: body.mailMode === "confirm" ? "confirm" : "preview" },
      user.email,
    );
    return NextResponse.json(serializeFilmOrderActionForActor(result, user.email, user.role));
  } catch (error) {
    const message = error instanceof Error ? error.message : "film_order_action_failed";
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
