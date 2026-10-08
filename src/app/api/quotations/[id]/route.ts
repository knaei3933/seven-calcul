import { NextResponse } from "next/server";
import { deleteQuotation, getQuotation, quotationStatuses, updateQuotationStatus, type QuotationStatus } from "@/lib/quotation-store";
import { getSessionUser } from "@/lib/api-auth";
import type { AuthenticatedUser } from "@/lib/auth-store";
import { filmOrderExistsForQuotation, syncFilmOrdersFromQuotations } from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
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
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const body = await request.json() as { status?: unknown };
    const status = quotationStatuses.find((item) => item === body.status) as QuotationStatus | undefined;
    if (!status) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    const existing = await getQuotation(Number(id));
    if (!existing) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (!canManageQuotation(user, existing.createdBy.id)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const record = await updateQuotationStatus(Number(id), status, user.id);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (status === "approved") {
      // 成約時にフィルム発注管理へ自動反映する。失敗してもステータス更新は取り消さない。
      try {
        await syncFilmOrdersFromQuotations(user.email);
      } catch {
        console.error("[film-orders] sync after approval failed");
      }
    }
    return NextResponse.json({ record });
  } catch {
    return NextResponse.json({ error: "quotation_update_failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const existing = await getQuotation(Number(id));
    if (!existing) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    if (!canManageQuotation(user, existing.createdBy.id)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (await filmOrderExistsForQuotation(Number(id))) {
      return NextResponse.json({ error: "film_order_exists" }, { status: 409 });
    }
    const deleted = await deleteQuotation(Number(id));
    if (!deleted) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: "quotation_delete_failed" }, { status: 500 });
  }
}

function canManageQuotation(user: AuthenticatedUser, creatorId: number): boolean {
  return user.role === "admin" || user.id === creatorId;
}
