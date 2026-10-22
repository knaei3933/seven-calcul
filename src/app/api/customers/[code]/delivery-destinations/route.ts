import { NextResponse } from "next/server";
import {
  listDeliveryDestinations,
  upsertDeliveryDestination,
  validateDeliveryDestinationInput,
} from "@/lib/customer-store";
import { getSessionUser } from "@/lib/api-auth";
import { customerOwnerDomainOf } from "@/lib/film-order-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

function errorStatus(message: string): number {
  if (message === "customer_not_found") return 404;
  if (message === "customer_code_required") return 400;
  return 500;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { code } = await context.params;
  try {
    const destinations = await listDeliveryDestinations(
      customerOwnerDomainOf(user.email),
      decodeURIComponent(code),
    );
    return NextResponse.json({ destinations });
  } catch {
    return NextResponse.json({ error: "delivery_destinations_load_failed" }, { status: 500 });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { code } = await context.params;
  try {
    const input = validateDeliveryDestinationInput(await request.json());
    if (!input) return NextResponse.json({ error: "invalid_delivery_destination" }, { status: 400 });
    const destination = await upsertDeliveryDestination(
      customerOwnerDomainOf(user.email),
      decodeURIComponent(code),
      input,
    );
    return NextResponse.json({ destination, saved: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "delivery_destination_save_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
