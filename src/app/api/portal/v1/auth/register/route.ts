import { handlePortalApiRequest } from "@/lib/portal/api-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handlePortalApiRequest(request, "register");
}
