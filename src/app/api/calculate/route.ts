import { NextResponse } from "next/server";
import { calculatePouchCost } from "@/lib/calculation";
import { QuotationValidationError } from "@/lib/digital-film";
import { getSessionUser } from "@/lib/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const input = await request.json();
    if (!input?.spec || !input?.quantity || !input?.printingMethod) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const result = calculatePouchCost(input);
    const originalResult = input.selectedCandidateId
      ? calculatePouchCost({ ...input, selectedCandidateId: "" })
      : result;
    return NextResponse.json({ result, originalResult, candidates: result.recommendationCandidates ?? [] });
  } catch (error) {
    if (error instanceof QuotationValidationError) {
      return NextResponse.json({ error: error.code, digitalValidation: error.digitalValidation }, { status: 400 });
    }
    const code = error instanceof Error ? error.message : "calculation_failed";
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
