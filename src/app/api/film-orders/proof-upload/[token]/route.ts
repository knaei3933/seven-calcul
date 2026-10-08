import { NextResponse } from "next/server";
import {
  getFilmOrderForProofUpload,
  registerProofFromUploadToken,
} from "@/lib/film-orders";
import {
  createResumableSession,
  driveConfigured,
  findFileUrl,
  proofFolderId,
} from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

function orderSummary(order: Awaited<ReturnType<typeof getFilmOrderForProofUpload>>) {
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
      .map((file) => ({ name: file.file_name, url: file.url })),
    proofs: (order?.files ?? [])
      .filter((file) => file.category === "proof")
      .map((file) => ({ name: file.file_name, version: file.version, url: file.url })),
  };
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
      fileUrl?: unknown;
    };
    const action = typeof body.action === "string" ? body.action : "";
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const order = await getFilmOrderForProofUpload(token);
    if (!order) return NextResponse.json({ error: "proof_order_not_found" }, { status: 404 });

    if (action === "session") {
      if (!fileName || fileName.length > 200 || fileName.includes("/") || fileName.includes("\\")) {
        return NextResponse.json({ error: "invalid_upload_request" }, { status: 400 });
      }
      if (!fileName.includes(order.order_number)) {
        return NextResponse.json({ error: "file_name_must_include_order_number" }, { status: 400 });
      }
      if (!/\.(ai|pdf|zip|eps|psd|indd)$/iu.test(fileName)) {
        return NextResponse.json({ error: "unsupported_file_type" }, { status: 400 });
      }
      const size = Number(body.sizeBytes);
      if (Number.isFinite(size) && size > 15 * 1024 * 1024) {
        return NextResponse.json({ error: "file_too_large" }, { status: 413 });
      }
      if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
      const sessionUri = await createResumableSession({
        fileName,
        folderId: proofFolderId(),
        contentType: typeof body.contentType === "string" ? body.contentType : undefined,
        sizeBytes: Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : undefined,
      });
      return NextResponse.json({ sessionUri });
    }

    if (action === "complete") {
      if (!fileName) return NextResponse.json({ error: "invalid_upload_request" }, { status: 400 });
      if (!driveConfigured()) return NextResponse.json({ error: "drive_not_configured" }, { status: 503 });
      let url: string | null = null;
      for (let attempt = 0; attempt < 3 && !url; attempt += 1) {
        url = await findFileUrl({ fileName, folderId: proofFolderId() });
        if (!url) await new Promise((resolve) => setTimeout(resolve, 800));
      }
      if (!url) return NextResponse.json({ error: "uploaded_file_not_found" }, { status: 404 });
      const updated = await registerProofFromUploadToken({
        token,
        fileName,
        fileUrl: url,
        uploader: typeof body.uploader === "string" ? body.uploader : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      return NextResponse.json({ order: orderSummary(updated), url });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "proof_upload_failed";
    const status = message === "invalid_status_transition" ? 409
      : message === "invalid_file_name" || message === "invalid_upload_request" ? 400
      : message === "invalid_proof_token" ? 403 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
