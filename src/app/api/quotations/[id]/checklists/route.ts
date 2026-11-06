import { NextResponse } from "next/server";
import {
  getChecklistsForQuotation,
  getQuotation,
  QuotationActionForbiddenError,
  createChecklistsForQuotation,
  createLegacyChecklistsForQuotation,
  updateChecklistItem,
} from "@/lib/quotation-store";
import { CHECKLIST_VERSION, readCalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import { printingMethodOf } from "@/lib/quotation-history";
import { checklistAudiences, type ChecklistAudience } from "@/lib/quotation-shared";
import { getSessionUser } from "@/lib/api-auth";
import { canPerformOwnerWorkflowAction, canReadQuotation } from "@/lib/quotation-access";
import { canViewInternalChecklist } from "@/lib/checklist-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function parseAudience(value: unknown): ChecklistAudience | null {
  return checklistAudiences.find((audience) => audience === value) ?? null;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
  }
  try {
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (!canReadQuotation(user, record)) {
      return NextResponse.json({ error: "checklist_forbidden" }, { status: 403 });
    }
    const checklists = await getChecklistsForQuotation(quotationId);
    const internalAllowed = canViewInternalChecklist(user.email, record.ownerDomain);
    return NextResponse.json({
      checklists: internalAllowed
        ? checklists
        : checklists.filter((record) => record.audience !== "INTERNAL_QA"),
    });
  } catch {
    return NextResponse.json({ error: "checklist_get_failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
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
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (!canPerformOwnerWorkflowAction(user, record)) {
      return NextResponse.json({ error: "owner_action_forbidden" }, { status: 403 });
    }
    if (audience === "INTERNAL_QA" && !canViewInternalChecklist(user.email, record.ownerDomain)) {
      return NextResponse.json({ error: "internal_checklist_forbidden" }, { status: 403 });
    }
    const checkedBy = user.name.slice(0, 200);
    const updated = await updateChecklistItem(
      quotationId,
      audience,
      body.itemId,
      body.accepted,
      checkedBy,
      user.id,
    );
    if (!updated) return NextResponse.json({ error: "checklist_item_not_found" }, { status: 404 });
    return NextResponse.json({ checklist: updated });
  } catch (error) {
    if (error instanceof QuotationActionForbiddenError) {
      return NextResponse.json({ error: "owner_action_forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "checklist_update_failed" }, { status: 500 });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const quotationId = Number(id);
  if (!Number.isInteger(quotationId) || quotationId <= 0) {
    return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
  }

  try {
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (!canPerformOwnerWorkflowAction(user, record)) {
      return NextResponse.json({ error: "owner_action_forbidden" }, { status: 403 });
    }

    const payloadSnapshot = readCalculationChecklistSnapshot(record.payload.calculationChecklistSnapshot);
    if (payloadSnapshot) payloadSnapshot.checklistVersion = CHECKLIST_VERSION;
    const checklists = payloadSnapshot
      ? await createChecklistsForQuotation(record, payloadSnapshot)
      : await createLegacyChecklistsForQuotation(record, printingMethodOf(record));
    return NextResponse.json({ checklists });
  } catch (error) {
    if (error instanceof QuotationActionForbiddenError) {
      return NextResponse.json({ error: "owner_action_forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "checklist_rebuild_failed" }, { status: 500 });
  }
}
