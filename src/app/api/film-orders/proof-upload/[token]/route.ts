import { NextResponse } from "next/server";
import {
  assertSupplierProofUploadPolicy,
  externalClientIpHash,
  getFilmOrderForProofUpload,
  registerProofFromUploadToken,
} from "@/lib/film-orders";
import {
  createResumableSession,
  driveConfigured,
  findDriveFiles,
  proofFolderId,
} from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

function orderSummary(order: Awaited<ReturnType<typeof getFilmOrderForProofUpload>>) {
  const fileIdOf = (url: string): string => url.split("/d/")[1]?.split("/")[0] ?? "";
  return {
    order_number: order?.order_number ?? "",
    product_name: order?.product_name ?? "",
    printing_method: order?.printing_method ?? "",
    film_composition: order?.film_composition ?? "",
    order_length_m: order?.order_length_m ?? "",
    web_width_mm: order?.web_width_mm ?? "",
    status: order?.status ?? "",
    files: (order?.files ?? [])
      .filter((file) => file.category === "receiving")
      .map((file) => ({ name: file.file_name, fileId: fileIdOf(file.url) })),
    proofs: (order?.files ?? [])
      .filter((file) => file.category === "proof")
      .map((file) => ({ name: file.file_name, version: file.version, fileId: fileIdOf(file.url) })),
  };
}

function publicErrorStatus(message: string): number {
  if (message === "invalid_status_transition") return 409;
  if (message === "file_too_large") return 413;
  if (message === "uploaded_file_not_found") return 404;
  if (message === "ambiguous_uploaded_file") return 409;
  if (
    message === "invalid_file_name"
    || message === "unsupported_file_type"
    || message === "invalid_upload_request"
    || message === "uploaded_file_mismatch"
  ) return 400;
  if (message === "invalid_proof_token") return 403;
  return 502;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const order = await getFilmOrderForProofUpload(token);
    if (!order) return NextResponse.json({ error: "proof_order_not_found" }, { status: 404 });
    return NextResponse.json({ order: orderSummary(order), driveConfigured: driveConfigured() });
  } catch {
    return NextResponse.json({ error: "invalid_proof_token" }, { status: 403 });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const body = await request.json() as {
      action?: unknown;
      fileName?: unknown;
      sizeBytes?: unknown;
      contentType?: unknown;
      uploader?: unknown;
      note?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const order = await getFilmOrderForProofUpload(token);
    if (!order) return NextResponse.json({ error: "proof_order_not_found" }, { status: 404 });

    if (action !== "session" && action !== "complete") {
      return NextResponse.json({ error: "unknown_action" }, { status: 400 });
    }
    const declaredSize = action === "session"
      ? typeof body.sizeBytes === "number" ? body.sizeBytes : undefined
      : undefined;
    try {
      assertSupplierProofUploadPolicy(order, fileName, declaredSize);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_upload_request";
      return NextResponse.json({ error: message }, { status: publicErrorStatus(message) });
    }
    if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });

    if (action === "session") {
      const sessionUri = await createResumableSession({
        fileName,
        folderId: proofFolderId(),
        contentType: typeof body.contentType === "string" ? body.contentType : undefined,
        sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : undefined,
      });
      return NextResponse.json({ sessionUri });
    }

    let candidates = await findDriveFiles({ fileName, folderId: proofFolderId() });
    for (let attempt = 1; candidates.length === 0 && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      candidates = await findDriveFiles({ fileName, folderId: proofFolderId() });
    }
    if (candidates.length === 0) return NextResponse.json({ error: "uploaded_file_not_found" }, { status: 404 });
    if (candidates.length > 1) return NextResponse.json({ error: "ambiguous_uploaded_file" }, { status: 409 });
    const candidate = candidates[0]!;
    if (!candidate.parentFolderIds.includes(proofFolderId())) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (!candidate.name.toLowerCase().endsWith(extension)) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    if (candidate.sizeBytes == null || candidate.sizeBytes <= 0 || candidate.sizeBytes > 15 * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    const url = `https://drive.google.com/file/d/${candidate.id}/view`;
    const updated = await registerProofFromUploadToken({
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
        uploadedVia: "supplier_proof",
        clientIpHash: externalClientIpHash(request),
        userAgent: request.headers.get("user-agent"),
      },
    });
    return NextResponse.json({ order: orderSummary(updated), url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "proof_upload_failed";
    return NextResponse.json({ error: message }, { status: publicErrorStatus(message) });
  }
}
