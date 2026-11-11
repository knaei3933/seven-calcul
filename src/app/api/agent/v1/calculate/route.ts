import { calculatePouchCost } from "@/lib/calculation";
import { QuotationValidationError } from "@/lib/digital-film";
import { defaultParameters, CALCULATION_VERSION, GRAVURE_MASTER_CALCULATION_VERSION } from "@/lib/constants";
import {
  AgentAuthError,
  withAgentApi,
} from "@/lib/agent-auth-store";
import {
  buildAgentCustomerSafeProjection,
  buildAgentInternalProjection,
} from "@/lib/agent-projections";
import {
  assertDurableGravureDatabase,
  GravureDurableDatabaseRequiredError,
  GravureInfrastructureError,
  GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR,
  isGravureSnapshotIssuanceEnabled,
  resolveGravureMasters,
  saveGravureSnapshot,
  sha256Canonical,
  tokyoDate,
  GravureValidationError,
  type SnapshotPublicMetadata,
} from "@/lib/gravure-price-store";
import { resolveFilmUnitPrices } from "@/lib/film-price-store";
import { getSizeMaster } from "@/lib/calculation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isGravureCalculation(input: Record<string, unknown>): boolean {
  if (input.printingMethod === "gravure") return true;
  // This boundary intentionally mirrors /api/calculate: a selected Y/K
  // candidate requires durable snapshot authority even after the input basis
  // has returned to digital.
  const selectedCandidateId = input.selectedCandidateId;
  return input.recommendationMode === true
    && typeof selectedCandidateId === "string"
    && /^(?:Y|K)-/.test(selectedCandidateId);
}

function rejectClientPricingAuthority(input: Record<string, unknown>): void {
  const forbidden = [
    "gravureYRows",
    "ySupplierRows",
    "pricingSnapshot",
    "publicProjectionHash",
    "pricingSnapshotSha256",
    "fullAugmentedCalculationRequest",
  ];
  if (forbidden.some((field) => Object.hasOwn(input, field))) {
    throw new GravureValidationError("client_pricing_authority_rejected");
  }
}

function blocked(status: number, reason: string): never {
  throw new AgentAuthError(status, reason);
}

function assertCalculationFresh(
  calculationVersion: string,
  gravureRequest: boolean,
): void {
  const expected = gravureRequest
    ? GRAVURE_MASTER_CALCULATION_VERSION
    : CALCULATION_VERSION;
  if (calculationVersion !== expected) blocked(409, "stale_calculation");
}

async function calculateWithSharedAuthority(
  request: Request,
  createdBy: string,
): Promise<unknown> {
  let gravureRequest = false;
  try {
    const input = (await request.json()) as Record<string, unknown>;
    if (!input?.spec || !input?.quantity || !input?.printingMethod) {
      blocked(400, "invalid_request");
    }
    gravureRequest = isGravureCalculation(input);
    rejectClientPricingAuthority(input);
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
      assertCalculationFresh(result.audit.calculationVersion, gravureRequest);
      if (originalResult.audit.calculationVersion !== result.audit.calculationVersion) {
        blocked(409, "stale_calculation");
      }
      const spec = input.spec as Record<string, unknown>;
      return {
        internalActor: buildAgentInternalProjection({ result, gravureRequest }),
        customerSafe: buildAgentCustomerSafeProjection({
          result,
          sizeWidthMm: String(spec.customWidthMm ?? ""),
          sizeLengthMm: String(spec.customLengthMm ?? ""),
        }),
      };
    }

    const asOf = tokyoDate();
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
      createdBy,
    });
    const metadata: SnapshotPublicMetadata = {
      id: snapshot.id,
      sha256: snapshot.snapshotSha256,
      resolverVersion: snapshot.resolverVersion,
      asOf: snapshot.asOf,
      view: "redacted",
    };
    if (publicSnapshotInvalid(snapshot, result)) {
      blocked(500, "pricing_snapshot_invalid");
    }
    assertCalculationFresh(result.audit.calculationVersion, gravureRequest);
    if (originalResult.audit.calculationVersion !== result.audit.calculationVersion) {
      blocked(409, "stale_calculation");
    }
    const spec = augmentedRequest.spec as Parameters<typeof getSizeMaster>[0];
    const size = getSizeMaster(spec);
    return {
      internalActor: buildAgentInternalProjection({ result, gravureRequest, pricingSnapshot: metadata }),
      customerSafe: buildAgentCustomerSafeProjection({
        result,
        sizeWidthMm: String(size.widthMm),
        sizeLengthMm: String(size.lengthMm),
      }),
    };
  } catch (error) {
    if (error instanceof AgentAuthError) throw error;
    if (error instanceof GravureDurableDatabaseRequiredError) {
      blocked(503, "gravure_master_unavailable");
    }
    if (error instanceof GravureValidationError) {
      blocked(400, error.message);
    }
    if (error instanceof GravureInfrastructureError) {
      blocked(503, "gravure_master_unavailable");
    }
    if (gravureRequest && error instanceof Error && error.message === GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR) {
      blocked(503, error.message);
    }
    if (gravureRequest && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection|terminate|database/i.test(error instanceof Error ? error.message : String(error))) {
      blocked(503, "gravure_master_unavailable");
    }
    if (error instanceof QuotationValidationError) {
      // The optional digital correction details are useful to the human
      // simulator but are intentionally not echoed through the agent DTO.
      blocked(400, error.code);
    }
    blocked(400, "calculation_failed");
  }
}

function publicSnapshotInvalid(
  snapshot: Awaited<ReturnType<typeof saveGravureSnapshot>>,
  result: ReturnType<typeof calculatePouchCost>,
): boolean {
  const publicProjection = snapshot.canonicalPublicProjection;
  const returnedProjectionHash = sha256Canonical(publicProjection);
  return publicProjection.pricingSnapshot.sha256 !== snapshot.snapshotSha256
    || returnedProjectionHash !== snapshot.publicProjectionSha256
    || result.audit.calculationVersion !== GRAVURE_MASTER_CALCULATION_VERSION;
}

export async function POST(request: Request): Promise<Response> {
  const outcome = await withAgentApi(
    request,
    { operation: "calculate", scope: "calculate:run" },
    async ({ auth }) => calculateWithSharedAuthority(request, auth.principalEmail),
  );
  if (outcome.response) return outcome.response;
  return Response.json(outcome.result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
