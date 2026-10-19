import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";
import { getRegisteredFilmOrderFile } from "@/lib/film-orders";
import { downloadFile } from "@/lib/google-drive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ai": "application/postscript",
  ".eps": "application/postscript",
  ".zip": "application/zip",
};

export async function GET(request: Request): Promise<NextResponse | Response> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!canViewFilmOrders(user.email)) return NextResponse.json({ error: "film_order_forbidden" }, { status: 403 });

  const fileId = new URL(request.url).searchParams.get("fileId") ?? "";
  if (!/^[\w-]{10,}$/u.test(fileId)) {
    return NextResponse.json({ error: "invalid_file_id" }, { status: 400 });
  }

  // このファイルが発注管理に登録済みか確認（他のファイルへのアクセス防止）。
  const registeredFile = await getRegisteredFilmOrderFile(fileId);
  if (!registeredFile) return NextResponse.json({ error: "file_not_registered" }, { status: 404 });
  const fileName = registeredFile.fileName;

  try {
    const drive = await downloadFile(fileId);
    const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    const contentType = CONTENT_TYPES[ext] ?? drive.headers.get("content-type") ?? "application/octet-stream";
    const disposition = contentType.startsWith("image/") || contentType === "application/pdf" ? "inline" : "attachment";
    return new Response(drive.body, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "file_preview_failed" }, { status: 502 });
  }
}
