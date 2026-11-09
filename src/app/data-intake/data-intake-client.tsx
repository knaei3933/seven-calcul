"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  allUploadGuidesChecked,
  UploadGuideAcknowledgement,
} from "@/components/upload-guide-acknowledgement";
import type {
  FilmOrderIntakeAction,
  FilmOrderIntakeDualApprovalStatus,
  FilmOrderIntakeEntry,
  FilmOrderIntakeMakerHandoffStatus,
  FilmOrderIntakePage,
  FilmOrderIntakePoStatus,
  FilmOrderIntakeProofStatus,
  FilmOrderIntakeState,
} from "@/lib/film-order-intake";
import type { DeliveryNoteDraft } from "@/lib/film-order-shared";

type Viewer = { id: number; email: string; name: string; role: "admin" | "user" };
type DataIntakeResponse = FilmOrderIntakePage & { created?: number };

const ownerLabels = { seven: "S7 セブン化学", kanei: "KT 金井貿易", unresolved: "未解決" } as const;
const stateLabels: Record<FilmOrderIntakeState, string> = {
  linked: "連携済み",
  pending_sync: "連携待ち",
  owner_mismatch: "会社不一致",
  unresolved_owner: "所有未解決",
};
const makerLabels: Record<FilmOrderIntakeMakerHandoffStatus, string> = {
  unavailable: "対象外",
  not_registered: "入稿前",
  registered: "入稿受領",
};
const proofLabels: Record<FilmOrderIntakeProofStatus, string> = {
  unavailable: "対象外",
  pending: "確認待ち",
  requested: "レビュー依頼",
  approved: "承認済み",
  correction_requested: "修正依頼",
  legacy_exempt: "既存対象外",
};
const approvalLabels: Record<FilmOrderIntakeDualApprovalStatus, string> = {
  pending: "未承認",
  owner_approved: "所有会社承認",
  kanei_approved: "金井承認",
  approved: "双方承認",
};
const poLabels: Record<FilmOrderIntakePoStatus, string> = {
  unavailable: "対象外",
  not_sent: "未発注",
  sent: "発注済み",
};

type ShipToForm = {
  companyName: string;
  postalCode: string;
  address: string;
  phone: string;
  email: string;
  note: string;
};

const emptyShipToForm: ShipToForm = {
  companyName: "",
  postalCode: "",
  address: "",
  phone: "",
  email: "",
  note: "",
};

const workflowGuide = [
  { step: 1, title: "データ入稿", owner: "見積所有会社", detail: "AI原稿を受入し、メーカーへ引き継ぎます。" },
  { step: 2, title: "校正確認", owner: "見積所有会社", detail: "校正ラウンドを確認し、修正または承認します。" },
  { step: 3, title: "双承認", owner: "所有会社 + 金井貿易", detail: "両社の承認が完了すると発注準備になります。" },
  { step: 4, title: "納品先確定", owner: "見積所有会社", detail: "納品先を登録し、内容を確定します。" },
  { step: 5, title: "フィルム発注", owner: "金井貿易", detail: "納品先確定後に発注メールを送信します。" },
  { step: 6, title: "納品書", owner: "金井貿易", detail: "到着見込を設定し、A4納品書を出力します。" },
] as const;

type WorkflowStageStatus = "done" | "active" | "waiting";

function workflowStages(entry: FilmOrderIntakeEntry): Array<{
  title: string;
  status: WorkflowStageStatus;
  value: string;
}> {
  const dataDone = entry.makerHandoffStatus === "registered";
  const proofDone = entry.proofStatus === "approved" || entry.proofStatus === "legacy_exempt";
  const poDone = entry.poStatus === "sent";
  const approvalsDone = entry.dualApprovalStatus === "approved";
  const shipToDone = entry.shipToStatus === "confirmed";
  return [
    {
      title: "データ入稿",
      status: dataDone ? "done" : entry.state === "linked" ? "active" : "waiting",
      value: makerLabels[entry.makerHandoffStatus],
    },
    {
      title: "校正",
      status: proofDone ? "done" : dataDone ? "active" : "waiting",
      value: proofLabels[entry.proofStatus],
    },
    {
      title: "双承認",
      status: entry.dualApprovalStatus === "approved"
        ? "done"
        : entry.dualApprovalStatus === "pending"
          ? dataDone && proofDone ? "active" : "waiting"
          : "active",
      value: approvalLabels[entry.dualApprovalStatus],
    },
    {
      title: "納品先",
      status: shipToDone ? "done" : approvalsDone ? "active" : "waiting",
      value: shipToDone ? "確定済み" : entry.shipToStatus === "registered" ? "登録済み" : "未登録",
    },
    {
      title: "発注",
      status: poDone ? "done" : shipToDone ? "active" : "waiting",
      value: poLabels[entry.poStatus],
    },
    {
      title: "納品書",
      status: entry.shippedOn ? "done" : poDone ? "active" : "waiting",
      value: entry.shippedOn ? `出荷 ${entry.shippedOn}` : poDone ? "作成可能" : "発注後",
    },
  ];
}

function nextWorkflowAction(entry: FilmOrderIntakeEntry): (Omit<FilmOrderIntakeAction, "kind"> & { kind: FilmOrderIntakeAction["kind"] | "ship_to" }) | null {
  const byKind = new Map(entry.actions.map((action) => [action.kind, action]));
  const pick = (kind: FilmOrderIntakeAction["kind"]): FilmOrderIntakeAction | null => {
    const action = byKind.get(kind);
    return action?.authorized && action.enabled ? action : null;
  };
  if (entry.state === "unresolved_owner") return null;
  if (entry.makerHandoffStatus !== "registered") return pick("intake_upload");
  if (entry.proofStatus !== "approved" && entry.proofStatus !== "legacy_exempt") return pick("proof_round");
  if (entry.dualApprovalStatus === "pending" || entry.dualApprovalStatus === "kanei_approved") return pick("owner_approval");
  if (entry.dualApprovalStatus === "owner_approved") return pick("kanei_approval");
  if (entry.shipToStatus !== "confirmed") {
    const ownerAction = byKind.get("owner_approval");
    if (!ownerAction?.authorized) return null;
    return { ...ownerAction, kind: "ship_to", label: "納品先登録・確定" };
  }
  if (entry.poStatus !== "sent") return pick("purchase_order");
  return pick("delivery_note");
}

function ownerBadgeClass(owner: FilmOrderIntakeEntry["ownerDomain"]): string {
  return owner === "kanei"
    ? "badge owner-badge owner-kanei"
    : owner === "seven"
      ? "badge owner-badge owner-seven"
      : "badge owner-badge owner-unresolved";
}

function ownerBadge(owner: FilmOrderIntakeEntry["ownerDomain"]): string {
  return owner === "kanei" ? "KT" : owner === "seven" ? "S7" : "未解決";
}

function IntakeActions({
  entry,
  nextKind,
  onUpload,
  onApproval,
  onShipTo,
  onPurchaseOrder,
  onDeliveryNote,
}: {
  entry: FilmOrderIntakeEntry;
  nextKind?: FilmOrderIntakeAction["kind"] | "ship_to";
  onUpload: (entry: FilmOrderIntakeEntry) => void;
  onApproval: (entry: FilmOrderIntakeEntry, kind: "owner_approval" | "kanei_approval") => void;
  onShipTo: (entry: FilmOrderIntakeEntry) => void;
  onPurchaseOrder: (entry: FilmOrderIntakeEntry) => void;
  onDeliveryNote: (entry: FilmOrderIntakeEntry) => void;
}) {
  const upload = entry.actions.find((action) => action.kind === "intake_upload");
  return (
    <div className="intake-actions">
      {entry.actions.map((action: FilmOrderIntakeAction) => (
        <button
          key={action.kind}
          type="button"
          disabled={!action.authorized || !action.enabled}
          data-testid={`intake-action-${action.kind}`}
          data-authorized={action.authorized ? "true" : "false"}
          onClick={
            action.kind === "intake_upload" && action.authorized
              ? () => onUpload(entry)
              : action.kind === "owner_approval" && action.authorized && action.enabled
                ? () => onApproval(entry, "owner_approval")
                : action.kind === "kanei_approval" && action.authorized && action.enabled
                  ? () => onApproval(entry, "kanei_approval")
                  : action.kind === "purchase_order" && action.authorized && action.enabled
                    ? () => onPurchaseOrder(entry)
                    : action.kind === "delivery_note" && action.authorized && action.enabled
                      ? () => onDeliveryNote(entry)
                      : undefined
          }
          title={
            action.kind === "intake_upload" && action.authorized
              ? "AI原稿を直接アップロードします。"
              : (action.kind === "owner_approval" || action.kind === "kanei_approval") && action.authorized && action.enabled
                ? `${action.reason} 承認フォームを開きます。`
                : action.reason
          }
          className={[
            "intake-action",
            action.authorized ? "authorized" : "",
            action.kind === nextKind && action.authorized && action.enabled ? "next-action" : "",
          ].filter(Boolean).join(" ")}
        >
          {action.kind === nextKind && action.authorized && action.enabled ? <span className="intake-action-step">NEXT</span> : null}
          {action.label}
        </button>
      ))}
      {entry.state === "linked"
        && entry.dualApprovalStatus === "approved"
        && entry.shipToStatus !== "confirmed"
        && entry.actions.find((action) => action.kind === "owner_approval")?.authorized ? (
          <button
            type="button"
            className={`intake-action authorized ${nextKind === "ship_to" ? "next-action" : ""}`}
            data-testid="intake-action-ship_to"
            onClick={() => onShipTo(entry)}
          >
            {nextKind === "ship_to" ? <span className="intake-action-step">NEXT</span> : null}
            納品先登録・確定
          </button>
        ) : null}
    </div>
  );
}

export default function DataIntakeClient({ viewer }: { viewer: Viewer }) {
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState({ search: "", owner: "", intakeState: "", makerHandoff: "", proof: "", dualApproval: "", po: "", pageSize: 20 });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DataIntakeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestOrder = useRef(0);
  const [uploadTarget, setUploadTarget] = useState<FilmOrderIntakeEntry | null>(null);
  const [aiFile, setAiFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [uploadNote, setUploadNote] = useState("");
  const [guideChecks, setGuideChecks] = useState([false, false, false]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [approvalTarget, setApprovalTarget] = useState<{ entry: FilmOrderIntakeEntry; kind: "owner_approval" | "kanei_approval" } | null>(null);
  const [approverName, setApproverName] = useState("");
  const [approvalEvidence, setApprovalEvidence] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [approvalFinalFileName, setApprovalFinalFileName] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalMessage, setApprovalMessage] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [purchaseOrderTarget, setPurchaseOrderTarget] = useState<FilmOrderIntakeEntry | null>(null);
  const [purchaseOrderBusy, setPurchaseOrderBusy] = useState(false);
  const [purchaseOrderMessage, setPurchaseOrderMessage] = useState("");
  const [purchaseOrderError, setPurchaseOrderError] = useState("");
  const [purchaseOrderNote, setPurchaseOrderNote] = useState("");
  const [purchaseOrderSubject, setPurchaseOrderSubject] = useState("");
  const [purchaseOrderBody, setPurchaseOrderBody] = useState("");
  const [deliveryNoteTarget, setDeliveryNoteTarget] = useState<FilmOrderIntakeEntry | null>(null);
  const [deliveryNoteDraft, setDeliveryNoteDraft] = useState<DeliveryNoteDraft | null>(null);
  const deliveryNoteDraftRef = useRef<DeliveryNoteDraft | null>(null);
  useEffect(() => {
    deliveryNoteDraftRef.current = deliveryNoteDraft;
  }, [deliveryNoteDraft]);
  const [deliveryNoteBusy, setDeliveryNoteBusy] = useState(false);
  const [deliveryNoteMessage, setDeliveryNoteMessage] = useState("");
  const [deliveryNoteError, setDeliveryNoteError] = useState("");
  const [shipToTarget, setShipToTarget] = useState<FilmOrderIntakeEntry | null>(null);
  const [shipToForm, setShipToForm] = useState<ShipToForm>(emptyShipToForm);
  const [shipToBusy, setShipToBusy] = useState(false);
  const [shipToMessage, setShipToMessage] = useState("");
  const [shipToError, setShipToError] = useState("");

  const load = useCallback(async (nextPage: number, currentQuery: typeof query) => {
    const order = ++requestOrder.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ page: String(nextPage), pageSize: String(currentQuery.pageSize) });
      for (const [key, value] of Object.entries(currentQuery)) {
        if (key !== "pageSize" && value) params.set(key, String(value));
      }
      const response = await fetch(`/api/data-intake?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      if (order === requestOrder.current) {
        setResult(payload as DataIntakeResponse);
      }
    } catch {
      if (order === requestOrder.current) {
        setResult(null);
        setError("データ受入一覧を読み込めませんでした。");
      }
    } finally {
      if (order === requestOrder.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (active) await load(page, query);
    })();
    return () => {
      active = false;
    };
  }, [load, page, query]);

  const applyFilters = () => {
    setPage(1);
    setQuery((current) => ({ ...current, search: searchDraft.trim() }));
  };

  const uploadOne = async (file: File) => {
    if (!uploadTarget) throw new Error("upload_target_missing");
    const sessionResponse = await fetch(`/api/data-intake/${uploadTarget.quotationId}/upload-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalFileName: file.name,
        sizeBytes: file.size,
        contentType: file.type || "application/octet-stream",
      }),
    });
    const session = await sessionResponse.json();
    if (!sessionResponse.ok || typeof session.sessionUri !== "string") {
      throw new Error(session.error ?? "session_failed");
    }
    const put = await fetch(session.sessionUri, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const uploaded = await put.json().catch(() => ({})) as { id?: unknown };
    if (!put.ok || typeof uploaded.id !== "string") throw new Error(`upload_failed:${put.status}`);
    const completeResponse = await fetch(`/api/data-intake/${uploadTarget.quotationId}/upload-complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalFileName: file.name,
        expectedFileName: session.fileName,
        fileId: uploaded.id,
        note: uploadNote.trim() || undefined,
        guideAcknowledged: allUploadGuidesChecked(guideChecks),
      }),
    });
    const complete = await completeResponse.json();
    if (!completeResponse.ok) throw new Error(complete.error ?? "complete_failed");
    return complete;
  };

  const submitUpload = async () => {
    if (!uploadTarget || !aiFile || uploadBusy || !allUploadGuidesChecked(guideChecks)) return;
    setUploadBusy(true);
    setUploadError("");
    setUploadMessage("");
    try {
      await uploadOne(aiFile);
      if (pdfFile) await uploadOne(pdfFile);
      setUploadMessage(`${uploadTarget.quotationNumber} のデータを受入しました。`);
      setUploadTarget(null);
      setAiFile(null);
      setPdfFile(null);
      setUploadNote("");
      setGuideChecks([false, false, false]);
      await load(page, query);
    } catch (cause) {
      setUploadError(cause instanceof Error ? `失敗しました（${cause.message}）` : "アップロードに失敗しました。");
    } finally {
      setUploadBusy(false);
    }
  };

  const submitApproval = async () => {
    if (!approvalTarget || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalError("");
    setApprovalMessage("");
    try {
      const kind = approvalTarget.kind;
      const action = kind === "owner_approval" ? "approve" : "record-customer-proof-approval";
      const body = kind === "owner_approval"
        ? {
          action,
          mailMode: "confirm",
          origin: window.location.origin,
          ...(approvalFinalFileName.trim() ? {
            finalFileName: approvalFinalFileName.trim(),
            finalFileUrl: approvalFinalFileName.trim(),
          } : {}),
        }
        : {
          action,
          mailMode: "confirm",
          origin: window.location.origin,
          approverName: approverName.trim() || (approvalTarget.entry.ownerDomain === "seven" ? "Seven Chemical Approver" : "Kanei Approver"),
          offlineEvidence: approvalEvidence.trim(),
          offlineReason: approvalReason.trim(),
        };
      const response = await fetch(`/api/film-orders/${approvalTarget.entry.filmOrder?.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "approval_failed");
      setApprovalMessage("承認を記録しました。");
      setApprovalTarget(null);
      setApproverName("");
      setApprovalEvidence("");
      setApprovalReason("");
      setApprovalFinalFileName("");
      await load(page, query);
    } catch (cause) {
      setApprovalError(cause instanceof Error ? `失敗しました（${cause.message}）` : "承認に失敗しました。");
    } finally {
      setApprovalBusy(false);
    }
  };

  const openPurchaseOrder = async (entry: FilmOrderIntakeEntry) => {
    setPurchaseOrderTarget(entry);
    setPurchaseOrderBusy(true);
    setPurchaseOrderMessage("");
    setPurchaseOrderError("");
    try {
      const response = await fetch(`/api/film-orders/${entry.filmOrder?.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview-supplier-po", origin: window.location.origin }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.preview) throw new Error(payload.error ?? "preview_failed");
      const preview = payload.preview as { subject: string; body: string; editableSubject?: string; editableBody?: string };
      setPurchaseOrderSubject(preview.editableSubject ?? preview.subject);
      setPurchaseOrderBody(preview.editableBody ?? preview.body);
      setPurchaseOrderNote(entry.poStatus === "not_sent" ? "" : "");
    } catch (cause) {
      setPurchaseOrderError(cause instanceof Error ? `失敗しました（${cause.message}）` : "発注メールを作成できませんでした。");
    } finally {
      setPurchaseOrderBusy(false);
    }
  };

  const sendPurchaseOrder = async () => {
    if (!purchaseOrderTarget || purchaseOrderBusy) return;
    setPurchaseOrderBusy(true);
    setPurchaseOrderError("");
    setPurchaseOrderMessage("");
    try {
      const response = await fetch(`/api/film-orders/${purchaseOrderTarget.filmOrder?.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send-po",
          mailMode: "confirm",
          origin: window.location.origin,
          supplierOrderNote: purchaseOrderNote,
          mailSubject: purchaseOrderSubject,
          mailBody: purchaseOrderBody,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "send_po_failed");
      setPurchaseOrderMessage("発注書をフィルムメーカーへ送信しました。納期入力フォームを案内しました。");
      setPurchaseOrderTarget(null);
      await load(page, query);
    } catch (cause) {
      setPurchaseOrderError(cause instanceof Error ? `失敗しました（${cause.message}）` : "発注に失敗しました。");
    } finally {
      setPurchaseOrderBusy(false);
    }
  };

  const openShipTo = async (entry: FilmOrderIntakeEntry) => {
    setShipToTarget(entry);
    setShipToMessage("");
    setShipToError("");
    setShipToForm(emptyShipToForm);
    if (!entry.filmOrder?.id) return;
    setShipToBusy(true);
    try {
      const response = await fetch(`/api/film-orders/${entry.filmOrder.id}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "ship_to_load_failed");
      const shipTo = payload.order?.shipTo as {
        companyName?: string; postalCode?: string; address?: string;
        phone?: string; email?: string; note?: string;
      } | undefined;
      if (shipTo?.companyName || shipTo?.address) {
        setShipToForm({
          companyName: shipTo.companyName ?? "",
          postalCode: shipTo.postalCode ?? "",
          address: shipTo.address ?? "",
          phone: shipTo.phone ?? "",
          email: shipTo.email ?? "",
          note: shipTo.note ?? "",
        });
      }
    } catch (cause) {
      setShipToError(cause instanceof Error ? `失敗しました（${cause.message}）` : "納品先を読み込めませんでした。");
    } finally {
      setShipToBusy(false);
    }
  };

  const submitShipTo = async () => {
    if (!shipToTarget?.filmOrder?.id || shipToBusy) return;
    if (!shipToForm.companyName.trim() || !shipToForm.postalCode.trim() || !shipToForm.address.trim()) {
      setShipToError("納品先情報が不足しています。");
      return;
    }
    setShipToBusy(true);
    setShipToError("");
    setShipToMessage("");
    try {
      const register = await fetch(`/api/film-orders/${shipToTarget.filmOrder.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "register-ship-to",
          shipToCompanyName: shipToForm.companyName.trim(),
          shipToPostalCode: shipToForm.postalCode.trim(),
          shipToAddress: shipToForm.address.trim(),
          shipToPhone: shipToForm.phone.trim(),
          shipToEmail: shipToForm.email.trim(),
          shipToNote: shipToForm.note.trim(),
          saveShipToMaster: true,
        }),
      });
      const registerPayload = await register.json();
      if (!register.ok) throw new Error(registerPayload.error ?? "ship_to_register_failed");
      const confirm = await fetch(`/api/film-orders/${shipToTarget.filmOrder.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm-ship-to" }),
      });
      const confirmPayload = await confirm.json();
      if (!confirm.ok) throw new Error(confirmPayload.error ?? "ship_to_confirm_failed");
      setShipToMessage("納品先を登録して確定しました。");
      setShipToTarget(null);
      await load(page, query);
    } catch (cause) {
      setShipToError(cause instanceof Error ? `失敗しました（${cause.message}）` : "納品先の確定に失敗しました。");
    } finally {
      setShipToBusy(false);
    }
  };

  const openDeliveryNote = async (entry: FilmOrderIntakeEntry) => {
    setDeliveryNoteTarget(entry);
    setDeliveryNoteBusy(true);
    setDeliveryNoteMessage("");
    setDeliveryNoteError("");
    try {
      const response = await fetch(`/api/film-orders/${entry.filmOrder?.id}/delivery-note-draft`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "delivery_note_load_failed");
      const draft = payload.draft as DeliveryNoteDraft;
      deliveryNoteDraftRef.current = draft;
      setDeliveryNoteDraft({
        ...draft,
        arrivalEstimateDate: draft.arrivalEstimateDate || entry.etaDate || "",
      });
    } catch (cause) {
      setDeliveryNoteError(cause instanceof Error ? `失敗しました（${cause.message}）` : "納品書下書きを読み込めませんでした。");
    } finally {
      setDeliveryNoteBusy(false);
    }
  };

  const saveDeliveryNote = async (): Promise<boolean> => {
    if (!deliveryNoteTarget || !deliveryNoteDraft || deliveryNoteBusy) return false;
    setDeliveryNoteBusy(true);
    setDeliveryNoteMessage("");
    setDeliveryNoteError("");
    try {
      const response = await fetch(`/api/film-orders/${deliveryNoteTarget.filmOrder?.id}/delivery-note-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deliveryNoteDraft),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "delivery_note_save_failed");
      const savedDraft = payload.draft as DeliveryNoteDraft;
      deliveryNoteDraftRef.current = savedDraft;
      setDeliveryNoteDraft(savedDraft);
      return true;
    } catch (cause) {
        setDeliveryNoteError(cause instanceof Error ? `失敗しました（${cause.message}）` : "納品書を保存できませんでした。");
      return false;
    } finally {
      setDeliveryNoteBusy(false);
    }
  };

  const outputDeliveryNotePdf = async () => {
    const currentDraft = deliveryNoteDraftRef.current;
    if (!deliveryNoteTarget || !currentDraft || deliveryNoteBusy) return;
    setDeliveryNoteBusy(true);
    setDeliveryNoteMessage("");
    setDeliveryNoteError("");
    try {
      const saveResponse = await fetch(`/api/film-orders/${deliveryNoteTarget.filmOrder?.id}/delivery-note-draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deliveryNoteDraft),
      });
      const savePayload = await saveResponse.json();
      if (!saveResponse.ok) throw new Error(savePayload.error ?? "delivery_note_save_failed");
      setDeliveryNoteDraft(savePayload.draft as DeliveryNoteDraft);
      const response = await fetch(`/api/film-orders/${deliveryNoteTarget.filmOrder?.id}/delivery-note-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(currentDraft),
      });
      if (!response.ok) throw new Error("delivery_note_pdf_failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${deliveryNoteTarget.filmOrder?.orderNumber ?? deliveryNoteTarget.quotationNumber}_納品書.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
      setDeliveryNoteMessage("納品書PDF（A4）を作成しました。");
    } catch (cause) {
      setDeliveryNoteError(cause instanceof Error ? `失敗しました（${cause.message}）` : "納品書PDFを作成できませんでした。");
    } finally {
      setDeliveryNoteBusy(false);
    }
  };


  return (
    <main className="page data-intake-page">
      <section className="history-toolbar">
        <div>
          <h1>データ受入</h1>
          <p>成約・内部承認後の案件を、入稿から納品書まで順番に管理します。青い NEXT ボタンが現在の操作です。</p>
        </div>
        <form className="history-controls" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
          <label>検索
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="見積番号 / 発注番号 / 得意先 / 品名"
              data-testid="intake-search"
            />
          </label>
          <label>所有会社
            <select value={query.owner} data-testid="intake-owner-filter" onChange={(event) => setQuery({ ...query, owner: event.target.value })}>
              <option value="">すべて</option>
              <option value="seven">Seven</option>
              <option value="kanei">Kanei</option>
              <option value="unresolved">未解決</option>
            </select>
          </label>
          <label>受入状態
            <select value={query.intakeState} data-testid="intake-state-filter" onChange={(event) => setQuery({ ...query, intakeState: event.target.value })}>
              <option value="">すべて</option>
              {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>メーカー連携
            <select value={query.makerHandoff} data-testid="intake-maker-filter" onChange={(event) => setQuery({ ...query, makerHandoff: event.target.value })}>
              <option value="">すべて</option>
              {Object.entries(makerLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>校正
            <select value={query.proof} data-testid="intake-proof-filter" onChange={(event) => setQuery({ ...query, proof: event.target.value })}>
              <option value="">すべて</option>
              {Object.entries(proofLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>双承認
            <select value={query.dualApproval} data-testid="intake-approval-filter" onChange={(event) => setQuery({ ...query, dualApproval: event.target.value })}>
              <option value="">すべて</option>
              {Object.entries(approvalLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>発注
            <select value={query.po} data-testid="intake-po-filter" onChange={(event) => setQuery({ ...query, po: event.target.value })}>
              <option value="">すべて</option>
              {Object.entries(poLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button type="submit" data-testid="intake-apply">再検索</button>
        </form>
      </section>

      <section className="panel intake-guide" aria-labelledby="intake-guide-title" data-testid="intake-guide">
        <div className="history-meta">
          <h2 id="intake-guide-title">作業の順番</h2>
          <span>左から右へ進めます</span>
        </div>
        <ol className="intake-guide-steps">
          {workflowGuide.map((step) => (
            <li key={step.step}>
              <span className="intake-guide-number">{step.step}</span>
              <strong>{step.title}</strong>
              <small>{step.owner}</small>
              <p>{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel" aria-labelledby="intake-table-title">
        <div className="history-meta">
          <h2 id="intake-table-title">受入進捗</h2>
          <span data-testid="intake-count">{loading ? "読み込み中..." : `${result?.total ?? 0} 件`}</span>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="history-table-wrap">
          <table className="table history-table intake-table" data-testid="intake-table">
            <thead>
              <tr>
                <th>見積 / 得意先</th><th>進行状況</th><th>次の操作・全操作</th>
              </tr>
            </thead>
            <tbody>
              {(result?.entries ?? []).map((entry) => (
                <tr key={`${entry.quotationId}-${entry.filmOrder?.id ?? "none"}`} data-testid="intake-row">
                  <td>
                    <strong>{entry.quotationNumber}</strong>
                    <span className={ownerBadgeClass(entry.ownerDomain)}>{ownerBadge(entry.ownerDomain)}</span>
                    <small>{entry.filmOrder ? `${entry.filmOrder.orderNumber} / ID ${entry.filmOrder.id}` : `見積 ID ${entry.quotationId}`}</small>
	                    <small>{entry.customerName || "—"} ／ {entry.productName || "—"}</small>
	                    <small>{Number(entry.quantity || 0).toLocaleString("ja-JP")} 枚</small>
	                    <small>{stateLabels[entry.state]}</small>
                  </td>
	                  <td>
	                    <ol className="intake-steps">
	                      {workflowStages(entry).map((stage) => (
	                        <li key={stage.title} data-status={stage.status}>
	                          <span aria-hidden="true">{stage.status === "done" ? "✓" : stage.status === "active" ? "●" : "○"}</span>
	                          <strong>{stage.title}</strong>
	                          <small>{stage.value}</small>
	                        </li>
	                      ))}
	                    </ol>
	                  </td>
                <td><IntakeActions
                  entry={entry}
	                  nextKind={nextWorkflowAction(entry)?.kind}
                  onUpload={setUploadTarget}
                  onApproval={(entry, kind) => setApprovalTarget({ entry, kind })}
	                  onShipTo={(entry) => void openShipTo(entry)}
                  onPurchaseOrder={(entry) => void openPurchaseOrder(entry)}
                  onDeliveryNote={(entry) => void openDeliveryNote(entry)}
                /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && result?.entries?.length === 0 ? <p className="empty">対象データはありません。</p> : null}
        <div className="intake-pagination">
          <button type="button" disabled={!result?.hasPrevious || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>前へ</button>
          <span data-testid="intake-pagination">Page {result?.page ?? page} / {result?.pageCount ?? 1}</span>
          <button type="button" disabled={!result?.hasNext || loading} onClick={() => setPage((current) => current + 1)}>次へ</button>
        </div>
      </section>
      {uploadTarget ? (
        <section className="panel" aria-labelledby="intake-upload-title">
          <div className="history-meta">
            <h2 id="intake-upload-title">直接データ入稿 — {uploadTarget.quotationNumber}</h2>
            <button type="button" onClick={() => setUploadTarget(null)}>閉じる</button>
          </div>
          {uploadMessage ? <p className="eta-ok" role="status">{uploadMessage}</p> : null}
          {uploadError ? <p className="eta-error" role="alert">{uploadError}</p> : null}
          <div className="eta-form">
            <label>AIデータ（必須）
              <input type="file" accept=".ai" onChange={(event) => setAiFile(event.target.files?.[0] ?? null)} />
            </label>
            <label>確認用PDF（AI入稿後に任意）
              <input type="file" accept=".pdf" onChange={(event) => setPdfFile(event.target.files?.[0] ?? null)} />
            </label>
            <UploadGuideAcknowledgement
              checks={guideChecks}
              onChange={(index, checked) => setGuideChecks((old) => old.map((value, itemIndex) => itemIndex === index ? checked : value))}
            />
            <label>備考（任意）<textarea value={uploadNote} rows={3} onChange={(event) => setUploadNote(event.target.value)} /></label>
            <button
              className="button"
              type="button"
              disabled={!aiFile || uploadBusy || !allUploadGuidesChecked(guideChecks)}
              onClick={() => void submitUpload()}
              data-testid="intake-upload-submit"
            >
              {uploadBusy ? "アップロード中..." : "デザインデータを入稿"}
            </button>
          </div>
        </section>
      ) : null}
      {approvalTarget ? (
        <section className="panel" aria-labelledby="intake-approval-title">
          <div className="history-meta">
            <h2 id="intake-approval-title">校正承認 — {approvalTarget.entry.quotationNumber}</h2>
            <button type="button" onClick={() => setApprovalTarget(null)}>閉じる</button>
          </div>
          {approvalMessage ? <p className="eta-ok" role="status">{approvalMessage}</p> : null}
          {approvalError ? <p className="eta-error" role="alert">{approvalError}</p> : null}
          <div className="eta-form">
            {approvalTarget.kind === "owner_approval" ? (
              <label>最終承認データ名（任意）
                <input value={approvalFinalFileName} onChange={(event) => setApprovalFinalFileName(event.target.value)} />
              </label>
            ) : (
              <>
                <label>承認者
                  <input value={approverName} onChange={(event) => setApproverName(event.target.value)} />
                </label>
                <label>確認根拠（必須）
                  <input value={approvalEvidence} onChange={(event) => setApprovalEvidence(event.target.value)} />
                </label>
                <label>確認理由（必須）
                  <input value={approvalReason} onChange={(event) => setApprovalReason(event.target.value)} />
                </label>
              </>
            )}
            <button
              className="button"
              type="button"
              disabled={approvalBusy || (approvalTarget.kind === "kanei_approval" && (!approvalEvidence.trim() || !approvalReason.trim()))}
              onClick={() => void submitApproval()}
              data-testid="intake-approval-submit"
            >
              {approvalBusy ? "承認中..." : "承認を記録"}
            </button>
          </div>
        </section>
      ) : null}
      {shipToTarget ? (
        <section className="panel" aria-labelledby="intake-ship-to-title">
          <div className="history-meta">
            <h2 id="intake-ship-to-title" data-testid="intake-ship-to-title">
              納品先登録・確定 — {shipToTarget.quotationNumber}
            </h2>
            <button type="button" onClick={() => setShipToTarget(null)}>閉じる</button>
          </div>
          {shipToMessage ? <p className="eta-ok" role="status">{shipToMessage}</p> : null}
          {shipToError ? <p className="eta-error" role="alert">{shipToError}</p> : null}
          <div className="eta-form delivery-note-grid">
            <label>納品先会社名 ★
              <input
                value={shipToForm.companyName}
                onChange={(event) => setShipToForm((current) => ({ ...current, companyName: event.target.value }))}
                data-testid="intake-ship-to-company"
              />
            </label>
            <label>郵便番号 ★
              <input
                value={shipToForm.postalCode}
                onChange={(event) => setShipToForm((current) => ({ ...current, postalCode: event.target.value }))}
              />
            </label>
            <label>住所 ★
              <input
                value={shipToForm.address}
                onChange={(event) => setShipToForm((current) => ({ ...current, address: event.target.value }))}
              />
            </label>
            <label>電話番号
              <input
                value={shipToForm.phone}
                onChange={(event) => setShipToForm((current) => ({ ...current, phone: event.target.value }))}
              />
            </label>
            <label>メール
              <input
                value={shipToForm.email}
                onChange={(event) => setShipToForm((current) => ({ ...current, email: event.target.value }))}
              />
            </label>
            <label>備考
              <textarea
                rows={3}
                value={shipToForm.note}
                onChange={(event) => setShipToForm((current) => ({ ...current, note: event.target.value }))}
              />
            </label>
            <div className="film-order-inline-actions">
              <button
                className="button"
                type="button"
                disabled={shipToBusy || !shipToForm.companyName.trim() || !shipToForm.postalCode.trim() || !shipToForm.address.trim()}
                onClick={() => void submitShipTo()}
                data-testid="intake-ship-to-submit"
              >
                {shipToBusy ? "処理中..." : "登録して確定"}
              </button>
            </div>
            <p className="help">納品先は住所録に保存されます。確定後にフィルム発注メールを作成できます。</p>
          </div>
        </section>
      ) : null}
      {purchaseOrderTarget ? (
        <section className="panel" aria-labelledby="intake-po-title">
          <div className="history-meta">
            <h2 id="intake-po-title">フィルム発注メール — {purchaseOrderTarget.quotationNumber}</h2>
            <button type="button" onClick={() => setPurchaseOrderTarget(null)}>閉じる</button>
          </div>
          {purchaseOrderMessage ? <p className="eta-ok" role="status">{purchaseOrderMessage}</p> : null}
          {purchaseOrderError ? <p className="eta-error" role="alert">{purchaseOrderError}</p> : null}
          <div className="eta-form">
            <label>追加発注指示（任意）
              <textarea value={purchaseOrderNote} rows={4} onChange={(event) => setPurchaseOrderNote(event.target.value)} />
            </label>
            <label>件名
              <input value={purchaseOrderSubject} onChange={(event) => setPurchaseOrderSubject(event.target.value)} maxLength={500} />
            </label>
            <label>メール本文
              <textarea value={purchaseOrderBody} rows={16} onChange={(event) => setPurchaseOrderBody(event.target.value)} maxLength={20000} />
            </label>
            <p className="help">専用リンクは送信時に確定トークンへ自動置換されます。リンク行を削除するとメーカーが報告できなくなります。</p>
            <button
              className="button"
              type="button"
              disabled={purchaseOrderBusy || !purchaseOrderSubject.trim() || !purchaseOrderBody.trim()}
              onClick={() => void sendPurchaseOrder()}
              data-testid="intake-po-send"
            >
              {purchaseOrderBusy ? "送信中..." : "この内容で発注する"}
            </button>
          </div>
        </section>
      ) : null}
      {deliveryNoteTarget ? (
        <section className="panel" aria-labelledby="intake-delivery-note-title">
          <div className="history-meta">
            <h2 id="intake-delivery-note-title" data-testid="intake-delivery-note-title">
              納品書下書き — {deliveryNoteTarget.quotationNumber}
            </h2>
            <button type="button" onClick={() => setDeliveryNoteTarget(null)}>閉じる</button>
          </div>
          {deliveryNoteMessage ? <p className="eta-ok" role="status">{deliveryNoteMessage}</p> : null}
          {deliveryNoteError ? <p className="eta-error" role="alert">{deliveryNoteError}</p> : null}
          {deliveryNoteDraft ? (
            <div className="eta-form delivery-note-grid">
              <label>納品先
                <input value={deliveryNoteDraft.recipientName} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, recipientName: event.target.value } : current)} />
              </label>
              <label>発行者
                <input value={deliveryNoteDraft.senderName} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, senderName: event.target.value } : current)} />
              </label>
              <label>発行日
                <input type="date" value={deliveryNoteDraft.issueDate} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, issueDate: event.target.value } : current)} />
              </label>
              <label>到着見込
                <input type="date" value={deliveryNoteDraft.arrivalEstimateDate} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, arrivalEstimateDate: event.target.value } : current)} />
              </label>
              <label>品名
                <input value={deliveryNoteDraft.productName} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, productName: event.target.value } : current)} />
              </label>
              <label>仕様
                <input value={deliveryNoteDraft.specification} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, specification: event.target.value } : current)} />
              </label>
              <label>数量
                <input value={deliveryNoteDraft.quantity} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, quantity: event.target.value } : current)} />
              </label>
              <label>フィルム長
                <input value={deliveryNoteDraft.filmLength} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, filmLength: event.target.value } : current)} />
              </label>
              <label>備考
                <textarea value={deliveryNoteDraft.remarks} rows={3} onChange={(event) => setDeliveryNoteDraft((current) => current ? { ...current, remarks: event.target.value } : current)} />
              </label>
              <div className="film-order-inline-actions">
                <button className="button secondary small" type="button" disabled={deliveryNoteBusy} onClick={() => void saveDeliveryNote()}>
                  {deliveryNoteBusy ? "保存中..." : "下書き保存"}
                </button>
                <button className="button small" type="button" disabled={deliveryNoteBusy} onClick={() => void outputDeliveryNotePdf()}>
                  納品書PDF出力（A4）
                </button>
              </div>
            </div>
          ) : <p>読み込み中...</p>}
        </section>
      ) : null}
    </main>
  );
}
