import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  approveQuotationGate,
  getQuotation,
  QuotationApprovalTransitionError,
  SampleBulkConfirmationRequiredError,
  type QuotationApprovalGate,
} from "@/lib/quotation-store";
import {
  canRecordCustomerApproval,
  isInternalQuotationApprover,
} from "@/lib/quotation-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const approvalGates: QuotationApprovalGate[] = [
  "internal",
  "customerApproval",
];

export async function POST(request: Request, context: Context): Promise<NextResponse> {
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

    if (gate === "internal" && !isInternalQuotationApprover(user.email)) {
      return NextResponse.json({ error: "internal_approval_forbidden" }, { status: 403 });
    }
    if (gate !== "internal" && !canRecordCustomerApproval(user.email)) {
      return NextResponse.json({ error: "customer_approval_forbidden" }, { status: 403 });
    }

    const approved = await approveQuotationGate(quotationId, gate, user.id);
    return NextResponse.json({ record: approved, gate, filmOrderSynced: false });
  } catch (error) {
    if (error instanceof SampleBulkConfirmationRequiredError) {
      return NextResponse.json({ error: "sample_bulk_confirmation_required" }, { status: 409 });
    }
    if (error instanceof QuotationApprovalTransitionError) {
      return NextResponse.json({ error: "invalid_approval_transition" }, { status: 409 });
    }
    return NextResponse.json({ error: "quotation_approval_failed" }, { status: 500 });
  }
}
