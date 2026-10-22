import { NextResponse } from "next/server";
import { recordCustomerSelection } from "@/lib/customer-store";
import { getSessionUser } from "@/lib/api-auth";
import { customerOwnerDomainOf } from "@/lib/film-order-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { code } = await context.params;
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  try {
    const recorded = await recordCustomerSelection(
      customerOwnerDomainOf(user.email),
      user.email,
      decodeURIComponent(code),
    );
    if (!recorded) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
    return NextResponse.json({ recorded: true });
  } catch {
    return NextResponse.json({ error: "customer_selection_failed" }, { status: 500 });
  }
}
