import { withAgentApi } from "@/lib/agent-auth-store";
import { issueAgentQuote } from "@/lib/agent-quote-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const outcome = await withAgentApi(
    request,
    { operation: "agent.quote.issue", scope: "quote:issue" },
    (context) => issueAgentQuote(request, context),
  );
  if (!outcome.response && outcome.result instanceof Response) return outcome.result;
  return outcome.response ?? Response.json(outcome.result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
