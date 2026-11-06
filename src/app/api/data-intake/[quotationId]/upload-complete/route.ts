import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  assertCustomerDesignUploadPolicy,
  customerDesignMaxBytes,
  nextCustomerDesignFileName,
  registerCustomerDesignFromInternalIntake,
} from "@/lib/film-orders";
import {
  customerDesignFolderId,
  driveConfigured,
  getConfirmedDriveUpload,
} from "@/lib/google-drive";
import {
  customerDesignSummary,
  intakeUploadErrorStatus,
  loadAuthorizedIntakeTarget,
  type Context,
} from "../target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  try {
    const body = await request.json() as {
      originalFileName?: unknown;
      expectedFileName?: unknown;
      fileId?: unknown;
      note?: unknown;
      guideAcknowledged?: unknown;
    };
    const { quotationId } = await context.params;
    const authorized = await loadAuthorizedIntakeTarget(user, Number(quotationId));
    if (authorized.response) return authorized.response;
    const target = authorized.target!;
    const originalFileName = typeof body.originalFileName === "string" ? body.originalFileName.trim() : "";
    const expectedFileName = typeof body.expectedFileName === "string" ? body.expectedFileName.trim() : "";
    const fileId = typeof body.fileId === "string" ? body.fileId.trim() : "";
    if (!originalFileName || !fileId) {
      return NextResponse.json({ error: "invalid_upload_request" }, { status: 400 });
    }
    const hasAiFile = target.order.files.some((file) =>
      file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai")
    );
    assertCustomerDesignUploadPolicy(target.order, originalFileName, undefined, hasAiFile);
    const fileName = nextCustomerDesignFileName(target.order, originalFileName);
    if (expectedFileName && fileName !== expectedFileName) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
    const folderId = customerDesignFolderId();
    const candidate = await getConfirmedDriveUpload({ fileId, fileName, folderId });
    if (!candidate) return NextResponse.json({ error: "uploaded_file_not_found" }, { status: 404 });
    if (!candidate.parentFolderIds.includes(folderId) || candidate.name !== fileName) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (!candidate.name.toLowerCase().endsWith(extension)) {
      return NextResponse.json({ error: "uploaded_file_mismatch" }, { status: 400 });
    }
    const sizeBytes = candidate.sizeBytes;
    if (sizeBytes == null || sizeBytes <= 0 || sizeBytes > customerDesignMaxBytes()) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    const order = await registerCustomerDesignFromInternalIntake({
      quotationId: target.quotationId,
      fileName,
      fileUrl: `https://drive.google.com/file/d/${candidate.id}/view`,
      uploader: user.email,
      note: typeof body.note === "string" ? body.note : undefined,
      guideAcknowledged: body.guideAcknowledged === true,
      metadata: {
        fileSizeBytes: sizeBytes,
        contentType: candidate.mimeType,
        checksum: candidate.checksum,
        checksumAlgorithm: candidate.checksum ? "md5" : null,
        driveFileId: candidate.id,
        uploadedVia: "internal_customer_design",
        userAgent: request.headers.get("user-agent"),
      },
      request,
      origin: new URL(request.url).origin,
    });
    return NextResponse.json(customerDesignSummary(target, order));
  } catch (error) {
    const message = error instanceof Error ? error.message : "intake_upload_complete_failed";
    return NextResponse.json(
      { error: message },
      { status: message === "invalid_json" ? 400 : intakeUploadErrorStatus(message) },
    );
  }
}
