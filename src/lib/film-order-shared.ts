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
  not_required: "バルク支給不要",
  pending: "バルク依頼準備中",
  requested: "バルク送付依頼済み",
  received: "バルク受領済み",
  confirmed: "バルク量確認済み",
  adjustment_requested: "バルク量変更依頼中",
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

export type FilmOrder = FilmOrderRow & {
  purchaseOrder: PurchaseOrderSnapshot | null;
  sampleBulk: SampleBulkTracking;
  customerDesign: CustomerDesignTracking;
};

export interface SampleBulkTracking {
  status: SampleBulkStatus;
  requiredMl: string;
  receivedMl: string | null;
  adjustedMl: string | null;
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
