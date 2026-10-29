import { NextResponse } from "next/server";
import { generateNextCustomerCode } from "@/lib/customer-store";
import { getSessionUser } from "@/lib/api-auth";
import { customerOwnerDomainOf } from "@/lib/film-order-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  try {
    return NextResponse.json({
      customerCode: await generateNextCustomerCode(customerOwnerDomainOf(user.email)),
    });
  } catch {
    return NextResponse.json({ error: "customer_code_generation_failed" }, { status: 500 });
  }
}
