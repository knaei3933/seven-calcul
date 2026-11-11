import { withAgentApi } from "@/lib/agent-auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const outcome = await withAgentApi(request, { operation: "credential.status" }, async ({ auth }) => ({
    status: "ok",
    credential: {
      id: auth.credentialId,
      principal: auth.principalEmail,
      name: auth.name,
      scopes: auth.scopes,
    },
  }));
  return outcome.response ?? Response.json(outcome.result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
