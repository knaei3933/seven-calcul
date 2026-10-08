import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  canManageFilmOrderProof,
  canRegisterFilmOrderReceiving,
  canViewFilmOrders,
} from "@/lib/film-order-access";
import { getFilmOrder } from "@/lib/film-orders";
import {
  createResumableSession,
  driveConfigured,
  proofFolderId,
  receivingFolderId,
} from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

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
    const body = await request.json() as { category?: unknown; fileName?: unknown; sizeBytes?: unknown; contentType?: unknown };
    const category = body.category === "receiving" || body.category === "proof" ? body.category : null;
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    if (!category || !fileName || fileName.length > 200 || fileName.includes("/") || fileName.includes("\\")) {
      return NextResponse.json({ error: "invalid_upload_request" }, { status: 400 });
    }
    const size = Number(body.sizeBytes);
    if (Number.isFinite(size) && size > 2 * 1024 * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    if (category === "receiving" && !canRegisterFilmOrderReceiving(user.email)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    if (category === "proof" && !canManageFilmOrderProof(user.email)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    const order = await getFilmOrder(orderId);
    if (!order) return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
    if (!driveConfigured()) {
      return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
    }
    const sessionUri = await createResumableSession({
      fileName,
      folderId: category === "receiving" ? receivingFolderId() : proofFolderId(),
      contentType: typeof body.contentType === "string" ? body.contentType : undefined,
      sizeBytes: Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : undefined,
    });
    return NextResponse.json({ sessionUri, fileName });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upload_session_failed";
    return NextResponse.json({ error: message }, { status: message === "invalid_upload_request" ? 400 : 502 });
  }
}
