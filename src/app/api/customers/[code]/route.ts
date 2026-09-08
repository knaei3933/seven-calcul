import { NextResponse } from "next/server";
import { getCustomer } from "@/lib/customer-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const { code } = await context.params;
  try {
    const customer = await getCustomer(decodeURIComponent(code));
    if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
    return NextResponse.json({ customer });
  } catch {
    return NextResponse.json({ error: "customer_get_failed" }, { status: 500 });
  }
}
