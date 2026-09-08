import { NextResponse } from "next/server";
import { createChecklistsForQuotation, getQuotationByNumber, listQuotations, saveQuotation, validateQuotationInput } from "@/lib/quotation-store";
import type { CalculationChecklistSnapshot } from "@/lib/calculation-checklist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  try {
    const records = await listQuotations({
      q: url.searchParams.get("q") ?? "",
      status: url.searchParams.get("status") ?? "all",
      limit: Number(url.searchParams.get("limit") ?? 100),
    });
    return NextResponse.json({ records });
  } catch {
    return NextResponse.json({ error: "quotation_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = validateQuotationInput(await request.json());
    if (!input) return NextResponse.json({ error: "invalid_quotation" }, { status: 400 });
    const existing = await getQuotationByNumber(input.quotationNumber);
    const record = await saveQuotation(input);
    if (!existing) {
      const snapshot = input.payload.calculationChecklistSnapshot;
      if (snapshot && typeof snapshot === "object") {
        await createChecklistsForQuotation(record, snapshot as CalculationChecklistSnapshot);
      }
    }
    return NextResponse.json({ record }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "quotation_save_failed" }, { status: 500 });
  }
}
