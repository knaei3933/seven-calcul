import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import {
  GravureDurableDatabaseRequiredError,
  GravureInfrastructureError,
  listGravureMasterAudit,
  listGravureSnapshotAuditRecords,
} from "@/lib/gravure-price-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const [audit, snapshots] = await Promise.all([
      listGravureMasterAudit(200),
      listGravureSnapshotAuditRecords(50),
    ]);
    return NextResponse.json({ audit, snapshots });
  } catch (error) {
    if (error instanceof GravureDurableDatabaseRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof GravureInfrastructureError) return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 503 });
    return NextResponse.json({ error: "gravure_audit_list_failed" }, { status: 500 });
  }
}
