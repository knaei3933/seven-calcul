import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { getSessionUser } from "@/lib/api-auth";
import {
  approveQuotationGate,
  getQuotation,
  QuotationApprovalTransitionError,
  QuotationApprovalForbiddenError,
  SampleBulkConfirmationRequiredError,
  type QuotationApprovalGate,
} from "@/lib/quotation-store";
import {
  canInternalApproveQuotation,
  canManageQuotationCustomerRequest,
} from "@/lib/quotation-access";
import { UnresolvedQuotationOwnerError } from "@/lib/quotation-store";
import { syncFilmOrderFromQuotationRecord } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const approvalGates: QuotationApprovalGate[] = [
  "internal",
  "customerApproval",
];

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const requestStartedAt = performance.now();
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });

    const body = await request.json() as { gate?: unknown };
    const gate = approvalGates.find((item) => item === body.gate) as QuotationApprovalGate | undefined;
    if (!gate) return NextResponse.json({ error: "invalid_approval_gate" }, { status: 400 });

    const { id } = await context.params;
    const quotationId = Number(id);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
    }
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (record.ownerDomain === "unresolved") {
      return NextResponse.json({ error: "unresolved_quote_owner" }, { status: 409 });
    }

    if (
      gate === "internal"
      && !canInternalApproveQuotation(user.email, record.ownerDomain)
    ) {
      return NextResponse.json({ error: "internal_approval_forbidden" }, { status: 403 });
    }
    if (
      gate !== "internal"
      && !canManageQuotationCustomerRequest(user.email, record.ownerDomain)
    ) {
      return NextResponse.json({ error: "customer_approval_forbidden" }, { status: 403 });
    }

    const approvalStartedAt = performance.now();
    const approved = await approveQuotationGate(quotationId, gate, user.id, { currentRecord: record });
    const approvalMs = performance.now() - approvalStartedAt;
    let createdFilmOrders = 0;
    // Durable internal approval—not customer evidence—is the intake transfer trigger.
    const syncStartedAt = performance.now();
    if (gate === "internal") createdFilmOrders = await syncFilmOrderFromQuotationRecord(approved, user.email) ? 1 : 0;
    const syncMs = performance.now() - syncStartedAt;
    console.info("[quotation-approval] timing", {
      quotationId,
      gate,
      approvalMs: Math.round(approvalMs),
      syncMs: Math.round(syncMs),
      totalMs: Math.round(performance.now() - requestStartedAt),
      createdFilmOrders,
    });
    return NextResponse.json({ record: approved, gate, filmOrderSynced: createdFilmOrders > 0 });
  } catch (error) {
    console.error("[quotation-approval] failed", error);
    if (error instanceof SampleBulkConfirmationRequiredError) {
      return NextResponse.json({ error: "sample_bulk_confirmation_required" }, { status: 409 });
    }
    if (error instanceof QuotationApprovalTransitionError) {
      return NextResponse.json({ error: "invalid_approval_transition" }, { status: 409 });
    }
    if (error instanceof UnresolvedQuotationOwnerError) {
      return NextResponse.json({ error: "unresolved_quote_owner" }, { status: 409 });
    }
    if (error instanceof QuotationApprovalForbiddenError) {
      return NextResponse.json({ error: "quote_owner_action_forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "quotation_approval_failed" }, { status: 500 });
  }
}
