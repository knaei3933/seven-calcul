import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  getQuotation,
  getQuotationPdf,
  MAX_QUOTATION_PDF_BYTES,
  QuotationPdfIntegrityError,
  saveQuotationPdf,
} from "@/lib/quotation-store";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";
import type { AuthenticatedUser } from "@/lib/auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function canManageQuotation(user: AuthenticatedUser, creatorId: number): boolean {
  return user.role === "admin" || user.id === creatorId;
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (!canManageQuotation(user, record.createdBy.id)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const formData = await request.formData();
    const pdfValue = formData.get("pdf");
    if (!(pdfValue instanceof File)) {
      return NextResponse.json({
        error: "pdf_required",
        message: "発行には有効なファイル形式のA4 PDF（10MB以内）を添付してください。",
      }, { status: 400 });
    }
    const pdfBlob = pdfValue;
    if (pdfBlob.size > MAX_QUOTATION_PDF_BYTES) {
      return NextResponse.json({
        error: "pdf_too_large",
        message: "PDFが大きすぎます。10MB以内のPDFを添付してください。",
      }, { status: 413 });
    }
    const buffer = Buffer.from(await pdfBlob.arrayBuffer());
    if (buffer.length === 0 || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      return NextResponse.json({
        error: "invalid_pdf",
        message: "PDFが不正です。A4形式のPDF（10MB以内）を添付してください。",
      }, { status: 400 });
    }
    const saved = await saveQuotationPdf(quotationId, buffer, `${record.quotationNumber}.pdf`);
    if (!saved) {
      const canonical = await getQuotationPdf(quotationId);
      if (canonical) {
        return NextResponse.json({
          error: "canonical_pdf_already_exists",
          message: "この見積書のPDFは確定済みのため上書きできません。",
        }, { status: 409 });
      }
      return NextResponse.json({ error: "pdf_save_failed" }, { status: 500 });
    }
    return NextResponse.json({ saved: true, size: buffer.length });
  } catch (error) {
    console.error("[quotation-pdf] save failed", error);
    return NextResponse.json({ error: "pdf_save_failed" }, { status: 500 });
  }
}

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    const pdf = await getQuotationPdf(quotationId);
    if (!pdf) return NextResponse.json({ error: "pdf_not_found" }, { status: 404 });
    const fileName = buildQuotationPdfFileName({
      issueDate: record.issueDate,
      productName: record.productName,
      customerName: record.customerName,
    });
    return new Response(new Uint8Array(pdf.data), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${fileName}.pdf`)}`,
        "Cache-Control": "private, no-store",
        "Content-Length": String(pdf.data.byteLength),
      },
    });
  } catch (error) {
    if (error instanceof QuotationPdfIntegrityError) {
      console.error("[quotation-pdf] integrity verification failed", error);
      return NextResponse.json({
        error: "pdf_integrity_failed",
        message: "保存済みPDFの整合性確認に失敗しました。",
      }, { status: 500 });
    }
    console.error("[quotation-pdf] get failed", error);
    return NextResponse.json({ error: "pdf_get_failed" }, { status: 500 });
  }
}
