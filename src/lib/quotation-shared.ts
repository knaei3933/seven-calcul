export const QUOTATION_RESTORE_KEY = "pouch-quotation-restore-v1";
export const SIMULATOR_STALE_STATUS_KEY = "pouch-simulator-stale-status-v1";
export const DEFAULT_FILM_COMPOSITION = "PET12+AL7+PET12+LLDPE50μ";

export type QuotationStatus = "draft" | "sent" | "approved" | "rejected" | "expired";

export const quotationStatuses: QuotationStatus[] = ["draft", "sent", "approved", "rejected", "expired"];

export interface QuotationApprovalSnapshot {
  approvedAt: string;
  approvedBy: UserSummary | null;
  customerIpHash?: string | null;
  userAgent?: string | null;
}

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
  createdBy: UserSummary;
  updatedBy: UserSummary | null;
  internalApproval: QuotationApprovalSnapshot | null;
  customerApproval: QuotationApprovalSnapshot | null;
}

export interface UserSummary {
  id: number;
  email: string;
  name: string;
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
  ownerDomain: "seven" | "kanei";
  createdAt: string;
  updatedAt: string;
}

export interface CustomerDeliveryDestinationInput {
  label: string;
  companyName: string;
  department: string;
  contactName: string;
  postalCode: string;
  address: string;
  building: string;
  phone: string;
  email: string;
  note: string;
  isDefault: boolean;
}

export interface CustomerDeliveryDestination extends CustomerDeliveryDestinationInput {
  id: number;
  ownerDomain: "seven" | "kanei";
  customerCode: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChecklistAudience = "CUSTOMER" | "INTERNAL_QA";

export const checklistAudiences: ChecklistAudience[] = ["CUSTOMER", "INTERNAL_QA"];
