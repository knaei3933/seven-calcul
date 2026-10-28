import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  getQuotation,
  QuotationApprovalTransitionError,
  SampleBulkConfirmationRequiredError,
  updateQuotationSampleBulkConfirmation,
} from "@/lib/quotation-store";
import { isInternalQuotationApprover } from "@/lib/quotation-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(_request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { id } = await context.params;
  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
  }
  const record = await getQuotation(quotationId);
  if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
  return NextResponse.json({ confirmation: record.payload.sampleBulkConfirmation ?? null });
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (!isInternalQuotationApprover(user.email)) {
    return NextResponse.json({ error: "sample_bulk_confirmation_forbidden" }, { status: 403 });
  }
  const { id } = await context.params;
  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
  }
  try {
    const body = await request.json() as {
      action?: unknown;
      sampleQuantityMl?: unknown;
      receivedMl?: unknown;
      note?: unknown;
    };
    const action = body.action === "record-received" || body.action === "confirm"
      ? body.action
      : null;
    if (!action) return NextResponse.json({ error: "invalid_sample_bulk_action" }, { status: 400 });
    const record = await updateQuotationSampleBulkConfirmation(
      quotationId,
      action,
      body,
      user.id,
    );
    return NextResponse.json({ record, confirmation: record.payload.sampleBulkConfirmation ?? null });
  } catch (error) {
    if (error instanceof QuotationApprovalTransitionError) {
      return NextResponse.json({ error: "invalid_sample_bulk_transition" }, { status: 409 });
    }
    if (error instanceof SampleBulkConfirmationRequiredError) {
      return NextResponse.json({ error: "sample_bulk_confirmation_required" }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "sample_bulk_update_failed";
    if (["sample_bulk_quantity_required", "sample_bulk_receipt_required"].includes(message)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: "sample_bulk_update_failed" }, { status: 500 });
  }
}
