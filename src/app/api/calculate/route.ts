import { NextResponse } from "next/server";
import { calculatePouchCost } from "@/lib/calculation";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = await request.json();
    if (!input?.spec || !input?.quantity || !input?.printingMethod) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    return NextResponse.json({ result: calculatePouchCost(input) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "calculation_failed";
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
