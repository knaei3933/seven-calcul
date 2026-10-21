import { NextResponse } from "next/server";
import { listCustomers, saveCustomer, validateCustomerInput } from "@/lib/customer-store";
import { getSessionUser } from "@/lib/api-auth";
import { customerOwnerDomainOf } from "@/lib/film-order-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const url = new URL(request.url);
  try {
    const customers = await listCustomers(
      url.searchParams.get("q") ?? "",
      Number(url.searchParams.get("limit") ?? 500),
      customerOwnerDomainOf(user.email),
    );
    return NextResponse.json({ customers });
  } catch {
    return NextResponse.json({ error: "customer_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const input = validateCustomerInput(await request.json());
    if (!input) return NextResponse.json({ error: "invalid_customer" }, { status: 400 });
    return NextResponse.json({
      customer: await saveCustomer(customerOwnerDomainOf(user.email), input),
    }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "customer_save_failed" }, { status: 500 });
  }
}
