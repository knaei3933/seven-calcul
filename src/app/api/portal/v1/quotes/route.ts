import { listPortalQuotesApi } from "@/lib/portal/quote-list-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return listPortalQuotesApi(request);
}
