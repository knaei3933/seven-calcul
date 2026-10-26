import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FONTS = {
  regular: "NotoSansJP-Quotation-Regular.ttf",
  bold: "NotoSansJP-Quotation-Bold.ttf",
} as const;

export async function GET(request: Request): Promise<Response> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const weight = new URL(request.url).searchParams.get("weight") === "bold" ? "bold" : "regular";
  try {
    const bytes = await readFile(path.join(process.cwd(), "src", "fonts", FONTS[weight]));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "font/ttf",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "font_not_found" }, { status: 404 });
  }
}
