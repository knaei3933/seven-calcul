import { NextResponse } from "next/server";
import { calculatePouchCost } from "@/lib/calculation";
import { QuotationValidationError } from "@/lib/digital-film";
import { getSessionUser } from "@/lib/api-auth";
import { resolveFilmUnitPrices } from "@/lib/film-price-store";
import { defaultParameters, GRAVURE_MASTER_CALCULATION_VERSION } from "@/lib/constants";
import {
  assertDurableGravureDatabase,
  buildPublicProjection,
  GravureDurableDatabaseRequiredError,
  GravureInfrastructureError,
  GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR,
  isGravureSnapshotIssuanceEnabled,
  resolveGravureMasters,
  saveGravureSnapshot,
  sha256Canonical,
  tokyoDate,
  type ReturnedPublicProjection,
  type SnapshotPublicMetadata,
} from "@/lib/gravure-price-store";
import { GravureValidationError } from "@/lib/gravure-price-store";

export const runtime = "nodejs";

function isGravureCalculation(input: Record<string, unknown>): boolean {
  if (input.printingMethod === "gravure") return true;
  // An empty digital recommendation request remains on the legacy digital
  // path. Once a Y/K candidate has actually been selected, server snapshot
  // authority is required even though the simulator's input basis is digital.
  const selectedCandidateId = input.selectedCandidateId;
  return input.recommendationMode === true
    && typeof selectedCandidateId === "string"
    && /^(?:Y|K)-/.test(selectedCandidateId);
}

function rejectClientPricingAuthority(input: Record<string, unknown>): void {
  const forbidden = ["gravureYRows", "ySupplierRows", "pricingSnapshot", "publicProjectionHash", "pricingSnapshotSha256", "fullAugmentedCalculationRequest"];
  if (forbidden.some((field) => Object.hasOwn(input, field))) {
    throw new GravureValidationError("client_pricing_authority_rejected");
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  let gravureRequest = false;
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const input = (await request.json()) as Record<string, unknown>;
    if (!input?.spec || !input?.quantity || !input?.printingMethod) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    gravureRequest = isGravureCalculation(input);
    if (gravureRequest) {
      if (!isGravureSnapshotIssuanceEnabled()) throw new Error(GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR);
      // Y/K are durable production data. Unlike legacy digital pricing, they
      // must never fall back to per-instance SQLite in production.
      assertDurableGravureDatabase();
    }

    // Digital remains the legacy UTC contract; explicit simulator values win.
    let digitalValues = (input.parameters as { filmUnitPrices?: typeof defaultParameters.filmUnitPrices } | undefined)?.filmUnitPrices;
    if (!digitalValues) {
      const today = new Date().toISOString().slice(0, 10);
      digitalValues = await resolveFilmUnitPrices(today, defaultParameters.filmUnitPrices);
      const parameters = (input.parameters ?? {}) as Record<string, unknown>;
      parameters.filmUnitPrices = digitalValues;
      input.parameters = parameters;
    }

    if (!gravureRequest) {
      const result = calculatePouchCost(input as never);
      const originalResult = input.selectedCandidateId
        ? calculatePouchCost({ ...(input as object), selectedCandidateId: "" } as never)
        : result;
      return NextResponse.json({ result, originalResult, candidates: result.recommendationCandidates ?? [] });
    }

    const asOf = tokyoDate();
    rejectClientPricingAuthority(input);
    const resolved = await resolveGravureMasters(asOf);
    const parameters = (input.parameters ?? {}) as Record<string, unknown>;
    // Simulator K inputs are superseded by the one active source set. With no
    // active set, the exact current derived defaults remain the fallback.
    const { defaultGravureRollParameters } = await import("@/lib/gravure-roll");
    input.gravureParameters = resolved.kSet?.derived ?? defaultGravureRollParameters();
    input.gravureYRows = resolved.yRows;
    input.parameters = parameters;

    const augmentedRequest = structuredClone(input);
    const result = calculatePouchCost(augmentedRequest as never);
    const originalResult = input.selectedCandidateId
      ? calculatePouchCost({ ...augmentedRequest, selectedCandidateId: "" } as never)
      : result;
    const snapshot = await saveGravureSnapshot({
      asOf,
      digitalValues,
      resolved,
      request: augmentedRequest as never,
      result,
      createdBy: user.email,
    });
    const metadata: SnapshotPublicMetadata = {
      id: snapshot.id,
      sha256: snapshot.snapshotSha256,
      resolverVersion: snapshot.resolverVersion,
      asOf: snapshot.asOf,
      view: "redacted",
    };
    const publicProjection = snapshot.canonicalPublicProjection;
    const returnedProjection: ReturnedPublicProjection = {
      ...publicProjection,
      publicProjectionHash: sha256Canonical(publicProjection),
    };
    if (publicProjection.pricingSnapshot.sha256 !== snapshot.snapshotSha256
      || returnedProjection.publicProjectionHash !== snapshot.publicProjectionSha256
      || result.audit.calculationVersion !== GRAVURE_MASTER_CALCULATION_VERSION) {
      return NextResponse.json({ error: "pricing_snapshot_invalid" }, { status: 500 });
    }

    // Product decision: every signed-in simulator user follows the same full
    // result flow. The snapshot and returned projection remain authoritative
    // for issuance, but candidate selection no longer branches by account.
    return NextResponse.json({
      result,
      originalResult,
      candidates: result.recommendationCandidates ?? [],
      calculationRequest: snapshot.fullAugmentedCalculationRequest,
      pricingSnapshot: metadata,
      returnedProjection,
    });
  } catch (error) {
    if (error instanceof GravureDurableDatabaseRequiredError) {
      return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 503 });
    }
    if (error instanceof GravureValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof GravureInfrastructureError) {
      return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 503 });
    }
    if (gravureRequest && error instanceof Error && error.message === GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (gravureRequest && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection|terminate|database/i.test(error instanceof Error ? error.message : String(error))) {
      return NextResponse.json({ error: "gravure_master_unavailable" }, { status: 503 });
    }
    if (error instanceof QuotationValidationError) {
      return NextResponse.json({ error: error.code, digitalValidation: error.digitalValidation }, { status: 400 });
    }
    const code = error instanceof Error ? error.message : "calculation_failed";
    // Gravure failures are deliberately generic so master source values and
    // snapshot internals cannot leak through validation/error paths.
    if (gravureRequest) return NextResponse.json({ error: "gravure_calculation_invalid" }, { status: 400 });
    return NextResponse.json({ error: code }, { status: 400 });
  }
}
