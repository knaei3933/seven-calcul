import { calculatePortalQuote } from "@/lib/portal/quote-calculation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return calculatePortalQuote(request);
}
