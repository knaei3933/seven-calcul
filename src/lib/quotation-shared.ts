export const QUOTATION_RESTORE_KEY = "pouch-quotation-restore-v1";
export const DEFAULT_FILM_COMPOSITION = "PET12+AL7+PET12+LLDPE50μ";

export type QuotationStatus = "draft" | "sent" | "approved" | "rejected" | "expired";

export const quotationStatuses: QuotationStatus[] = ["draft", "sent", "approved", "rejected", "expired"];

export interface QuotationRecordInput {
  quotationNumber: string;
  status: QuotationStatus;
  issueDate: string;
  validUntil: string;
  customerName: string;
  customerContact: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  fillingCostPerPiece: string;
  filmCostPerPiece: string;
  filmMeterPrice: string;
  filmOrderLengthM: string;
  targetMargin: string;
  taxRatePercent: string;
  pricePerPiece: string;
  subtotal: string;
  tax: string;
  grandTotal: string;
  deliveryDate: string;
  paymentTerms: string;
  notes: string;
  calculationVersion: string;
  resultHash: string;
  payload: Record<string, unknown>;
}

export interface QuotationRecord extends QuotationRecordInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export type { QuotationPayload } from "./quotation-history-types";

export interface CustomerMasterInput {
  customerCode: string;
  customerName: string;
  customerPostalCode: string;
  customerAddress: string;
  customerContact: string;
  customerTelephone: string;
  customerEmail: string;
}

export interface CustomerMaster extends CustomerMasterInput {
  createdAt: string;
  updatedAt: string;
}

export type ChecklistAudience = "CUSTOMER" | "INTERNAL_QA";

export const checklistAudiences: ChecklistAudience[] = ["CUSTOMER", "INTERNAL_QA"];
