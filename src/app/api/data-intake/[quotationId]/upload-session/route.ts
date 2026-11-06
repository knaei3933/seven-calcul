import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  assertCustomerDesignUploadPolicy,
  customerDesignMaxBytes,
  nextCustomerDesignFileName,
} from "@/lib/film-orders";
import {
  browserOriginOf,
  createResumableSession,
  customerDesignFolderId,
  driveConfigured,
} from "@/lib/google-drive";
import { intakeUploadErrorStatus, loadAuthorizedIntakeTarget, type Context } from "../target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  try {
    const body = await request.json() as {
      originalFileName?: unknown;
      sizeBytes?: unknown;
      contentType?: unknown;
    };
    const { quotationId } = await context.params;
    const authorized = await loadAuthorizedIntakeTarget(user, Number(quotationId));
    if (authorized.response) return authorized.response;
    const target = authorized.target!;
    const originalFileName = typeof body.originalFileName === "string" ? body.originalFileName.trim() : "";
    const size = typeof body.sizeBytes === "number" ? body.sizeBytes : Number(body.sizeBytes);
    const hasAiFile = target.order.files.some((file) =>
      file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai")
    );
    assertCustomerDesignUploadPolicy(
      target.order,
      originalFileName,
      Number.isFinite(size) ? size : undefined,
      hasAiFile,
    );
    if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
    const fileName = nextCustomerDesignFileName(target.order, originalFileName);
    const sessionUri = await createResumableSession({
      fileName,
      folderId: customerDesignFolderId(),
      contentType: typeof body.contentType === "string" ? body.contentType : undefined,
      sizeBytes: Number.isFinite(size) ? size : undefined,
      origin: browserOriginOf(request),
    });
    return NextResponse.json({
      sessionUri,
      fileName,
      maxBytes: customerDesignMaxBytes(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "intake_upload_session_failed";
    return NextResponse.json(
      { error: message },
      { status: message === "invalid_json" ? 400 : intakeUploadErrorStatus(message) },
    );
  }
}
