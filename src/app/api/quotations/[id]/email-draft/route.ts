import { NextResponse } from "next/server";
import { getQuotation, getQuotationPdf } from "@/lib/quotation-store";
import { buildCustomerApprovalToken } from "@/lib/quotation-approval-token";
import { buildCustomerQuotationEmail } from "@/lib/quotation-email";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";
import { findCustomerDesignAttachments } from "@/lib/customer-design-data";
import { getSessionUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function originOf(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) return `${forwardedProto ?? "https"}://${forwardedHost}`;
  return new URL(request.url).origin;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  try {
    const { id } = await context.params;
    const quotationId = Number(id);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
    }
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    const fileName = buildQuotationPdfFileName({
      issueDate: record.issueDate,
      productName: record.productName,
      customerName: record.customerName,
    });
    const approvalUrl = `${originOf(request)}/quote-approvals/${encodeURIComponent(buildCustomerApprovalToken(record))}`;
    const automatic = buildCustomerQuotationEmail(record, approvalUrl, fileName);
    let designFiles: Awaited<ReturnType<typeof findCustomerDesignAttachments>> = [];
    try {
      designFiles = await findCustomerDesignAttachments(record);
    } catch {
      designFiles = [];
    }
    const pdf = await getQuotationPdf(quotationId).catch(() => null);
    return NextResponse.json({
      subject: automatic.subject,
      body: automatic.body,
      to: record.payload.customerEmail,
      internalApproved: Boolean(record.internalApproval),
      quotePdf: pdf ? { fileName, sizeBytes: pdf.data.byteLength } : null,
      designLabel: designFiles[0]?.designLabel ?? null,
      designAttachments: designFiles.map((file) => ({
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        revision: file.revision,
        contentType: file.contentType,
      })),
    });
  } catch {
    return NextResponse.json({ error: "email_draft_failed" }, { status: 500 });
  }
}
