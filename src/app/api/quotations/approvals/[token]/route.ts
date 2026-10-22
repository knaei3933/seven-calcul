import { NextResponse } from "next/server";
import { customerApprovalIpHash } from "@/lib/quotation-approval-token";
import {
  approveQuotationByCustomerToken,
  CustomerApprovalExpiredError,
  CustomerApprovalTokenError,
  getQuotationForCustomerApproval,
  QuotationApprovalTransitionError,
} from "@/lib/quotation-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

function clientIpHash(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim();
  return ip ? customerApprovalIpHash(ip) : null;
}

function summary(record: Awaited<ReturnType<typeof getQuotationForCustomerApproval>>) {
  return {
    quotationNumber: record.quotationNumber,
    customerName: record.customerName,
    productName: record.productName,
    sizeSummary: record.sizeSummary,
    quantity: record.quantity,
    grandTotal: record.grandTotal,
    validUntil: record.validUntil,
    status: record.status,
    approvedAt: record.customerApproval?.approvedAt ?? null,
    customerApprovalRecorded: Boolean(record.customerApproval),
  };
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const { token } = await context.params;
    const record = await getQuotationForCustomerApproval(token);
    return NextResponse.json({ quotation: summary(record) });
  } catch (error) {
    if (error instanceof CustomerApprovalExpiredError) {
      return NextResponse.json({ error: "customer_approval_expired" }, { status: 410 });
    }
    if (error instanceof CustomerApprovalTokenError || error instanceof QuotationApprovalTransitionError) {
      return NextResponse.json({ error: "invalid_customer_approval_token" }, { status: 403 });
    }
    return NextResponse.json({ error: "customer_approval_load_failed" }, { status: 500 });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => ({})) as { acknowledge?: unknown };
    if (body.acknowledge !== true) {
      return NextResponse.json({ error: "acknowledgement_required" }, { status: 400 });
    }
    const { token } = await context.params;
    const record = await approveQuotationByCustomerToken(token, {
      customerIpHash: clientIpHash(request),
      userAgent: request.headers.get("user-agent"),
    });
    return NextResponse.json({ quotation: summary(record), filmOrderSynced: false });
  } catch (error) {
    if (error instanceof CustomerApprovalExpiredError) {
      return NextResponse.json({ error: "customer_approval_expired" }, { status: 410 });
    }
    if (error instanceof CustomerApprovalTokenError || error instanceof QuotationApprovalTransitionError) {
      return NextResponse.json({ error: "invalid_customer_approval_token" }, { status: 403 });
    }
    return NextResponse.json({ error: "customer_approval_failed" }, { status: 500 });
  }
}
