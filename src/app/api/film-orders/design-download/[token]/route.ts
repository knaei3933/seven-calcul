import { NextResponse } from "next/server";
import {
  getFilmOrderForMakerCustomerDesign,
  recordMakerCustomerDesignDownload,
} from "@/lib/film-orders";
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
    const order = await getFilmOrderForMakerCustomerDesign(token, request);
    if (!order) return NextResponse.json({ error: "design_order_not_found" }, { status: 404 });
    const file = order.files.find((item) =>
      item.category === "customer_design"
      && item.url.includes(`/d/${fileId}/`)
    );
    if (!file) {
      await recordMakerCustomerDesignDownload({ request, token, fileId, order });
      return NextResponse.json({ error: "file_not_linked_to_order" }, { status: 403 });
    }
    await recordMakerCustomerDesignDownload({ request, token, fileId, order });
    const drive = await downloadFile(fileId);
    return new Response(drive.body, {
      headers: {
        "Content-Type": drive.headers.get("content-type") ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.file_name)}`,
      },
    });
  } catch {
    return NextResponse.json({ error: "maker_customer_design_download_failed" }, { status: 502 });
  }
}
