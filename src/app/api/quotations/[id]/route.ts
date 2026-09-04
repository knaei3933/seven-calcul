import { NextResponse } from "next/server";
import { deleteQuotation, getQuotation, quotationStatuses, updateQuotationStatus, type QuotationStatus } from "@/lib/quotation-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const record = await getQuotation(Number(id));
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    return NextResponse.json({ record });
  } catch {
    return NextResponse.json({ error: "quotation_get_failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const body = await request.json() as { status?: unknown };
    const status = quotationStatuses.find((item) => item === body.status) as QuotationStatus | undefined;
    if (!status) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    const record = await updateQuotationStatus(Number(id), status);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    return NextResponse.json({ record });
  } catch {
    return NextResponse.json({ error: "quotation_update_failed" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const deleted = await deleteQuotation(Number(id));
    if (!deleted) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: "quotation_delete_failed" }, { status: 500 });
  }
}
