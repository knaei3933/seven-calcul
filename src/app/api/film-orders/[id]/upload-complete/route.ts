import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  canManageFilmOrderProof,
  canRegisterFilmOrderReceiving,
  canViewFilmOrders,
} from "@/lib/film-order-access";
import { driveConfigured, findFileUrl, proofFolderId, receivingFolderId } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  try {
    const body = await request.json() as { category?: unknown; fileName?: unknown };
    const category = body.category === "receiving" || body.category === "proof" ? body.category : null;
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    if (!category || !fileName) return NextResponse.json({ error: "invalid_upload_request" }, { status: 400 });
    if (category === "receiving" && !canRegisterFilmOrderReceiving(user.email)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    if (category === "proof" && !canManageFilmOrderProof(user.email)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
    // アップロード完了は少し遅れて反映されることがあるため短く再試行する。
    let url: string | null = null;
    for (let attempt = 0; attempt < 3 && !url; attempt += 1) {
      url = await findFileUrl({
        fileName,
        folderId: category === "receiving" ? receivingFolderId() : proofFolderId(),
      });
      if (!url) await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (!url) return NextResponse.json({ error: "uploaded_file_not_found" }, { status: 404 });
    return NextResponse.json({ url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upload_complete_failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
