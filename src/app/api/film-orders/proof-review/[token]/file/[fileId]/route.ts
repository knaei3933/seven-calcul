import { NextResponse } from "next/server";
import { getFilmOrderForCustomerProofReview } from "@/lib/film-orders";
import { downloadFile } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string; fileId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { token, fileId } = await context.params;
  try {
    const order = await getFilmOrderForCustomerProofReview(token, request);
    const file = order.files.find((item) =>
      item.category === "proof"
      && item.drive_file_id === fileId
    );
    if (!file) return NextResponse.json({ error: "file_not_available" }, { status: 403 });
    const drive = await downloadFile(fileId);
    return new Response(drive.body, {
      headers: {
        "Content-Type": drive.headers.get("content-type") ?? "application/pdf",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
      },
    });
  } catch {
    return NextResponse.json({ error: "proof_download_failed" }, { status: 403 });
  }
}
