import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { canViewFilmOrders } from "@/lib/film-order-access";
import { listFilmOrderIntakePage } from "@/lib/film-order-intake";
import { syncFilmOrdersFromQuotations } from "@/lib/film-orders";
import { parseIntakeQuery } from "./query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" && !canViewFilmOrders(user.email)) {
    return NextResponse.json({ error: "data_intake_forbidden" }, { status: 403 });
  }

  try {
    const query = parseIntakeQuery(new URL(request.url));
    if (!query) return NextResponse.json({ error: "invalid_data_intake_query" }, { status: 400 });
    const created = await syncFilmOrdersFromQuotations(user.email);
    const result = await listFilmOrderIntakePage(query, user);
    return NextResponse.json({ created, ...result });
  } catch {
    return NextResponse.json({ error: "data_intake_list_failed" }, { status: 500 });
  }
}
