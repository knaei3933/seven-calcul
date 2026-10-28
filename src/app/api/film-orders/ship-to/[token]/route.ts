import { NextResponse } from "next/server";
import {
  getFilmOrderForShipToRequest,
  registerShipToFromCustomerToken,
} from "@/lib/film-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string }> };

function errorStatus(message: string): number {
  if (message === "invalid_ship_to_token") return 403;
  if (message === "ship_to_already_confirmed") return 409;
  if (message === "delivery_destination_not_found") return 404;
  if (message === "invalid_ship_to") return 400;
  return 502;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const requestView = await getFilmOrderForShipToRequest(token, request);
    return NextResponse.json(requestView);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ship_to_request_load_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  const { token } = await context.params;
  try {
    const body = await request.json() as {
      destinationId?: unknown;
      values?: unknown;
      saveAsDefault?: unknown;
    };
    const { destination } = await registerShipToFromCustomerToken({
      token,
      destinationId: body.destinationId,
      values: body.values,
      saveAsDefault: body.saveAsDefault === true,
      request,
    });
    return NextResponse.json({
      saved: true,
      status: "registered",
      destination: {
        id: destination.id,
        label: destination.label,
        companyName: destination.companyName,
        postalCode: destination.postalCode,
        address: destination.address,
        building: destination.building,
        phone: destination.phone,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ship_to_save_failed";
    return NextResponse.json({ error: message }, { status: errorStatus(message) });
  }
}
