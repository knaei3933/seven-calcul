import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import {
  createGravureYMasterRow,
  GravureDurableDatabaseRequiredError,
  GravureInfrastructureError,
  GravureOverlapError,
  GravureValidationError,
  listGravureYMasterRows,
  validateGravureYMasterInput,
} from "@/lib/gravure-price-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json({ prices: await listGravureYMasterRows() });
  } catch (error) {
    if (error instanceof GravureDurableDatabaseRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "gravure_y_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const input = validateGravureYMasterInput(await request.json());
    const price = await createGravureYMasterRow(input, user.email);
    return NextResponse.json({ price }, { status: 201 });
  } catch (error) {
    if (error instanceof GravureDurableDatabaseRequiredError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (error instanceof GravureOverlapError) return NextResponse.json({ error: "gravure_y_overlap" }, { status: 409 });
    if (error instanceof GravureValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof GravureInfrastructureError) return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 503 });
    return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 500 });
  }
}
