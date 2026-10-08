import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  canApproveFilmOrderProof,
  canManageFilmOrderProof,
  canMarkFilmOrderOrdered,
  canRegisterFilmOrderReceiving,
  canViewFilmOrders,
} from "@/lib/film-order-access";
import { runFilmOrderAction, type FilmOrderAction } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const actions = new Set<FilmOrderAction>([
  "mark-ordered",
  "set-supplier",
  "register-receiving",
  "send-proof-notice",
  "register-proof",
  "approve",
  "request-re-proof",
]);

function actionAllowed(action: FilmOrderAction, email: string): boolean {
  switch (action) {
    case "mark-ordered":
      return canMarkFilmOrderOrdered(email);
    case "register-receiving":
      return canRegisterFilmOrderReceiving(email);
    case "set-supplier":
    case "send-proof-notice":
    case "register-proof":
      return canManageFilmOrderProof(email);
    case "approve":
    case "request-re-proof":
      return canApproveFilmOrderProof(email);
  }
}

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
    if (!action || !actions.has(action)) {
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
    if (!actionAllowed(action, user.email)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    const result = await runFilmOrderAction(orderId, action, body as Parameters<typeof runFilmOrderAction>[2], user.email);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "film_order_action_failed";
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
