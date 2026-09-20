import { NextResponse } from "next/server";
import { getCustomer } from "@/lib/customer-store";
import { getSessionUser } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { code } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  try {
    const customer = await getCustomer(decodeURIComponent(code));
    if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
    return NextResponse.json({ customer });
  } catch {
    return NextResponse.json({ error: "customer_get_failed" }, { status: 500 });
  }
}
