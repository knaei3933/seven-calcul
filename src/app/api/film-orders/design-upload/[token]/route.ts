import { NextResponse } from "next/server";
import {
  assertCustomerDesignUploadPolicy,
  customerDesignMaxBytes,
  externalClientIpHash,
  getFilmOrderForCustomerDesign,
  nextCustomerDesignFileName,
  registerCustomerDesignFromUploadToken,
} from "@/lib/film-orders";
import {
  createResumableSession,
  customerDesignFolderId,
  driveConfigured,
  findDriveFiles,
} from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

function designSummary(order: Awaited<ReturnType<typeof getFilmOrderForCustomerDesign>>) {
  return {
    order: {
      orderNumber: order.order_number,
      productName: order.product_name,
      statusLabel: "design_upload",
      designStatusLabel: order.customerDesign.status,
      requestedAt: order.customerDesign.requestedAt,
      note: order.customerDesign.correctionReason || null,
    },
    policy: {
      allowedExtensions: [".ai", ".pdf", ".psd", ".eps", ".indd", ".zip", ".png", ".jpg", ".jpeg"],
      maxBytes: customerDesignMaxBytes(),
    },
    files: order.files
      .filter((file) => file.category === "customer_design")
      .map((file) => ({
        id: file.id,
        fileName: file.file_name,
        version: file.version,
        uploadedAt: file.created_at,
        sizeBytes: file.file_size_bytes,
        note: file.note || null,
      })),
    canUpload: ["requested", "correction_requested"].includes(order.customerDesign.status),
  };
}

function errorStatus(message: string): number {
  if (message === "invalid_status_transition") return 409;
  if (message === "file_too_large") return 413;
  if (message === "uploaded_file_not_found") return 404;
  if (message === "ambiguous_uploaded_file") return 409;
  if (message === "invalid_customer_design_token") return 403;
  if (
    message === "invalid_file_name"
    || message === "unsupported_file_type"
    || message === "invalid_upload_request"
    || message === "uploaded_file_mismatch"
  ) return 400;
  return 502;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const order = await getFilmOrderForCustomerDesign(token);
    return NextResponse.json(designSummary(order));
  } catch (error) {
    const message = error instanceof Error ? error.message : "customer_design_load_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const body = await request.json() as {
      action?: unknown;
      fileName?: unknown;
      originalFileName?: unknown;
      sizeBytes?: unknown;
      contentType?: unknown;
      uploader?: unknown;
      note?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";
    const order = await getFilmOrderForCustomerDesign(token);
    const originalFileName = typeof body.originalFileName === "string" && body.originalFileName.trim()
      ? body.originalFileName.trim()
      : typeof body.fileName === "string" ? body.fileName.trim() : "";
    if (action !== "session" && action !== "complete") {
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
    const declaredSize = action === "session"
      ? typeof body.sizeBytes === "number" ? body.sizeBytes : undefined
      : undefined;
    assertCustomerDesignUploadPolicy(order, originalFileName, declaredSize);
    if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
    const folderId = customerDesignFolderId();
    const fileName = nextCustomerDesignFileName(order, originalFileName);

    if (action === "session") {
      const sessionUri = await createResumableSession({
        fileName,
        folderId,
        contentType: typeof body.contentType === "string" ? body.contentType : undefined,
        sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : undefined,
      });
      return NextResponse.json({ sessionUri, fileName });
    }

    let candidates = await findDriveFiles({ fileName, folderId });
    for (let attempt = 1; candidates.length === 0 && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      candidates = await findDriveFiles({ fileName, folderId });
    }
    if (candidates.length === 0) return NextResponse.json({ error: "uploaded_file_not_found" }, { status: 404 });
    if (candidates.length > 1) return NextResponse.json({ error: "ambiguous_uploaded_file" }, { status: 409 });
    const candidate = candidates[0]!;
    if (!candidate.parentFolderIds.includes(folderId)) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (!candidate.name.toLowerCase().endsWith(extension)) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    const url = `https://drive.google.com/file/d/${candidate.id}/view`;
    const updated = await registerCustomerDesignFromUploadToken({
      token,
      fileName,
      fileUrl: url,
      uploader: typeof body.uploader === "string" ? body.uploader : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      metadata: {
        fileSizeBytes: candidate.sizeBytes,
        contentType: candidate.mimeType,
        checksum: candidate.checksum,
        checksumAlgorithm: candidate.checksum ? "md5" : null,
        driveFileId: candidate.id,
        uploadedVia: "customer_design",
        clientIpHash: externalClientIpHash(request),
        userAgent: request.headers.get("user-agent"),
      },
    });
    return NextResponse.json(designSummary(updated));
  } catch (error) {
    const message = error instanceof Error ? error.message : "customer_design_upload_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
