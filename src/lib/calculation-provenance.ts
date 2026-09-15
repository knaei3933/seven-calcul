import type { CalculationInput } from "./calculation";

export function isCalculationRequest(value: unknown): value is CalculationInput {
  if (!value || typeof value !== "object") return false;
  const request = value as CalculationInput;
  return request.recommendationMode === true
    && typeof request.selectedCandidateId === "string"
    && Array.isArray(request.selectedCandidateTargetMargins)
    && request.selectedCandidateTargetMargins.every((margin) => typeof margin === "string");
}
