"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  FILM_ORDER_STATUSES,
  buildFilmOrderFileName,
  filmOrderStatusLabels,
  customerDesignStatusLabels,
  customerProofStatusLabels,
  productionPlanStatusLabels,
  sampleBulkStatusLabels,
  shipToStatusLabels,
  type CustomerDesignStatus,
  type FilmOrderStatus,
  type FilmOrderView,
} from "@/lib/film-order-shared";
import {
  FILM_ORDER_WORKFLOW_STAGES,
  filmOrderActionAvailability,
  filmOrderGuardReasonLabels,
  filmOrderStageOf,
  filmOrderWorkflowStageLabels,
  type FilmOrderActorRole,
  type FilmOrderWorkflowStage,
  type FilmWorkflowAction,
} from "@/lib/film-order-stage";
import {
  buyerDomainOf,
  isKaneiTradeUser,
  isSevenChemicalUser,
  supplierLocaleFor,
} from "@/lib/film-order-access";
import { D } from "@/lib/decimal";
import { filmQuotationNumberFor } from "@/lib/film-quotation";
import type { CustomerDeliveryDestination } from "@/lib/quotation-shared";
import {
  allUploadGuidesChecked,
  UploadGuideAcknowledgement,
} from "@/components/upload-guide-acknowledgement";

interface MailResult {
  to: string;
  subject: string;
  dryRun: boolean;
  error?: string;
  requestedTo?: string;
  recipientOverridden?: boolean;
}

interface MailLinkUi {
  key: string;
  url: string;
  label?: string;
}

interface MailAttachmentUi {
  fileName: string;
  category: string;
  version?: number;
  contentType?: string;
}

interface MailPreviewEnvelopeUi {
  audience: "maker" | "seven" | "kanei" | "customer";
  intendedTo: string;
  cc: string[];
  language: "ja" | "ko";
  subject: string;
  body: string;
  links: MailLinkUi[];
  attachments: MailAttachmentUi[];
  contentHash: string;
  effectiveTemplateIdentity: { key: string; source: "default" | "override" };
}

interface MailPreviewUi {
  dispatchGroupId: string;
  event?: string;
  envelopes: MailPreviewEnvelopeUi[];
  stagedTokens: Array<{ linkKey: string; url: string; expiresAt: string }>;
  stagedTokenHashes?: readonly string[];
  warnings?: string[];
}

interface MailLifecycleOutcomeUi {
  audience: "maker" | "seven" | "kanei" | "customer";
  attemptCount: number;
  status: "sending" | "sent" | "failed" | "unknown" | "retry_required" | "skipped";
  intendedTo: string;
  actualTo: string | null;
  recipientOverridden: boolean;
  smtpMessageId: string | null;
  errorCode: string | null;
  subject?: string;
  body?: string;
}

interface MailOutboxAttemptUi {
  id: number;
  attemptCount: number;
  status: "sending" | "sent" | "failed" | "unknown" | "retry_required" | "skipped";
  requestedByEmail?: string;
  intendedTo?: string;
  actualTo?: string | null;
  recipientOverridden?: boolean;
  smtpMessageId?: string | null;
  errorCode?: string | null;
  createdAt: string;
  attemptStartedAt: string;
  attemptFinishedAt: string | null;
}

interface MailOutboxUi {
  id: number;
  dispatchGroupId: string;
  workflowKey: string;
  audience: "maker" | "seven" | "kanei" | "customer";
  language: "ja" | "ko";
  envelopeStatus: "draft" | "composed" | "skipped" | "superseded";
  intendedTo?: string;
  cc?: string[];
  subject?: string;
  body?: string;
  links?: MailLinkUi[];
  attachments?: MailAttachmentUi[];
  contentHash?: string;
  requestedByEmail?: string;
  createdAt: string;
  updatedAt: string;
  attempts: MailOutboxAttemptUi[];
}

const STEP_DEFS: Array<{ key: string; label: string }> = [
  { key: "pending", label: "発注待ち" },
  { key: "ordered", label: "発注送信" },
  { key: "receiving_registered", label: "入稿" },
  { key: "proof_registered", label: "校正" },
  { key: "final_approved", label: "承認" },
  { key: "po_sent", label: "発注" },
  { key: "eta", label: "納期" },
];

type FilmOrderCompany = "seven" | "kanei";
type WorkflowRole = "seven" | "kanei" | "customer" | "buyer" | "mixed" | "supplier";

const actorLabelOf = (role: WorkflowRole): string => {
  if (role === "seven") return "セブン化学";
  if (role === "kanei" || role === "buyer") return "カネイ側";
  if (role === "customer") return "得意先";
  if (role === "supplier") return "フィルムメーカー";
  return "関係者";
};

function WorkflowRoleBadge({
  role,
  label,
}: {
  role: WorkflowRole;
  label?: string;
}) {
  const labels: Record<WorkflowRole, string> = {
    seven: "セブン化学",
    kanei: "カネイ側",
    customer: "得意先",
    buyer: "カネイ側",
    mixed: "関連各社",
    supplier: "フィルムメーカー",
  };
  return (
    <span className={`workflow-role-badge ${role}`}>
      <i aria-hidden="true" />
      {label || labels[role]}
    </span>
  );
}

function buyerRoleOf(order: Pick<FilmOrderView, "buyer_domain" | "created_by_email">): "seven" | "kanei" {
  return buyerCompanyOf(order) === "seven" ? "seven" : "kanei";
}

function primaryWorkflowRoleOf(order: Pick<FilmOrderView, "buyer_domain" | "created_by_email" | "customerProof" | "status">): "seven" | "kanei" {
  if (order.status === "receiving_registered" || order.status === "re_proof_requested") return "kanei";
  if (order.status === "proof_registered" && !supplierApprovalReadyOf(order)) return "kanei";
  return buyerRoleOf(order);
}

function workflowActionRoleOf(
  order: FilmOrderView,
  next: NextAction,
): "seven" | "kanei" | "supplier" {
  if (next.kind === "form") {
    if (next.form === "receiving") return buyerRoleOf(order);
    return "kanei";
  }
  if (next.kind === "run" && next.body.action === "approve") return buyerRoleOf(order);
  if (order.status === "final_approved") {
    if (!order.po_sent_at || !order.eta_date) return "kanei";
    if (order.shipTo.status !== "confirmed") return "seven";
    if (!order.delivery.shippedOn || !order.delivery.deliveredOn) return "supplier";
    if (!order.delivery.receivedAt) return "seven";
    return "supplier";
  }
  return primaryWorkflowRoleOf(order);
}

function buyerCompanyOf(order: Pick<FilmOrderView, "buyer_domain" | "created_by_email">): FilmOrderCompany {
  if (order.buyer_domain === "727.co.jp") return "seven";
  if (order.buyer_domain === "kanei-trade.co.jp") return "kanei";
  return buyerDomainOf(order.created_by_email);
}

function companyLabel(company: FilmOrderCompany): string {
  return company === "seven" ? "セブン化学" : "カネイ側";
}

function customerDesignReadyOf(order: Pick<FilmOrderView, "customerDesign">): boolean {
  return ["confirmed", "not_required", "legacy_exempt"].includes(order.customerDesign?.status as CustomerDesignStatus);
}

function supplierApprovalReadyOf(order: Pick<FilmOrderView, "customerProof">): boolean {
  return ["approved", "legacy_exempt"].includes(order.customerProof?.supplierApprovalStatus ?? "pending");
}

function proofBaseNameOf(fileName: string): string {
  return fileName.replace(/\.(ai|pdf)$/iu, "");
}

function latestProofPairOf(order: Pick<FilmOrderView, "files">) {
  const proofs = order.files
    .filter((file) => file.category === "proof")
    .sort((left, right) => right.version - left.version);
  const ai = proofs.find((file) => file.file_name.toLowerCase().endsWith(".ai"));
  const aiBase = ai ? proofBaseNameOf(ai.file_name) : "";
  const pdf = ai
    ? proofs.find((file) => file.file_name.toLowerCase().endsWith(".pdf") && proofBaseNameOf(file.file_name) === aiBase)
      ?? proofs.find((file) => file.file_name.toLowerCase().endsWith(".pdf"))
    : proofs.find((file) => file.file_name.toLowerCase().endsWith(".pdf"));
  return {
    ai,
    pdf,
    version: ai?.version ?? pdf?.version ?? 0,
  };
}

function workflowOwnerLabelOf(order: Pick<FilmOrderView, "buyer_domain" | "created_by_email">): string {
  return buyerCompanyOf(order) === "seven" ? "セブン化学" : "カネイ側";
}

function supplierLabelOf(order: Pick<FilmOrderView, "supplier_name" | "supplier_email">): string {
  void order;
  return "フィルムメーカー";
}

function workflowStageOf(order: FilmOrderView): FilmOrderWorkflowStage {
  return filmOrderStageOf({
    status: order.status,
    orderedAt: order.ordered_at,
    receivingRegisteredAt: order.receiving_registered_at,
    proofRegisteredAt: order.proof_registered_at,
    reProofRequestedAt: order.re_proof_requested_at,
    finalApprovedAt: order.final_approved_at,
    customerDesignStatus: order.customer_design_status,
    customerProofStatus: order.customer_proof_status,
    supplierApprovalStatus: order.supplier_approval_status,
    supplierApprovalAt: order.supplier_approval_at,
    buyerApprovalStatus: order.buyer_approval_status,
    buyerApprovalAt: order.buyer_approval_at,
    poSentAt: order.po_sent_at,
    etaUpdatedAt: order.eta_updated_at,
    shippedAt: order.film_shipped_at,
    deliveredAt: order.film_delivered_at,
    receivedAt: order.film_received_at,
  });
}

interface WorkflowActionPanelItem {
  action: FilmWorkflowAction;
  label: string;
  owner: WorkflowRole;
  enabled: boolean;
  reason: string;
}

function actorRoleOf(order: FilmOrderView, role: WorkflowRole): FilmOrderActorRole {
  void order;
  if (role === "seven" || role === "buyer") return "buyer";
  if (role === "kanei") return "kanei";
  if (role === "customer") return "customer";
  if (role === "supplier") return "maker";
  return "system";
}

function workflowActionBody(action: FilmWorkflowAction, order: FilmOrderView): Record<string, unknown> {
  switch (action) {
    case "send-po":
      return { action, supplierOrderNote: order.supplier_order_note ?? "" };
    case "confirm-film-receipt":
      return { action, note: order.film_received_note ?? "" };
    default:
      return { action };
  }
}

function workflowActionDecisionOf(
  order: FilmOrderView,
  action: FilmWorkflowAction,
  owner: WorkflowRole,
  isSeven: boolean,
  isKanei: boolean,
): WorkflowActionPanelItem {
  const snapshot = order.film_maker_snapshot_json
    ? JSON.parse(order.film_maker_snapshot_json) as Record<string, unknown>
    : null;
  const guard = {
    status: order.status,
    orderedAt: order.ordered_at,
    receivingRegisteredAt: order.receiving_registered_at,
    proofRegisteredAt: order.proof_registered_at,
    reProofRequestedAt: order.re_proof_requested_at,
    finalApprovedAt: order.final_approved_at,
    customerDesignStatus: order.customer_design_status,
    customerProofStatus: order.customer_proof_status,
    supplierApprovalStatus: order.supplier_approval_status,
    supplierApprovalAt: order.supplier_approval_at,
    buyerApprovalStatus: order.buyer_approval_status,
    buyerApprovalAt: order.buyer_approval_at,
    poSentAt: order.po_sent_at,
    etaUpdatedAt: order.eta_updated_at,
    shippedAt: order.film_shipped_at,
    deliveredAt: order.film_delivered_at,
    receivedAt: order.film_received_at,
    procurementRoute: order.procurement_route,
    printingMethod: order.printing_method,
    supplierResolution: order.supplier_resolution,
    supplierEmail: order.supplier_email,
    makerId: order.film_maker_id,
    makerSnapshot: snapshot,
    shipToStatus: order.ship_to_status,
    customerProofCorrectionCount: order.customer_proof_correction_count,
    receivingAiRegistered: order.files.some((file) => file.category === "receiving" && file.file_name.toLowerCase().endsWith(".ai")),
    receivingPdfRegistered: order.files.some((file) => file.category === "receiving" && file.file_name.toLowerCase().endsWith(".pdf")),
    customerProofPdfRegistered: order.files.some((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf")),
  };
  const decision = filmOrderActionAvailability(guard, action, actorRoleOf(order, owner));
  const authorized = owner === "seven" ? isSeven : owner === "kanei" ? isKanei : true;
  const reasonCode = authorized ? decision.reasons[0] : "actor_role_forbidden";
  return {
    action,
    label: actionLabelOf(action),
    owner,
    enabled: authorized && decision.available,
    reason: reasonCode ? filmOrderGuardReasonLabels[reasonCode] : "実行できます。",
  };
}

function actionLabelOf(action: FilmWorkflowAction): string {
  const labels: Record<FilmWorkflowAction, string> = {
    "mark-ordered": "発注書送信を確定",
    "register-receiving": "製作データを登録",
    "send-proof-notice": "校正案内を再送",
    "rotate-supplier-proof-token": "校正リンクを再発行",
    "register-proof": "校正データを登録",
    "send-customer-proof-review": "得意先校正確認を送る",
    "record-customer-proof-approval": "カネイ側校正承認を記録",
    approve: "最終承認する",
    "request-re-proof": "再校正を依頼",
    "send-po": "発注メールを送る",
    "update-eta": "納期見込みを更新",
    "report-shipment": "出荷を報告",
    "report-delivery": "納品を報告",
    "confirm-film-receipt": "フィルムを受領確認",
    "resend-receiving-notice": "入稿案内を再送",
    "resend-supplier-links": "発注書・報告リンクを再送",
  };
  return labels[action];
}

function workflowEffectOf(action: FilmWorkflowAction): string {
  const labels: Record<FilmWorkflowAction, string> = {
    "mark-ordered": "発注待ち → フィルムメーカー依頼前へ進めます。",
    "register-receiving": "データ入稿中へ進めます。",
    "send-proof-notice": "案件状態は変えずに校正案内を再送します。",
    "rotate-supplier-proof-token": "案件状態は変えずに校正リンクを再発行します。",
    "register-proof": "得意先校正確認中へ進めます。",
    "send-customer-proof-review": "案件状態は変えずに得意先へ確認を送ります。",
    "record-customer-proof-approval": "校正承認済みへ進めます。",
    approve: "最終承認処理中へ進めます。",
    "request-re-proof": "修正ループ中へ進めます。",
    "send-po": "フィルムメーカー発注済みへ進めます。",
    "update-eta": "納期見込み調整中として更新します。",
    "report-shipment": "出荷報告済みへ進めます。",
    "report-delivery": "納品報告済みへ進めます。",
    "confirm-film-receipt": "検収確認済みへ進めます。",
    "resend-receiving-notice": "案件状態は変えずに入稿案内を再送します。",
    "resend-supplier-links": "案件状態は変えずに既存リンクを再送します。",
  };
  return labels[action];
}

function statusHintOf(order: FilmOrderView): string {
  const owner = workflowOwnerLabelOf(order);
  const selfData = order.customerDesign.status === "not_required";
  switch (order.status) {
    case "pending":
      return `${owner}が発注書を送付し、「発注書送信済み」にします。`;
    case "ordered":
      return selfData
        ? `${owner}が自社製作データを入稿します。`
        : `得意先デザイン確定後、${owner}が製作データ（AI必須・PDF任意）を入稿します。`;
    case "receiving_registered":
      return "デザイン側の校正データアップロードを待っています。専用URLからの返却は自動反映されます。";
    case "proof_registered":
      return supplierApprovalReadyOf(order)
        ? `${owner}が校正を最終承認、または再校正を依頼します。`
        : "カネイ側の校正承認を待っています。承認後にBuyer最終承認ができます。";
    case "re_proof_requested":
      return "デザイン側の再校正データアップロードを待っています。専用URLからの返却は自動反映されます。";
    case "final_approved":
      if (!order.po_sent_at) return "カネイ側が発注書・報告リンクをフィルムメーカーへ送信します。";
      if (!order.eta_date) return `${supplierLabelOf(order)}の納期見込み入力を待っています。`;
      if (order.shipTo.status !== "confirmed") return "納品先の確認が必要です。セブン化学／カネイ側が確認できます。";
      if (!order.delivery.shippedOn) return `${supplierLabelOf(order)}の出荷報告を待っています。`;
      if (!order.delivery.deliveredOn) return `${supplierLabelOf(order)}の納品報告を待っています。`;
      if (!order.delivery.receivedAt) return "セブン化学のフィルム受領確認を待っています。";
      return "フィルム受領済み。パウチ製作へ進行します。";
  }
}

function canOperate(company: FilmOrderCompany, isSeven: boolean, isKanei: boolean): boolean {
  return company === "seven" ? isSeven : isKanei;
}

export function filmOrderStepRole(
  order: Pick<FilmOrderView, "buyer_domain" | "created_by_email" | "customerDesign">,
  status: FilmOrderStatus,
): FilmOrderCompany | "none" {
  const buyer = buyerCompanyOf(order);
  if (status === "ordered" && !customerDesignReadyOf(order)) return buyer;
  if (status === "pending" || status === "ordered" || status === "proof_registered") return buyer;
  if (status === "receiving_registered" || status === "re_proof_requested") return "kanei";
  return "none";
}

type NextAction =
  | { kind: "run"; label: string; body: Record<string, unknown>; ok: string }
  | { kind: "form"; label: string; form: "receiving" | "proof" | "design-mode" | "seller-approval" }
  | { kind: "none"; label: string };

export function nextActionOf(order: FilmOrderView, isSeven: boolean, isKanei: boolean): NextAction {
  const buyer = buyerCompanyOf(order);
  const buyerCanOperate = canOperate(buyer, isSeven, isKanei);
  switch (order.status) {
    case "pending":
      return buyerCanOperate
        ? { kind: "run", label: "発注書送信済みにする", body: { action: "mark-ordered" }, ok: "発注書送信済みにしました。" }
        : { kind: "none", label: `${companyLabel(buyer)}の発注書送信待ち` };
    case "ordered":
      if (!customerDesignReadyOf(order)) {
        return buyerCanOperate
          ? { kind: "form", label: "入稿方式を選択", form: "design-mode" }
          : { kind: "none", label: `${companyLabel(buyer)}の入稿方式選択待ち` };
      }
      return buyerCanOperate
        ? { kind: "form", label: "入稿データを登録", form: "receiving" }
        : { kind: "none", label: `${companyLabel(buyer)}の入稿登録待ち` };
    case "receiving_registered":
      return { kind: "none", label: "デザイン校正データのアップロード待ち" };
    case "proof_registered":
      if (!supplierApprovalReadyOf(order)) {
        return isKanei
          ? { kind: "form", label: "カネイ側の校正承認", form: "seller-approval" }
          : { kind: "none", label: "カネイ側の校正承認待ち" };
      }
      return buyerCanOperate
        ? { kind: "run", label: "校正を承認する", body: { action: "approve" }, ok: "校正を承認しました。" }
        : { kind: "none", label: `${companyLabel(buyer)}の承認待ち` };
    case "re_proof_requested":
      return { kind: "none", label: "デザイン再校正データのアップロード待ち" };
    case "final_approved":
      if (!order.po_sent_at) return { kind: "none", label: "カネイ側の発注書・報告リンク送信待ち" };
      if (!order.eta_date) return { kind: "none", label: `${supplierLabelOf(order)}の納期見込み入力待ち` };
      if (order.shipTo.status === "registered") {
        return buyerCanOperate
          ? { kind: "run", label: "納品先を確認する", body: { action: "confirm-ship-to" }, ok: "納品先を確認しました。" }
          : { kind: "none", label: "納品先の確認待ち" };
      }
      if (order.shipTo.status !== "confirmed") return { kind: "none", label: "納品先の登録待ち" };
      if (!order.delivery.shippedOn) return { kind: "none", label: `${supplierLabelOf(order)}の出荷報告待ち` };
      if (!order.delivery.deliveredOn) return { kind: "none", label: `${supplierLabelOf(order)}の納品報告待ち` };
      if (!order.delivery.receivedAt) {
        return buyerCanOperate
          ? { kind: "run", label: "フィルムを受領確認", body: { action: "confirm-film-receipt" }, ok: "フィルムの受領を確認しました。" }
          : { kind: "none", label: "セブン化学のフィルム受領確認待ち" };
      }
      return { kind: "none", label: "完了" };
  }
}

function orderTotalText(order: FilmOrderView): string {
  const po = order.purchaseOrder;
  const total = D(po?.filmCostYen ?? "0")
    .plus(po?.copperPlate ? D(po.copperPlate.priceYen) : D(0))
    .plus(po?.customMold ? D(po.customMold.costYen) : D(0));
  return `￥${Number(total.toFixed(0)).toLocaleString("ja-JP")}`;
}

export default function FilmOrdersClient({ userEmail }: { userEmail: string }) {
  const [orders, setOrders] = useState<FilmOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"all" | FilmOrderStatus>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const [detailError, setDetailError] = useState("");
  const [focusForm, setFocusForm] = useState<{ id: number; kind: "receiving" | "proof" | "design-mode" | "seller-approval" } | null>(null);
  const [driveReady, setDriveReady] = useState(false);
  const isSeven = isSevenChemicalUser(userEmail);
  const isKanei = isKaneiTradeUser(userEmail);
  const [mailRouting, setMailRouting] = useState<{ enabled: boolean; recipient: string }>({
    enabled: false,
    recipient: "",
  });

  const load = useCallback(async () => {
    const fetchOrders = async () => {
      const response = await fetch("/api/film-orders", {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.orders)) throw new Error();
      return payload as { orders: FilmOrderView[]; created: number; driveConfigured: boolean };
    };
    setLoading(true);
    setError("");
    try {
      let payload;
      try {
        payload = await fetchOrders();
      } catch (error) {
        // 初回アクセス時のスキーマ移行・dev再コンパイルで 1 回目がタイムアウトすることがあるため、
        // TimeoutError の場合は 1 回だけ自動で再取得する。
        if (!(error instanceof DOMException && error.name === "TimeoutError")) throw error;
        payload = await fetchOrders();
      }
      setOrders(payload.orders);
      setCreated(Number(payload.created ?? 0));
      setDriveReady(payload.driveConfigured === true);
    } catch (error) {
      setError(error instanceof DOMException && error.name === "TimeoutError"
        ? "発注データの取得がタイムアウトしました。更新してください。"
        : "発注データを読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoadingId(id);
    setDetailError("");
    try {
      const response = await fetch(`/api/film-orders/${id}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json();
      if (!response.ok || !payload.order) throw new Error();
      const order = payload.order as FilmOrderView;
      setOrders((old) => old.map((item) => item.id === id ? order : item));
    } catch (error) {
      setDetailError(error instanceof DOMException && error.name === "TimeoutError"
        ? "発注詳細の取得がタイムアウトしました。更新してください。"
        : "発注詳細を読み込めませんでした。");
    } finally {
      setDetailLoadingId((current) => current === id ? null : current);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時にサーバーから発注一覧を取得する意図的な処理です。
    void load();
  }, [load]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/film-orders/mail-routing", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok) return;
        setMailRouting({
          enabled: payload.enabled === true,
          recipient: typeof payload.recipient === "string" ? payload.recipient : "",
        });
      } catch {
        // 확인용 정보이므로 실패해도 워크플로는 막지 않는다.
      }
    })();
    return () => controller.abort();
  }, []);

  const filtered = useMemo(
    () => statusFilter === "all" ? orders : orders.filter((order) => order.status === statusFilter),
    [orders, statusFilter],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>([["all", orders.length]]);
    for (const status of FILM_ORDER_STATUSES) {
      map.set(status, orders.filter((order) => order.status === status).length);
    }
    return map;
  }, [orders]);
  const myTurnCount = useMemo(() => orders.filter((order) => {
    const next = nextActionOf(order, isSeven, isKanei);
    return next.kind !== "none";
  }).length, [orders, isSeven, isKanei]);

  const applyResult = (id: number, result: { order: FilmOrderView }) => {
    setOrders((old) => old.map((order) => order.id === id ? result.order : order));
  };

  const toggleOrder = (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      setFocusForm(null);
      return;
    }
    setExpandedId(id);
    void loadDetail(id);
  };

  const expandWithForm = (id: number, kind: "receiving" | "proof" | "design-mode" | "seller-approval") => {
    toggleOrder(id);
    setFocusForm({ id, kind });
  };

  return (
    <main className="film-orders-page">
      <header className="film-orders-head">
        <div>
          <p className="film-orders-eyebrow">FILM PROCUREMENT WORKFLOW</p>
          <h1>フィルム発注管理</h1>
        </div>
        <div className="film-orders-toolbar">
          <span className={`film-orders-role ${isSeven ? "seven" : "kanei"}`}>
            {isSeven ? "セブン化学" : "カネイ側"}
          </span>
          <span className="film-orders-myturn" role="status" aria-live="polite">
            あなたの操作待ち <strong>{myTurnCount}</strong> 件
          </span>
          <button className="button secondary small" type="button" onClick={() => {
            void load().then(() => {
              if (expandedId != null) return loadDetail(expandedId);
            });
          }}>
            {loading ? "読み込み中..." : "更新"}
          </button>
        </div>
      </header>
      <p className="film-orders-lead">
        得意先はパウチ充填製造をセブン化学へ発注し、セブン化学がフィルムをカネイ側へ発注します。成約見積から自動作成された発注を、ステップに沿って管理します。
      </p>

      <div className="workflow-role-legend" aria-label="担当会社ごとの色と注力ポイント">
        <div className="workflow-role-legend-item role-seven">
          <WorkflowRoleBadge role="seven" />
          <p>入稿データ登録・Buyer最終承認・納品先/受領確認</p>
        </div>
        <div className="workflow-role-legend-item role-kanei">
          <WorkflowRoleBadge role="kanei" />
          <p>校正データ登録・カネイ側承認・フィルムメーカー発注・納期</p>
        </div>
        <div className="workflow-role-legend-item role-customer">
          <WorkflowRoleBadge role="customer" />
          <p>得意先デザインアップロード・校正レビュー</p>
        </div>
      </div>

      <div className="film-orders-alerts">
        {created > 0 ? <p className="film-orders-sync">成約見積 {created} 件を発注管理に反映しました。</p> : null}
        {error ? <p className="film-orders-error">{error}</p> : null}
        {detailError ? <p className="film-orders-error">{detailError}</p> : null}
      </div>

      <details className="film-order-guide">
        <summary>{isSeven ? "セブン化学担当者の流れ" : "カネイ側担当者の流れ"}</summary>
        {isSeven ? (
          <ol>
            <li>見積履歴で見積を「成約」にすると、ここに発注が自動作成されます。</li>
            <li>発注内容を確認し、発注書をメールでカネイ側へ送付したら「発注書送信済みにする」を押します。</li>
            <li>フィルム製作用データを「入稿データを登録」します（AI必須・PDF任意。design@ へ自動連絡）。</li>
            <li>校正データが登録されたら「校正を承認」または「再校正を依頼」します。</li>
          </ol>
        ) : (
          <ol>
            <li>成約後の発注は自動的にここに表示されます（発注番号 F-…）。</li>
            <li>仕入先・校正データ送付先を設定します。</li>
            <li>フィルムメーカーから校正データが返却されたら「校正データを登録」します（セブン化学へ自動連絡）。</li>
            <li>再校正依頼が来たら再校正データを登録します。</li>
          </ol>
        )}
      </details>

      <nav className="film-orders-tabs" aria-label="発注ステータスで絞り込む">
        <button
          type="button"
          aria-pressed={statusFilter === "all"}
          className={statusFilter === "all" ? "active" : ""}
          data-role="all"
          onClick={() => setStatusFilter("all")}
        >
          全件 <b>{counts.get("all") ?? 0}</b>
        </button>
        {FILM_ORDER_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={statusFilter === status}
            className={statusFilter === status ? "active" : ""}
            data-role={status === "receiving_registered" || status === "re_proof_requested" ? "kanei" : "buyer"}
            onClick={() => setStatusFilter(status)}
          >
            {filmOrderStatusLabels[status]} <b>{counts.get(status) ?? 0}</b>
          </button>
        ))}
      </nav>

      {loading && orders.length === 0 ? <p className="film-orders-empty">読み込み中...</p> : null}
      {!loading && filtered.length === 0 ? <p className="film-orders-empty">該当する発注はありません。見積履歴で成約処理を行うと自動的に作成されます。</p> : null}

      <div className="film-orders-list">
        {filtered.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            expanded={expandedId === order.id}
            loadingDetail={detailLoadingId === order.id}
            onToggle={() => toggleOrder(order.id)}
            onUpdated={applyResult}
            onExpandWithForm={expandWithForm}
            focusForm={focusForm}
            isSeven={isSeven}
            isKanei={isKanei}
            driveReady={driveReady}
            mailRouting={mailRouting}
          />
        ))}
      </div>
    </main>
  );
}

type PendingWorkflowRun = {
  body: Record<string, unknown>;
  okMessage: string;
  preview: MailPreviewUi;
};

type MailRoutingState = {
  enabled: boolean;
  recipient: string;
};

const MAIL_WORKFLOW_ACTIONS = new Set([
  "register-receiving",
  "send-proof-notice",
  "rotate-supplier-proof-token",
  "register-proof",
  "request-customer-design-upload",
  "request-customer-design-correction",
  "send-customer-proof-review",
  "record-customer-proof-approval",
  "request-re-proof",
  "approve",
  "send-po",
  "resend-supplier-links",
  "request-production-plan",
  "request-ship-to-registration",
  "confirm-film-receipt",
]);

function isMailWorkflowAction(action: unknown): boolean {
  return typeof action === "string" && MAIL_WORKFLOW_ACTIONS.has(action);
}

function audienceLabelOf(audience: MailPreviewEnvelopeUi["audience"]): string {
  const labels = {
    maker: "フィルムメーカー",
    seven: "セブン化学",
    kanei: "カネイ側",
    customer: "得意先",
  } as const;
  return labels[audience];
}

function mailStatusTextOf(status: MailOutboxUi["attempts"][number]["status"]): string {
  const labels = {
    sending: "送信中",
    sent: "送信済み",
    failed: "送信失敗",
    unknown: "結果不明",
    retry_required: "再送が必要",
    skipped: "送信対象外",
  } as const;
  return labels[status];
}

function mailStatusLabelOf(status: MailOutboxUi["envelopeStatus"]): string {
  const labels = {
    draft: "プレビュー保留",
    composed: "送信キュー",
    skipped: "取消済み",
    superseded: "置き換え済み",
  } as const;
  return labels[status];
}

function notificationSummaryOf(outcomes: MailLifecycleOutcomeUi[]): string {
  if (!outcomes.length) return "通知なし";
  if (outcomes.every((outcome) => outcome.status === "sent")) return "全宛先送信済み";
  if (outcomes.some((outcome) => outcome.status === "sending")) return "送信中";
  if (outcomes.some((outcome) => outcome.status === "unknown")) return "結果不明・要確認";
  if (outcomes.some((outcome) => outcome.status === "retry_required")) return "再送が必要";
  if (outcomes.some((outcome) => outcome.status === "failed")) return "送信失敗あり";
  return "送信対象外を含む";
}

function OrderCard({
  order,
  expanded,
  loadingDetail,
  onToggle,
  onUpdated,
  onExpandWithForm,
  focusForm,
  isSeven,
  isKanei,
  driveReady,
  mailRouting,
}: {
  order: FilmOrderView;
  expanded: boolean;
  loadingDetail: boolean;
  onToggle: () => void;
  onUpdated: (id: number, result: { order: FilmOrderView }) => void;
  onExpandWithForm: (id: number, kind: "receiving" | "proof" | "design-mode" | "seller-approval") => void;
  focusForm: { id: number; kind: "receiving" | "proof" | "design-mode" | "seller-approval" } | null;
  isSeven: boolean;
  isKanei: boolean;
  driveReady: boolean;
  mailRouting: MailRoutingState;
}) {
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState("");
  const [mails, setMails] = useState<MailResult[]>([]);
  const [lifecycleOutcomes, setLifecycleOutcomes] = useState<MailLifecycleOutcomeUi[]>([]);
  const [lifecycleCompleted, setLifecycleCompleted] = useState<boolean | null>(null);
  const [outbox, setOutbox] = useState<MailOutboxUi[]>([]);
  const [outboxError, setOutboxError] = useState(false);
  const [outboxLoaded, setOutboxLoaded] = useState(false);
  const [pendingRun, setPendingRun] = useState<PendingWorkflowRun | null>(null);
  const [operationTab, setOperationTab] = useState<"ship" | "sample" | "design" | "review" | "history" | "notifications">(() => {
    if (order.status === "ordered" && !customerDesignReadyOf(order) && canOperate(buyerCompanyOf(order), isSeven, isKanei)) return "design";
    if (order.status === "final_approved" && order.shipTo.status !== "confirmed") return "ship";
    if (["proof_registered", "re_proof_requested"].includes(order.status)) return "review";
    return "sample";
  });
  const next = nextActionOf(order, isSeven, isKanei);
  const stage = workflowStageOf(order);
  const activeSupportTab = next.kind === "form" && next.form === "design-mode"
    ? "design" as const
    : operationTab;
  const statusBadgeClass = order.status === "final_approved" ? "final" : order.status === "re_proof_requested" ? "warn" : "";
  const buyerOwner = buyerRoleOf(order);
  const actionItems = [
    workflowActionDecisionOf(order, "mark-ordered", buyerOwner, isSeven, isKanei),
    workflowActionDecisionOf(order, "register-receiving", buyerOwner, isSeven, isKanei),
    workflowActionDecisionOf(order, "approve", buyerOwner, isSeven, isKanei),
    workflowActionDecisionOf(order, "confirm-film-receipt", buyerOwner, isSeven, isKanei),
    workflowActionDecisionOf(order, "send-po", "kanei", isSeven, isKanei),
    workflowActionDecisionOf(order, "resend-supplier-links", "kanei", isSeven, isKanei),
  ];

  const loadOutbox = useCallback(async () => {
    try {
      const response = await fetch(`/api/film-orders/${order.id}/mail-outbox`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.envelopes)) throw new Error();
      setOutbox(payload.envelopes as MailOutboxUi[]);
      setOutboxError(false);
    } catch {
      setOutboxError(true);
    } finally {
      setOutboxLoaded(true);
    }
  }, [order.id]);

  useEffect(() => {
    if (!expanded || outboxLoaded) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 展開時にアウトボックス履歴を一度だけ取得します。
    void loadOutbox();
  }, [expanded, loadOutbox, outboxLoaded]);

  const applyPayload = (payload: Record<string, unknown>) => {
    if (payload.order) onUpdated(order.id, payload as { order: FilmOrderView });
    setMails((payload.mails ?? []) as MailResult[]);
    const lifecycle = payload.lifecycle as { outcomes?: MailLifecycleOutcomeUi[]; workflowCompleted?: boolean } | undefined;
    setLifecycleOutcomes(lifecycle?.outcomes ?? []);
    setLifecycleCompleted(lifecycle?.workflowCompleted ?? null);
    setOutboxLoaded(false);
    setOutbox([]);
  };

  const runDirect = async (body: Record<string, unknown>, okMessage: string) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setMails([]);
    setLifecycleOutcomes([]);
    setLifecycleCompleted(null);
    try {
      const response = await fetch(`/api/film-orders/${order.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: window.location.origin, ...body }),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok || !payload.order) throw new Error(String(payload.error ?? "failed"));
      applyPayload(payload);
      const outcomes = ((payload.lifecycle as { outcomes?: MailLifecycleOutcomeUi[] } | undefined)?.outcomes ?? []);
      const overridden = outcomes.some((outcome) => outcome.recipientOverridden);
      setMessage(overridden
        ? `${okMessage}（テストモードのため実際送信先は設定済みテスト宛先です。）`
        : okMessage);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "failed";
      const humanMessages: Record<string, string> = {
        invalid_ai_file: "AIファイルが必要です。.ai ファイルを選択してください。",
        invalid_pdf_file: "PDFファイル名が不正です。.pdf ファイルを選択するか、PDFチェックを外してください。",
        invalid_pdf_file_url: "PDFのDriveアップロードが完了していません。完了後に登録してください。",
        invalid_ai_file_url: "AIのDriveアップロードが完了していません。完了後に登録してください。",
        invalid_file_url: "ファイルURLが正しくありません。",
        customer_design_confirmation_required: "先に得意先デザインを確定または不要設定してください。",
        customer_design_not_required_reason_required: "入稿方式の設定メモを入力してください。",
        invalid_ship_to: "納品先の必須項目を確認してください。更新後に再度お試しください。",
        delivery_destination_not_found: "選択された住所録が見つかりません。更新後に再度お試しください。",
        invalid_production_plan_date: "生産予定の開始日と終了日を入力してください。",
        invalid_production_plan_range: "生産予定の終了日は開始日以降にしてください。",
        sample_bulk_quantity_required: "サンプル量は0より大きい数値で入力してください。",
        customer_proof_pdf_required: "得意先確認用の校正PDFが必要です。",
        supplier_approval_required: "先にカネイ側の校正承認を記録してください。",
        customer_proof_release_required: "得意先／カネイ側の校正リリース確認が必要です。",
        customer_email_required: "得意先メールアドレスが未登録のため依頼メールを送信できません。",
        upload_guide_acknowledgement_required: "データ入稿ガイド3冊の確認チェックが必要です。",
        customer_proof_evidence_required: "承認者と証拠・経緯を入力してください。",
        film_order_mail_hash_mismatch: "メール内容が変わったため、新しいプレビューを作成してください。",
        film_maker_resolution_required: "先にフィルムメーカーを選択してください。",
        maker_data_packet_required: "フィルムメーカー連絡に必要なAI/PDFデータが不足しています。",
        supplier_destination_missing: "フィルムメーカー送信先が未設定です。",
      };
      setMessage(rawMessage && humanMessages[rawMessage] ? `失敗しました（${humanMessages[rawMessage]}）` : "失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (body: Record<string, unknown>, okMessage: string) => {
    if (busy || previewing) return;
    setBusy(true);
    setPreviewing(true);
    setMessage("");
    setMails([]);
    setLifecycleOutcomes([]);
    setLifecycleCompleted(null);
    try {
      const response = await fetch(`/api/film-orders/${order.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: window.location.origin, ...body, mailMode: "preview" }),
      });
      const payload = await response.json() as { preview?: MailPreviewUi; error?: string };
      if (!response.ok || !payload.preview) throw new Error(String(payload.error ?? "preview_failed"));
      setPendingRun({ body, okMessage, preview: payload.preview });
    } catch (error) {
      const raw = error instanceof Error ? error.message : "preview_failed";
      setMessage(raw === "preview_failed" ? "メールプレビューを作成できませんでした。" : `失敗しました（${raw}）`);
    } finally {
      setBusy(false);
      setPreviewing(false);
    }
  };

  const run = async (body: Record<string, unknown>, okMessage: string) => {
    if (isMailWorkflowAction(body.action)) return runPreview(body, okMessage);
    return runDirect(body, okMessage);
  };

  const cancelPending = async () => {
    const pending = pendingRun;
    if (!pending || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/film-orders/${order.id}/mail-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "cancel", dispatchGroupId: pending.preview.dispatchGroupId }),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.error ?? "cancel_failed"));
      if (payload.order) onUpdated(order.id, payload as { order: FilmOrderView });
      setPendingRun(null);
      setMails([]);
      setLifecycleOutcomes([]);
      setLifecycleCompleted(null);
      setMessage("メール送信を取り消しました。業務状態は変更されていません。");
      setOutboxLoaded(false);
      setOutbox([]);
    } catch {
      setMessage("メール送信を取り消せませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const retryOutbox = async (dispatchGroupId: string) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/film-orders/${order.id}/mail-dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "retry", dispatchGroupId }),
      });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(payload.error ?? "retry_failed"));
      if (payload.order) onUpdated(order.id, payload as { order: FilmOrderView });
      const outcomes = (payload.outcomes ?? []) as MailLifecycleOutcomeUi[];
      setLifecycleOutcomes(outcomes);
      setLifecycleCompleted(false);
      setMessage(outcomes.every((outcome) => outcome.status === "sent")
        ? "送信を再試行しました。"
        : "送信を再試行しましたが、一部の結果が確定していません。");
      await loadOutbox();
    } catch {
      setMessage("この送信は再試行できません。");
    } finally {
      setBusy(false);
    }
  };

  const testModeNote = mailRouting.enabled ? (
    <p className="workflow-mail-routing-note" role="note" data-testid="workflow-mail-test-routing">
      <strong>テストモード ON：</strong>
      実際の送信先は <span>{mailRouting.recipient}</span> に変更されます。宛先欄は正規宛先を表示します。
    </p>
  ) : null;
  const persistedMailWarnings = (
    <div className="mail-routing-warning" data-testid="mail-preview-warnings">
      {(pendingRun?.preview.warnings ?? []).map((warning) => (
        <p key={warning} role="alert">
          {warning === "mail_test_mode_enabled"
            ? "保存済みメール設定のテストモードが有効です。"
            : warning === "mail_environment_recipient_override_enabled"
              ? "環境変数 MAIL_RECIPIENT_OVERRIDE が有効です。"
              : warning}
        </p>
      ))}
    </div>
  );

  return (
    <>
    <article
      className={`film-order-card ${expanded ? "expanded" : ""}`}
      data-print-target={expanded ? "true" : undefined}
      data-testid={`film-order-card-${order.id}`}
    >
      <div className="film-order-summary" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }}
        aria-expanded={expanded}>
        <div className="film-order-summary-main">
          <div className="film-order-titleline">
            <span className="film-order-number">{order.order_number}</span>
            <span className="film-order-product">{order.product_name || "-"}</span>
            <span className={`film-order-status ${statusBadgeClass}`}>{filmOrderStatusLabels[order.status]}</span>
          </div>
          <div className="film-order-metaline">
            <WorkflowRoleBadge role={buyerRoleOf(order)} label={companyLabel(buyerRoleOf(order))} />
            <WorkflowRoleBadge role="customer" label={order.customer_name || "得意先未設定"} />
            <span className="film-order-stage-chip" data-testid={`workflow-stage-${order.id}`}>
              状態: {filmOrderWorkflowStageLabels[stage]}
            </span>
            {order.procurement_route ? <span className="film-order-chip">調達 {order.procurement_route}</span> : null}
            {order.web_width_mm ? <span className="film-order-chip">{order.web_width_mm}mm</span> : null}
            {order.order_length_m ? <span className="film-order-chip">{Number(order.order_length_m).toLocaleString("ja-JP")}m</span> : null}
            <span className="film-order-chip total">{orderTotalText(order)}</span>
          </div>
        </div>
        <div className="film-order-summary-actions" onClick={(event) => event.stopPropagation()}>
          {next.kind === "run" ? (
            <button className={`button small workflow-action role-${workflowActionRoleOf(order, next)}`} type="button" disabled={busy || previewing} onClick={() => void run(next.body, next.ok)}>
              {next.label}
            </button>
          ) : null}
          {next.kind === "form" ? (
            <button className={`button small workflow-action role-${workflowActionRoleOf(order, next)}`} type="button" onClick={() => onExpandWithForm(order.id, next.form)}>
              {next.label}
            </button>
          ) : null}
          {next.kind === "none" ? <span className="film-order-next-wait">{next.label}</span> : null}
          <button className="film-order-toggle" type="button" onClick={onToggle} aria-label={expanded ? "詳細を閉じる" : "詳細を開く"}>
            {expanded ? "▲" : "▼"}
          </button>
        </div>
      </div>

      <OrderSteps order={order} status={order.status} reProofCount={order.re_proof_count} poSent={Boolean(order.po_sent_at)} etaDate={order.eta_date} />
      {order.eta_date ? (
        <div className="film-order-eta-row">
          <span className="film-order-eta-badge">納期見込み {order.eta_date}</span>
          {order.eta_note ? <small>{order.eta_note}</small> : null}
          {order.delivery.shippedOn && order.eta_date > order.delivery.shippedOn ? (
            <small className="film-order-eta-warning">出荷報告済み。納期見込みを実績に合わせて更新してください。</small>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="film-order-detail">
          {loadingDetail ? <p className="film-order-message" role="status">詳細データを読み込み中...</p> : null}
          {loadingDetail ? null : (
          <>
          {message ? <p className="film-order-message" role="status">{message}</p> : null}
          {lifecycleOutcomes.length > 0 ? (
            <section className="film-order-section notification-outcome-section" aria-label="送信結果">
              <h3>送信結果</h3>
              <p data-testid="workflow-notification-split">
                <strong>業務状態：</strong>{lifecycleCompleted === true ? "完了" : lifecycleCompleted === false ? "業務状態変更なし" : "-"}
                <span aria-hidden="true"> / </span>
                <strong>通知状態：</strong>{notificationSummaryOf(lifecycleOutcomes)}
              </p>
              <ul className="mail-outcome-list" data-testid={`mail-outcomes-${order.id}`}>
                {lifecycleOutcomes.map((outcome, index) => (
                  <li key={`${outcome.audience}-${index}`} className={outcome.status}>
                    <strong>{audienceLabelOf(outcome.audience)}</strong>
                    <span data-testid="mail-attempt-status">{mailStatusTextOf(outcome.status)}</span>
                    <small>宛先 {outcome.intendedTo} / 試行 {outcome.attemptCount}</small>
                    {outcome.errorCode ? <small>エラー: {outcome.errorCode}</small> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {mailRouting.enabled ? testModeNote : null}
          {persistedMailWarnings}

          <WorkflowActionPanel
            order={order}
            stage={stage}
            actions={actionItems}
            busy={busy || previewing}
            onRun={run}
          />

          <div className="film-order-columns">
            <OrderSheet order={order} />
            <div className="film-order-side">
              <NextStepPanel
                order={order}
                isSeven={isSeven}
                isKanei={isKanei}
                busy={busy || previewing}
                focused={focusForm?.id === order.id ? focusForm.kind : null}
                onRun={run}
                onExpandWithForm={onExpandWithForm}
                driveReady={driveReady}
              />
            </div>
          </div>

          <section className="support-workbench" aria-label="進行管理">
            <div className="support-tabbar" role="tablist" aria-label="進行管理切替">
              {([
                ["ship", "納品先"],
                ["sample", "サンプル"],
                ["design", "デザイン"],
                ["review", "校正レビュー"],
                ["notifications", "通知"],
                ["history", "データ・履歴"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`film-order-support-tab-${order.id}-${key}`}
                  aria-controls={`film-order-support-panel-${order.id}`}
                  aria-selected={operationTab === key}
                  className={operationTab === key ? "active" : ""}
                  data-role={key === "ship" ? buyerRoleOf(order) : key === "sample" || key === "design" || key === "review" ? "customer" : "all"}
                  onClick={() => setOperationTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div
              className="support-panel"
              role="tabpanel"
              id={`film-order-support-panel-${order.id}`}
              aria-labelledby={`film-order-support-tab-${order.id}-${activeSupportTab}`}
              tabIndex={0}
            >
              {operationTab === "ship" ? <ShipToPanel order={order} isSeven={isSeven} isKanei={isKanei} busy={busy || previewing} onRun={run} /> : null}
              {operationTab === "sample" ? <SampleBulkPanel order={order} /> : null}
              {operationTab === "design" ? <CustomerDesignPanel order={order} isSeven={isSeven} isKanei={isKanei} busy={busy || previewing} onRun={run} /> : null}
              {operationTab === "review" ? <CustomerProofPanel order={order} isKanei={isKanei} busy={busy || previewing} onRun={run} /> : null}
              {operationTab === "notifications" ? (
                <MailOutboxPanel
                  order={order}
                  isKanei={isKanei}
                  envelopes={outbox}
                  loaded={outboxLoaded}
                  error={outboxError}
                  busy={busy}
                  onRetry={retryOutbox}
                  onReload={loadOutbox}
                />
              ) : null}
              {operationTab === "history" ? (
                <>
                  <section className="film-order-section">
                    <h3>入稿・校正データ履歴</h3>
                    {order.files.length === 0 ? <p>まだ登録されていません。</p> : (
                      <div className="table-scroll">
                        <table className="film-order-files">
                          <thead><tr><th>種別</th><th>ファイル名</th><th>リンク</th><th>プレビュー</th><th>v</th><th>登録者</th><th>日時</th></tr></thead>
                          <tbody>
                            {order.files.map((file) => (
                              <tr key={file.id}>
                                <td><span className={`film-order-file-badge ${file.category}`}>{file.category === "receiving" ? "入稿" : file.category === "proof" ? "校正" : "最終"}</span></td>
                                <td>{file.file_name}</td>
                                <td>{file.url ? <a href={file.url} target="_blank" rel="noreferrer">開く</a> : "-"}</td>
                                <td>
                                  {file.url && isPreviewable(file.file_name) ? (
                                    <button className="button secondary small" type="button" onClick={() => openPreview(file.url, file.file_name)}>表示</button>
                                  ) : "-"}
                                </td>
                                <td>{file.version}</td>
                                <td>{file.uploaded_by_email}</td>
                                <td>{new Date(file.created_at).toLocaleString("ja-JP")}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                  <section className="film-order-section">
                    <h3>履歴</h3>
                    <ul className="film-order-events">
                      {order.events.map((event) => (
                        <li key={event.id}>
                          <span className={`film-order-event-type ${event.type}`}>{event.type}</span>
                          <span>{event.detail}</span>
                          <small>{event.actor_email} / {new Date(event.created_at).toLocaleString("ja-JP")}</small>
                        </li>
                      ))}
                    </ul>
                  </section>
                </>
              ) : null}
            </div>
          </section>
          </>
          )}
        </div>
      ) : null}
    </article>
    {pendingRun ? (
      <MailPreviewDialog
        action={String(pendingRun.body.action)}
        preview={pendingRun.preview}
        testModeNote={testModeNote}
        persistedWarnings={persistedMailWarnings}
        busy={busy}
        onCancel={() => void cancelPending()}
        onDismiss={() => setPendingRun(null)}
        onConfirm={() => {
          const selected = pendingRun;
          setPendingRun(null);
          void runDirect({
            ...selected.body,
            mailMode: "confirm",
            mailEnvelopeHashes: selected.preview.envelopes.map((envelope) => envelope.contentHash),
            mailDispatchGroupId: selected.preview.dispatchGroupId,
          }, selected.okMessage);
        }}
      />
    ) : null}
    </>
  );
}

function WorkflowActionPanel({
  order,
  stage,
  actions,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  stage: FilmOrderWorkflowStage;
  actions: WorkflowActionPanelItem[];
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const stageIndex = FILM_ORDER_WORKFLOW_STAGES.indexOf(stage);
  return (
    <section className="film-order-section workflow-action-panel" aria-labelledby={`workflow-action-panel-${order.id}`} data-testid={`workflow-action-panel-${order.id}`}>
      <h3 id={`workflow-action-panel-${order.id}`}>承認・送信アクション</h3>
      <div className="workflow-stage-track" data-testid={`workflow-stage-track-${order.id}`}>
        {FILM_ORDER_WORKFLOW_STAGES.map((item, index) => (
          <span key={item} className={index < stageIndex ? "done" : index === stageIndex ? "active" : ""}>
            {filmOrderWorkflowStageLabels[item]}
          </span>
        ))}
      </div>
      <div className="workflow-action-grid">
        {actions.map((item) => (
          <div key={item.action} className="workflow-action-cell" data-testid={`workflow-action-${item.action}`}>
            <WorkflowRoleBadge role={item.owner} label={actorLabelOf(item.owner)} />
            <button
              className={`button workflow-action role-${item.owner}`}
              type="button"
              disabled={!item.enabled || busy}
              aria-disabled={!item.enabled || busy}
              aria-describedby={`workflow-action-reason-${order.id}-${item.action}`}
              onClick={() => void onRun(workflowActionBody(item.action, order), `${item.label}しました。`)}
            >
              {item.label}
            </button>
            <p id={`workflow-action-reason-${order.id}-${item.action}`} className="workflow-action-reason" role={item.enabled ? undefined : "note"}>
              {busy && item.enabled ? "処理中..." : item.reason}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function MailPreviewDialog({
  action,
  preview,
  testModeNote,
  persistedWarnings,
  busy,
  onConfirm,
  onCancel,
  onDismiss,
}: {
  action: string;
  preview: MailPreviewUi;
  testModeNote: React.ReactNode;
  persistedWarnings: React.ReactNode;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const titleId = `mail-preview-title-${preview.dispatchGroupId}`;

  useEffect(() => {
    previousActiveRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
    );
    focusables?.[0]?.focus();
    return () => previousActiveRef.current?.focus();
  }, [preview.dispatchGroupId]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
    ) ?? []).filter((item) => item.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="workflow-mail-confirm-layer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleKeyDown}>
      <article className="workflow-mail-confirm-panel" ref={panelRef}>
        <header>
          <span>MAIL PREVIEW</span>
          <h4 id={titleId}>{actionLabelOf(action as FilmWorkflowAction)}</h4>
        </header>
        <div className="workflow-mail-confirm-body" data-testid="workflow-mail-preview">
          <p><strong>送信グループ：</strong><code>{preview.dispatchGroupId}</code></p>
          {preview.envelopes.map((envelope, index) => (
            <section
              key={envelope.contentHash + String(index)}
              className="mail-preview-envelope"
              data-testid="workflow-mail-envelope"
              data-language={envelope.language}
            >
              <h5>{audienceLabelOf(envelope.audience)} / {envelope.language === "ko" ? "한국語" : "日本語"}</h5>
              <p><strong>To：</strong><span>{envelope.intendedTo}</span></p>
              {envelope.cc.length > 0 ? <p><strong>CC：</strong><span>{envelope.cc.join("、")}</span></p> : null}
              <p><strong>件名：</strong><span>{envelope.subject}</span></p>
              <pre>{envelope.body}</pre>
              {envelope.links.length > 0 ? (
                <div><strong>型付きリンク：</strong>
                  <ul>{envelope.links.map((link) => <li key={link.key}>{link.label || link.key}: <code>{link.url}</code></li>)}</ul>
                </div>
              ) : null}
              {envelope.attachments.length > 0 ? (
                <div><strong>添付対象データ：</strong>
                  <ul>{envelope.attachments.map((attachment, attachmentIndex) => (
                    <li key={`${attachment.fileName}-${attachmentIndex}`}>{attachment.fileName} / {attachment.category}{attachment.version ? ` v${attachment.version}` : ""}{attachment.contentType ? ` / ${attachment.contentType}` : ""}</li>
                  ))}</ul>
                </div>
              ) : <p><strong>添付対象データ：</strong>なし</p>}
              <p><strong>内容ハッシュ：</strong><code data-testid="mail-envelope-hash">{envelope.contentHash}</code></p>
              <p><strong>テンプレート：</strong>{envelope.effectiveTemplateIdentity.key}（{envelope.effectiveTemplateIdentity.source === "override" ? "上書き" : "既定"}）</p>
            </section>
          ))}
          <p><strong>業務効果：</strong>{workflowEffectOf(action as FilmWorkflowAction)}</p>
          {testModeNote}
          {persistedWarnings}
          <p className="help">確認を押すと表示済みハッシュのみを送信します。取り消すと業務状態は変わりません。</p>
        </div>
        <footer>
          <button className="button secondary" type="button" disabled={busy} onClick={onDismiss}>閉じる</button>
          <button className="button secondary" type="button" disabled={busy} onClick={onCancel}>送信を取り消す</button>
          <button className="button" type="button" disabled={busy} onClick={onConfirm} data-testid="workflow-mail-confirm">この内容で送信</button>
        </footer>
      </article>
    </div>
  );
}

function MailOutboxPanel({
  order,
  isKanei,
  envelopes,
  loaded,
  error,
  busy,
  onRetry,
  onReload,
}: {
  order: FilmOrderView;
  isKanei: boolean;
  envelopes: MailOutboxUi[];
  loaded: boolean;
  error: boolean;
  busy: boolean;
  onRetry: (dispatchGroupId: string) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const retryGroups = new Map<string, { canRetry: boolean; reasons: string[] }>();
  for (const envelope of envelopes) {
    const current = retryGroups.get(envelope.dispatchGroupId) ?? { canRetry: false, reasons: [] };
    if (envelope.envelopeStatus === "composed") current.canRetry = true;
    current.reasons.push(`${envelope.audience}: ${mailStatusLabelOf(envelope.envelopeStatus)}`);
    retryGroups.set(envelope.dispatchGroupId, current);
  }
  return (
    <section className="film-order-section mail-outbox-panel" aria-labelledby={`mail-outbox-title-${order.id}`} data-testid={`mail-outbox-${order.id}`}>
      <div className="film-order-section-head">
        <h3 id={`mail-outbox-title-${order.id}`}>通知・送信結果</h3>
        <button className="button secondary small" type="button" disabled={busy} onClick={() => void onReload()}>更新</button>
      </div>
      <p className="help" data-testid="mail-disclosure-note">
        {isKanei ? "カネイ側は正規宛先・CC・本文・型付きリンク・添付対象・完全な試行履歴を参照できます。" : "セブン化学には自社宛通知の安全な状態と試行結果のみ表示します。"}
      </p>
      {error ? <p className="form-error" role="alert">通知履歴を読み込めませんでした。</p> : null}
      {loaded && !error && envelopes.length === 0 ? <p>まだ通知履歴はありません。</p> : null}
      <ul className="mail-outbox-list">
        {envelopes.map((envelope) => (
          <li key={envelope.id} data-testid={`mail-outbox-envelope-${envelope.id}`} className={envelope.envelopeStatus}>
            <div>
              <strong>{audienceLabelOf(envelope.audience)}</strong>
              <span>{mailStatusLabelOf(envelope.envelopeStatus)}</span>
              <small>{envelope.workflowKey} / {envelope.language === "ko" ? "한국어" : "日本語"}</small>
            </div>
            {isKanei ? (
              <>
                <p><strong>To：</strong>{envelope.intendedTo}</p>
                {envelope.cc?.length ? <p><strong>CC：</strong>{envelope.cc.join("、")}</p> : null}
                {envelope.subject ? <p><strong>件名：</strong>{envelope.subject}</p> : null}
                {envelope.body ? <pre>{envelope.body}</pre> : null}
                {envelope.links?.length ? (
                  <div><strong>型付きリンク：</strong>
                    <ul>{envelope.links.map((link) => <li key={link.key}>{link.label || link.key}: <code>{link.url}</code></li>)}</ul>
                  </div>
                ) : null}
                {envelope.attachments?.length ? (
                  <div><strong>添付対象データ：</strong>
                    <ul>{envelope.attachments.map((attachment, index) => <li key={`${attachment.fileName}-${index}`}>{attachment.fileName} / {attachment.category}{attachment.version ? ` v${attachment.version}` : ""}</li>)}</ul>
                  </div>
                ) : null}
                {envelope.contentHash ? <p><strong>内容ハッシュ：</strong><code>{envelope.contentHash}</code></p> : null}
                {envelope.requestedByEmail ? <p><strong>要求者：</strong>{envelope.requestedByEmail}</p> : null}
              </>
            ) : null}
            <div className="mail-attempt-list" data-testid={`mail-attempts-${envelope.id}`}>
              {envelope.attempts.map((attempt) => (
                <p key={attempt.id}>
                  <span data-testid="mail-attempt-status">{mailStatusTextOf(attempt.status)}</span>
                  <small>試行 {attempt.attemptCount} / {new Date(attempt.attemptStartedAt).toLocaleString("ja-JP")}</small>
                  {attempt.errorCode ? <small>エラー {attempt.errorCode}</small> : null}
                </p>
              ))}
            </div>
            {isKanei && envelope.envelopeStatus === "composed" && envelope.attempts.some((attempt) => ["failed", "unknown", "retry_required"].includes(attempt.status)) ? (
              <button className="button secondary small" type="button" disabled={busy} onClick={() => void onRetry(envelope.dispatchGroupId)}>
                永続化済み送信を再試行
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {!isKanei && Array.from(retryGroups.entries()).some(([, group]) => group.canRetry) ? (
        <p className="help">失敗・不明・再送が必要な場合はカネイ側が永続化された送信を再試行します。</p>
      ) : null}
    </section>
  );
}

function OrderSteps({
  order,
  status,
  reProofCount,
  poSent,
  etaDate,
}: {
  order: FilmOrderView;
  status: FilmOrderStatus;
  reProofCount: number;
  poSent: boolean;
  etaDate: string | null;
}) {
  const effective = poSent ? "po_sent" : etaDate ? "eta" : status;
  const activeIndex = status === "re_proof_requested"
    ? STEP_DEFS.findIndex((step) => step.key === "proof_registered")
    : STEP_DEFS.findIndex((step) => step.key === effective);
  const nextRole = primaryWorkflowRoleOf(order);
  return (
    <div className="film-order-steps" aria-label="進捗">
      {STEP_DEFS.map((step, index) => (
        <span
          key={step.key}
          className={`film-order-step ${index < activeIndex ? "done" : index === activeIndex ? `active role-${nextRole}` : ""}`}
        >
          <em>{index + 1}</em>{step.label}
        </span>
      ))}
      {status === "re_proof_requested" ? <span className="film-order-reproof">再校正 {reProofCount}回目</span> : null}
      {status !== "final_approved" ? (
        <WorkflowRoleBadge role={nextRole} label={`次の操作: ${companyLabel(nextRole)}`} />
      ) : null}
    </div>
  );
}

function NextStepPanel({
  order,
  isSeven,
  isKanei,
  busy,
  focused,
  onRun,
  onExpandWithForm,
  driveReady,
}: {
  order: FilmOrderView;
  isSeven: boolean;
  isKanei: boolean;
  busy: boolean;
  focused: "receiving" | "proof" | "design-mode" | "seller-approval" | null;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
  onExpandWithForm: (id: number, kind: "receiving" | "proof" | "design-mode" | "seller-approval") => void;
  driveReady: boolean;
}) {
  const next = nextActionOf(order, isSeven, isKanei);
  const nextRole = workflowActionRoleOf(order, next);
  const isDataModeChoice = next.kind === "form" && next.form === "design-mode";
  const proofFileCount = order.files.filter((file) => file.category === "proof").length;
  const proofVersion = Math.floor(proofFileCount / 2) + 1;
  const isExternalProofWait = order.status === "receiving_registered" || order.status === "re_proof_requested";
  const proofRegistrationOpen = isKanei && isExternalProofWait;
  const receivingFiles = order.files.filter((file) => file.category === "receiving");
  const proofPair = latestProofPairOf(order);
  const sellerApprovalReady = supplierApprovalReadyOf(order);
  return (
    <section className={`film-order-section next-step role-${nextRole} ${next.kind === "none" ? "waiting" : "mine"}`}>
      <div className="next-step-head">
        <p className="next-step-kicker">{next.kind === "none" ? "WAITING" : "NEXT STEP"}</p>
        <WorkflowRoleBadge
          role={nextRole}
          label={nextRole === "supplier" ? "フィルムメーカー" : companyLabel(nextRole as FilmOrderCompany)}
        />
      </div>
      {isKanei ? (
        <FilmMakerSelectionPanel
          order={order}
          busy={busy}
          onRun={onRun}
        />
      ) : null}
      <h3>{statusHintOf(order)}</h3>
      {order.eta_date ? (
        <div className="production-schedule-note" role="note">
          <strong>フィルム入荷予定（セブン化学工場到着見込み）</strong>
          <span>納期見込み: {order.eta_date}</span>
          {order.eta_note ? <span>フィルムメーカーメモ: {order.eta_note}</span> : null}
          {order.eta_updated_at ? <small>更新: {new Date(order.eta_updated_at).toLocaleString("ja-JP")}</small> : null}
          <small>セブン化学の充填スケジュール・受領準備にそのまま共有してください。</small>
        </div>
      ) : null}
      {order.status === "ordered" && isDataModeChoice ? (
        <div className="workflow-mode-note" role="note">
          <strong>入稿方式を選択してください</strong>
          <span>得意先原稿を受領するか、カネイ側が保有する自社製作データで進めるかを選べます。選択後に製作データを入稿できます。</span>
        </div>
      ) : null}
      {next.kind === "none" && nextRole === "supplier" ? (
        <div className="workflow-mode-note" role="note">
          <strong>{supplierLabelOf(order)}専用リンクでの報告待ち</strong>
          <span>フィルムメーカーが専用URLから出荷・納品報告すると、この発注に自動反映されます。</span>
        </div>
      ) : null}
      {isExternalProofWait ? (
        <>
          <div className="workflow-mode-note" role="note">
            <strong>外部校正アップロード待ち</strong>
            <span>入稿登録時に送信した専用URLからAI/PDFが返却されると、この発注は自動的に「校正待ち」に更新されます。</span>
          </div>
          <div className="next-step-submitted">
            <p>入稿済みデータ:</p>
            <ul>
              {receivingFiles.map((file) => (
                <li key={file.id}>
                  {file.file_name}
                  {file.url ? <a href={file.url} target="_blank" rel="noreferrer">開く</a> : null}
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
      {next.kind === "none" && !isExternalProofWait && order.status !== "final_approved" ? (
        <div className="next-step-wait">
          <p>{next.label}</p>
          <button className="button small" type="button" disabled title="担当部署のみ操作できます">
            {filmOrderStepRole(order, order.status) === "seven" ? "入稿・承認操作（セブン化学）" : "校正データ操作（カネイ側）"}
          </button>
        </div>
      ) : null}
      {next.kind === "run" ? (
        <button className={`button workflow-action role-${nextRole}`} type="button" disabled={busy} onClick={() => void onRun(next.body, next.ok)}>
          {next.label}
        </button>
      ) : null}
      {next.kind === "form" && next.form === "receiving" ? (
        <ReceivingForm
          order={order}
          autofocus={focused === "receiving"}
          busy={busy}
          driveReady={driveReady}
          onSubmit={(aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note, guideAcknowledged) =>
            void onRun({ action: "register-receiving", aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note, guideAcknowledged }, "入稿データを登録し、デザイン宛てに連絡しました。")}
        />
      ) : null}
      {next.kind === "form" && next.form === "design-mode" ? (
        <div className="workflow-choice-grid">
          <div className="workflow-choice">
            <strong>得意先デザインを受領</strong>
            <p>得意先・外部デザイナーにアップロードを依頼し、確定後に入稿します。</p>
            <CustomerDesignRequestForm busy={busy} onSubmit={(note) => void onRun({ action: "request-customer-design-upload", note }, "得意先デザイン依頼を送信しました。")} />
          </div>
          <div className="workflow-choice">
            <strong>自社データで進める</strong>
            <p>カネイ側がすでに製作データを持っている場合に選択します。</p>
            <CustomerDesignNotRequiredForm
              busy={busy}
              selfService
              immediate
              onSubmit={(reason) => void onRun({ action: "set-customer-design-not-required", reason }, "自社データワークフローに設定しました。")}
            />
          </div>
        </div>
      ) : null}
      {proofRegistrationOpen ? (
        <div className="film-order-inline-actions">
          {order.status === "receiving_registered" ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => void onRun({ action: "send-proof-notice" }, "校正アップロード案内を再送しました。")}>
              校正アップロード案内を再送
            </button>
          ) : null}
          {canOperate(buyerCompanyOf(order), isSeven, isKanei) ? (
            <details className="film-order-additional">
              <summary>入稿データを追加する</summary>
              <FileActionForm
                title="入稿データ 追加登録"
                submitLabel="追加登録"
                defaultFileName={`${buildFilmOrderFileName(order, "receiving", receivingFiles.length + 1)}`}
                busy={busy}
                orderId={order.id}
                category="receiving"
                onSubmit={(fileName, note, fileUrl) => {
                  void onRun(
                    { action: "register-receiving-extra", fileName, fileUrl, note },
                    "入稿データを追加登録しました。",
                  );
                }}
              />
            </details>
          ) : null}
          <details className="film-order-additional">
            <summary>カネイ側が手動登録する（フォールバック）</summary>
            <ProofRegistrationForm
              title={order.status === "re_proof_requested" ? "再校正データ登録" : "校正データ登録"}
              autofocus={focused === "proof"}
              driveReady={driveReady}
              order={order}
              version={proofVersion}
              submitLabel={order.status === "re_proof_requested" ? "再校正データを登録" : "校正データを登録"}
              onSubmit={(aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note) =>
                void onRun({ action: "register-proof", aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note }, "校正データを手動登録しました。")}
            />
          </details>
        </div>
      ) : null}
      {order.status === "proof_registered" ? (
        <div className="film-order-inline-actions">
          <div className="film-order-proof-files">
            <p className="film-order-preview-label">最新校正データセット（v{proofPair.version || "-"}）</p>
            <div className="film-order-proof-file-row">
              <span className="film-order-file-badge receiving">AI 必須</span>
              <span className="film-order-proof-file-name">
                {proofPair.ai ? `${proofPair.ai.file_name}（v${proofPair.ai.version}）` : "未登録"}
              </span>
              {proofPair.ai?.url ? (
                <a className="button secondary small" href={proofPair.ai.url} target="_blank" rel="noreferrer">開く</a>
              ) : <span className="film-order-url-missing">URL未登録</span>}
            </div>
            <div className="film-order-proof-file-row">
              <span className="film-order-file-badge proof">PDF 任意</span>
              <span className="film-order-proof-file-name">
                {proofPair.pdf ? `${proofPair.pdf.file_name}（v${proofPair.pdf.version}）` : "未登録"}
              </span>
              {proofPair.pdf?.url ? (
                <a className="button secondary small" href={proofPair.pdf.url} target="_blank" rel="noreferrer">開く</a>
              ) : null}
            </div>
            {proofPair.pdf?.url ? (() => {
              const fileId = proofPair.pdf!.url.split("/d/")[1]?.split("/")[0];
              if (!fileId) return null;
              return (
                <iframe
                  src={`/api/film-orders/preview?fileId=${encodeURIComponent(fileId)}`}
                  className="film-order-preview-iframe"
                  title="校正PDFプレビュー"
                />
              );
            })() : proofPair.ai ? (
              <p className="film-order-preview-note">AI形式はブラウザプレビュー不可。ダウンロードして確認してください。</p>
            ) : null}
          </div>

          <div className="approval-flow-status" role="status">
            <span className={order.customerProof.supplierApprovalStatus === "approved" ? "approved" : "pending"}>
              ① カネイ側校正承認: {order.customerProof.supplierApprovalStatus === "approved"
                ? `済み（${order.customerProof.supplierApprovalBy || "-"}）`
                : "待ち"}
            </span>
            <span className={order.customerProof.buyerApprovalStatus === "approved" ? "approved" : "pending"}>
              ② Buyer最終承認: {order.customerProof.buyerApprovalStatus === "approved"
                ? `済み（${order.customerProof.buyerApprovalBy || "-"}）`
                : "待ち"}
            </span>
          </div>

          {next.kind === "form" && next.form === "seller-approval" && isKanei ? (
            <div>
              <p className="next-step-note">고객レビュー·오프라인 확인 결과를 포함해 カネイ側 책임자 승인을 먼저 기록합니다.</p>
              <CustomerProofOfflineForm
                busy={busy}
                onSubmit={(approverName, evidence, reason) => void onRun(
                  { action: "record-customer-proof-approval", approverName, evidence, offlineReason: reason },
                  "カネイ側校正承認を記録しました。",
                )}
              />
            </div>
          ) : null}

          {sellerApprovalReady && canOperate(buyerCompanyOf(order), isSeven, isKanei) ? (
            <button className="button workflow-action role-buyer" type="button" disabled={busy} onClick={() => void onRun({ action: "approve" }, "校正を最終承認しました。")}>
              校正を最終承認する
            </button>
          ) : null}
          {sellerApprovalReady && !canOperate(buyerCompanyOf(order), isSeven, isKanei) ? (
            <p className="next-step-note">カネイ側承認済み。Buyer最終承認を待っています。</p>
          ) : null}

          <ReProofForm
            order={order}
            busy={busy}
            onSubmit={({ internalComment, supplierMessage }) => void onRun({ action: "request-re-proof", comment: internalComment, supplierMessage }, "再校正を依頼しました。")}
          />
        </div>
      ) : null}
      {order.status === "final_approved" ? (
        <div className="film-order-inline-actions">
          <p className="film-order-final">最終承認済み（カネイ側の最終受注処理が確定）。{order.po_sent_at ? "発注書は送信済みです。" : "発注書をフィルムメーカーへ送信してください。"}</p>
          <ProductionPlanPanel
            key={`${order.id}-${order.productionPlan.updatedAt ?? ""}-${order.productionPlan.status}`}
            order={order}
            isSeven={isSeven}
            isKanei={isKanei}
            busy={busy}
            onRun={onRun}
          />
          <div className="film-delivery-summary">
            <span>出荷: {order.delivery.shippedOn ?? "未報告"}</span>
            <span>納品: {order.delivery.deliveredOn ?? "未報告"}</span>
            <span>受領: {order.delivery.receivedAt ? new Date(order.delivery.receivedAt).toLocaleDateString("ja-JP") : "未確認"}</span>
            {order.delivery.carrier ? <small>{order.delivery.carrier}{order.delivery.trackingNumber ? ` / ${order.delivery.trackingNumber}` : ""}</small> : null}
            {order.delivery.documents.map((document) => (
              <a key={document.url} href={document.url} target="_blank" rel="noreferrer">{document.name}</a>
            ))}
          </div>
          {isKanei && !order.po_sent_at ? (
            <SupplierOrderNoteForm
              key={`${order.id}-${order.supplier_order_note ?? ""}`}
              orderId={order.id}
              initialNote={order.supplier_order_note ?? ""}
              busy={busy}
              onSave={(note) => void onRun({ action: "update-supplier-order-note", supplierOrderNote: note }, "発注時メモを保存しました。")}
              onSend={(note) => void onRun({ action: "send-po", supplierOrderNote: note }, "発注書をフィルムメーカーへ送信しました。納期入力フォームを案内しました。")}
            />
          ) : null}
          {isKanei && order.po_sent_at ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => void onRun({ action: "resend-supplier-links" }, "既存発注の発注書・報告リンクをフィルムメーカーへ再送しました。")}>
              発注書・報告リンクを再送（新規発注ではありません）
            </button>
          ) : null}
          {canOperate(buyerCompanyOf(order), isSeven, isKanei) && order.delivery.deliveredOn && !order.delivery.receivedAt ? (
            <FilmReceiptConfirmForm busy={busy} onSubmit={(note) => void onRun({ action: "confirm-film-receipt", note }, "フィルムの受領を確認しました。")} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface SupplierOrderMailPreviewUi {
  to: string | null;
  route: "A" | "B" | "custom";
  subject: string;
  body: string;
}

type FilmMakerSelectionUi = {
  id: number;
  makerCode: string;
  companyName: string;
  language: "ja" | "ko";
};

function FilmMakerSelectionPanel({
  order,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const [selections, setSelections] = useState<FilmMakerSelectionUi[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const resolution = order.supplier_resolution ?? "legacy_unresolved";
  const snapshot = order.film_maker_snapshot_json
    ? JSON.parse(order.film_maker_snapshot_json) as {
      companyName?: string;
      makerCode?: string;
      language?: "ja" | "ko";
      procurementRoute?: "K" | "Y";
      printMethod?: "gravure" | "digital";
    }
    : null;
  const unresolved = resolution === "legacy_unresolved" && !snapshot?.companyName;

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/film-makers/selection?procurementRoute=${encodeURIComponent(order.procurement_route)}&printMethod=${encodeURIComponent(order.printing_method)}`,
          { cache: "no-store" },
        );
        const payload = await response.json();
        if (!response.ok) throw new Error();
        if (mounted) {
          setSelections(payload.selections as FilmMakerSelectionUi[]);
          setLoadError(false);
        }
      } catch {
        if (mounted) setLoadError(true);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    return () => { mounted = false; };
  }, [order.id, order.procurement_route, order.printing_method]);

  return (
    <section className="film-maker-selection" aria-label="フィルムメーカー選択" data-testid="film-maker-selection">
      <h4>フィルムメーカー選択</h4>
      <p data-testid="film-maker-resolution">
        <strong>供給者解決：</strong>
        {resolution === "master_selected" ? "選択済み（スナップショット固定）"
          : resolution === "legacy_exempt" ? "レガシー除外"
            : "未解決"}
      </p>
      {snapshot?.companyName ? (
        <dl className="film-maker-snapshot" data-testid="film-maker-snapshot">
          <div><dt>会社名</dt><dd>{snapshot.companyName}</dd></div>
          {snapshot.makerCode ? <div><dt>メーカーコード</dt><dd>{snapshot.makerCode}</dd></div> : null}
          {snapshot.language ? <div><dt>連絡言語</dt><dd>{snapshot.language === "ko" ? "한국어" : "日本語"}</dd></div> : null}
          {snapshot.procurementRoute ? <div><dt>調達ルート</dt><dd>{snapshot.procurementRoute}</dd></div> : null}
          {snapshot.printMethod ? <div><dt>印刷方式</dt><dd>{snapshot.printMethod}</dd></div> : null}
        </dl>
      ) : (
        <p className="workflow-mode-note" role="note">
          <strong>未解決フィルムメーカーの対応</strong>
          <span>下記から条件一致する有効なフィルムメーカーを選択してください。連絡先はカネイ側管理画面でのみ登録でき、ここでは表示・列挙されません。</span>
        </p>
      )}
      {loading ? <p role="status">有効な候補を読み込み中...</p> : null}
      {loadError ? <p className="form-error" role="alert">選択候補を読み込めませんでした。</p> : null}
      {!loading && !loadError && selections.length === 0 ? (
        <p className="form-error" role="note">この条件に一致する有効なフィルムメーカーはありません。カネイ側管理者に登録を依頼してください。</p>
      ) : null}
      <label>
        有効なフィルムメーカー候補
        <select
          data-testid="film-maker-select"
          defaultValue={snapshot?.companyName ? "selected" : ""}
          disabled={busy || loading || Boolean(snapshot?.companyName)}
          aria-describedby="film-maker-select-description"
          onChange={(event) => {
            const makerId = Number(event.target.value);
            if (makerId > 0) void onRun({ action: "select-film-maker", makerId }, "フィルムメーカーを選択しました。");
          }}
        >
          <option value="">選択してください</option>
          {snapshot?.companyName ? <option value="selected">{snapshot.companyName}（選択済み）</option> : null}
          {selections.map((maker) => (
            <option key={maker.id} value={maker.id} disabled={Boolean(snapshot?.companyName)}>
              {maker.companyName} / {maker.makerCode}
            </option>
          ))}
        </select>
      </label>
      <p id="film-maker-select-description" className="help">
        {snapshot?.companyName
          ? "選択後のスナップショットはこの案件に固定されます。変更は管理者調整フローで扱います。"
          : "連絡先を含まない最小投影のみ表示します。"}
      </p>
    </section>
  );
}

function SupplierOrderNoteForm({
  orderId,
  initialNote,
  busy,
  onSave,
  onSend,
}: {
  orderId: number;
  initialNote: string;
  busy: boolean;
  onSave: (note: string) => void;
  onSend: (note: string) => void;
}) {
  const [note, setNote] = useState(initialNote);
  const [preview, setPreview] = useState<SupplierOrderMailPreviewUi | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState("");

  const runPreview = async () => {
    if (previewing || busy) return;
    setPreviewing(true);
    setError("");
    try {
      const response = await fetch(`/api/film-orders/${orderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview-supplier-po", supplierOrderNote: note }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.preview) throw new Error(payload.error ?? "preview_failed");
      setPreview(payload.preview as SupplierOrderMailPreviewUi);
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof Error && caught.message !== "preview_failed" ? caught.message : "プレビューを作成できませんでした。");
    } finally {
      setPreviewing(false);
    }
  };

  const normalizedNote = note.trim();
  return (
    <section className="supplier-order-note" aria-label="発注メール確認">
      <h4>発注メールの確認・追加指示</h4>
      <p className="help">
        計算済みの発注内容は保持されます。用材・1ロール長・優先幅などの追加指示をフィルムメーカーへ伝える場合は、下記に入力してください。
      </p>
      <label>
        追加発注指示（フィルムメーカー宛）
        <textarea
          value={note}
          rows={5}
          maxLength={4000}
          placeholder={`例）\n用材：既指定フィルムから ○○ に変更\n1ロール：○○m × △本\n発注長：SKUごとに □□m を優先`}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      <div className="supplier-order-note-actions">
        <button className="button secondary small" type="button" disabled={busy} onClick={() => onSave(normalizedNote)}>
          メモを保存
        </button>
        <button className="button secondary small" type="button" disabled={busy || previewing} onClick={() => void runPreview()}>
          {previewing ? "プレビュー作成中..." : "メール本文をプレビュー"}
        </button>
        <button className="button workflow-action role-kanei" type="button" disabled={busy || previewing} onClick={() => onSend(normalizedNote)}>
          この内容で発注する
        </button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {preview ? (
        <div className="supplier-order-preview" data-testid="supplier-order-preview">
          <div><strong>宛先：</strong><span>{preview.to ?? "未設定"}</span></div>
          <div><strong>件名：</strong><span>{preview.subject}</span></div>
          <pre>{preview.body}</pre>
          <p className="help">納期登録・発注書URLは送信後に確定リンクへ置き換わります。</p>
        </div>
      ) : null}
    </section>
  );
}

function FilmReceiptConfirmForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(note.trim()); }}>
      <label>受領メモ（任意）
        <textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "確認中..." : "フィルムを受領確認する"}</button>
    </form>
  );
}

function ProductionPlanPanel({
  order,
  isSeven,
  isKanei,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  isSeven: boolean;
  isKanei: boolean;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const plan = order.productionPlan;
  const [startDate, setStartDate] = useState(plan.startDate ?? "");
  const [endDate, setEndDate] = useState(plan.endDate ?? "");
  const [note, setNote] = useState(plan.note);
  const planConfirmed = plan.status === "confirmed";
  const [expanded, setExpanded] = useState(!planConfirmed);
  const [confirmedBefore, setConfirmedBefore] = useState(planConfirmed);
  if (planConfirmed && !confirmedBefore) {
    setConfirmedBefore(true);
    setExpanded(false);
  }

  const save = (confirm: boolean) => {
    if (busy || !startDate || !endDate) return;
    void onRun({
      action: confirm ? "confirm-production-plan" : "save-production-plan",
      productionPlanStartDate: startDate,
      productionPlanEndDate: endDate,
      productionPlanNote: note,
    }, confirm ? "生産予定を確定しました。" : "生産予定を保存しました。");
  };

  return (
    <section className="film-order-section role-seven" aria-label="生産予定" data-testid="production-plan-panel">
      <details
        className="production-plan-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <span className="production-plan-summary-title">
            충진 생산 예정（任意）
            <WorkflowRoleBadge role="seven" />
          </span>
          <span className="production-plan-summary-state">
            {planConfirmed
              ? `${productionPlanStatusLabels[plan.status]}${plan.startDate && plan.endDate ? `／${plan.startDate} 〜 ${plan.endDate}` : ""}`
              : productionPlanStatusLabels[plan.status]}
            <span aria-hidden="true">{expanded ? "▲" : "▼"}</span>
          </span>
        </summary>
        <div className="film-order-section-head">
          <h3>生産予定の詳細</h3>
          <span className="production-plan-edit-hint">
            {planConfirmed ? "確定済みのため折りたたみ表示中。開くと変更できます。" : "入力・編集できます。"}
          </span>
        </div>
        <dl>
          <div><dt>状態</dt><dd>{productionPlanStatusLabels[plan.status]}</dd></div>
          <div><dt>生産可能期間</dt><dd>{plan.startDate && plan.endDate ? `${plan.startDate} 〜 ${plan.endDate}` : "-"}</dd></div>
          <div><dt>フィルム入荷予定</dt><dd>{order.eta_date ?? "-"}</dd></div>
          {plan.note ? <div><dt>メモ</dt><dd>{plan.note}</dd></div> : null}
          {plan.updatedAt ? <div><dt>更新</dt><dd>{plan.updatedBy} / {new Date(plan.updatedAt).toLocaleString("ja-JP")}</dd></div> : null}
        </dl>
        <p className="help">
          この項目は任意です。未入力でもフィルム発注ワークフローは止まりません。セブン化学が登録するとカネイ側にも共有され、必要な場合はカネイ側から確認依頼を送れます。
        </p>
        {isSeven ? (
          <div className="film-order-form">
            <label>生産可能 開始日
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
            </label>
            <label>生産可能 終了日
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} required />
            </label>
            <label>生産計画メモ
              <textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
            </label>
            <div className="film-order-inline-actions">
              <button className="button secondary" type="button" disabled={busy || !startDate || !endDate} onClick={() => save(false)}>
                {busy ? "保存中..." : "暫定予定を保存"}
              </button>
              <button className="button" type="button" disabled={busy || !startDate || !endDate} onClick={() => save(true)}>
                {busy ? "確定中..." : "生産予定を確定"}
              </button>
            </div>
          </div>
        ) : null}
        {isKanei ? (
          <div className="film-order-inline-actions">
            <button className="button secondary" type="button" disabled={busy} onClick={() => void onRun({ action: "request-production-plan" }, "セブン化学へ生産予定の確認依頼を送信しました。")}>
              生産予定を問い合わせる
            </button>
          </div>
        ) : null}
      </details>
    </section>
  );
}

interface ShipToFormEntry {
  source: "basic" | "master" | "new";
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
}

const MAX_SHIP_TO_DESTINATIONS = 10;
/** 得意先基本情報（初回登録時の住所）を住所録ラジオで表す際の合成ID。 */
const SHIP_TO_BASIC_OPTION_ID = -1;
interface ShipToBasicDestination {
  companyName: string;
  department: string;
  contactName: string;
  postalCode: string;
  address: string;
  building: string;
  phone: string;
  email: string;
}

function emptyShipToEntry(): ShipToFormEntry {
  return {
    source: "new",
    destinationId: null,
    label: "",
    companyName: "",
    department: "",
    contactName: "",
    postalCode: "",
    address: "",
    building: "",
    phone: "",
    email: "",
    note: "",
  };
}

function shipToEntryCompleteOf(entry: ShipToFormEntry): boolean {
  if (entry.source === "basic") return true;
  if (entry.source === "master") return entry.destinationId != null;
  return Boolean(entry.companyName && entry.postalCode && entry.address && entry.phone);
}

function ShipToPanel({
  order,
  isSeven,
  isKanei,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  isSeven: boolean;
  isKanei: boolean;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const [masterDestinations, setMasterDestinations] = useState<CustomerDeliveryDestination[]>([]);
  const [basicDestination, setBasicDestination] = useState<ShipToBasicDestination | null>(null);
  const [entries, setEntries] = useState<ShipToFormEntry[] | null>(null);
  const [selectedMasterId, setSelectedMasterId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    if (!order.customer_code) {
      setMasterDestinations([]);
      setBasicDestination(null);
      setSelectedMasterId(null);
      setEntries([]);
      return;
    }
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/film-orders/${order.id}/ship-to-destinations`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      const loaded = payload.destinations as CustomerDeliveryDestination[];
      setMasterDestinations(loaded);
      const basic = payload.basicDestination as ShipToBasicDestination | null | undefined;
      setBasicDestination(basic ?? null);
      if (basic) {
        // 得意先基本情報（初回登録時の住所）を既定の納品先にする。
        setSelectedMasterId(SHIP_TO_BASIC_OPTION_ID);
        setEntries([{ ...emptyShipToEntry(), source: "basic" }]);
      } else {
        const defaultDestination = loaded.find((item) => item.isDefault) ?? loaded[0] ?? null;
        setSelectedMasterId(defaultDestination?.id ?? null);
        setEntries(defaultDestination
          ? [{ ...emptyShipToEntry(), source: "master", destinationId: defaultDestination.id }]
          : []);
      }
    } catch {
      setMasterDestinations([]);
      setBasicDestination(null);
      setSelectedMasterId(null);
      setEntries([]);
      setLoadError("住所録を読み込めませんでした。更新後に再試行してください。");
    } finally {
      setLoading(false);
    }
  }, [order.customer_code, order.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時に納品先マスタを取得する意図的な処理です。
    void load();
  }, [load]);

  const canOperateShipTo = isSeven || isKanei;
  const canEdit = canOperateShipTo && order.shipTo.status !== "confirmed";
  const draftEntries = entries ?? [];
  const allEntriesComplete = draftEntries.length > 0 && draftEntries.every(shipToEntryCompleteOf);
  const registered = order.shipTo.destinations;
  const registrationPending = order.shipTo.status === "not_provided" && Boolean(order.shipTo.requestedAt);
  const canAddMore = draftEntries.length < MAX_SHIP_TO_DESTINATIONS;
  const draftMasterIds = new Set(
    [
      ...draftEntries.filter((entry) => entry.source === "basic").map(() => SHIP_TO_BASIC_OPTION_ID),
      ...draftEntries
        .filter((entry) => entry.source === "master" && entry.destinationId != null)
        .map((entry) => entry.destinationId as number),
    ],
  );
  const hasBasicOption = Boolean(basicDestination);
  const selectedAlreadyAdded = selectedMasterId != null && draftMasterIds.has(selectedMasterId);

  const updateEntry = (index: number, patch: Partial<ShipToFormEntry>) => {
    setEntries((old) => (old ?? []).map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry));
  };
  const addFromMaster = () => {
    if (busy || !canEdit || !canAddMore || selectedMasterId == null || selectedAlreadyAdded) return;
    if (selectedMasterId === SHIP_TO_BASIC_OPTION_ID) {
      setEntries((old) => [...(old ?? []), { ...emptyShipToEntry(), source: "basic" }]);
      return;
    }
    setEntries((old) => [...(old ?? []), { ...emptyShipToEntry(), source: "master", destinationId: selectedMasterId }]);
  };
  const addManualEntry = () => {
    if (busy || !canEdit || !canAddMore) return;
    setEntries((old) => [...(old ?? []), emptyShipToEntry()]);
  };
  const removeEntry = (index: number) => {
    setEntries((old) => (old ?? []).filter((_, entryIndex) => entryIndex !== index));
  };
  const removeRegisteredDestination = (destinationRowId: number) => {
    void onRun({ action: "remove-ship-to-destination", destinationRowId }, "納品先を削除しました。").then(() => load());
  };

  const submit = async () => {
    if (busy || !canEdit || !allEntriesComplete) return;
    const body = {
      action: "register-ship-to",
      destinations: draftEntries.map((entry) => {
        if (entry.source === "basic") return { customerBasic: true };
        if (entry.source === "master" && entry.destinationId) return { destinationId: entry.destinationId };
        return {
          shipToLabel: entry.label,
          shipToCompanyName: entry.companyName,
          shipToDepartment: entry.department,
          shipToContactName: entry.contactName,
          shipToPostalCode: entry.postalCode,
          shipToAddress: entry.address,
          shipToBuilding: entry.building,
          shipToPhone: entry.phone,
          shipToEmail: entry.email,
          shipToNote: entry.note,
        };
      }),
    };
    await onRun(
      body,
      draftEntries.length > 1
        ? `納品先${draftEntries.length}件を登録しました。得意先マスターへ自動保存しました。`
        : "納品先を登録しました。得意先マスターへ自動保存しました。",
    );
    await load();
  };

  return (
    <section className={`film-order-section role-buyer ${buyerRoleOf(order) === "seven" ? "on-seven" : "on-kanei"}`} aria-label="納品先管理" data-testid="ship-to-panel">
      <div className="film-order-section-head">
        <h3>納品先管理</h3>
        <WorkflowRoleBadge role="mixed" label="セブン化学／カネイ側" />
      </div>
      <div className="film-order-columns">
        <dl>
          <div><dt>状態</dt><dd data-testid="ship-to-status">
            {registrationPending ? "得意先登録依頼済み" : shipToStatusLabels[order.shipTo.status]}
          </dd></div>
          {order.shipTo.requestedAt ? <div><dt>得意先依頼日時</dt><dd>{new Date(order.shipTo.requestedAt).toLocaleString("ja-JP")}</dd></div> : null}
          {order.shipTo.registeredAt && order.shipTo.registeredBy.startsWith("customer:") ? (
            <div><dt>登録者</dt><dd>得意先（外部リンク）</dd></div>
          ) : null}
          {registered.length ? (
            <div>
              <dt>納品先（{registered.length}件）</dt>
              <dd>
                <ol className="ship-to-registered-list" data-testid="ship-to-registered-list">
                  {registered.map((destination, index) => (
                    <li key={destination.id} className="ship-to-registered-item">
                      <span className="ship-to-registered-name">
                        {index + 1}. {destination.label ? `${destination.label} / ` : ""}{destination.companyName}
                        {destination.confirmedAt ? <em className="ship-to-confirmed-badge">確認済</em> : null}
                      </span>
                      <span className="ship-to-registered-meta">
                        {destination.department ? `${destination.department} / ` : ""}
                        {destination.contactName ? `${destination.contactName} / ` : ""}
                        〒{destination.postalCode} {destination.address}{destination.building ? ` ${destination.building}` : ""}
                      </span>
                      <span className="ship-to-registered-meta">電話：{destination.phone}</span>
                      {canEdit ? (
                        <button
                          className="button danger small ship-to-entry-remove"
                          type="button"
                          disabled={busy}
                          onClick={() => removeRegisteredDestination(destination.id)}
                        >
                          この納品先を削除
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </dd>
            </div>
          ) : (
            <>
              <div><dt>納品先</dt><dd>-</dd></div>
              <div><dt>住所</dt><dd>-</dd></div>
              <div><dt>電話</dt><dd>-</dd></div>
              {registrationPending ? (
                <div><dt /><dd className="ship-to-pending-hint">得意先の登録待ちです。依頼メール送信済みのため、各項目は空欄です。</dd></div>
              ) : null}
            </>
          )}
          {order.shipTo.confirmedAt ? <div><dt>確認</dt><dd>{new Date(order.shipTo.confirmedAt).toLocaleString("ja-JP")}</dd></div> : null}
        </dl>
        <div className="film-order-inline-actions">
          {!order.customer_code ? <p className="help">得意先コードがないため、住所録へ自動保存できません。</p> : null}
          {loading ? <p className="help">住所録を読み込み中...</p> : null}
          {canEdit && entries ? (
            <>
              {loadError ? <p className="form-error" role="alert">{loadError}</p> : null}
              {masterDestinations.length || basicDestination ? (
                <fieldset className="ship-to-master-list" data-testid="ship-to-master-list">
                  <legend>納品先候補（得意先基本情報・住所録）</legend>
                  <div className="ship-to-options">
                    {basicDestination ? (
                      <label className={selectedMasterId === SHIP_TO_BASIC_OPTION_ID ? "selected" : ""}>
                        <input
                          type="radio"
                          name={`ship-to-master-${order.id}`}
                          checked={selectedMasterId === SHIP_TO_BASIC_OPTION_ID}
                          onChange={() => setSelectedMasterId(SHIP_TO_BASIC_OPTION_ID)}
                        />
                        <span>
                          <strong>
                            得意先基本情報（初回登録時の住所）
                            {draftMasterIds.has(SHIP_TO_BASIC_OPTION_ID) ? <em className="ship-to-added-badge">追加済み</em> : null}
                          </strong>
                          <small>
                            {basicDestination.contactName ? `${basicDestination.contactName} / ` : ""}
                            〒{basicDestination.postalCode} {basicDestination.address}
                          </small>
                          <small>電話：{basicDestination.phone}{basicDestination.email ? ` ／ ${basicDestination.email}` : ""}</small>
                        </span>
                      </label>
                    ) : null}
                    {masterDestinations.map((destination) => (
                      <label key={destination.id} className={selectedMasterId === destination.id ? "selected" : ""}>
                        <input
                          type="radio"
                          name={`ship-to-master-${order.id}`}
                          checked={selectedMasterId === destination.id}
                          onChange={() => setSelectedMasterId(destination.id)}
                        />
                        <span>
                          <strong>
                            {destination.label || destination.companyName}
                            {destination.isDefault ? "（既定）" : ""}
                            {draftMasterIds.has(destination.id) ? <em className="ship-to-added-badge">追加済み</em> : null}
                          </strong>
                          <small>
                            {destination.department ? `${destination.department} / ` : ""}
                            {destination.contactName ? `${destination.contactName} / ` : ""}
                            〒{destination.postalCode} {destination.address}{destination.building ? ` ${destination.building}` : ""}
                          </small>
                          <small>電話：{destination.phone}{destination.email ? ` ／ ${destination.email}` : ""}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <button
                    className="button secondary"
                    type="button"
                    data-testid="ship-to-add-from-master"
                    disabled={busy || !canAddMore || selectedMasterId == null || selectedAlreadyAdded}
                    onClick={addFromMaster}
                  >
                    {selectedAlreadyAdded ? "選択済みの納品先は追加済みです" : "選択した納品先を追加"}
                  </button>
                </fieldset>
              ) : !loading ? (
                <p className="help">住所録はまだありません。新規入力で登録すると住所録に保存され、次回から選択できます。</p>
              ) : null}

              <div className="ship-to-entry-list" data-testid="ship-to-entry-list">
                {draftEntries.length === 0 ? (
                  <p className="help">住所録から選ぶか「＋ 新規入力で追加」で納品先を登録してください。</p>
                ) : null}
                {draftEntries.map((entry, index) => {
                  const master = entry.source === "master" && entry.destinationId != null
                    ? masterDestinations.find((item) => item.id === entry.destinationId)
                    : null;
                  const isBasic = entry.source === "basic";
                  return (
                    <fieldset key={index} className="ship-to-entry-card">
                      <legend>納品先 {index + 1}{entry.source === "master" ? "（住所録）" : entry.source === "basic" ? "（得意先基本情報）" : "（新規入力）"}</legend>
                      <button
                        className="button danger small ship-to-entry-remove"
                        type="button"
                        disabled={busy}
                        onClick={() => removeEntry(index)}
                      >
                        削除
                      </button>
                      {isBasic && basicDestination ? (
                        <div className="ship-to-entry-summary">
                          <strong>得意先基本情報（初回登録時の住所）</strong>
                          <small>
                            {basicDestination.contactName ? `${basicDestination.contactName} / ` : ""}
                            〒{basicDestination.postalCode} {basicDestination.address}
                          </small>
                          <small>電話：{basicDestination.phone}{basicDestination.email ? ` ／ ${basicDestination.email}` : ""}</small>
                        </div>
                      ) : master ? (
                        <div className="ship-to-entry-summary">
                          <strong>{master.label || master.companyName}</strong>
                          <small>
                            {master.department ? `${master.department} / ` : ""}
                            {master.contactName ? `${master.contactName} / ` : ""}
                            〒{master.postalCode} {master.address}{master.building ? ` ${master.building}` : ""}
                          </small>
                          <small>電話：{master.phone}{master.email ? ` ／ ${master.email}` : ""}</small>
                        </div>
                      ) : (
                        <div className="film-order-form ship-to-form">
                          <label>ラベル<input value={entry.label} onChange={(event) => updateEntry(index, { label: event.target.value })} /></label>
                          <label>会社名 ★<input autoComplete="organization" value={entry.companyName} onChange={(event) => updateEntry(index, { companyName: event.target.value })} required /></label>
                          <label>部署<input value={entry.department} onChange={(event) => updateEntry(index, { department: event.target.value })} /></label>
                          <label>担当者<input autoComplete="name" value={entry.contactName} onChange={(event) => updateEntry(index, { contactName: event.target.value })} /></label>
                          <label>郵便番号 ★<input inputMode="numeric" autoComplete="postal-code" placeholder="582-0017" value={entry.postalCode} onChange={(event) => updateEntry(index, { postalCode: event.target.value })} required /></label>
                          <label>住所 ★<input autoComplete="address-line1" value={entry.address} onChange={(event) => updateEntry(index, { address: event.target.value })} required /></label>
                          <label>建物名<input autoComplete="address-line2" value={entry.building} onChange={(event) => updateEntry(index, { building: event.target.value })} /></label>
                          <label>電話番号 ★<input type="tel" autoComplete="tel" value={entry.phone} onChange={(event) => updateEntry(index, { phone: event.target.value })} required /></label>
                          <label>メール<input type="email" autoComplete="email" value={entry.email} onChange={(event) => updateEntry(index, { email: event.target.value })} /></label>
                          <label>備考<textarea value={entry.note} rows={2} onChange={(event) => updateEntry(index, { note: event.target.value })} /></label>
                          <p className="help">登録内容は得意先住所録に自動保存され、次回から選択できます。</p>
                        </div>
                      )}
                    </fieldset>
                  );
                })}
              </div>
              {canAddMore ? (
                <button className="button secondary" type="button" data-testid="ship-to-add-manual" disabled={busy} onClick={addManualEntry}>
                  ＋ 新規入力で追加
                </button>
              ) : (
                <p className="help">納品先は最大{MAX_SHIP_TO_DESTINATIONS}件までです。</p>
              )}
              <form onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={busy}>
                <button
                  className="button"
                  type="submit"
                  disabled={busy || !allEntriesComplete}
                >
                  {busy ? "登録中..." : draftEntries.length > 1 ? `納品先を登録（${draftEntries.length}件）` : "納品先を登録"}
                </button>
              </form>
              {order.shipTo.status !== "confirmed" && order.customer_code ? (
                <button
                  className="button workflow-action role-customer"
                  type="button"
                  disabled={busy}
                  onClick={() => void onRun({ action: "request-ship-to-registration" }, "得意先に納品先登録依頼を送信しました。")}
                >
                  {order.shipTo.requestedAt ? "得意先登録依頼メールを再送" : "得意先に納品先登録を依頼"}
                </button>
              ) : null}
              {order.shipTo.status === "registered" ? (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => void onRun(
                    { action: "confirm-ship-to" },
                    registered.length > 1 ? `納品先${registered.length}件を確認しました。` : "納品先を確認しました。",
                  )}
                >
                  {registered.length > 1 ? `納品先を確認する（${registered.length}件）` : "納品先を確認する"}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}



function CustomerDesignPanel({
  order,
  isSeven,
  isKanei,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  isSeven: boolean;
  isKanei: boolean;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const design = order.customerDesign;
  const files = order.files.filter((file) => file.category === "customer_design");
  return (
    <section className="film-order-section role-customer" aria-label="得意先デザイン管理" data-testid="customer-design-panel">
      <div className="film-order-section-head">
        <h3>得意先デザイン管理</h3>
        <span className="workflow-role-badge-group">
          <WorkflowRoleBadge role="kanei" />
          <WorkflowRoleBadge role="customer" />
        </span>
      </div>
      <div className="film-order-columns">
        <dl>
          <div><dt>状態</dt><dd data-testid="customer-design-status">{customerDesignStatusLabels[design.status]}</dd></div>
          <div><dt>依頼日時</dt><dd>{design.requestedAt ? new Date(design.requestedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div><dt>受領日時</dt><dd>{design.receivedAt ? new Date(design.receivedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div><dt>確定日時</dt><dd>{design.confirmedAt ? new Date(design.confirmedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          {design.correctionReason ? <div><dt>修正理由</dt><dd>{design.correctionReason}</dd></div> : null}
        </dl>
        <div className="film-order-inline-actions">
          {files.length ? (
            <ul>
              {files.map((file) => <li key={file.id}>v{file.version} / {file.file_name}</li>)}
            </ul>
          ) : <p>まだアップロードはありません。</p>}
          {canOperate(buyerCompanyOf(order), isSeven, isKanei) && design.status === "received" ? (
            <>
              <button className="button" type="button" disabled={busy} onClick={() => void onRun({ action: "confirm-customer-design" }, "得意先デザインを確定しました。")}>確定する</button>
              <CustomerDesignCorrectionForm busy={busy} onSubmit={({ internalReason, customerMessage }) => void onRun({ action: "request-customer-design-correction", reason: internalReason, customerMessage }, "得意先修正依頼を送信しました。")} />
            </>
          ) : null}
          {canOperate(buyerCompanyOf(order), isSeven, isKanei) && ["requested","received","correction_requested"].includes(design.status) ? (
            <CustomerDesignNotRequiredForm busy={busy} onSubmit={(reason) => void onRun({ action: "set-customer-design-not-required", reason }, "得意先デザインを不要に設定しました。")} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CustomerDesignRequestForm({ busy, onSubmit }: { busy: boolean; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(note.trim()); }}>
      <label>依頼メモ（任意）<textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} /></label>
      <button className="button" type="submit" disabled={busy}>{busy ? "送信中..." : "得意先にアップロード依頼"}</button>
    </form>
  );
}

function CustomerDesignCorrectionForm({ busy, onSubmit }: { busy: boolean; onSubmit: (values: { internalReason: string; customerMessage: string }) => void }) {
  const [internalReason, setInternalReason] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  return (
    <form className="film-order-form compact" onSubmit={(event) => { event.preventDefault(); onSubmit({ internalReason: internalReason.trim(), customerMessage: customerMessage.trim() }); }}>
      <label>内部確認メモ（任意）<textarea value={internalReason} rows={2} onChange={(event) => setInternalReason(event.target.value)} /></label>
      <label>得意先向けメッセージ（日本語推奨・한국어も可）<textarea value={customerMessage} rows={3} onChange={(event) => setCustomerMessage(event.target.value)} required /></label>
      <button className="button secondary" type="submit" disabled={busy}>{busy ? "送信中..." : "修正を依頼"}</button>
    </form>
  );
}

function CustomerDesignNotRequiredForm({
  busy,
  selfService = false,
  immediate = false,
  onSubmit,
}: {
  busy: boolean;
  selfService?: boolean;
  immediate?: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const SELF_SERVICE_DEFAULT_REASON = "カネイ側の自社製作データで進行";
  const form = (
    <form
      className={`film-order-form ${immediate ? "" : "compact"}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(selfService ? (reason.trim() || SELF_SERVICE_DEFAULT_REASON) : reason.trim());
      }}
    >
      <label>
        {selfService ? "設定メモ" : "理由"}
        <textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} required={!selfService} aria-describedby={selfService ? "self-data-mode-help" : undefined} />
      </label>
      {selfService ? <small id="self-data-mode-help" className="help">任意。空欄の場合は「{SELF_SERVICE_DEFAULT_REASON}」を記録します。</small> : null}
      <button className={selfService ? "button" : "button danger"} type="submit" disabled={busy}>
        {selfService ? (busy ? "設定中..." : "自社データで進める") : (busy ? "設定中..." : "設定")}
      </button>
    </form>
  );
  if (immediate) return form;
  return (
    <details>
      <summary className={selfService ? "button small" : "button secondary small"}>
        {selfService ? "自社データに切り替える" : "得意先デザイン不要にする"}
      </summary>
      {form}
    </details>
  );
}

function CustomerProofPanel({
  order,
  isKanei,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  isKanei: boolean;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const review = order.customerProof;
  const latestProof = order.files
    .filter((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf"))
    .at(-1);
  return (
    <section className="film-order-section role-customer" aria-label="得意先校正レビュー" data-testid="customer-proof-panel">
      <div className="film-order-section-head">
        <h3>校正レビュー・二段階承認</h3>
        <span className="workflow-role-badge-group">
          <WorkflowRoleBadge role="customer" />
          <WorkflowRoleBadge role="kanei" />
          <WorkflowRoleBadge role={buyerRoleOf(order)} label={companyLabel(buyerRoleOf(order))} />
        </span>
      </div>
      <div className="film-order-columns">
        <dl>
          <div><dt>得意先レビュー</dt><dd data-testid="customer-proof-status">{customerProofStatusLabels[review.status]}</dd></div>
          <div><dt>依頼日時</dt><dd>{review.requestedAt ? new Date(review.requestedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div><dt>得意先承認日時</dt><dd>{review.approvedAt ? new Date(review.approvedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div>
            <dt>① カネイ側承認</dt>
            <dd data-testid="supplier-approval-status">
              {review.supplierApprovalStatus === "approved"
                ? `${new Date(review.supplierApprovalAt ?? "").toLocaleString("ja-JP")} / ${review.supplierApprovalBy || "-"}`
                : "待ち"}
            </dd>
          </div>
          {review.supplierApprovalNote ? <div className="wide"><dt>承認根拠</dt><dd>{review.supplierApprovalNote}</dd></div> : null}
          <div>
            <dt>② Buyer最終承認</dt>
            <dd data-testid="buyer-approval-status">
              {review.buyerApprovalStatus === "approved"
                ? `${new Date(review.buyerApprovalAt ?? "").toLocaleString("ja-JP")} / ${review.buyerApprovalBy || "-"}`
                : "待ち"}
            </dd>
          </div>
          <div><dt>最新校正PDF</dt><dd>{latestProof ? `v${latestProof.version} / ${latestProof.file_name}` : "-"}</dd></div>
          {review.correctionReason ? <div className="wide"><dt>得意先修正依頼</dt><dd>{review.correctionReason}</dd></div> : null}
        </dl>
        <div className="film-order-inline-actions">
          {isKanei && order.status === "proof_registered" && latestProof && ["pending","requested","correction_requested"].includes(review.status) ? (
            <button className="button workflow-action role-customer" type="button" disabled={busy} onClick={() => void onRun({ action: "send-customer-proof-review" }, "得意先校正レビュー依頼を送信しました。")}>
              得意先レビューリンク送信
            </button>
          ) : null}
          {isKanei && ["receiving_registered","re_proof_requested"].includes(order.status) ? (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              title="기존 업로드 링크를 폐기하고 새 링크로 재안내합니다."
              onClick={() => void onRun({ action: "rotate-supplier-proof-token" }, "업로드 링크를 강제 재발급하고 재안내했습니다.")}
            >
              업로드 링크 강제 재발급
            </button>
          ) : null}
          {review.status === "approved" && review.supplierApprovalStatus !== "approved"
            ? <p className="film-order-final">得意先承認済み。次にカネイ側校正承認を記録してください。</p>
            : null}
          {review.supplierApprovalStatus === "approved" && review.buyerApprovalStatus !== "approved"
            ? <p className="film-order-final">カネイ側承認済み。{companyLabel(buyerCompanyOf(order))}の最終承認に進めます。</p>
            : null}
          {order.status === "proof_registered" && ["pending","requested","correction_requested"].includes(review.status) ? (
            <p className="film-order-final">得意先承認前に最終承認はできません。</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CustomerProofOfflineForm({ busy, onSubmit }: { busy: boolean; onSubmit: (approverName: string, evidence: string, reason: string) => void }) {
  const [approverName, setApproverName] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  return (
    <details>
      <summary className="button secondary small">オフライン承認を記録</summary>
      <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(approverName.trim(), evidence.trim(), reason.trim()); }}>
        <label>承認者<input value={approverName} onChange={(event) => setApproverName(event.target.value)} required /></label>
        <label>証拠<textarea value={evidence} rows={2} onChange={(event) => setEvidence(event.target.value)} required /></label>
        <label>承認理由<textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} required /></label>
        <button className="button" type="submit" disabled={busy}>記録</button>
      </form>
    </details>
  );
}

function OrderSheet({ order }: { order: FilmOrderView }) {
  const po = order.purchaseOrder;
  const filmTotal = D(po?.filmCostYen ?? "0");
  const copperTotal = po?.copperPlate ? D(po.copperPlate.priceYen) : D(0);
  const moldTotal = po?.customMold ? D(po.customMold.costYen) : D(0);
  const orderTotal = filmTotal.plus(copperTotal).plus(moldTotal);
  const yen = (value: ReturnType<typeof D>) => `￥${Number(value.toFixed(0)).toLocaleString("ja-JP")}`;
  const filmQuotationNumber = filmQuotationNumberFor(order.quotation_number, order.created_at);
  return (
    <section className="film-order-section film-order-sheet" aria-label="発注内容">
      <div className="no-print film-order-sheet-head">
        <h3>発注内容（フィルム仕様）</h3>
        <div className="film-order-sheet-actions">
          <Link
            className="button secondary small"
            href={`/history?record=${order.quotation_id}&tab=film`}
            target="_blank"
            data-testid="open-film-quotation"
          >
            フィルム見積書
          </Link>
          <button className="button secondary small" type="button" onClick={() => window.print()}>発注書を印刷</button>
        </div>
      </div>
      <div className="film-order-sheet-body">
        <h2>フィルム発注書</h2>
        <dl>
          <div><dt>発注番号</dt><dd>{order.order_number}</dd></div>
          <div><dt>見積番号</dt><dd>{order.quotation_number}</dd></div>
          <div><dt>フィルム見積番号</dt><dd>{filmQuotationNumber}</dd></div>
          <div><dt>商品名</dt><dd>{order.product_name || "-"}</dd></div>
          <div><dt>印刷方式</dt><dd>{order.printing_method === "gravure" ? "グラビア印刷" : order.printing_method === "digital" ? "デジタル印刷" : "-"}</dd></div>
          <div><dt>フィルム構成</dt><dd>{order.film_composition || "-"}</dd></div>
          <div><dt>原反幅</dt><dd>{order.web_width_mm ? `${order.web_width_mm}mm` : "-"}</dd></div>
          <div><dt>発注長</dt><dd>{order.order_length_m ? `${Number(order.order_length_m).toLocaleString("ja-JP")}m` : "-"}</dd></div>
          {po?.webWidthsMm && po.webWidthsMm.length > 1 ? (
            <div className="wide"><dt>SKU別原反幅</dt><dd>{po.webWidthsMm.map((width) => `${width}mm`).join(" / ")}</dd></div>
          ) : null}
          {order.procurement_route ? <div><dt>調達経路</dt><dd>{order.procurement_route === "Y" ? "国内調達" : "韓国輸入"}</dd></div> : null}
          {po?.filmCostYen ? <div><dt>フィルム金額</dt><dd>{yen(filmTotal)}</dd></div> : null}
          {po?.copperPlate ? (
            <div><dt>銅版</dt><dd>{po.copperPlate.quantity}枚 ／ {po.copperPlate.plateWidthMm}mm ／ {yen(copperTotal)}</dd></div>
          ) : null}
          {po?.customMold ? <div><dt>カスタム金型</dt><dd>{yen(moldTotal)}</dd></div> : null}
          <div className="film-order-total wide"><dt>発注金額合計（税抜）</dt><dd>{yen(orderTotal)}</dd></div>
        </dl>
        {po?.skuOrderDetails?.length ? (
          <div className="table-scroll">
            <table className="film-order-sku">
              <thead><tr><th>SKU</th><th>色数</th><th>発注長</th><th>原反幅</th><th>倍率</th></tr></thead>
              <tbody>
                {po.skuOrderDetails.map((sku) => (
                  <tr key={sku.skuCode}>
                    <td>{sku.skuCode}</td>
                    <td>{sku.colorCount}</td>
                    <td>{Number(sku.orderLengthM).toLocaleString("ja-JP")}m</td>
                    <td>{sku.webWidthMm}mm</td>
                    <td>×{sku.multiplier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="film-order-sheet-note">発注書はセブン化学からカネイ側へメールで送付してください。送信後に「発注書送信済みにする」でステータスを進めます。</p>
      </div>
    </section>
  );
}

function SampleBulkPanel({ order }: { order: FilmOrderView }) {
  const bulk = order.sampleBulk;
  return (
    <section className="film-order-section role-customer" aria-label="サンプルバルク支給管理" data-testid="sample-bulk-panel">
      <div className="film-order-section-head">
        <h3>サンプルバルク支給管理</h3>
        <WorkflowRoleBadge role="customer" />
      </div>
      <div className="film-order-inline-actions">
        <p className="film-order-final">
          この工程は見積ステージへ移動しました。見積履歴の「サンプルバルク」タブで確認してください。
        </p>
        <dl>
          <div><dt>参考（本生産用バルク量）</dt><dd>{bulk.productionBulkUsageMl ? `${Number(bulk.productionBulkUsageMl).toLocaleString("ja-JP")}ml` : "-"}</dd></div>
          <div><dt>履歴ステータス</dt><dd>{sampleBulkStatusLabels[bulk.status]}</dd></div>
        </dl>
        <p className="help">
          発注後の操作は廃止しました。得意先バルク確認→充填方法決定→見積反映→内部承認の順で進めます。
        </p>
      </div>
    </section>
  );
}

function openPreview(url: string, fileName: string): void {
  const fileId = url.split("/d/")[1]?.split("/")[0];
  if (!fileId) return;
  window.open(`/api/film-orders/preview?fileId=${encodeURIComponent(fileId)}`, "_blank");
}

function isPreviewable(fileName: string): boolean {
  return /\.(pdf|png|jpe?g|gif|svg)$/iu.test(fileName);
}

function ReceivingForm({
  order,
  autofocus,
  busy,
  driveReady,
  onSubmit,
}: {
  order: FilmOrderView;
  autofocus?: boolean;
  busy?: boolean;
  driveReady: boolean;
  onSubmit: (aiFileName: string, aiFileUrl: string, pdfFileName: string, pdfFileUrl: string, note: string, guideAcknowledged: boolean) => void;
}) {
  const baseName = buildFilmOrderFileName(order, "receiving", 1);
  const [aiFileName, setAiFileName] = useState(`${baseName}.ai`);
  const [aiFileUrl, setAiFileUrl] = useState("");
  const [aiUploaded, setAiUploaded] = useState(false);
  const [pdfFileName, setPdfFileName] = useState(`${baseName}.pdf`);
  const [pdfFileUrl, setPdfFileUrl] = useState("");
  const [pdfUploaded, setPdfUploaded] = useState(false);
  const [withPdf, setWithPdf] = useState(false);
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const [guideChecks, setGuideChecks] = useState<boolean[]>([false, false, false]);
  const guidesChecked = allUploadGuidesChecked(guideChecks);
  const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value.trim());
  const aiReady = driveReady ? aiUploaded : isHttpUrl(aiFileUrl);
  const pdfReady = driveReady ? pdfUploaded : isHttpUrl(pdfFileUrl);
  const receivingReady = aiFileName.trim().toLowerCase().endsWith(".ai")
    && aiReady
    && (!withPdf || (pdfFileName.trim().toLowerCase().endsWith(".pdf") && pdfReady))
    && guidesChecked;
  const pendingItems: string[] = [];
  if (!aiFileName.trim().toLowerCase().endsWith(".ai")) pendingItems.push("AIファイル名を .ai に設定");
  if (!guidesChecked) pendingItems.push("入稿ガイド3冊の確認チェック");
  else if (!aiReady) pendingItems.push(driveReady ? "AIファイルをDriveへアップロード" : "AIファイルのDrive URLを入力");
  if (withPdf) {
    if (!pdfFileName.trim().toLowerCase().endsWith(".pdf")) pendingItems.push("PDFファイル名を .pdf に設定");
    else if (!pdfReady) pendingItems.push(driveReady ? "PDFファイルをDriveへアップロード" : "PDFファイルのDrive URLを入力");
  }
  const submitReceiving = () => {
    if (!receivingReady) {
      setFormError(
        driveReady
          ? "AIファイルはDriveへアップロードしてください。PDFを含める場合はPDFのアップロードも完了させてください。"
          : "AIファイルのDrive URLは必須です。PDFを含める場合はPDFのURLも入力してください。",
      );
      return;
    }
    setFormError("");
    onSubmit(aiFileName.trim(), aiFileUrl.trim(), withPdf ? pdfFileName.trim() : "", withPdf ? pdfFileUrl.trim() : "", note, true);
  };
  return (
    <div className="film-order-file-form">
      <strong>入稿データ登録（フィルム製作用）</strong>
      <CompactDriveUploadField
        label="AIファイル（必須）"
        accept=".ai"
        orderId={order.id}
        category="receiving"
        baseName={`${baseName}.ai`}
        onFileNameChange={setAiFileName}
        onUrlChange={setAiFileUrl}
        url={aiFileUrl}
        onUploadedChange={setAiUploaded}
        autofocus={autofocus}
        driveReady={driveReady === true}
      />
      <label className="film-order-pdf-toggle">
        <input type="checkbox" checked={withPdf} onChange={(event) => setWithPdf(event.target.checked)} />
        PDFも追加する（任意）
      </label>
      {withPdf ? (
        <CompactDriveUploadField
          label="PDFファイル"
          accept=".pdf"
          orderId={order.id}
          category="receiving"
          baseName={`${baseName}.pdf`}
          onFileNameChange={setPdfFileName}
          onUrlChange={setPdfFileUrl}
          url={pdfFileUrl}
          onUploadedChange={setPdfUploaded}
          driveReady={driveReady === true}
        />
      ) : null}
      <UploadGuideAcknowledgement
        checks={guideChecks}
        onChange={(index, checked) => setGuideChecks((old) => old.map((value, itemIndex) => itemIndex === index ? checked : value))}
      />
      <details className="film-order-note-details">
        <summary>メモを追加（任意）</summary>
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" />
      </details>
      <p className="film-order-upload-hint" data-testid="receiving-readiness">
        {pendingItems.length > 0 ? `送信に必要: ${pendingItems.join(" / ")}` : "入稿データを送信できます。"}
      </p>
      {formError ? <p className="film-order-upload-error" role="alert">{formError}</p> : null}
      <button
        className="button"
        type="button"
        disabled={busy || !receivingReady}
        title={pendingItems.length > 0 ? `送信に必要: ${pendingItems.join(" / ")}` : "入稿データを送信します"}
        onClick={submitReceiving}
      >
        入稿してデザインへ連絡
      </button>
    </div>
  );
}

function normalizeUploadName(baseName: string, extension: ".ai" | ".pdf"): string {
  const dot = baseName.lastIndexOf(".");
  return `${dot > 0 ? baseName.slice(0, dot) : baseName}${extension}`;
}

function CompactDriveUploadField({
  label,
  accept,
  orderId,
  category,
  baseName,
  onFileNameChange,
  url,
  onUrlChange,
  onUploadedChange,
  autofocus,
  driveReady,
}: {
  label: string;
  accept: ".ai" | ".pdf";
  orderId: number;
  category: "receiving" | "proof";
  baseName: string;
  onFileNameChange: (value: string) => void;
  url: string;
  onUrlChange: (value: string) => void;
  onUploadedChange?: (uploaded: boolean) => void;
  autofocus?: boolean;
  driveReady: boolean;
}) {
  const extension = accept;
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState(baseName);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState("");

  const humanizeError = (value: string): string => (
    value === "Failed to fetch"
      ? "Googleへの接続が中断されました。ページを再読込して再試行してください。"
      : `アップロード失敗: ${value}`
  );

  const upload = async (targetFile: File, targetName: string): Promise<void> => {
    setUploading(true);
    setUploaded(false);
    onUploadedChange?.(false);
    setError("");
    try {
      const sessionResponse = await fetch(`/api/film-orders/${orderId}/upload-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          fileName: targetName,
          sizeBytes: targetFile.size,
          contentType: targetFile.type || "application/octet-stream",
        }),
      });
      const session = await sessionResponse.json() as { sessionUri?: string; error?: string };
      if (!sessionResponse.ok || !session.sessionUri) throw new Error(session.error ?? "session_failed");
      const put = await fetch(session.sessionUri, {
        method: "PUT",
        headers: {
          "Content-Type": targetFile.type || "application/octet-stream",
          "Content-Range": `bytes 0-${targetFile.size - 1}/${targetFile.size}`,
        },
        body: targetFile,
      });
      const uploaded = await put.json().catch(() => ({})) as { id?: unknown };
      if (!put.ok || typeof uploaded.id !== "string") throw new Error(`upload_failed:${put.status}`);
      const completeResponse = await fetch(`/api/film-orders/${orderId}/upload-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, fileName: targetName, fileId: uploaded.id }),
      });
      const complete = await completeResponse.json() as { url?: string; error?: string };
      if (!completeResponse.ok || !complete.url) throw new Error(complete.error ?? "complete_failed");
      onUrlChange(complete.url);
      setUploaded(true);
      onUploadedChange?.(true);
    } catch (cause) {
      onUrlChange("");
      onUploadedChange?.(false);
      setError(humanizeError(cause instanceof Error ? cause.message : "unknown_error"));
    } finally {
      setUploading(false);
    }
  };

  const pickFile = (selected: File | null): void => {
    setFile(selected);
    setUploaded(false);
    setError("");
    onUploadedChange?.(false);
    if (!selected) return;
    if (selected.size <= 0) {
      setError("ファイルが読み取れませんでした。ローカルに保存したファイルを選択してください。");
      return;
    }
    if (selected.size > 15 * 1024 * 1024) {
      setError(`ファイルサイズが15MBを超えています（${(selected.size / 1024 / 1024).toFixed(1)}MB）。`);
      return;
    }
    const targetName = normalizeUploadName(fileName, extension);
    setFileName(targetName);
    onFileNameChange(targetName);
    if (driveReady) void upload(selected, targetName);
  };

  if (!driveReady) {
    return (
      <div className="film-order-drive-field">
        <label>{label} URL
          <input
            value={url}
            onChange={(event) => {
              onUrlChange(event.target.value);
              setUploaded(/^https?:\/\//iu.test(event.target.value));
              onUploadedChange?.(/^https?:\/\//iu.test(event.target.value));
            }}
            placeholder="https://drive.google.com/..."
            inputMode="url"
            autoFocus={autofocus}
          />
        </label>
      </div>
    );
  }

  const status = uploading ? "uploading" : uploaded ? "done" : error ? "error" : file ? "selected" : "empty";
  const statusLabel = uploading
    ? "アップロード中..."
    : uploaded
      ? "完了 ✓"
      : error
        ? "要再選択"
        : file
          ? "選択済み"
          : "未選択";

  return (
    <div className="compact-upload">
      <label className={`upload-zone ${uploaded ? "done" : error ? "error" : ""}`}>
        <span className="upload-zone-main">
          <strong>{label}</strong>
          <small>{file ? `${file.name} → ${fileName}` : "クリックしてファイルを選択"}</small>
        </span>
        <span className={`upload-status ${status}`}>{statusLabel}</span>
        <input
          className="visually-hidden"
          type="file"
          accept={extension}
          autoFocus={autofocus}
          onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
        />
      </label>
      {uploaded && url ? <a href={url} target="_blank" rel="noreferrer">アップロード済みファイルを開く</a> : null}
      {error ? <p className="film-order-upload-error" role="alert">{error}</p> : null}
    </div>
  );
}

function ProofRegistrationForm({
  order,
  version,
  autofocus,
  busy,
  driveReady,
  title,
  submitLabel,
  onSubmit,
}: {
  order: FilmOrderView;
  version: number;
  autofocus?: boolean;
  busy?: boolean;
  driveReady?: boolean;
  title: string;
  submitLabel: string;
  onSubmit: (aiFileName: string, aiFileUrl: string, pdfFileName: string, pdfFileUrl: string, note: string) => void;
}) {
  const baseName = buildFilmOrderFileName(order, "proof", version);
  const [aiFileName, setAiFileName] = useState(`${baseName}.ai`);
  const [aiFileUrl, setAiFileUrl] = useState("");
  const [aiUploaded, setAiUploaded] = useState(false);
  const [pdfFileName, setPdfFileName] = useState(`${baseName}.pdf`);
  const [pdfFileUrl, setPdfFileUrl] = useState("");
  const [pdfUploaded, setPdfUploaded] = useState(false);
  const [withPdf, setWithPdf] = useState(true);
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value.trim());
  const aiReady = driveReady ? aiUploaded : isHttpUrl(aiFileUrl);
  const pdfReady = driveReady ? pdfUploaded : isHttpUrl(pdfFileUrl);
  const proofReady = aiFileName.trim().toLowerCase().endsWith(".ai")
    && aiReady
    && (!withPdf || (pdfFileName.trim().toLowerCase().endsWith(".pdf") && pdfReady));
  const submitProof = () => {
    if (!proofReady) {
      setFormError(
        driveReady
          ? "AIファイルはDriveへアップロードしてください。PDFを含める場合はPDFのアップロードも完了させてください。"
          : "AIファイルのDrive URLは必須です。PDFを含める場合はPDFのURLも入力してください。",
      );
      return;
    }
    setFormError("");
    onSubmit(aiFileName.trim(), aiFileUrl.trim(), withPdf ? pdfFileName.trim() : "", pdfFileUrl.trim(), note);
  };
  return (
    <div className="film-order-file-form">
      <strong>{title}</strong>
      {!driveReady ? <p className="film-order-upload-hint">直接アップロードは未設定です。Driveへ手動アップロード後、URLを入力してください。</p> : null}
      <DriveFileField
        label="AIファイル（必須）"
        orderId={order.id}
        category="proof"
        fileName={aiFileName}
        onFileNameChange={setAiFileName}
        url={aiFileUrl}
        onUrlChange={setAiFileUrl}
        onUploadedChange={setAiUploaded}
        accept=".ai"
        autofocus={autofocus}
        driveReady={driveReady === true}
      />
      <label className="film-order-pdf-toggle">
        <input type="checkbox" checked={withPdf} onChange={(event) => setWithPdf(event.target.checked)} />
        PDFも登録する（任意）
      </label>
      {withPdf ? (
        <DriveFileField
          label="PDFファイル"
          orderId={order.id}
          category="proof"
          fileName={pdfFileName}
          onFileNameChange={setPdfFileName}
          url={pdfFileUrl}
          onUrlChange={setPdfFileUrl}
          onUploadedChange={setPdfUploaded}
          accept=".pdf"
          driveReady={driveReady === true}
        />
      ) : null}
      <label>メモ<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" /></label>
      <button
        className="button"
        type="button"
        disabled={busy || !proofReady}
        onClick={() => onSubmit(aiFileName.trim(), aiFileUrl.trim(), withPdf ? pdfFileName.trim() : "", withPdf ? pdfFileUrl.trim() : "", note)}
      >
        {submitLabel}
      </button>
    </div>
  );
}

function FileActionForm({
  title,
  defaultFileName,
  submitLabel,
  busy,
  autofocus,
  driveReady,
  orderId,
  category,
  onSubmit,
}: {
  title: string;
  defaultFileName: string;
  submitLabel: string;
  busy?: boolean;
  autofocus?: boolean;
  driveReady?: boolean;
  orderId?: number;
  category?: "receiving" | "proof";
  onSubmit: (fileName: string, note: string, fileUrl: string) => void;
}) {
  const [fileName, setFileName] = useState(defaultFileName);
  const [fileUrl, setFileUrl] = useState("");
  const [note, setNote] = useState("");
  const [fileUploaded, setFileUploaded] = useState(false);
  const [formError, setFormError] = useState("");
  const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value.trim());
  const fileReady = driveReady ? fileUploaded : isHttpUrl(fileUrl);
  const submitFile = () => {
    if (!fileReady) {
      setFormError(driveReady ? "ファイルをDriveへアップロードしてください。" : "ファイルのDrive URLを入力してください。");
      return;
    }
    setFormError("");
    onSubmit(fileName.trim(), note, fileUrl.trim());
  };
  return (
    <div className="film-order-file-form">
      <strong>{title}</strong>
      {orderId && category ? (
        <DriveFileField
          label="ファイル"
          orderId={orderId}
          category={category}
          fileName={fileName}
          onFileNameChange={setFileName}
          url={fileUrl}
          onUrlChange={setFileUrl}
          onUploadedChange={setFileUploaded}
          driveReady={driveReady === true}
          autofocus={autofocus}
        />
      ) : (
        <>
          <label>ファイル名
            <input value={fileName} onChange={(event) => setFileName(event.target.value)} autoFocus={autofocus} />
          </label>
          <label>ファイルURL（任意）
            <input value={fileUrl} onChange={(event) => setFileUrl(event.target.value)} placeholder="https://drive.google.com/..." inputMode="url" />
          </label>
        </>
      )}
      <label>メモ<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" /></label>
      {formError ? <p className="film-order-upload-error" role="alert">{formError}</p> : null}
      <button className="button" type="button" disabled={busy || !fileName.trim() || !fileReady} onClick={submitFile}>
        {submitLabel}
      </button>
    </div>
  );
}

function DriveFileField({
  label,
  orderId,
  category,
  fileName,
  onFileNameChange,
  url,
  onUrlChange,
  onUploadedChange,
  accept,
  autofocus,
  driveReady,
}: {
  label: string;
  orderId: number;
  category: "receiving" | "proof";
  fileName: string;
  onFileNameChange: (value: string) => void;
  url: string;
  onUrlChange: (value: string) => void;
  onUploadedChange?: (uploaded: boolean) => void;
  accept?: string;
  autofocus?: boolean;
  driveReady: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState("");

  const pickFile = (selected: File | null) => {
    setFile(selected);
    setUploaded(false);
    onUploadedChange?.(false);
    setError("");
    if (selected) {
      if (selected.size <= 0) {
        setError("ファイルが読み取れませんでした。ローカルに保存したファイルを選択してください。");
        setFile(null);
        return;
      }
      if (selected.size > 15 * 1024 * 1024) {
        setError(`ファイルサイズが15MBを超えています（${(selected.size / 1024 / 1024).toFixed(1)}MB）。圧縮するか、Driveへ直接アップロードしてURLを登録してください。`);
        setFile(null);
        return;
      }
      const extension = selected.name.includes(".") ? selected.name.slice(selected.name.lastIndexOf(".")).toLowerCase() : "";
      const expectedExtension = accept === ".pdf" ? ".pdf" : accept === ".ai" ? ".ai" : null;
      const looksLikePdf = extension === ".pdf" || selected.type === "application/pdf";
      const valid = expectedExtension === ".pdf"
        ? (extension === ".pdf" || looksLikePdf)
        : expectedExtension == null || extension === expectedExtension;
      if (!valid) {
        setError(`ファイル形式が正しくありません。${expectedExtension} を選択してください（選択: ${selected.name}）。`);
        setFile(null);
        return;
      }
      const dot = fileName.lastIndexOf(".");
      const normalizedExtension = expectedExtension ?? extension;
      onFileNameChange(dot > 0 ? `${fileName.slice(0, dot)}${normalizedExtension}` : `${fileName}${normalizedExtension}`);
    }
  };

  const upload = async () => {
    if (!file || uploading) return;
    setUploading(true);
    onUploadedChange?.(false);
    setError("");
    try {
      const sessionResponse = await fetch(`/api/film-orders/${orderId}/upload-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          fileName: fileName.trim(),
          sizeBytes: file.size,
          contentType: file.type || "application/octet-stream",
        }),
      });
      const session = await sessionResponse.json() as { sessionUri?: string; error?: string };
      if (!sessionResponse.ok || !session.sessionUri) throw new Error(session.error ?? "session_failed");
      const put = await fetch(session.sessionUri, {
        method: "PUT",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          // 小さなファイルでも最終リクエストとして扱わせるために必須。
          "Content-Range": `bytes 0-${file.size - 1}/${file.size}`,
        },
        body: file,
      });
      if (!put.ok) throw new Error(`upload_failed:${put.status}`);
      const uploaded = await put.json().catch(() => ({})) as { id?: unknown };
      if (!put.ok || typeof uploaded.id !== "string") throw new Error(`upload_failed:${put.status}`);
      const completeResponse = await fetch(`/api/film-orders/${orderId}/upload-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, fileName: fileName.trim(), fileId: uploaded.id }),
      });
      const complete = await completeResponse.json() as { url?: string; error?: string };
      if (!completeResponse.ok || !complete.url) throw new Error(complete.error ?? "complete_failed");
      onUrlChange(complete.url);
      setUploaded(true);
      onUploadedChange?.(true);
    } catch (err) {
      onUploadedChange?.(false);
      setError(err instanceof Error ? `アップロード失敗: ${err.message}` : "アップロードに失敗しました。");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="film-order-drive-field">
      <label>{label}
        <input value={fileName} onChange={(event) => { onFileNameChange(event.target.value); setUploaded(false); onUploadedChange?.(false); }} autoFocus={autofocus} />
      </label>
      <label>ファイル選択
        <input type="file" accept={accept} onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />
      </label>
      {driveReady ? (
        <button className="button secondary small" type="button" disabled={!file || uploading || uploaded} onClick={() => void upload()}>
          {uploaded ? "アップロード済み ✓" : uploading ? "アップロード中..." : "Driveへアップロード"}
        </button>
      ) : null}
      {uploaded && url ? <a href={url} target="_blank" rel="noreferrer">アップロード済みファイルを開く</a> : null}
      {!driveReady ? (
        <label>URL（Drive手動登録用・任意）
          <input value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder="https://drive.google.com/..." inputMode="url" />
        </label>
      ) : null}
      {error ? <p className="film-order-upload-error">{error}</p> : null}
    </div>
  );
}

function ReProofForm({
  order,
  busy,
  onSubmit,
}: {
  order: FilmOrderView;
  busy: boolean;
  onSubmit: (values: { internalComment: string; supplierMessage: string }) => void;
}) {
  const locale = order.makerLanguage ?? supplierLocaleFor(order);
  const isKorean = locale === "ko";
  const [comment, setComment] = useState("");
  const [supplierMessage, setSupplierMessage] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="button danger" type="button" onClick={() => setOpen(true)}>再校正を依頼</button>
    );
  }
  return (
    <div className="film-order-file-form">
      <strong>再校正依頼</strong>
      <label>내부 확인용 메모 / 内部確認用メモ
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="修正内容を記入してください" />
      </label>
      <label>{isKorean ? "공급사 전달용 한국어 메시지" : "供給先用メッセージ（日本語推奨・한국어も可）"}
        <textarea
          value={supplierMessage}
          onChange={(event) => setSupplierMessage(event.target.value)}
          rows={3}
          placeholder={isKorean ? "필름업체에 그대로 전달됩니다. 한국어로 입력하세요." : "フィルムメーカーにそのまま送付されます。日本語で入力してください。"}
          required
        />
      </label>
      <button className="button danger" type="button" disabled={busy || !comment.trim() || !supplierMessage.trim()} onClick={() => onSubmit({ internalComment: comment.trim(), supplierMessage: supplierMessage.trim() })}>
        再校正依頼を送信
      </button>
      <button className="button secondary small" type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
    </div>
  );
}
