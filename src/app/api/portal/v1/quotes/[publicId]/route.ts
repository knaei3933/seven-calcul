import { getPortalQuoteApi } from "@/lib/portal/quote-list-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ publicId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { publicId } = await context.params;
  return getPortalQuoteApi(request, publicId);
}
