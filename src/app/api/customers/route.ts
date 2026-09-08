import { NextResponse } from "next/server";
import { listCustomers, saveCustomer, validateCustomerInput } from "@/lib/customer-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  try {
    const customers = await listCustomers(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 100));
    return NextResponse.json({ customers });
  } catch {
    return NextResponse.json({ error: "customer_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = validateCustomerInput(await request.json());
    if (!input) return NextResponse.json({ error: "invalid_customer" }, { status: 400 });
    return NextResponse.json({ customer: await saveCustomer(input) }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "customer_save_failed" }, { status: 500 });
  }
}
