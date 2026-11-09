import { NextResponse } from "next/server";
import { getQuotation } from "@/lib/quotation-store";
import { getSqlClient } from "@/lib/db";
import { getSessionUser } from "@/lib/api-auth";
import { isMasterQuotationAdmin } from "@/lib/quotation-access";
import { buildCanonicalQuotationPdfModel, renderCanonicalQuotationPdf } from "@/lib/standard-quote-pdf";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user || !isMasterQuotationAdmin(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await context.params;
  const quotationId = Number(id);
  const record = await getQuotation(quotationId);
  if (!record || !["seven", "kanei"].includes(record.ownerDomain)) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
  const canonical = await renderCanonicalQuotationPdf(
    buildCanonicalQuotationPdfModel(record, record.quotationNumber, record.ownerDomain as "seven" | "kanei"),
    record.ownerDomain as "seven" | "kanei",
  );
  const fileName = buildQuotationPdfFileName({ issueDate: record.issueDate, productName: record.productName, customerName: record.customerName });
  const sha256 = createHash("sha256").update(canonical.bytes).digest("hex");
  const db = await getSqlClient("quotations");
  await db.run(
    `UPDATE quotations SET pdf_data=?, pdf_file_name=?, pdf_uploaded_at=?, pdf_sha256=? WHERE id=?`,
    [canonical.bytes, fileName, new Date().toISOString(), sha256, quotationId],
  );
  return NextResponse.json({ regenerated: true, bytes: canonical.bytes.byteLength, sha256 });
}
