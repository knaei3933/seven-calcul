import { NextResponse } from "next/server";
import {
  decideCustomerProofReview,
  getFilmOrderForCustomerProofReview,
} from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

function summary(order: Awaited<ReturnType<typeof getFilmOrderForCustomerProofReview>>) {
  const proofs = order.files
    .filter((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf"))
    .reverse();
  const latest = proofs[0];
  return {
    order: {
      orderNumber: order.order_number,
      productName: order.product_name,
      status: order.status,
      proofStatus: order.customerProof.status,
      requestedAt: order.customerProof.requestedAt,
      approvedAt: order.customerProof.approvedAt,
      correctionReason: order.customerProof.correctionReason || null,
    },
    latestProof: latest ? {
      id: latest.id,
      fileName: latest.file_name,
      version: latest.version,
      uploadedAt: latest.created_at,
    } : null,
    priorProofs: proofs.slice(1).map((file) => ({
      id: file.id,
      fileName: file.file_name,
      version: file.version,
      uploadedAt: file.created_at,
    })),
    decision: order.customerProof.status,
    canDecide: order.customerProof.status === "requested",
  };
}

function errorStatus(message: string): number {
  if (message === "invalid_customer_proof_decision") return 409;
  if (message === "customer_proof_correction_reason_required") return 400;
  if (message === "invalid_customer_proof_token") return 403;
  return 502;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const order = await getFilmOrderForCustomerProofReview(token, request);
    return NextResponse.json(summary(order));
  } catch (error) {
    const message = error instanceof Error ? error.message : "proof_review_load_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const body = await request.json() as { decision?: unknown; reason?: unknown };
    const decision = body.decision === "approve" || body.decision === "correction" ? body.decision : null;
    if (!decision) return NextResponse.json({ error: "invalid_customer_proof_decision" }, { status: 400 });
    const order = await decideCustomerProofReview({
      token,
      decision,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      request,
    });
    return NextResponse.json(summary(order));
  } catch (error) {
    const message = error instanceof Error ? error.message : "proof_review_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
