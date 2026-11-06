import { getDatabaseForFilmMakerStore } from "./film-orders";
import { filmOrderBuyerDomainOf, type CustomerOwnerDomain } from "./film-order-access";
import { canActForQuoteOwner } from "./quotation-access";
import { getDatabaseForFilmOrderIntake } from "./quotation-store";
import { quotationOwnerDomainFromStorage, type QuotationOwnerDomain } from "./quotation-shared";

export type FilmOrderIntakeState =
  | "linked"
  | "pending_sync"
  | "owner_mismatch"
  | "unresolved_owner";

export interface FilmOrderIntakeOrderState {
  id: number;
  orderNumber: string;
  status: string;
}

export type FilmOrderIntakeMakerHandoffStatus =
  | "unavailable"
  | "not_registered"
  | "registered";

export type FilmOrderIntakeProofStatus =
  | "unavailable"
  | "pending"
  | "requested"
  | "approved"
  | "correction_requested"
  | "legacy_exempt";

export type FilmOrderIntakeDualApprovalStatus =
  | "pending"
  | "owner_approved"
  | "kanei_approved"
  | "approved";

export type FilmOrderIntakePoStatus = "unavailable" | "not_sent" | "sent";

export type FilmOrderIntakeActionKind =
  | "intake_upload"
  | "maker_handoff"
  | "proof_round"
  | "owner_approval"
  | "kanei_approval"
  | "purchase_order";

export interface FilmOrderIntakeAction {
  kind: FilmOrderIntakeActionKind;
  label: string;
  /** Future G003+ behavior may call this only when durable ownership matches. */
  authorized: boolean;
  enabled: boolean;
  reason: string;
  releaseStory: "G003" | "G004" | "G005" | "G006" | "G007";
}

export interface FilmOrderIntakeViewer {
  email: string | null | undefined;
  role?: string | null;
}

export const FILM_ORDER_INTAKE_OWNER_FILTERS = ["seven", "kanei", "unresolved"] as const;
export const FILM_ORDER_INTAKE_STATE_FILTERS = [
  "linked",
  "pending_sync",
  "owner_mismatch",
  "unresolved_owner",
] as const;
export const FILM_ORDER_INTAKE_MAKER_FILTERS = [
  "unavailable",
  "not_registered",
  "registered",
] as const;
export const FILM_ORDER_INTAKE_PROOF_FILTERS = [
  "unavailable",
  "pending",
  "requested",
  "approved",
  "correction_requested",
  "legacy_exempt",
] as const;
export const FILM_ORDER_INTAKE_DUAL_APPROVAL_FILTERS = [
  "pending",
  "owner_approved",
  "kanei_approved",
  "approved",
] as const;
export const FILM_ORDER_INTAKE_PO_FILTERS = ["unavailable", "not_sent", "sent"] as const;

export interface FilmOrderIntakeEntry {
  quotationId: number;
  quotationNumber: string;
  productName: string;
  customerName: string;
  quantity: string;
  internalApprovedAt: string | null;
  ownerDomain: QuotationOwnerDomain;
  state: FilmOrderIntakeState;
  filmOrder: FilmOrderIntakeOrderState | null;
  makerHandoffStatus: FilmOrderIntakeMakerHandoffStatus;
  proofStatus: FilmOrderIntakeProofStatus;
  proofRound: number;
  dualApprovalStatus: FilmOrderIntakeDualApprovalStatus;
  poStatus: FilmOrderIntakePoStatus;
  actions: FilmOrderIntakeAction[];
}

export type FilmOrderIntakeFilter = {
  owner?: (typeof FILM_ORDER_INTAKE_OWNER_FILTERS)[number];
  intakeState?: (typeof FILM_ORDER_INTAKE_STATE_FILTERS)[number];
  makerHandoff?: (typeof FILM_ORDER_INTAKE_MAKER_FILTERS)[number];
  proof?: (typeof FILM_ORDER_INTAKE_PROOF_FILTERS)[number];
  dualApproval?: (typeof FILM_ORDER_INTAKE_DUAL_APPROVAL_FILTERS)[number];
  po?: (typeof FILM_ORDER_INTAKE_PO_FILTERS)[number];
};

export interface FilmOrderIntakeQuery extends FilmOrderIntakeFilter {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface FilmOrderIntakePage {
  entries: FilmOrderIntakeEntry[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

interface FilmOrderIntakeRow {
  quotation_id: number;
  quotation_number: string;
  product_name: string;
  customer_name: string;
  quantity: string;
  internal_approved_at: string | null;
  owner_domain: string | null;
  film_order_id: number | null;
  film_order_number: string | null;
  film_order_status: string | null;
  film_order_buyer_domain: string | null;
  receiving_registered_at: string | null;
  customer_proof_status: string | null;
  current_proof_round: number | null;
  supplier_approval_status: string | null;
  buyer_approval_status: string | null;
  po_sent_at: string | null;
}

function orderOwnerDomainOf(buyerDomain: string | null): CustomerOwnerDomain | "unresolved" {
  try {
    return filmOrderBuyerDomainOf({ buyer_domain: buyerDomain });
  } catch {
    return "unresolved";
  }
}

function intakeStateOf(
  ownerDomain: QuotationOwnerDomain,
  row: FilmOrderIntakeRow,
): FilmOrderIntakeState {
  if (ownerDomain === "unresolved") return "unresolved_owner";
  if (row.film_order_id == null) return "pending_sync";
  const orderOwner = orderOwnerDomainOf(row.film_order_buyer_domain);
  return orderOwner === ownerDomain ? "linked" : "owner_mismatch";
}

function makerHandoffStatusOf(row: FilmOrderIntakeRow): FilmOrderIntakeMakerHandoffStatus {
  if (row.film_order_id == null) return "unavailable";
  return row.receiving_registered_at ? "registered" : "not_registered";
}

function proofStatusOf(row: FilmOrderIntakeRow): FilmOrderIntakeProofStatus {
  const statuses: FilmOrderIntakeProofStatus[] = [
    "pending",
    "requested",
    "approved",
    "correction_requested",
    "legacy_exempt",
  ];
  const value = row.customer_proof_status as FilmOrderIntakeProofStatus | null | undefined;
  if (row.film_order_id == null || !value || !statuses.includes(value)) return "unavailable";
  return value;
}

function proofRoundOf(row: FilmOrderIntakeRow): number {
  return Number(row.current_proof_round || 1);
}

function dualApprovalStatusOf(row: FilmOrderIntakeRow): FilmOrderIntakeDualApprovalStatus {
  const ownerApproved = row.buyer_approval_status === "approved";
  const kaneiApproved = row.supplier_approval_status === "approved"
    || row.supplier_approval_status === "legacy_exempt";
  if (ownerApproved && kaneiApproved) return "approved";
  if (ownerApproved) return "owner_approved";
  if (kaneiApproved) return "kanei_approved";
  return "pending";
}

function poStatusOf(row: FilmOrderIntakeRow): FilmOrderIntakePoStatus {
  if (row.film_order_id == null) return "unavailable";
  return row.po_sent_at ? "sent" : "not_sent";
}

function actionsFor(
  ownerDomain: QuotationOwnerDomain,
  viewer: FilmOrderIntakeViewer | null | undefined,
  proofRound: number,
  dualApprovalStatus: FilmOrderIntakeDualApprovalStatus,
): FilmOrderIntakeAction[] {
  const ownerActor = ownerDomain !== "unresolved" && canActForQuoteOwner(viewer?.email, ownerDomain);
  const kaneiActor = canActForQuoteOwner(viewer?.email, "kanei");
  const future = (story: FilmOrderIntakeAction["releaseStory"]) =>
    `${story}で有効化予定のため、現在は操作できません。`;

  return [
    {
      kind: "intake_upload",
      label: "データ入稿",
      authorized: ownerActor,
      enabled: true,
      reason: future("G003"),
      releaseStory: "G003",
    },
    {
      kind: "maker_handoff",
      label: "メーカー連携",
      authorized: kaneiActor,
      enabled: false,
      reason: future("G004"),
      releaseStory: "G004",
    },
    {
      kind: "proof_round",
      label: "校正確認",
      authorized: kaneiActor,
      enabled: ownerActor,
      reason: proofRound > 1 ? `校正ラウンド ${proofRound} を確認中です。` : "校正ラウンド 1 を確認できます。",
      releaseStory: "G005",
    },
    {
      kind: "owner_approval",
      label: ownerDomain === "seven" ? "Seven承認" : "Kanei承認",
      authorized: ownerActor,
      enabled: dualApprovalStatus !== "owner_approved" && dualApprovalStatus !== "approved",
      reason: dualApprovalStatus === "owner_approved" || dualApprovalStatus === "approved"
        ? "承認済みです。"
        : "顧客承認後に承認できます。",
      releaseStory: "G006",
    },
    {
      kind: "kanei_approval",
      label: ownerDomain === "seven" ? "金井承認" : "Seven承認",
      authorized: ownerDomain === "seven" ? kaneiActor : ownerActor,
      enabled: dualApprovalStatus !== "kanei_approved" && dualApprovalStatus !== "approved",
      reason: dualApprovalStatus === "kanei_approved" || dualApprovalStatus === "approved"
        ? "承認済みです。"
        : "顧客承認後に承認できます。",
      releaseStory: "G006",
    },
    {
      kind: "purchase_order",
      label: "発注",
      authorized: kaneiActor,
      enabled: false,
      reason: future("G007"),
      releaseStory: "G007",
    },
  ];
}

function filterClauses(query: FilmOrderIntakeQuery): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = [
    "(quotations.internal_approved_at IS NOT NULL OR quotations.status = 'approved')",
  ];
  const params: unknown[] = [];
  const search = query.search?.trim();
  if (search) {
    const pattern = `%${search.toLowerCase()}%`;
    clauses.push(`(
      lower(quotations.quotation_number) LIKE ?
      OR lower(quotations.product_name) LIKE ?
      OR lower(quotations.customer_name) LIKE ?
      OR lower(coalesce(film_orders.order_number, '')) LIKE ?
    )`);
    params.push(pattern, pattern, pattern, pattern);
  }
  if (query.owner) {
    clauses.push(query.owner === "unresolved"
      ? "(quotations.owner_domain IS NULL OR quotations.owner_domain NOT IN ('seven','kanei'))"
      : "quotations.owner_domain = ?");
    if (query.owner !== "unresolved") params.push(query.owner);
  }
  if (query.intakeState) {
    const state = query.intakeState;
    if (state === "pending_sync") {
      clauses.push("film_orders.id IS NULL");
    } else if (state === "linked") {
      clauses.push(`film_orders.id IS NOT NULL AND quotations.owner_domain IN ('seven','kanei')
        AND film_orders.buyer_domain IS NOT NULL AND film_orders.buyer_domain = CASE quotations.owner_domain
          WHEN 'seven' THEN '727.co.jp' ELSE 'kanei-trade.co.jp' END`);
    } else if (state === "owner_mismatch") {
      clauses.push(`film_orders.id IS NOT NULL AND quotations.owner_domain IN ('seven','kanei')
        AND (film_orders.buyer_domain IS NULL OR film_orders.buyer_domain <> CASE quotations.owner_domain
          WHEN 'seven' THEN '727.co.jp' ELSE 'kanei-trade.co.jp' END)`);
    } else {
      clauses.push("(quotations.owner_domain IS NULL OR quotations.owner_domain NOT IN ('seven','kanei'))");
    }
  }
  if (query.makerHandoff === "unavailable") clauses.push("film_orders.id IS NULL");
  if (query.makerHandoff === "not_registered") {
    clauses.push("film_orders.id IS NOT NULL AND film_orders.receiving_registered_at IS NULL");
  }
  if (query.makerHandoff === "registered") {
    clauses.push("film_orders.receiving_registered_at IS NOT NULL");
  }
  if (query.proof === "unavailable") clauses.push("film_orders.id IS NULL");
  if (query.proof && query.proof !== "unavailable") {
    clauses.push("film_orders.customer_proof_status = ?");
    params.push(query.proof);
  }
  if (query.dualApproval) {
    const ownerApproved = "film_orders.buyer_approval_status = 'approved'";
    const kaneiApproved = `film_orders.supplier_approval_status IN ('approved','legacy_exempt')`;
    if (query.dualApproval === "pending") clauses.push(`NOT ${ownerApproved} AND NOT ${kaneiApproved}`);
    if (query.dualApproval === "owner_approved") clauses.push(`${ownerApproved} AND NOT ${kaneiApproved}`);
    if (query.dualApproval === "kanei_approved") clauses.push(`NOT ${ownerApproved} AND ${kaneiApproved}`);
    if (query.dualApproval === "approved") clauses.push(`${ownerApproved} AND ${kaneiApproved}`);
  }
  if (query.po === "unavailable") clauses.push("film_orders.id IS NULL");
  if (query.po === "not_sent") {
    clauses.push("film_orders.id IS NOT NULL AND film_orders.po_sent_at IS NULL");
  }
  if (query.po === "sent") clauses.push("film_orders.po_sent_at IS NOT NULL");
  return { clauses, params };
}

/**
 * The database-style projection exposes progress and planned-action authorization only.
 * Supplier identities and mutable workflow operations remain in their story-scoped APIs.
 */
export async function listFilmOrderIntakePage(
  query: FilmOrderIntakeQuery = {},
  viewer: FilmOrderIntakeViewer | null | undefined,
): Promise<FilmOrderIntakePage> {
  // Ensure quotation approval columns and the existing film-order migration slot are
  // both ready before synchronization or the projection query touches them.
  await getDatabaseForFilmOrderIntake();
  const db = await getDatabaseForFilmMakerStore();
  const { clauses, params } = filterClauses(query);
  const where = `WHERE ${clauses.join(" AND ")}`;
  const page = Number.isInteger(query.page) && Number(query.page) > 0 ? Number(query.page) : 1;
  const requestedPageSize = Number.isInteger(query.pageSize) && Number(query.pageSize) > 0
    ? Number(query.pageSize)
    : 20;
  const pageSize = Math.min(requestedPageSize, 100);
  const total = Number((await db.get<{ total: number | string }>(`
    SELECT COUNT(*) AS total
    FROM quotations
    LEFT JOIN film_orders ON film_orders.quotation_id = quotations.id
    ${where}
  `, params))?.total ?? 0);
  const rows = await db.all<FilmOrderIntakeRow>(`
    SELECT
      quotations.id AS quotation_id,
      quotations.quotation_number AS quotation_number,
      quotations.product_name AS product_name,
      quotations.customer_name AS customer_name,
      quotations.quantity AS quantity,
      quotations.internal_approved_at AS internal_approved_at,
      quotations.owner_domain AS owner_domain,
      film_orders.id AS film_order_id,
      film_orders.order_number AS film_order_number,
      film_orders.status AS film_order_status,
      film_orders.buyer_domain AS film_order_buyer_domain
      , film_orders.receiving_registered_at AS receiving_registered_at
      , film_orders.customer_proof_status AS customer_proof_status
      , film_orders.supplier_approval_status AS supplier_approval_status
      , film_orders.buyer_approval_status AS buyer_approval_status
      , film_orders.po_sent_at AS po_sent_at
    FROM quotations
    LEFT JOIN film_orders ON film_orders.quotation_id = quotations.id
    ${where}
    ORDER BY COALESCE(quotations.internal_approved_at, quotations.updated_at) DESC, quotations.id DESC
    LIMIT ? OFFSET ?
  `, [...params, pageSize, (page - 1) * pageSize]);
  const pageCount = Math.ceil(total / pageSize);

  const entries = rows.map((row) => {
    const ownerDomain = quotationOwnerDomainFromStorage(row.owner_domain);
    return {
      quotationId: Number(row.quotation_id),
      quotationNumber: row.quotation_number,
      productName: row.product_name,
      customerName: row.customer_name,
      quantity: row.quantity,
      internalApprovedAt: row.internal_approved_at,
      ownerDomain,
      state: intakeStateOf(ownerDomain, row),
      filmOrder: row.film_order_id == null ? null : {
        id: Number(row.film_order_id),
        orderNumber: row.film_order_number ?? "",
        status: row.film_order_status ?? "",
      },
      makerHandoffStatus: makerHandoffStatusOf(row),
      proofStatus: proofStatusOf(row),
      proofRound: proofRoundOf(row),
      dualApprovalStatus: dualApprovalStatusOf(row),
      poStatus: poStatusOf(row),
      actions: actionsFor(ownerDomain, viewer, proofRoundOf(row), dualApprovalStatusOf(row)),
    };
  });

  return {
    entries,
    total,
    page,
    pageSize,
    pageCount,
    hasNext: page < pageCount,
    hasPrevious: page > 1,
  };
}

/** Backward-compatible G001 list helper used by focused store tests. */
export async function listFilmOrderIntakeEntries(
  query: FilmOrderIntakeQuery = {},
  viewer?: FilmOrderIntakeViewer | null,
): Promise<FilmOrderIntakeEntry[]> {
  return (await listFilmOrderIntakePage(query, viewer)).entries;
}
