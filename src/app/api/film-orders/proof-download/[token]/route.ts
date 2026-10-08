import { NextResponse } from "next/server";
import { getFilmOrderForProofUpload } from "@/lib/film-orders";
import { downloadFile } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { token } = await context.params;
  const fileId = new URL(request.url).searchParams.get("fileId") ?? "";
  if (!/^[\w-]{10,}$/u.test(fileId)) {
    return NextResponse.json({ error: "invalid_file_id" }, { status: 400 });
  }
  try {
    const order = await getFilmOrderForProofUpload(token);
    if (!order) return NextResponse.json({ error: "proof_order_not_found" }, { status: 404 });
    const allowed = order.files.some((file) => file.url.includes(`/d/${fileId}/`));
    if (!allowed) return NextResponse.json({ error: "file_not_linked_to_order" }, { status: 403 });
    const drive = await downloadFile(fileId);
    return new Response(drive.body, {
      headers: {
        "Content-Type": drive.headers.get("content-type") ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(order.files.find((file) => file.url.includes(`/d/${fileId}/`))?.file_name ?? fileId)}`,
      },
    });
  } catch {
    return NextResponse.json({ error: "proof_download_failed" }, { status: 502 });
  }
}
