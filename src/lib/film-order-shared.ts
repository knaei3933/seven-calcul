import type { PurchaseOrderSnapshot } from "./purchase-order";

export const FILM_ORDER_STATUSES = [
  "pending",
  "ordered",
  "receiving_registered",
  "proof_registered",
  "re_proof_requested",
  "final_approved",
] as const;

export type FilmOrderStatus = typeof FILM_ORDER_STATUSES[number];

export const filmOrderStatusLabels: Record<FilmOrderStatus, string> = {
  pending: "成約・発注待ち",
  ordered: "発注書送信済み",
  receiving_registered: "入稿済み",
  proof_registered: "校正待ち",
  re_proof_requested: "再校正依頼中",
  final_approved: "最終承認済み",
};

export const SAMPLE_BULK_STATUSES = [
  "not_required",
  "pending",
  "requested",
  "received",
  "confirmed",
  "adjustment_requested",
] as const;

export type SampleBulkStatus = typeof SAMPLE_BULK_STATUSES[number];

export const sampleBulkStatusLabels: Record<SampleBulkStatus, string> = {
  not_required: "サンプル支給不要",
  pending: "サンプル依頼準備中",
  requested: "サンプル送付依頼済み",
  received: "サンプル受領済み",
  confirmed: "サンプル量確認済み",
  adjustment_requested: "サンプル量変更依頼中",
};

export const CUSTOMER_DESIGN_STATUSES = [
  "pending",
  "requested",
  "received",
  "correction_requested",
  "confirmed",
  "not_required",
  "legacy_exempt",
] as const;

export type CustomerDesignStatus = typeof CUSTOMER_DESIGN_STATUSES[number];

export const customerDesignStatusLabels: Record<CustomerDesignStatus, string> = {
  pending: "顧客デザイン依頼準備中",
  requested: "顧客アップロード依頼済み",
  received: "顧客デザイン受領",
  correction_requested: "顧客修正依頼中",
  confirmed: "顧客デザイン確定",
  not_required: "顧客デザイン不要",
  legacy_exempt: "既存案件（対象外）",
};

export const CUSTOMER_PROOF_STATUSES = [
  "pending",
  "requested",
  "approved",
  "correction_requested",
  "legacy_exempt",
] as const;

export type CustomerProofStatus = typeof CUSTOMER_PROOF_STATUSES[number];

export const customerProofStatusLabels: Record<CustomerProofStatus, string> = {
  pending: "顧客校正確認待ち",
  requested: "顧客レビュー依頼済み",
  approved: "顧客承認済み",
  correction_requested: "顧客修正依頼中",
  legacy_exempt: "既存案件（対象外）",
};

export const FILM_RECEIVING_FOLDER_URL =
  "https://drive.google.com/drive/folders/1u2iaE15tH5sQ6s39aGzaDet8tdAzgEf_?usp=drive_link";
export const FILM_PROOF_FOLDER_URL =
  "https://drive.google.com/drive/folders/1EP8faGx8z-tLUfdpStN74O9-oIuBSO0K?usp=drive_link";

export const DEFAULT_FILM_PROOF_EMAIL = "design@package-lab.com";

export type FilmOrderFileCategory = "customer_design" | "receiving" | "proof" | "final";

export interface FilmOrderFileRecord {
  id: number;
  order_id: number;
  category: FilmOrderFileCategory;
  file_name: string;
  url: string;
  version: number;
  note: string;
  uploaded_by_email: string;
  file_size_bytes: number | null;
  content_type: string | null;
  checksum: string | null;
  checksum_algorithm: string | null;
  drive_file_id: string | null;
  uploaded_via: string | null;
  client_ip_hash: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface FilmOrderEventRecord {
  id: number;
  order_id: number;
  type: string;
  detail: string;
  actor_email: string;
  created_at: string;
}

export interface FilmOrderRow {
  id: number;
  order_number: string;
  customer_code: string;
  quotation_id: number;
  quotation_number: string;
  product_name: string;
  customer_name: string;
  printing_method: string;
  procurement_route: string;
  film_composition: string;
  order_length_m: string;
  web_width_mm: string;
  pouch_quantity: string;
  supplier_name: string;
  supplier_email: string;
  seven_contact_email: string;
  buyer_domain: string;
  po_sent_at: string | null;
  eta_token: string | null;
  eta_expires_at: string | null;
  eta_date: string | null;
  eta_note: string | null;
  eta_updated_at: string | null;
  film_shipped_on: string | null;
  film_shipped_at: string | null;
  film_carrier: string;
  film_tracking_number: string;
  film_shipment_note: string;
  film_delivery_document_name: string;
  film_delivery_document_url: string;
  film_delivered_on: string | null;
  film_delivered_at: string | null;
  film_delivery_note: string;
  film_received_at: string | null;
  film_received_note: string;
  film_received_by_email: string;
  ship_to_destination_id: number | null;
  ship_to_status: ShipToStatus;
  ship_to_label: string;
  ship_to_company_name: string;
  ship_to_department: string;
  ship_to_contact_name: string;
  ship_to_postal_code: string;
  ship_to_address: string;
  ship_to_building: string;
  ship_to_phone: string;
  ship_to_email: string;
  ship_to_note: string;
  ship_to_registered_at: string | null;
  ship_to_registered_by: string;
  ship_to_saved_to_master: number | boolean;
  ship_to_confirmed_at: string | null;
  ship_to_confirmed_by: string;
  proof_upload_token: string | null;
  proof_upload_expires_at: string | null;
  status: FilmOrderStatus;
  re_proof_count: number;
  ordered_at: string | null;
  receiving_registered_at: string | null;
  proof_registered_at: string | null;
  re_proof_requested_at: string | null;
  final_approved_at: string | null;
  customer_design_status: CustomerDesignStatus;
  customer_design_requested_at: string | null;
  customer_design_received_at: string | null;
  customer_design_confirmed_at: string | null;
  customer_design_correction_count: number;
  customer_design_correction_reason: string;
  customer_proof_status: CustomerProofStatus;
  customer_proof_requested_at: string | null;
  customer_proof_approved_at: string | null;
  customer_proof_correction_count: number;
  customer_proof_correction_reason: string;
  notes: string;
  created_at: string;
  updated_at: string;
  created_by_email: string;
  updated_by_email: string;
}

export interface CustomerDesignTracking {
  status: CustomerDesignStatus;
  requestedAt: string | null;
  receivedAt: string | null;
  confirmedAt: string | null;
  correctionCount: number;
  correctionReason: string;
  note: string;
}

export interface CustomerProofTracking {
  status: CustomerProofStatus;
  requestedAt: string | null;
  approvedAt: string | null;
  correctionCount: number;
  correctionReason: string;
}

export interface FilmDeliveryTracking {
  shippedOn: string | null;
  shippedAt: string | null;
  carrier: string;
  trackingNumber: string;
  shipmentNote: string;
  deliveryDocumentName: string;
  deliveryDocumentUrl: string;
  deliveredOn: string | null;
  deliveredAt: string | null;
  deliveryNote: string;
  receivedAt: string | null;
  receivedNote: string;
  receivedByEmail: string;
}

export const SHIP_TO_STATUSES = [
  "not_provided",
  "registered",
  "confirmed",
] as const;

export type ShipToStatus = typeof SHIP_TO_STATUSES[number];

export const shipToStatusLabels: Record<ShipToStatus, string> = {
  not_provided: "納品先未登録",
  registered: "納品先登録済み",
  confirmed: "納品先確認済み",
};

export interface ShipToTracking {
  status: ShipToStatus;
  destinationId: number | null;
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
  registeredAt: string | null;
  registeredBy: string;
  savedToMaster: boolean;
  confirmedAt: string | null;
  confirmedBy: string;
}

export type FilmOrder = FilmOrderRow & {
  purchaseOrder: PurchaseOrderSnapshot | null;
  sampleBulk: SampleBulkTracking;
  customerDesign: CustomerDesignTracking;
  customerProof: CustomerProofTracking;
  delivery: FilmDeliveryTracking;
  shipTo: ShipToTracking;
};

export interface SampleBulkTracking {
  status: SampleBulkStatus;
  /** 見積計算上の本生産バルク使用量。サンプル支給量ではない。 */
  productionBulkUsageMl: string;
  /** 実際に依頼するサンプル支給量。 */
  sampleQuantityMl: string | null;
  sampleReceivedMl: string | null;
  sampleAdjustedMl: string | null;
  adjustmentCount: number;
  recipientName: string;
  recipientPostalCode: string;
  recipientAddress: string;
  requestedAt: string | null;
  receivedAt: string | null;
  confirmedAt: string | null;
  adjustmentRequestedAt: string | null;
  requestNote: string;
  receiveNote: string;
  adjustmentReason: string;
}

export type FilmOrderView = FilmOrder & {
  files: FilmOrderFileRecord[];
  events: FilmOrderEventRecord[];
};

function sanitizeFileNamePart(value: string, maxLength = 40): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\r\n\t]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, maxLength);
  return cleaned || "無題";
}

export function buildFilmOrderFileName(
  order: Pick<FilmOrder, "product_name" | "order_number">,
  category: FilmOrderFileCategory,
  version: number,
): string {
  const date = new Date();
  const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const label = category === "customer_design"
    ? "顧客原稿"
    : category === "receiving"
      ? "入稿"
      : category === "proof"
        ? "校正"
        : "最終";
  const versionPart = category === "proof" && version > 1 ? `_v${version}` : "";
  return `${sanitizeFileNamePart(order.product_name)}_${order.order_number}_${label}_${datePart}${versionPart}`;
}
