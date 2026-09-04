export const QUOTATION_RESTORE_KEY = "pouch-quotation-restore-v1";

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
