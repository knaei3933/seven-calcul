import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import {
  createGravureKMasterRow,
  GravureDurableDatabaseRequiredError,
  GravureInfrastructureError,
  GravureOverlapError,
  GravureValidationError,
  listGravureKMasterRows,
  validateGravureKMasterInput,
} from "@/lib/gravure-price-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json({ parameterSets: await listGravureKMasterRows() });
  } catch (error) {
    if (error instanceof GravureDurableDatabaseRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "gravure_k_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const input = validateGravureKMasterInput(await request.json());
    const parameterSet = await createGravureKMasterRow(input, user.email);
    return NextResponse.json({ parameterSet }, { status: 201 });
  } catch (error) {
    if (error instanceof GravureDurableDatabaseRequiredError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (error instanceof GravureOverlapError) return NextResponse.json({ error: "gravure_k_overlap" }, { status: 409 });
    if (error instanceof GravureValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof GravureInfrastructureError) return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 503 });
    return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 500 });
  }
}
