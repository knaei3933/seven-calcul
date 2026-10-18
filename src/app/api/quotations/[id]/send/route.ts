import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  getQuotation,
  getQuotationPdf,
  QuotationPdfIntegrityError,
  updateQuotationStatus,
} from "@/lib/quotation-store";
import { sendMail, isSmtpConfigured } from "@/lib/mail-sender";
import { buildCustomerApprovalToken } from "@/lib/quotation-approval-token";
import { buildCustomerQuotationEmail } from "@/lib/quotation-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function originOf(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) return `${forwardedProto ?? "https"}://${forwardedHost}`;
  return new URL(request.url).origin;
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (!isSmtpConfigured()) return NextResponse.json({ error: "smtp_not_configured" }, { status: 503 });

    const { id } = await context.params;
    const quotationId = Number(id);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
    }
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });

    const email = typeof record.payload.customerEmail === "string" ? record.payload.customerEmail.trim() : "";
    if (!email) return NextResponse.json({ error: "customer_email_required" }, { status: 400 });
    if (!record.internalApproval) {
      return NextResponse.json({ error: "internal_approval_required" }, { status: 409 });
    }

    const pdf = await getQuotationPdf(quotationId);
    if (!pdf) return NextResponse.json({ error: "quotation_pdf_not_found" }, { status: 409 });
    const fileName = pdf.fileName || `${record.quotationNumber}.pdf`;
    const approvalUrl = `${originOf(request)}/quote-approvals/${encodeURIComponent(buildCustomerApprovalToken(record))}`;
    const { subject, body } = buildCustomerQuotationEmail(record, approvalUrl, fileName);

    const result = await sendMail({
      to: email,
      subject,
      body,
      attachments: [{
        filename: fileName,
        content: pdf.data,
        contentType: "application/pdf",
      }],
    });
    const updated = await updateQuotationStatus(quotationId, "sent", user.id);
    if (!updated) return NextResponse.json({ error: "status_update_failed" }, { status: 500 });
    return NextResponse.json({
      record: updated,
      sentTo: result.recipient,
      recipientOverridden: result.recipientOverridden,
      approvalUrl,
      attachment: {
        fileName,
        sizeBytes: pdf.data.byteLength,
      },
    });
  } catch (error) {
    if (error instanceof QuotationPdfIntegrityError) {
      return NextResponse.json({ error: "quotation_pdf_integrity_failed" }, { status: 500 });
    }
    if (error instanceof Error && error.message === "smtp_not_configured") {
      return NextResponse.json({ error: "smtp_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }
}
