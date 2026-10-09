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
import { defaultParameters } from "@/lib/constants";
import { defaultGravureRollParameters, GRAVURE_ROLL_COPPER_PLATE_MINIMUM_YEN } from "@/lib/gravure-roll";
import { candidateSkuOrderLengthM } from "@/lib/print-recommendation";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
import { getSessionUser } from "@/lib/api-auth";
import { getQuotationByNumber } from "@/lib/quotation-store";
import type { AuthenticatedUser } from "@/lib/auth-store";
import { buildFilmQuotationFromRecord } from "@/lib/film-quotation";

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

function hasValidChecklist(
  snapshot: CalculationChecklistSnapshot,
  result: CostResult,
  request: CalculationInput,
): boolean {
  const expectedParameters = { ...defaultParameters, ...request.parameters };
  const expectedGravureParameters = request.gravureParameters ?? defaultGravureRollParameters();
  const expectedSkuCount = result.film.skuCosts.length > 0
    ? result.film.skuCosts.length
    : request.spec.skuQuantities?.length ?? request.spec.skuCount;
  return snapshot.sourceHash === result.audit.resultJsonSha256
    && snapshot.resultHash === result.audit.resultJsonSha256
    && decimalEquals(snapshot.quantity, result.quantity)
    && decimalEquals(snapshot.film.filmBaseCost, result.film.filmBaseCost)
    && decimalEquals(snapshot.film.filmTotal, result.film.filmTotal)
    && decimalEquals(snapshot.film.unitPrice, result.film.unitPrice)
    && decimalEquals(snapshot.film.lossM, result.film.lossM)
    && decimalEquals(snapshot.film.effectiveLengthM, result.film.effectiveLengthM)
    && decimalEquals(snapshot.film.shippingTrips, result.film.shippingTrips)
    && decimalEquals(snapshot.film.domesticShipping, result.film.domesticShipping)
    && decimalEquals(snapshot.film.overseasShipping, result.film.overseasShipping)
    && decimalEquals(snapshot.film.customs, result.film.customs)
    && decimalEquals(snapshot.bulkCost, result.bulkCost)
    && decimalEquals(snapshot.variableProcessingTotal, result.variableProcessingTotal)
    && decimalEquals(snapshot.fixedLotCost, result.fixedLotCost)
    && decimalEquals(snapshot.customCharge, result.customCharge)
    && decimalEquals(snapshot.costTotal, result.costTotal)
    && decimalEquals(snapshot.totalCostPerPiece, result.totalCostPerPiece)
    && snapshot.sellingPrices.length === result.sellingPrices.length
    && snapshot.sellingPrices.every((price, index) => {
      const expectedPrice = result.sellingPrices[index];
      return decimalEquals(price.margin, expectedPrice.margin)
        && decimalEquals(price.pricePerPiece, expectedPrice.pricePerPiece)
        && decimalEquals(price.totalSales, expectedPrice.totalSales)
        && decimalEquals(price.profit, expectedPrice.profit);
    })
    && decimalEquals(snapshot.parameters.lossRate, expectedParameters.lossRate)
    && decimalEquals(snapshot.parameters.lossMinM, expectedParameters.lossMinM)
    && decimalEquals(snapshot.parameters.domesticShippingPerTrip, expectedParameters.domesticShippingPerTrip)
    && decimalEquals(snapshot.parameters.overseasShippingPerTrip, expectedParameters.overseasShippingPerTrip)
    && decimalEquals(snapshot.parameters.customsThreshold, expectedParameters.customsThreshold)
    && decimalEquals(snapshot.parameters.customsHighCharge, expectedParameters.customsHighCharge)
    && decimalEquals(snapshot.parameters.customsPerTrip, expectedParameters.customsPerTrip)
    && (!snapshot.gravure || (
      decimalEquals(snapshot.gravure.copperPlateCostYen, result.gravure?.copperPlateCostYen ?? "0")
      && snapshot.gravure.copperPlateCount === result.gravure?.copperPlateCount
      && decimalEquals(snapshot.gravure.copperPlateUnitPriceYen, result.gravure?.copperPlateUnitPriceYen ?? "0")
    ))
    && (!snapshot.gravureParameters || Object.entries(expectedGravureParameters).every(([key, value]) => (
      decimalEquals(snapshot.gravureParameters?.[key as keyof typeof snapshot.gravureParameters], value)
    )))
    && (snapshot.skus?.length ?? 0) === expectedSkuCount
    && (snapshot.skus ?? []).every((sku, index) => {
      const expected = result.film.skuCosts[index];
      return !expected
        || decimalEquals(sku.quantity, expected.quantity)
        && decimalEquals(sku.orderLengthM, expected.orderLengthM)
        && decimalEquals(sku.unitPriceYen ?? result.film.unitPrice, expected.unitPriceYen);
    });
}

function hasValidPurchaseOrder(
  order: PurchaseOrderSnapshot,
  result: CostResult,
  request: CalculationInput,
): boolean {
  const activeWidthMm = activeMaterialWidthMm(result);
  if (activeWidthMm == null || !decimalEquals(order.webWidthMm, activeWidthMm)) return false;
  if (order.filmCostYen === undefined || !decimalEquals(order.filmCostYen, result.film.filmTotal)) return false;
  const expectedWidths = result.film.skuCosts.length > 0
    ? result.film.skuCosts.map((sku) => sku.webWidthMm)
    : activeWidthMm == null ? [] : [activeWidthMm];
  if (
    !Array.isArray(order.webWidthsMm)
    || order.webWidthsMm.length !== expectedWidths.length
    || order.webWidthsMm.some((width, index) => !decimalEquals(width, expectedWidths[index]))
  ) return false;
  const expectedRoute = result.sasche ? "Y" : result.gravure ? "K" : undefined;
  if (order.procurementRoute !== expectedRoute) return false;
  if (order.printingMethod !== result.printingMethod) return false;
  if (!decimalEquals(order.pouchQuantity, result.quantity)) return false;
  if (!decimalEquals(order.requiredLengthM, result.film.requiredLengthM)) return false;
  if (!decimalEquals(order.orderLengthM, result.film.orderLengthM)) return false;
  if (!decimalEquals(order.effectiveLengthM, result.film.effectiveLengthM)) return false;
  if (!decimalEquals(order.lossM, result.film.lossM)) return false;
  if (!decimalEquals(order.gravureLossM ?? result.film.lossM, result.film.lossM)) return false;
  const expectedSkuOrderLengths = result.sasche?.skuOutputLengthsM;
  if (
    (expectedSkuOrderLengths == null && order.skuOrderLengthsM !== undefined)
    || (expectedSkuOrderLengths != null && (
      order.skuOrderLengthsM?.length !== expectedSkuOrderLengths.length
      || order.skuOrderLengthsM.some((length, index) => !decimalEquals(length, expectedSkuOrderLengths[index]))
    ))
  ) return false;
  if (result.gravure && result.gravure.copperPlateCount > 0) {
    const gravureParameters = request.gravureParameters ?? defaultGravureRollParameters();
    const expectedPlateWidthMm = D(result.gravure.materialWidthMm).plus(gravureParameters.copperPlateWidthExtraMm);
    const expectedPlateDiameterCm = D(gravureParameters.copperPlateMinimumDiameterMm).div(10);
    if (
      !order.copperPlate
      || order.copperPlate.quantity !== result.gravure.copperPlateCount
      || !decimalEquals(order.copperPlate.unitPriceYen, result.gravure.copperPlateUnitPriceYen)
      || !decimalEquals(order.copperPlate.priceYen, result.gravure.copperPlateCostYen)
      || !decimalEquals(order.copperPlate.plateWidthMm, expectedPlateWidthMm)
      || !decimalEquals(order.copperPlate.diameterMm, expectedPlateDiameterCm)
      || !decimalEquals(order.copperPlate.minimumPriceYen, GRAVURE_ROLL_COPPER_PLATE_MINIMUM_YEN)
    ) return false;
  }
  if (D(result.customCharge).gt(0)) {
    if (
      !order.customMold
      || !decimalEquals(order.customMold.costYen, result.customCharge)
      || !D(order.customMold.quantity).gt(0)
    ) return false;
  }


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
  const totalQuantity = adjustedQuantities.reduce((total, value) => total.plus(D(value)), D(0));
  return order.skuOrderDetails.every((sku, index) => {
    const quantity = D(adjustedQuantities[index]);
    const allocatedOrderLength = selectedCandidate
      ? D(candidateSkuOrderLengthM(selectedCandidate, index, result.film.orderLengthM))
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
      && hasValidChecklist(snapshot, result, request)
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
    // 発行には顧客の必須情報（会社名・郵便番号・電話番号・住所）が必要。
    const payload = input.payload as Record<string, unknown>;
    const missingIssueFields = [
      !input.customerName.trim() && "customerName",
      !(typeof payload.customerPostalCode === "string" && payload.customerPostalCode.trim()) && "customerPostalCode",
      !(typeof payload.customerTelephone === "string" && payload.customerTelephone.trim()) && "customerTelephone",
      !(typeof payload.customerAddress === "string" && payload.customerAddress.trim()) && "customerAddress",
    ].filter(Boolean) as string[];
    if (missingIssueFields.length > 0) {
      return NextResponse.json({ error: "issue_fields_required", missing: missingIssueFields }, { status: 400 });
    }
    // 발행 시 金井貿易→セブン化學 필름 견적서를 자동 생성해 payload에 포함
    const filmQuotation = buildFilmQuotationFromRecord({
      quotationNumber: input.quotationNumber,
      issueDate: input.issueDate,
      validUntil: input.validUntil,
      productName: input.productName,
      quantity: input.quantity,
      payload: input.payload,
    });
    if (filmQuotation) {
      input.payload = { ...input.payload, filmQuotation };
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
