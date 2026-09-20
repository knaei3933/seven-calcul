import { NextResponse } from "next/server";
import {
  createChecklistsForQuotation,
  listQuotations,
  QuotationOwnershipConflictError,
  saveQuotation,
  validateQuotationInput,
} from "@/lib/quotation-store";
import { readCalculationChecklistSnapshot, type CalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import { calculatePouchCost, type CalculationInput, type CostResult } from "@/lib/calculation";
import { isCalculationRequest } from "@/lib/calculation-provenance";
import { D } from "@/lib/decimal";
import { activeMaterialWidthMm, type PurchaseOrderSnapshot } from "@/lib/purchase-order";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
import { getSessionUser } from "@/lib/api-auth";
import { getQuotationByNumber } from "@/lib/quotation-store";
import type { AuthenticatedUser } from "@/lib/auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function decimalEquals(left: unknown, right: unknown): boolean {
  try {
    return D(String(left)).eq(D(String(right)));
  } catch (error) {
    return false;
  }
}

function hasMeaningfulFilmTotal(value: unknown): boolean {
  try {
    return typeof value === "string" && D(value).gt(0);
  } catch (error) {
    return false;
  }
}

function hasCalculationArtifacts(input: QuotationRecordInput): boolean {
  return input.calculationVersion === "simulator-linked"
    || input.payload.calculationRequest != null
    || input.payload.calculationChecklistSnapshot != null
    || input.payload.purchaseOrder != null
    || hasMeaningfulFilmTotal(input.payload.calculationFilmTotal);
}

function hasValidChecklist(snapshot: CalculationChecklistSnapshot, resultHash: string): boolean {
  return snapshot.sourceHash === resultHash && snapshot.resultHash === resultHash;
}

function hasValidPurchaseOrder(
  order: PurchaseOrderSnapshot,
  result: CostResult,
  request: CalculationInput,
): boolean {
  const activeWidthMm = activeMaterialWidthMm(result);
  if (activeWidthMm == null || !decimalEquals(order.webWidthMm, activeWidthMm)) return false;
  if (order.printingMethod !== result.printingMethod) return false;
  if (!decimalEquals(order.pouchQuantity, result.quantity)) return false;
  if (!decimalEquals(order.requiredLengthM, result.film.requiredLengthM)) return false;
  if (!decimalEquals(order.orderLengthM, result.film.orderLengthM)) return false;
  if (!decimalEquals(order.effectiveLengthM, result.film.effectiveLengthM)) return false;

  const resultSkus = result.film.skuCosts;
  if (resultSkus.length > 0) {
    if (order.skuOrderDetails.length !== resultSkus.length) return false;
    return order.skuOrderDetails.every((sku, index) => {
      const expected = resultSkus[index];
      return decimalEquals(sku.quantity, expected.quantity)
        && decimalEquals(sku.orderLengthM, expected.orderLengthM)
        && decimalEquals(sku.webWidthMm, expected.webWidthMm);
    });
  }

	  const selectedCandidate = result.recommendationCandidates
	    ?.find((candidate) => candidate.id === result.selectedCandidateId);
	  const adjustedQuantities = selectedCandidate?.adjustedSkuQuantities
	    ?? request.spec.skuQuantities
	    ?? Array.from({ length: request.spec.skuCount }, () => request.quantity);
	  if (order.skuOrderDetails.length !== adjustedQuantities.length) return false;
	  const productionPatternLengthM = request.gravureParameters?.productionPatternLengthM;
	  const totalQuantity = adjustedQuantities.reduce((total, value) => total.plus(D(value)), D(0));
	  return order.skuOrderDetails.every((sku, index) => {
	    const quantity = D(adjustedQuantities[index]);
	    const allocatedOrderLength = selectedCandidate?.route === "Y" && selectedCandidate.sasche?.skuOutputLengthsM?.[index]
	      ? D(selectedCandidate.sasche.skuOutputLengthsM[index])
	      : selectedCandidate?.route === "K" && selectedCandidate.skuPatternCounts?.[index]
	        ? D(selectedCandidate.skuPatternCounts[index]).times(D(productionPatternLengthM ?? "5500"))
	        : totalQuantity.gt(0)
	          ? D(result.film.orderLengthM).times(quantity.div(totalQuantity))
	          : D(result.film.orderLengthM);
	    return decimalEquals(sku.quantity, quantity)
	      && decimalEquals(sku.orderLengthM, allocatedOrderLength)
      && decimalEquals(sku.webWidthMm, activeWidthMm);
  });
}

function hasValidSimulatorProvenance(input: QuotationRecordInput | null): boolean {
  if (!input) return false;
  const requiresProvenance = Boolean(input.resultHash.trim()) || hasCalculationArtifacts(input);
  if (!requiresProvenance) return true;

  const request = input.payload.calculationRequest;
  const basis = input.payload;
  const snapshot = readCalculationChecklistSnapshot(basis.calculationChecklistSnapshot);
  const purchaseOrder = basis.purchaseOrder as PurchaseOrderSnapshot | undefined;
  if (!input.resultHash.trim()
    || basis.resultHash !== input.resultHash
    || !isCalculationRequest(request)
    || !snapshot
    || !purchaseOrder
    || typeof basis.printingMethod !== "string"
    || typeof basis.quantity !== "string"
    || typeof basis.filmOrderLengthM !== "string"
    || typeof basis.calculationFilmTotal !== "string") return false;

  try {
    const result = calculatePouchCost(request);
    return input.resultHash === result.audit.resultJsonSha256
      && hasValidChecklist(snapshot, result.audit.resultJsonSha256)
      && hasValidPurchaseOrder(purchaseOrder, result, request)
      && basis.printingMethod === result.printingMethod
      && decimalEquals(basis.quantity, result.quantity)
      && decimalEquals(basis.filmOrderLengthM, result.film.orderLengthM)
      && decimalEquals(basis.calculationFilmTotal, result.film.filmTotal);
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  const url = new URL(request.url);
  try {
    const records = await listQuotations({
      q: url.searchParams.get("q") ?? "",
      status: url.searchParams.get("status") ?? "all",
      limit: Number(url.searchParams.get("limit") ?? 100),
      creatorId: url.searchParams.has("creatorId") ? Number(url.searchParams.get("creatorId")) : undefined,
    });
    return NextResponse.json({ records });
  } catch {
    return NextResponse.json({ error: "quotation_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const input = validateQuotationInput(await request.json());
    if (!input) return NextResponse.json({ error: "invalid_quotation" }, { status: 400 });
    const existing = await getQuotationByNumber(input.quotationNumber);
    if (existing && !canManageQuotation(user, existing.createdBy.id)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (!hasValidSimulatorProvenance(input)) {
      return NextResponse.json({ error: "calculation_provenance_invalid" }, { status: 400 });
    }
    const record = await saveQuotation(input, user.id, user.role);
    const snapshot = readCalculationChecklistSnapshot(input.payload.calculationChecklistSnapshot);
    if (snapshot) {
      await createChecklistsForQuotation(record, snapshot);
    }
    return NextResponse.json({ record }, { status: 201 });
  } catch (error) {
    if (error instanceof QuotationOwnershipConflictError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json({ error: "quotation_save_failed" }, { status: 500 });
  }
}

function canManageQuotation(user: AuthenticatedUser, creatorId: number): boolean {
  return user.role === "admin" || user.id === creatorId;
}
