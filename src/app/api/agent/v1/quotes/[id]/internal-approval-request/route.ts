import { withAgentApi } from "@/lib/agent-auth-store";
import { requestInternalApproval } from "@/lib/agent-approval-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const outcome = await withAgentApi(
    request,
    {
      operation: "agent.quote.internal_approval.request",
      unauthorizedReason: "unauthorized",
      details: (auth) => ({ metadata: { principal_user_id: auth.userId } }),
    },
    (requestContext) => requestInternalApproval(requestContext, Number(id)),
  );
  return outcome.response ?? Response.json(outcome.result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
