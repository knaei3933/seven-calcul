import type { CostResult } from "@/lib/calculation";
import type { SnapshotPublicMetadata } from "@/lib/gravure-price-store";
import type { PrintCandidateRoute } from "@/lib/print-recommendation";
import { calculateAutomaticQuotation } from "@/lib/quotation-pricing";

export type AgentCandidateProjection = {
  id: string;
  route: PrintCandidateRoute;
  printingMethod: CostResult["printingMethod"];
  originalQuantity: string;
  capacityQuantity: string;
  capacityPlanningDifference: string;
  adjustedQuantity: string;
  adjustedSkuQuantities: string[];
  requiredLengthM: string;
  orderLengthM: string;
  effectiveLengthM: string;
  surplusLengthM: string;
  shortageLengthM: string;
  surplusPieces: string;
  shortagePieces: string;
  isFulfilling: boolean;
  isPractical: boolean;
  isExactQuantity: boolean;
  selectionTag: string;
  incrementalFilmTotalYen?: string;
  incrementalQuantity?: string;
  incrementalCostPerAdditionalPieceYen?: string;
  copperPlateTotalYen?: string;
  allInTotalCostYen?: string;
  allInCostPerPieceYen?: string;
  allInDeltaYen?: string;
  includedUnitPricePerM: string;
  filmTotalYen: string;
  filmCostPerPieceYen: string;
  recommended: boolean;
  toleranceExceeded: boolean;
  priceBreak: boolean;
};

export type AgentCalculationProjection = {
  calculation: {
    calculationVersion: string;
    inputHash: string;
    resultHash: string;
    digitalFilmPriceMode: CostResult["audit"]["digitalFilmPriceMode"];
    componentReconciliationDifference: string;
    authority: "digital_film_store" | "durable_gravure_snapshot";
    pricingSnapshot?: SnapshotPublicMetadata;
  };
  quantity: string;
  printingMethod: CostResult["printingMethod"];
  connectedChambers: CostResult["connectedChambers"];
  fillingMethod: CostResult["fillingMethod"];
  selectedCandidateId: string;
  selectedCandidate: AgentCandidateProjection | null;
  candidates: AgentCandidateProjection[];
  warnings: CostResult["warnings"];
  unresolvedInputFlags: CostResult["audit"]["unresolvedInputFlags"];
};

export type AgentCustomerCandidateProjection = {
  optionNumber: number;
  label: string;
  quantity: string;
  requiredLengthM: string;
  orderLengthM: string;
  effectiveLengthM: string;
};

export type AgentCustomerSafeProjection = {
  quantity: string;
  printingMethod: CostResult["printingMethod"];
  connectedChambers: CostResult["connectedChambers"];
  fillingMethod: CostResult["fillingMethod"];
  size: { widthMm: string; lengthMm: string };
  displayedUnitPrice: string;
  displayedSubtotal: string;
  displayedTax: string;
  displayedGrandTotal: string;
  candidateOptions: AgentCustomerCandidateProjection[];
};

export function buildAgentCandidateProjection(
  candidate: NonNullable<CostResult["recommendationCandidates"]>[number],
): AgentCandidateProjection {
  return {
    id: candidate.id,
    route: candidate.route,
    printingMethod: candidate.printingMethod,
    originalQuantity: candidate.originalQuantity,
    capacityQuantity: candidate.capacityQuantity,
    capacityPlanningDifference: candidate.capacityPlanningDifference,
    adjustedQuantity: candidate.adjustedQuantity,
    adjustedSkuQuantities: [...candidate.adjustedSkuQuantities],
    requiredLengthM: candidate.requiredLengthM,
    orderLengthM: candidate.orderLengthM,
    effectiveLengthM: candidate.effectiveLengthM,
    surplusLengthM: candidate.surplusLengthM,
    shortageLengthM: candidate.shortageLengthM,
    surplusPieces: candidate.surplusPieces,
    shortagePieces: candidate.shortagePieces,
    isFulfilling: candidate.isFulfilling,
    isPractical: candidate.isPractical,
    isExactQuantity: candidate.isExactQuantity,
    selectionTag: candidate.selectionTag,
    incrementalFilmTotalYen: candidate.incrementalFilmTotalYen,
    incrementalQuantity: candidate.incrementalQuantity,
    incrementalCostPerAdditionalPieceYen: candidate.incrementalCostPerAdditionalPieceYen,
    copperPlateTotalYen: candidate.copperPlateTotalYen,
    allInTotalCostYen: candidate.allInTotalCostYen,
    allInCostPerPieceYen: candidate.allInCostPerPieceYen,
    allInDeltaYen: candidate.allInDeltaYen,
    includedUnitPricePerM: candidate.includedUnitPricePerM,
    filmTotalYen: candidate.filmTotalYen,
    filmCostPerPieceYen: candidate.filmCostPerPieceYen,
    recommended: candidate.recommended,
    toleranceExceeded: candidate.toleranceExceeded,
    priceBreak: candidate.priceBreak,
  };
}

export function buildAgentInternalProjection(input: {
  result: CostResult;
  gravureRequest: boolean;
  pricingSnapshot?: SnapshotPublicMetadata;
}): AgentCalculationProjection {
  const candidates = input.result.recommendationCandidates ?? [];
  const projectedCandidates = candidates.map(buildAgentCandidateProjection);
  const selectedCandidateId = input.result.selectedCandidateId ?? "";
  return {
    calculation: {
      calculationVersion: input.result.audit.calculationVersion,
      inputHash: input.result.audit.inputJsonSha256,
      resultHash: input.result.audit.resultJsonSha256,
      digitalFilmPriceMode: input.result.audit.digitalFilmPriceMode,
      componentReconciliationDifference: input.result.audit.componentReconciliationDifference,
      authority: input.gravureRequest ? "durable_gravure_snapshot" : "digital_film_store",
      ...(input.pricingSnapshot
        ? { pricingSnapshot: { ...input.pricingSnapshot } }
        : {}),
    },
    quantity: input.result.quantity,
    printingMethod: input.result.printingMethod,
    connectedChambers: input.result.connectedChambers,
    fillingMethod: input.result.fillingMethod,
    selectedCandidateId,
    selectedCandidate: projectedCandidates.find((candidate) => candidate.id === selectedCandidateId) ?? null,
    candidates: projectedCandidates,
    warnings: [...input.result.warnings],
    unresolvedInputFlags: [...input.result.audit.unresolvedInputFlags],
  };
}

export function buildAgentCustomerSafeProjection(input: {
  result: CostResult;
  sizeWidthMm: string;
  sizeLengthMm: string;
}): AgentCustomerSafeProjection {
  // The customer view is priced by one server-selected target margin. Hermes
  // cannot choose or observe that margin, and no cost/profit basis is sent.
  const quotation = calculateAutomaticQuotation(input.result, "0.4");
  if (!quotation) throw new Error("agent_customer_projection_invalid");
  const candidates = input.result.recommendationCandidates ?? [];
  return {
    quantity: input.result.quantity,
    printingMethod: input.result.printingMethod,
    connectedChambers: input.result.connectedChambers,
    fillingMethod: input.result.fillingMethod,
    size: {
      widthMm: input.sizeWidthMm,
      lengthMm: input.sizeLengthMm,
    },
    displayedUnitPrice: quotation.display.pricePerPiece,
    displayedSubtotal: quotation.display.subtotal,
    displayedTax: quotation.display.tax,
    displayedGrandTotal: quotation.display.grandTotal,
    candidateOptions: candidates.map((candidate, index) => ({
      optionNumber: index + 1,
      label: candidate.routeLabel,
      quantity: candidate.adjustedQuantity,
      requiredLengthM: candidate.requiredLengthM,
      orderLengthM: candidate.orderLengthM,
      effectiveLengthM: candidate.effectiveLengthM,
    })),
  };
}
