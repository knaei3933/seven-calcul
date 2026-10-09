import { NextResponse } from "next/server";
import { calculatePouchCost } from "@/lib/calculation";
import { QuotationValidationError } from "@/lib/digital-film";
import { getSessionUser } from "@/lib/api-auth";
import { resolveFilmUnitPrices } from "@/lib/film-price-store";
import { defaultParameters } from "@/lib/constants";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const input = await request.json();
    // 필름 단가 마스터의 오늘 적용행을 조회해 클라이언트가 지정하지 않은 경우 주입.
    if (!input.parameters?.filmUnitPrices) {
      const today = new Date().toISOString().slice(0, 10);
      const filmUnitPrices = await resolveFilmUnitPrices(today, defaultParameters.filmUnitPrices);
      if (input.parameters) input.parameters.filmUnitPrices = filmUnitPrices;
      else input.parameters = { filmUnitPrices };
    }
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
