import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ asset: string }> };

const ASSETS = {
  "kanei-trade-logo.png": { file: "kanei-trade-logo.png", contentType: "image/png" },
  "epackage-lab-logo.png": { file: "epackage-lab-logo.png", contentType: "image/png" },
  "kanei-trade-seal.png": { file: "kanei-trade-seal.png", contentType: "image/png" },
} as const;

export async function GET(request: Request, context: Context): Promise<NextResponse | Response> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

  const { asset } = await context.params;
  const configuredAsset = ASSETS[asset as keyof typeof ASSETS];
  if (!configuredAsset) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  try {
    const bytes = await readFile(path.join(process.cwd(), "assets", "brand", configuredAsset.file));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": configuredAsset.contentType,
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  }
}
