import { NextResponse } from "next/server";
import { getChecklistsForQuotation, updateChecklistItem } from "@/lib/quotation-store";
import { checklistAudiences, type ChecklistAudience } from "@/lib/quotation-shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function parseAudience(value: unknown): ChecklistAudience | null {
  return checklistAudiences.find((audience) => audience === value) ?? null;
}

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
  }
  try {
    return NextResponse.json({ checklists: await getChecklistsForQuotation(quotationId) });
  } catch {
    return NextResponse.json({ error: "checklist_get_failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const quotationId = Number(id);
  try {
    const body = await request.json() as {
      audience?: unknown;
      itemId?: unknown;
      accepted?: unknown;
      checkedBy?: unknown;
    };
    const audience = parseAudience(body.audience);
    if (!Number.isInteger(quotationId) || quotationId <= 0 || !audience) {
      return NextResponse.json({ error: "invalid_checklist_target" }, { status: 400 });
    }
    if (typeof body.itemId !== "string" || !body.itemId.trim() || typeof body.accepted !== "boolean") {
      return NextResponse.json({ error: "invalid_checklist_update" }, { status: 400 });
    }
    const checkedBy = typeof body.checkedBy === "string" ? body.checkedBy.trim().slice(0, 200) : "";
    const record = await updateChecklistItem(
      quotationId,
      audience,
      body.itemId,
      body.accepted,
      checkedBy,
    );
    if (!record) return NextResponse.json({ error: "checklist_item_not_found" }, { status: 404 });
    return NextResponse.json({ checklist: record });
  } catch {
    return NextResponse.json({ error: "checklist_update_failed" }, { status: 500 });
  }
}
