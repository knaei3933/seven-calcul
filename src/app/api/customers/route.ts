import { NextResponse } from "next/server";
import { getCustomer, listCustomers, saveCustomer, validateCustomerInput } from "@/lib/customer-store";
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
      user.email,
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
    const submitted = await request.json() as Record<string, unknown> | null;
    const createOnly = submitted?.mode === "create";
    const input = validateCustomerInput(submitted);
    if (!input) return NextResponse.json({ error: "invalid_customer" }, { status: 400 });
    const owner = customerOwnerDomainOf(user.email);
    if (createOnly && await getCustomer(owner, input.customerCode)) {
      return NextResponse.json({ error: "customer_code_already_used" }, { status: 409 });
    }
    return NextResponse.json({
      customer: await saveCustomer(owner, input),
    }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "customer_save_failed" }, { status: 500 });
  }
}
