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
import { buildQuotationPdfFileName } from "@/lib/film-quotation";
import { findCustomerDesignAttachments, readCustomerDesignAttachments } from "@/lib/customer-design-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

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
    if (record.status === "expired") {
      return NextResponse.json({ error: "quotation_validity_expired" }, { status: 409 });
    }
    if (!record.internalApproval) {
      return NextResponse.json({ error: "internal_approval_required" }, { status: 409 });
    }

    const pdf = await getQuotationPdf(quotationId);
    if (!pdf) return NextResponse.json({ error: "quotation_pdf_not_found" }, { status: 409 });
    const fileName = buildQuotationPdfFileName({
      issueDate: record.issueDate,
      productName: record.productName,
      customerName: record.customerName,
    });
    const composeInput = await request.json().catch(() => null) as {
      to?: unknown;
      subject?: unknown;
      body?: unknown;
    } | null;
    const recipient = typeof composeInput?.to === "string" && composeInput.to.trim()
      ? composeInput.to.trim()
      : email;
    if (!EMAIL_PATTERN.test(recipient)) {
      return NextResponse.json({ error: "invalid_recipient_email" }, { status: 400 });
    }
    // 팝업에서 한 번만 변경한 수신처도 승인 토큰 메타데이터와 일치시킨다.
    const approvalTokenRecord = recipient === email ? record : {
      ...record,
      payload: { ...record.payload, customerEmail: recipient },
    };
    const approvalUrl = `${originOf(request)}/quote-approvals/${encodeURIComponent(buildCustomerApprovalToken(approvalTokenRecord))}`;
    const designFiles = await findCustomerDesignAttachments(record);
    if (!designFiles.length) {
      return NextResponse.json({ error: "customer_design_data_not_found" }, { status: 409 });
    }
    const designAttachments = await readCustomerDesignAttachments(record);
    const automatic = buildCustomerQuotationEmail(
      record,
      approvalUrl,
      fileName,
      designAttachments.map((file) => file.filename),
    );
    const subject = typeof composeInput?.subject === "string" && composeInput.subject.trim()
      ? composeInput.subject.trim().slice(0, 300)
      : automatic.subject;
    const body = typeof composeInput?.body === "string" && composeInput.body.trim()
      ? composeInput.body.trim()
      : automatic.body;
    const usesAutomaticText = subject === automatic.subject && body === automatic.body;

    const result = await sendMail({
      to: recipient,
      subject,
      body,
      templateKey: usesAutomaticText ? "quotation_customer_send" : undefined,
      templateVars: usesAutomaticText ? {
        quotationNumber: record.quotationNumber,
        productName: record.productName,
        customerName: record.customerName,
        approvalUrl,
        fileName,
      } : undefined,
      attachments: [
        {
          filename: fileName,
          content: pdf.data,
          contentType: "application/pdf",
        },
        ...designAttachments,
      ],
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
      designAttachments: designFiles.map((file) => ({
        fileName: file.fileName,
        sizeBytes: file.sizeBytes,
        revision: file.revision,
      })),
    });
  } catch (error) {
    if (error instanceof QuotationPdfIntegrityError) {
      return NextResponse.json({ error: "quotation_pdf_integrity_failed" }, { status: 500 });
    }
    if (error instanceof Error && error.message === "design_file_too_large") {
      return NextResponse.json({ error: "design_file_too_large" }, { status: 413 });
    }
    if (error instanceof Error && error.message === "smtp_not_configured") {
      return NextResponse.json({ error: "smtp_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }
}
