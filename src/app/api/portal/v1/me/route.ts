import { handlePortalApiRequest } from "@/lib/portal/api-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handlePortalApiRequest(request, "me");
}
