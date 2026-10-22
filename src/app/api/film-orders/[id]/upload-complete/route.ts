import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders, canPerformFilmOrderAction } from "@/lib/film-order-access";
import { getFilmOrder } from "@/lib/film-orders";
import { driveConfigured, findDriveFiles, getConfirmedDriveUpload, proofFolderId, receivingFolderId } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const orderId = Number(id);
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });
  try {
    const body = await request.json() as { category?: unknown; fileName?: unknown; fileId?: unknown };
    const category = body.category === "receiving" || body.category === "proof" ? body.category : null;
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const fileId = typeof body.fileId === "string" ? body.fileId.trim() : "";
    if (!category || !fileName) return NextResponse.json({ error: "invalid_upload_request" }, { status: 400 });
    const order = await getFilmOrder(orderId);
    if (!order) return NextResponse.json({ error: "film_order_not_found" }, { status: 404 });
    const uploadAction = category === "receiving" ? "register-receiving" : "register-proof";
    if (!canPerformFilmOrderAction(uploadAction, user.email, order.buyer_domain)) {
      return NextResponse.json({ error: "film_order_action_forbidden" }, { status: 403 });
    }
    if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
    const folderId = category === "receiving" ? receivingFolderId() : proofFolderId();
    let candidates = fileId
      ? [await getConfirmedDriveUpload({ fileId, fileName, folderId })].filter((candidate) => candidate != null)
      : await findDriveFiles({ fileName, folderId });
    for (let attempt = 1; !fileId && candidates.length === 0 && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      candidates = await findDriveFiles({ fileName, folderId });
    }
    if (candidates.length === 0) return NextResponse.json({ error: "uploaded_file_not_found" }, { status: 404 });
    if (candidates.length > 1) return NextResponse.json({ error: "ambiguous_uploaded_file" }, { status: 409 });
    const candidate = candidates[0]!;
    if (!candidate.parentFolderIds.includes(folderId)) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    return NextResponse.json({
      url: `https://drive.google.com/file/d/${candidate.id}/view`,
      fileId: candidate.id,
      sizeBytes: candidate.sizeBytes,
      contentType: candidate.mimeType,
      checksum: candidate.checksum,
      checksumAlgorithm: candidate.checksum ? "md5" : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "upload_complete_failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
