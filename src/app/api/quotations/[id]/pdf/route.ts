import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { getQuotation, saveQuotationPdf, getQuotationPdf } from "@/lib/quotation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

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
    const formData = await request.formData();
    const pdfBlob = formData.get("pdf") as File | null;
    if (!pdfBlob) return NextResponse.json({ error: "pdf_required" }, { status: 400 });
    const buffer = Buffer.from(await pdfBlob.arrayBuffer());
    const saved = await saveQuotationPdf(quotationId, buffer, `${record.quotationNumber}.pdf`);
    if (!saved) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    return NextResponse.json({ saved: true, size: buffer.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "pdf_save_failed";
    return NextResponse.json({ error: msg }, { status: 500 });
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
    const pdf = await getQuotationPdf(quotationId);
    if (!pdf) return NextResponse.json({ error: "pdf_not_found" }, { status: 404 });
    return new Response(new Uint8Array(pdf.data), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "pdf_get_failed" }, { status: 500 });
  }
}
