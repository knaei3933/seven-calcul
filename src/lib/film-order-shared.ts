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

export const FILM_RECEIVING_FOLDER_URL =
  "https://drive.google.com/drive/folders/1u2iaE15tH5sQ6s39aGzaDet8tdAzgEf_?usp=drive_link";
export const FILM_PROOF_FOLDER_URL =
  "https://drive.google.com/drive/folders/1EP8faGx8z-tLUfdpStN74O9-oIuBSO0K?usp=drive_link";

export type FilmOrderFileCategory = "receiving" | "proof" | "final";

export interface FilmOrderFileRecord {
  id: number;
  order_id: number;
  category: FilmOrderFileCategory;
  file_name: string;
  url: string;
  version: number;
  note: string;
  uploaded_by_email: string;
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
  notes: string;
  created_at: string;
  updated_at: string;
  created_by_email: string;
  updated_by_email: string;
}

export type FilmOrder = FilmOrderRow & {
  purchaseOrder: PurchaseOrderSnapshot | null;
};

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
  const label = category === "receiving" ? "入稿" : category === "proof" ? "校正" : "最終";
  const versionPart = category === "proof" && version > 1 ? `_v${version}` : "";
  return `${sanitizeFileNamePart(order.product_name)}_${order.order_number}_${label}_${datePart}${versionPart}`;
}
