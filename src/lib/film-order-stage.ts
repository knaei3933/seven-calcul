import type {
  CustomerDesignStatus,
  CustomerProofStatus,
  FilmOrderStatus,
  ShipToStatus,
} from "./film-order-shared";

export const FILM_ORDER_WORKFLOW_STAGES = [
  "contract_accepted",
  "maker_requested",
  "data_intake",
  "proof_registered",
  "customer_review",
  "approved",
  "correction",
  "final_approvals",
  "po",
  "eta",
  "shipment",
  "delivery",
  "receipt",
  "complete",
] as const;

export type FilmOrderWorkflowStage = typeof FILM_ORDER_WORKFLOW_STAGES[number];

export const filmOrderWorkflowStageLabels: Record<FilmOrderWorkflowStage, string> = {
  contract_accepted: "成約・データ準備前",
  maker_requested: "フィルムメーカー依頼前",
  data_intake: "製作データ入稿中",
  proof_registered: "校正作成中",
  customer_review: "得意先校正確認中",
  approved: "校正承認済み",
  correction: "修正ループ中",
  final_approvals: "最終承認処理中",
  po: "フィルムメーカー発注済み",
  eta: "納期見込み調整中",
  shipment: "出荷報告済み",
  delivery: "納品報告済み",
  receipt: "検収確認済み",
  complete: "完了",
};

export type FilmOrderActorRole = "buyer" | "kanei" | "customer" | "maker" | "system";

export type FilmOrderGuardReasonCode =
  | "film_maker_resolution_required"
  | "film_maker_not_found"
  | "film_maker_inactive"
  | "film_maker_route_mismatch"
  | "film_maker_print_method_mismatch"
  | "maker_data_packet_required"
  | "supplier_destination_missing"
  | "customer_proof_pdf_required"
  | "invalid_status_transition"
  | "customer_proof_release_required"
  | "supplier_approval_required"
  | "buyer_approval_required"
  | "ship_to_confirmation_required"
  | "invalid_eta_transition"
  | "invalid_delivery_transition"
  | "invalid_receipt_transition"
  | "invalid_delivery_document_transition"
  | "film_order_resend_conflict"
  | "film_order_state_conflict"
  | "actor_role_forbidden";

export const filmOrderGuardReasonLabels: Record<FilmOrderGuardReasonCode, string> = {
  film_maker_resolution_required: "フィルムメーカーを選択してください。",
  film_maker_not_found: "選択されたフィルムメーカーが存在しません。",
  film_maker_inactive: "選択されたフィルムメーカーは無効です。",
  film_maker_route_mismatch: "フィルムメーカーの調達ルートが案件と一致しません。",
  film_maker_print_method_mismatch: "フィルムメーカーの印刷方式が案件と一致しません。",
  maker_data_packet_required: "フィルムメーカー連絡に必要なAI/PDFデータが不足しています。",
  supplier_destination_missing: "フィルムメーカー送信先が未設定です。",
  customer_proof_pdf_required: "得意先確認用の校正PDFが必要です。",
  invalid_status_transition: "現在の状態では実行できません。",
  customer_proof_release_required: "得意先校正承認が必要です。",
  supplier_approval_required: "金井貿易側の校正承認が必要です。",
  buyer_approval_required: "バイヤーの最終承認が必要です。",
  ship_to_confirmation_required: "納品先の確定が必要です。",
  invalid_eta_transition: "フィルムメーカー発注後に納期見込みを登録できます。",
  invalid_delivery_transition: "納品報告済みのため出荷報告はできません。",
  invalid_receipt_transition: "納品報告前に受領できません。",
  invalid_delivery_document_transition: "納品済み案件の納品書アップロードはできません。",
  film_order_resend_conflict: "再送対象の発注状態が変更されています。",
  film_order_state_conflict: "他の操作が先に完了したため再読み込みしてください。",
  actor_role_forbidden: "この操作を実行できる権限がありません。",
};

export interface FilmMakerGuardSnapshot {
  id?: number | string | null;
  email?: string | null;
  isActive?: boolean | number | null;
  procurementRoute?: string | null;
  printMethod?: string | null;
}

export interface FilmOrderStageInput {
  status: FilmOrderStatus;
  orderedAt?: string | null;
  receivingRegisteredAt?: string | null;
  proofRegisteredAt?: string | null;
  reProofRequestedAt?: string | null;
  finalApprovedAt?: string | null;
  customerDesignStatus?: CustomerDesignStatus;
  customerProofStatus?: CustomerProofStatus;
  supplierApprovalStatus?: "pending" | "approved" | "legacy_exempt";
  supplierApprovalAt?: string | null;
  buyerApprovalStatus?: "pending" | "approved";
  buyerApprovalAt?: string | null;
  poSentAt?: string | null;
  etaUpdatedAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  receivedAt?: string | null;
}

export interface FilmOrderGuardInput extends FilmOrderStageInput {
  id?: number | string | null;
  procurementRoute?: string | null;
  printingMethod?: string | null;
  supplierResolution?: "legacy_unresolved" | "master_selected" | "legacy_exempt";
  supplierEmail?: string | null;
  makerId?: number | string | null;
  makerSnapshot?: FilmMakerGuardSnapshot | null;
  shipToStatus?: ShipToStatus;
  customerProofCorrectionCount?: number;
  receivingAiRegistered?: boolean;
  receivingPdfRegistered?: boolean;
  customerProofPdfRegistered?: boolean;
}

export interface FilmOrderActionDecision {
  action: FilmWorkflowAction;
  stage: FilmOrderWorkflowStage;
  available: boolean;
  reasons: FilmOrderGuardReasonCode[];
  reasonLabel: string | null;
}

export type FilmWorkflowAction =
  | "mark-ordered"
  | "register-receiving"
  | "send-proof-notice"
  | "rotate-supplier-proof-token"
  | "register-proof"
  | "send-customer-proof-review"
  | "record-customer-proof-approval"
  | "approve"
  | "request-re-proof"
  | "send-po"
  | "update-eta"
  | "report-shipment"
  | "report-delivery"
  | "confirm-film-receipt"
  | "resend-receiving-notice"
  | "resend-supplier-links";

export interface FilmOrderTransitionDefinition {
  action: FilmWorkflowAction;
  from: readonly FilmOrderWorkflowStage[];
  to: FilmOrderWorkflowStage;
}

export const FILM_ORDER_TRANSITIONS: readonly FilmOrderTransitionDefinition[] = [
  { action: "mark-ordered", from: ["contract_accepted"], to: "maker_requested" },
  { action: "register-receiving", from: ["maker_requested"], to: "data_intake" },
  { action: "register-proof", from: ["data_intake"], to: "customer_review" },
  { action: "send-customer-proof-review", from: ["customer_review"], to: "customer_review" },
  { action: "record-customer-proof-approval", from: ["customer_review", "approved"], to: "approved" },
  { action: "approve", from: ["approved"], to: "final_approvals" },
  { action: "request-re-proof", from: ["customer_review"], to: "correction" },
  { action: "send-po", from: ["final_approvals"], to: "po" },
  { action: "update-eta", from: ["po", "eta"], to: "eta" },
  { action: "report-shipment", from: ["po", "eta"], to: "shipment" },
  { action: "report-delivery", from: ["shipment"], to: "delivery" },
  { action: "confirm-film-receipt", from: ["delivery"], to: "receipt" },
] as const;

const MAKER_CONTACT_ACTIONS: readonly FilmWorkflowAction[] = [
  "register-receiving",
  "send-proof-notice",
  "rotate-supplier-proof-token",
  "request-re-proof",
  "send-po",
  "resend-receiving-notice",
  "resend-supplier-links",
] as const;

const PACKET_REQUIRED_ACTIONS: readonly FilmWorkflowAction[] = [
  "register-receiving",
  "send-proof-notice",
  "rotate-supplier-proof-token",
  "request-re-proof",
  "send-po",
  "resend-receiving-notice",
  "resend-supplier-links",
] as const;

const ACTOR_ROLE_ACTIONS: Partial<Record<FilmWorkflowAction, readonly FilmOrderActorRole[]>> = {
  "mark-ordered": ["buyer"],
  "register-receiving": ["buyer"],
  "send-proof-notice": ["kanei"],
  "rotate-supplier-proof-token": ["kanei"],
  "register-proof": ["kanei", "maker"],
  "send-customer-proof-review": ["kanei"],
  "record-customer-proof-approval": ["kanei"],
  "approve": ["buyer"],
  "request-re-proof": ["buyer"],
  "send-po": ["kanei"],
  "update-eta": ["maker"],
  "report-shipment": ["maker"],
  "report-delivery": ["maker"],
  "confirm-film-receipt": ["buyer"],
  "resend-receiving-notice": ["buyer", "kanei"],
  "resend-supplier-links": ["kanei"],
};

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function normalize(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function filmOrderStageOf(order: FilmOrderStageInput): FilmOrderWorkflowStage {
  const approvalsApproved = (order.supplierApprovalStatus === "approved" || order.supplierApprovalStatus === "legacy_exempt")
    && order.buyerApprovalStatus === "approved";

  if (order.receivedAt && approvalsApproved && order.deliveredAt) return "complete";
  if (order.receivedAt) return "receipt";
  if (order.deliveredAt) return "delivery";
  if (order.shippedAt) return "shipment";
  if (order.etaUpdatedAt) return "eta";
  if (order.poSentAt) return "po";

  if (order.status === "final_approved") return "final_approvals";
  if (order.status === "re_proof_requested" || order.customerProofStatus === "correction_requested") {
    return "correction";
  }
  if (order.status === "proof_registered") {
    const customerApproved = order.customerProofStatus === "approved" || order.customerProofStatus === "legacy_exempt";
    const supplierApproved = order.supplierApprovalStatus === "approved" || order.supplierApprovalStatus === "legacy_exempt";
    return customerApproved && supplierApproved ? "approved" : "customer_review";
  }
  if (order.status === "receiving_registered") return "data_intake";
  if (order.status === "ordered" || order.orderedAt) return "maker_requested";
  return "contract_accepted";
}

function makerGuardReason(order: FilmOrderGuardInput): FilmOrderGuardReasonCode | null {
  if (order.supplierResolution === "legacy_unresolved" || (order.supplierResolution !== "legacy_exempt" && !order.makerSnapshot)) {
    return "film_maker_resolution_required";
  }
  if (order.supplierResolution === "legacy_exempt") return "film_maker_resolution_required";

  const snapshot = order.makerSnapshot;
  const selectedId = order.makerId == null ? null : Number(order.makerId);
  const snapshotId = snapshot?.id == null ? null : Number(snapshot.id);
  if (!selectedId || !snapshotId || selectedId !== snapshotId) return "film_maker_not_found";
  if (!truthy(snapshot?.isActive)) return "film_maker_inactive";
  if (normalize(snapshot?.procurementRoute) !== normalize(String(order.procurementRoute ?? ""))) {
    return "film_maker_route_mismatch";
  }
  if (normalize(snapshot?.printMethod) !== normalize(String(order.printingMethod ?? ""))) {
    return "film_maker_print_method_mismatch";
  }
  if (!snapshot?.email) return "supplier_destination_missing";
  return null;
}

function packetGuardReason(order: FilmOrderGuardInput, action: FilmWorkflowAction): FilmOrderGuardReasonCode | null {
  if (!PACKET_REQUIRED_ACTIONS.includes(action)) return null;
  return order.receivingAiRegistered === true && order.receivingPdfRegistered === true
    ? null
    : "maker_data_packet_required";
}

function transitionGuardReasons(order: FilmOrderGuardInput, action: FilmWorkflowAction): FilmOrderGuardReasonCode[] {
  const reasons: FilmOrderGuardReasonCode[] = [];
  const proofApproved = order.customerProofStatus === "approved" || order.customerProofStatus === "legacy_exempt";
  const supplierApproved = order.supplierApprovalStatus === "approved" || order.supplierApprovalStatus === "legacy_exempt";

  switch (action) {
    case "mark-ordered":
      if (order.status !== "pending") reasons.push("invalid_status_transition");
      break;
    case "register-receiving":
      if (order.status !== "ordered") reasons.push("invalid_status_transition");
      if (!["confirmed", "not_required", "legacy_exempt"].includes(order.customerDesignStatus ?? "pending")) {
        reasons.push("invalid_status_transition");
      }
      break;
    case "register-proof":
      if (order.status !== "receiving_registered" && order.status !== "re_proof_requested") {
        reasons.push("invalid_status_transition");
      }
      break;
    case "send-customer-proof-review":
      if (order.status !== "proof_registered" || !["pending", "requested", "correction_requested"].includes(order.customerProofStatus ?? "pending")) {
        reasons.push("invalid_status_transition");
      }
      if (order.customerProofPdfRegistered !== true) reasons.push("customer_proof_pdf_required");
      break;
    case "record-customer-proof-approval":
      if (order.status !== "proof_registered" || !["pending", "requested", "approved"].includes(order.customerProofStatus ?? "pending")) {
        reasons.push("invalid_status_transition");
      }
      break;
    case "approve":
      if (order.status !== "proof_registered") reasons.push("invalid_status_transition");
      if (!proofApproved) reasons.push("customer_proof_release_required");
      if (!supplierApproved) reasons.push("supplier_approval_required");
      break;
    case "request-re-proof":
      if (order.status !== "proof_registered") reasons.push("invalid_status_transition");
      break;
    case "send-po":
    case "resend-supplier-links":
      if (order.status !== "final_approved") reasons.push("invalid_status_transition");
      if (!supplierApproved) reasons.push("supplier_approval_required");
      if (order.buyerApprovalStatus !== "approved") reasons.push("buyer_approval_required");
      if (action === "send-po" && order.shipToStatus !== "confirmed") reasons.push("ship_to_confirmation_required");
      if (action === "resend-supplier-links" && !order.poSentAt) reasons.push("film_order_resend_conflict");
      break;
    case "update-eta":
      if (!order.poSentAt) reasons.push("invalid_eta_transition");
      break;
    case "report-shipment":
      if (!order.poSentAt) reasons.push("invalid_eta_transition");
      if (order.shipToStatus !== "confirmed") reasons.push("ship_to_confirmation_required");
      if (order.deliveredAt) reasons.push("invalid_delivery_transition");
      break;
    case "report-delivery":
      if (!order.shippedAt) reasons.push("invalid_delivery_transition");
      break;
    case "confirm-film-receipt":
      if (!order.deliveredAt) reasons.push("invalid_receipt_transition");
      break;
    case "send-proof-notice":
    case "rotate-supplier-proof-token":
      if (order.status !== "receiving_registered" && order.status !== "re_proof_requested") {
        reasons.push("invalid_status_transition");
      }
      break;
    case "resend-receiving-notice":
      if (order.status !== "receiving_registered") reasons.push("invalid_status_transition");
      break;
  }
  return reasons;
}

export function filmOrderActionReasons(
  order: FilmOrderGuardInput,
  action: FilmWorkflowAction,
  actorRole?: FilmOrderActorRole,
): FilmOrderGuardReasonCode[] {
  const reasons = transitionGuardReasons(order, action);
  const allowedRoles = ACTOR_ROLE_ACTIONS[action];
  if (actorRole && allowedRoles && !allowedRoles.includes(actorRole)) reasons.push("actor_role_forbidden");

  if (MAKER_CONTACT_ACTIONS.includes(action)) {
    const makerReason = makerGuardReason(order);
    if (makerReason) reasons.push(makerReason);
    const packetReason = packetGuardReason(order, action);
    if (packetReason) reasons.push(packetReason);
  }
  return [...new Set(reasons)];
}

export function filmOrderActionAvailability(
  order: FilmOrderGuardInput,
  action: FilmWorkflowAction,
  actorRole?: FilmOrderActorRole,
): FilmOrderActionDecision {
  const reasons = filmOrderActionReasons(order, action, actorRole);
  return {
    action,
    stage: filmOrderStageOf(order),
    available: reasons.length === 0,
    reasons,
    reasonLabel: reasons[0] ? filmOrderGuardReasonLabels[reasons[0]!] : null,
  };
}

/** Storage/action orchestration calls this immediately before its first authoritative write. */
export function assertFilmOrderActionGuard(
  order: FilmOrderGuardInput,
  action: FilmWorkflowAction,
  actorRole?: FilmOrderActorRole,
): void {
  const reason = filmOrderActionReasons(order, action, actorRole)[0];
  if (reason) throw new Error(reason);
}

export function assertFilmOrderDeliveryDocumentGuard(order: {
  status: FilmOrderStatus;
  poSentAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
}): void {
  if (order.status !== "final_approved" || !order.poSentAt || order.deliveredAt) {
    throw new Error("invalid_delivery_transition");
  }
  void order.shippedAt;
}

export function filmOrderErrorStatusCode(code: string): number {
  if ([
    "invalid_status_transition",
    "ship_to_confirmation_required",
    "invalid_eta_transition",
    "invalid_delivery_transition",
    "invalid_receipt_transition",
    "invalid_delivery_document_transition",
    "film_order_resend_conflict",
    "film_order_state_conflict",
  ].includes(code)) return 409;
  if ([
    "film_maker_resolution_required",
    "film_maker_language_mismatch",
    "film_maker_not_found",
    "film_maker_inactive",
    "film_maker_route_mismatch",
    "film_maker_print_method_mismatch",
    "maker_data_packet_required",
    "supplier_destination_missing",
    "customer_proof_pdf_required",
    "customer_proof_release_required",
    "supplier_approval_required",
    "buyer_approval_required",
  ].includes(code)) return 400;
  return 500;
}
