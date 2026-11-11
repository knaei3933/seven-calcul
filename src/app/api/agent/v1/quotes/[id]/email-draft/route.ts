import { withAgentApi } from "@/lib/agent-auth-store";
import { readAgentQuoteEmailDraft } from "@/lib/agent-quote-read-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function quotationId(params: { id: string }): number {
  return Number(params.id);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const outcome = await withAgentApi(
    request,
    {
      operation: "agent.quote.email_draft.read",
      scope: "email_draft:read",
      details: (auth) => ({
        quotationId: id,
        metadata: { principal_user_id: auth.userId },
      }),
    },
    (requestContext) => readAgentQuoteEmailDraft(request, requestContext, quotationId({ id })),
  );
  if (outcome.response) return outcome.response;
  return Response.json(outcome.result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
