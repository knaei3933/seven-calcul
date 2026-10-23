import {
  downloadPortalQuotePdfApi,
} from "@/lib/portal/quote-pdf-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ publicId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { publicId } = await context.params;
  return downloadPortalQuotePdfApi(request, publicId);
}
