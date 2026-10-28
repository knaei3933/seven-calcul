import { NextResponse } from "next/server";
import {
  assertDeliveryDocumentPolicy,
  DELIVERY_DOCUMENT_MAX_BYTES,
  deliveryDocumentFileName,
  getFilmOrderForEta,
  updateFilmDeliveryFromToken,
} from "@/lib/film-orders";
import {
  browserOriginOf,
  createResumableSession,
  deliveryDocumentFolderId,
  driveConfigured,
  findDriveFiles,
  getConfirmedDriveUpload,
} from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

function errorStatus(message: string): number {
  if (message === "invalid_delivery_transition") return 409;
  if (message === "file_too_large") return 413;
  if (message === "uploaded_file_not_found") return 404;
  if (message === "ambiguous_uploaded_file") return 409;
  if (message === "invalid_eta_token") return 403;
  if (message === "delivery_document_folder_not_configured") return 503;
  return 400;
}

function dateParam(value: unknown): string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : "";
}

function uploadIdParam(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{12,64}$/u.test(value) ? value : "";
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    driveConfigured: driveConfigured(),
    folderConfigured: Boolean(process.env.FILM_DELIVERY_DOCUMENT_FOLDER_ID?.trim()),
    allowedExtensions: [".pdf"],
    maxBytes: DELIVERY_DOCUMENT_MAX_BYTES,
  });
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const body = await request.json() as {
      action?: unknown;
      originalFileName?: unknown;
      fileName?: unknown;
      uploadId?: unknown;
      shipmentDate?: unknown;
      sizeBytes?: unknown;
      contentType?: unknown;
      carrier?: unknown;
      trackingNumber?: unknown;
      note?: unknown;
      fileId?: unknown;
      recordShipment?: unknown;
    };
    const action = body.action === "session" || body.action === "complete" ? body.action : "";
    if (!action) return NextResponse.json({ error: "unknown_action" }, { status: 400 });

    const order = await getFilmOrderForEta(token);
    if (!order) return NextResponse.json({ error: "invalid_eta_token" }, { status: 403 });
    const originalFileName = typeof body.originalFileName === "string" ? body.originalFileName.trim() : "";
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : originalFileName;
    const shipmentDate = dateParam(body.shipmentDate);
    const uploadId = uploadIdParam(body.uploadId);
    if (action === "session") {
      assertDeliveryDocumentPolicy(order, originalFileName, typeof body.sizeBytes === "number" ? body.sizeBytes : undefined);
    } else {
      assertDeliveryDocumentPolicy(order, fileName, undefined);
    }
    if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
    const folderId = deliveryDocumentFolderId();
    const safeFileName = action === "session"
      ? deliveryDocumentFileName(order, shipmentDate, originalFileName, uploadId)
      : fileName;

    if (action === "session") {
      const sessionUri = await createResumableSession({
        fileName: safeFileName,
        folderId,
        contentType: typeof body.contentType === "string" ? body.contentType : "application/pdf",
        sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : undefined,
        origin: browserOriginOf(request),
      });
      return NextResponse.json({ sessionUri, fileName: safeFileName });
    }

    if (!shipmentDate || !uploadId) return NextResponse.json({ error: "invalid_upload_request" }, { status: 400 });
    const fileId = typeof body.fileId === "string" ? body.fileId.trim() : "";
    let candidates = fileId
      ? [await getConfirmedDriveUpload({ fileId, fileName: safeFileName, folderId })].filter((candidate) => candidate != null)
      : await findDriveFiles({ fileName: safeFileName, folderId });
    for (let attempt = 1; !fileId && candidates.length === 0 && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      candidates = await findDriveFiles({ fileName: safeFileName, folderId });
    }
    if (!candidates.length) return NextResponse.json({ error: "uploaded_file_not_found" }, { status: 404 });
    if (candidates.length > 1) return NextResponse.json({ error: "ambiguous_uploaded_file" }, { status: 409 });
    const candidate = candidates[0]!;
    if (!candidate.parentFolderIds.includes(folderId)) return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    if (!candidate.name.toLowerCase().endsWith(".pdf")) return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    if (candidate.mimeType && candidate.mimeType !== "application/pdf") return NextResponse.json({ error: "invalid_delivery_document_type" }, { status: 400 });
    if (!candidate.sizeBytes || candidate.sizeBytes <= 0 || candidate.sizeBytes > DELIVERY_DOCUMENT_MAX_BYTES) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }

    const documentUrl = `https://drive.google.com/file/d/${candidate.id}/view`;
    if (body.recordShipment === false) {
      return NextResponse.json({
        document: {
          fileName: candidate.name,
          url: documentUrl,
          fileId: candidate.id,
          sizeBytes: candidate.sizeBytes,
          mimeType: candidate.mimeType,
          checksum: candidate.checksum,
        },
      });
    }
    const updated = await updateFilmDeliveryFromToken(token, {
      kind: "shipment",
      date: shipmentDate,
      carrier: typeof body.carrier === "string" ? body.carrier : "",
      trackingNumber: typeof body.trackingNumber === "string" ? body.trackingNumber : "",
      note: typeof body.note === "string" ? body.note : "",
      documentName: candidate.name,
      documentUrl,
    });
    return NextResponse.json({
      order: { delivery: updated.delivery },
      document: {
        fileName: candidate.name,
        url: documentUrl,
        fileId: candidate.id,
        sizeBytes: candidate.sizeBytes,
        mimeType: candidate.mimeType,
        checksum: candidate.checksum,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delivery_upload_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
