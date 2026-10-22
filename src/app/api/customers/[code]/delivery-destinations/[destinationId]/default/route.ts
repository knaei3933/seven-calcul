import { NextResponse } from "next/server";
import { setDefaultDeliveryDestination } from "@/lib/customer-store";
import { getSessionUser } from "@/lib/api-auth";
import { customerOwnerDomainOf } from "@/lib/film-order-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string; destinationId: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const { code, destinationId } = await context.params;
  try {
    const destination = await setDefaultDeliveryDestination(
      customerOwnerDomainOf(user.email),
      decodeURIComponent(code),
      Number(destinationId),
    );
    if (!destination) return NextResponse.json({ error: "delivery_destination_not_found" }, { status: 404 });
    return NextResponse.json({ destination });
  } catch {
    return NextResponse.json({ error: "delivery_destination_update_failed" }, { status: 500 });
  }
}
