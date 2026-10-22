"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import { CALCULATION_VERSION, sizeMaster } from "@/lib/constants";
import { buildFilmQuotationFromRecord, filmQuotationNumberFor, kaneiTrade } from "@/lib/film-quotation";
import { D, Decimal } from "@/lib/decimal";
import { analyzeQuotation, filmCompositionOf, printingMethodOf } from "@/lib/quotation-history";
import { fileNameFromContentDisposition } from "@/lib/content-disposition";
import {
  DEFAULT_FILM_COMPOSITION,
  QUOTATION_RESTORE_KEY,
  quotationStatuses,
  type QuotationRecord,
  type QuotationStatus,
  type UserSummary,
} from "@/lib/quotation-shared";
import type { AuthenticatedUser } from "@/lib/auth-store";
import { isKaneiTradeUser } from "@/lib/film-order-access";

const statusLabels: Record<QuotationStatus, string> = {
  draft: "下書き",
  sent: "送付済み",
  approved: "成約",
  rejected: "見送り",
  expired: "期限切れ",
};

type HistoryDetailTab = "document" | "film" | "data";
type QuotationApprovalGate = "internal" | "customerApproval";

function requestedHistoryRecordId(): number | null {
  if (typeof window === "undefined") return null;
  const recordId = Number(new URLSearchParams(window.location.search).get("record"));
  return Number.isInteger(recordId) && recordId > 0 ? recordId : null;
}

function requestedHistoryDetailTab(): HistoryDetailTab {
  if (typeof window === "undefined") return "document";
  const tab = new URLSearchParams(window.location.search).get("tab");
  return tab === "film" || tab === "data" ? tab : "document";
}

export default function HistoryClient({ currentUser }: { currentUser: AuthenticatedUser }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [creatorFilter, setCreatorFilter] = useState<string>("all");
  const [records, setRecords] = useState<QuotationRecord[]>([]);
  const [creatorOptions, setCreatorOptions] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(requestedHistoryRecordId);
  const [initialDetailTab, setInitialDetailTab] = useState<HistoryDetailTab>(requestedHistoryDetailTab);
  const requestOrder = useRef(0);
  const selectedRecord = records.find((record) => record.id === selectedId) ?? null;
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailMessage, setEmailMessage] = useState("");
  const [approvingGateId, setApprovingGateId] = useState<number | null>(null);
  const [editingEmailId, setEditingEmailId] = useState<number | null>(null);
  const [editingEmail, setEditingEmail] = useState("");
  const [updatingEmail, setUpdatingEmail] = useState(false);
  const [historyActionError, setHistoryActionError] = useState("");

  const load = useCallback(async (search: string, statusFilter: string, creatorFilter: string) => {
    const order = ++requestOrder.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: search, status: statusFilter, limit: "200" });
      if (creatorFilter !== "all") params.set("creatorId", creatorFilter);
      const response = await fetch(`/api/quotations?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      if (order === requestOrder.current) setRecords(payload.records as QuotationRecord[]);
    } catch {
      if (order === requestOrder.current) {
        setRecords([]);
        setError("履歴を読み込めませんでした。DB接続を確認してください。");
      }
    } finally {
      if (order === requestOrder.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const loadCreators = async () => {
      try {
        const response = await fetch("/api/quotations?limit=500", { cache: "no-store" });
        const payload = await response.json();
        if (!active || !response.ok) return;
        const recordsForCreators = payload.records as QuotationRecord[];
        setCreatorOptions(Array.from(new Map(recordsForCreators.map((record) => [record.createdBy.id, record.createdBy])).values())
          .sort((left, right) => left.name.localeCompare(right.name, "ja")));
      } catch {
        // Filter options remain at "all" when this supplemental lookup is unavailable.
      }
    };
    void loadCreators();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query, status, creatorFilter), 180);
    return () => clearTimeout(timer);
  }, [load, query, status, creatorFilter]);


  useEffect(() => {
    if (!selectedRecord) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRecord]);

  const restore = (record: QuotationRecord) => {
    // 発行済みPDFは不変。復元は常に修正見積として新しい見積番号で発行する。
    const nowJst = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
    const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const restoredPayload: Record<string, unknown> = {
      ...record.payload,
      revisionOf: record.quotationNumber,
    };
    delete restoredPayload.quotationNumber;
    restoredPayload.issueDate = nowJst;
    restoredPayload.validUntil = validUntil;
    sessionStorage.setItem(QUOTATION_RESTORE_KEY, JSON.stringify(restoredPayload));
    router.push("/quote");
  };

  const openDetail = (recordId: number, tab: HistoryDetailTab = "document") => {
    setInitialDetailTab(tab);
    setSelectedId(recordId);
  };

  const changeStatus = async (record: QuotationRecord, nextStatus: QuotationStatus) => {
    const response = await fetch(`/api/quotations/${record.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (response.ok) {
      const payload = await response.json();
      setRecords((old) => old.map((item) => (item.id === record.id ? payload.record as QuotationRecord : item)));
    }
  };

  const approveGate = async (record: QuotationRecord, gate: QuotationApprovalGate) => {
    if (gate === "internal" && currentUser.email.trim().toLowerCase() !== "kim@kanei-trade.co.jp") return;
    setApprovingGateId(record.id);
    setEmailMessage("");
    try {
      const response = await fetch(`/api/quotations/${record.id}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gate }),
      });
      const payload = await response.json();
      if (response.ok) {
        const approved = payload.record as QuotationRecord;
        setRecords((old) => old.map((item) => (item.id === record.id ? approved : item)));
        if (selectedRecord?.id === record.id) setSelectedId(record.id);
        setEmailMessage(gate === "internal"
          ? `${record.quotationNumber} を内部承認しました。`
          : `${record.quotationNumber} の顧客承認を記録しました。`);
      } else if (payload.error === "internal_approval_forbidden") {
        setEmailMessage("内部承認はKimのみ実行できます。");
      } else if (payload.error === "invalid_approval_transition") {
        setEmailMessage("現在の状態では承認できません。");
      } else {
        setEmailMessage("承認処理に失敗しました。");
      }
    } catch {
      setEmailMessage("承認処理に失敗しました。");
    } finally {
      setApprovingGateId(null);
    }
  };

  const remove = async (record: QuotationRecord) => {
    if (!window.confirm(`${record.quotationNumber} を削除しますか？`)) return;
    setHistoryActionError("");
    try {
      const response = await fetch(`/api/quotations/${record.id}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) {
        setRecords((old) => old.filter((item) => item.id !== record.id));
        if (selectedRecord?.id === record.id) setSelectedId(null);
        return;
      }
      if (payload.error === "film_order_exists") {
        setHistoryActionError(`${record.quotationNumber} はフィルム発注管理に反映済みのため削除できません。`);
      } else if (response.status === 403) {
        setHistoryActionError(`${record.quotationNumber} は作成者または管理者のみ削除できます。`);
      } else {
        setHistoryActionError(`${record.quotationNumber} を削除できませんでした。`);
      }
    } catch {
      setHistoryActionError(`${record.quotationNumber} の削除に失敗しました。`);
    }
  };

  const sendQuotationEmail = async (record: QuotationRecord) => {
    setSendingEmail(true);
    setEmailMessage("");
    try {
      const response = await fetch(`/api/quotations/${record.id}/send`, { method: "POST" });
      const payload = await response.json();
      if (response.ok) {
        setRecords((old) => old.map((item) => (item.id === record.id ? payload.record as QuotationRecord : item)));
        setEmailMessage(`${record.quotationNumber} を ${payload.sentTo} に送信しました。`);
      } else if (payload.error === "smtp_not_configured") {
        setEmailMessage("SMTPが設定されていません。.env に SMTP_HOST / SMTP_USER / SMTP_PASS を設定してください。");
      } else if (payload.error === "customer_email_required") {
        setEmailMessage("得意先のメールアドレスが登録されていません。");
      } else if (payload.error === "quotation_pdf_not_found") {
        setEmailMessage("添付できる見積書PDFがありません。先にPDFを発行してください。");
      } else if (payload.error === "quotation_pdf_integrity_failed") {
        setEmailMessage("保存済みPDFの整合性確認に失敗しました。送信を中止しました。");
      } else if (payload.error === "quotation_validity_expired") {
        setEmailMessage("有効期限が切れています。復元して新しい見積番号で再発行してください。");
      } else {
        setEmailMessage("送信に失敗しました。");
      }
    } catch {
      setEmailMessage("送信に失敗しました。");
    } finally {
      setSendingEmail(false);
    }
  };

  const startEmailEdit = (record: QuotationRecord) => {
    setEditingEmailId(record.id);
    setEditingEmail(typeof record.payload.customerEmail === "string" ? record.payload.customerEmail.trim() : "");
    setEmailMessage("");
  };

  const cancelEmailEdit = () => {
    setEditingEmailId(null);
    setEditingEmail("");
  };

  const saveCustomerEmail = async (record: QuotationRecord) => {
    setUpdatingEmail(true);
    setEmailMessage("");
    try {
      const response = await fetch(`/api/quotations/${record.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerEmail: editingEmail }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setEmailMessage(payload.error === "invalid_customer_email"
          ? "メールアドレスの形式が正しくありません。"
          : "メールアドレスを更新できませんでした。");
        return;
      }
      const updated = payload.record as QuotationRecord;
      setRecords((old) => old.map((item) => (item.id === updated.id ? updated : item)));
      cancelEmailEdit();
      setEmailMessage(`${updated.quotationNumber} の宛先メールを更新しました。`);
    } catch {
      setEmailMessage("メールアドレスを更新できませんでした。");
    } finally {
      setUpdatingEmail(false);
    }
  };

  const canManage = (record: QuotationRecord) => currentUser.role === "admin" || currentUser.id === record.createdBy.id;

  return (
    <main className="history-page">
      <section className="panel history-toolbar" aria-labelledby="history-title">
        <div>
          <h1 id="history-title">見積履歴（SQLite）</h1>
          <p>保存済み見積書を検索し、状態管理・復元・削除ができます。</p>
        </div>
        <div className="history-controls">
          <label>検索
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="見積番号 / 得意先 / 品名"
              data-testid="history-search"
            />
          </label>
          <label>状態
            <select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="history-status">
              <option value="all">すべて</option>
              {quotationStatuses.map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}
            </select>
          </label>
          <label>作成者
            <select
              value={creatorFilter}
              onChange={(event) => setCreatorFilter(event.target.value)}
              data-testid="history-creator"
              aria-label="作成者で絞り込み"
            >
              <option value="all">すべて</option>
              {creatorOptions.map((creator) => (
                <option key={creator.id} value={String(creator.id)}>
                  {creator.name}（{creator.email}）
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="panel" aria-labelledby="history-list-title">
        <div className="history-meta">
          <h2 id="history-list-title">保存済み見積書</h2>
          <span>{loading ? "読み込み中..." : `${formatNumber(records.length, 0)} 件`}</span>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {historyActionError ? <p className="error" role="alert" data-testid="history-action-error">{historyActionError}</p> : null}
        {!loading && records.length === 0 && !error ? (
          <p className="empty">保存された見積書はありません。見積書画面から保存またはPDF出力してください。</p>
        ) : null}
        <div className="history-table-wrap">
          <table className="table history-table" data-testid="history-table">
            <thead>
              <tr>
                <th>見積番号</th><th>発行日</th><th>得意先</th><th>品名 / 仕様</th><th>数量</th><th>単価</th><th>税込合計</th><th>状態</th><th>操作</th><th>作成者</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{record.quotationNumber}</strong>
                    <small>{record.resultHash ? `ID ${record.resultHash.slice(0, 8)}` : "手入力"}</small>
                  </td>
                  <td>{record.issueDate}</td>
                  <td>{record.customerName || <span className="badge" data-testid="customer-missing-badge">得意先未入力</span>}</td>
                  <td>{record.productName}<small>{record.sizeSummary}</small></td>
                  <td>{formatNumber(record.quantity, 0)} 枚</td>
                  <td>{formatCurrency(record.pricePerPiece, 2)}</td>
                  <td>{formatCurrency(record.grandTotal, 0)}</td>
                  <td>
                    <select
                      aria-label={`${record.quotationNumber} の状態`}
                      value={record.status}
                      disabled={!canManage(record)}
                      title={canManage(record) ? undefined : "作成者または管理者のみ変更できます"}
                      onChange={(event) => void changeStatus(record, event.target.value as QuotationStatus)}
                    >
                      {manualStatusOptions(record).map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}
                    </select>
                  </td>
                  <td className="history-actions">
                    <button className="button small" type="button" onClick={() => openDetail(record.id)}>詳細</button>
                    <button className="button secondary small" type="button" onClick={() => openDetail(record.id, "film")}>
                      フィルム見積書
                    </button>
                    <button
                      className="button secondary small"
                      type="button"
                      title={record.status === "expired" ? "新しい見積番号で更新発行します" : "修正見積として復元します"}
                      onClick={() => restore(record)}
                    >
                      {record.status === "expired" ? "更新" : "復元"}
                    </button>
                    <button
                      className="button danger small"
                      type="button"
                      disabled={!canManage(record)}
                      title={canManage(record) ? undefined : "作成者または管理者のみ削除できます"}
                      onClick={() => void remove(record)}
                    >削除</button>
                  </td>
                  <td data-testid="history-creator-name">
                    <strong>{record.createdBy.name}</strong>
                    <small>{record.createdBy.email}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRecord ? (
        <>
          <QuotationDetailModal
            key={`${selectedRecord.id}-${initialDetailTab}`}
            record={selectedRecord}
            initialTab={initialDetailTab}
            onClose={() => setSelectedId(null)}
            onStatusChange={(record, nextStatus) => { void changeStatus(record, nextStatus); }}
            onSendEmail={(record) => { void sendQuotationEmail(record); }}
            onApproveGate={(record, gate) => { void approveGate(record, gate); }}
            canEditEmail={canManage(selectedRecord) && ["draft", "sent"].includes(selectedRecord.status)}
            editingEmail={editingEmailId === selectedRecord.id}
            editingEmailValue={editingEmail}
            onEditingEmailChange={setEditingEmail}
            onStartEmailEdit={startEmailEdit}
            onCancelEmailEdit={cancelEmailEdit}
            onSaveEmail={(record) => { void saveCustomerEmail(record); }}
            updatingEmail={updatingEmail}
            approvingGate={approvingGateId === selectedRecord.id}
            canApproveInternally={currentUser.email.trim().toLowerCase() === "kim@kanei-trade.co.jp"}
            canRecordCustomerApproval={isKaneiTradeUser(currentUser.email)}
            sendingEmail={sendingEmail}
          />
          {emailMessage ? <p className="help" role="status" data-testid="email-message" style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 999, background: "white", padding: "8px 16px", borderRadius: 8, border: "1px solid #cbd5e1" }}>{emailMessage}</p> : null}
        </>
      ) : null}
    </main>
  );
}

class StoredQuotationPdfUnavailableError extends Error {}

async function fetchStoredQuotationPdf(
  recordId: number,
  fallbackFileName: string,
): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(`/api/quotations/${recordId}/pdf`, { cache: "no-store" });
  if (response.status === 404) {
    throw new StoredQuotationPdfUnavailableError("見積書PDFが見つかりません。");
  }
  if (!response.ok) throw new Error("pdf_request_failed");
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("empty_pdf");
  return {
    blob,
    fileName: fileNameFromContentDisposition(
      response.headers.get("Content-Disposition") ?? "",
      fallbackFileName,
    ),
  };
}

function manualStatusOptions(record: QuotationRecord): QuotationStatus[] {
  const base: Record<QuotationStatus, QuotationStatus[]> = {
    draft: ["draft", "rejected", "expired"],
    sent: ["sent", "approved", "rejected", "expired"],
    approved: ["approved"],
    rejected: ["rejected"],
    expired: ["expired"],
  };
  // 成約への手動変更は内部承認後のみ出す。未承認のまま発注管理へ流さない。
  if (record.status === "sent" && !record.internalApproval) {
    return base.sent.filter((status) => status !== "approved");
  }
  return base[record.status];
}

function QuotationDetailModal({
  record,
  initialTab = "document",
  onClose,
  onStatusChange,
  onSendEmail,
  onApproveGate,
  canEditEmail,
  editingEmail,
  editingEmailValue,
  onEditingEmailChange,
  onStartEmailEdit,
  onCancelEmailEdit,
  onSaveEmail,
  updatingEmail,
  approvingGate,
  canApproveInternally,
  canRecordCustomerApproval,
  sendingEmail,
}: {
  record: QuotationRecord;
  initialTab?: "document" | "film" | "data";
  onClose: () => void;
  onStatusChange: (record: QuotationRecord, nextStatus: QuotationStatus) => void;
  onSendEmail: (record: QuotationRecord) => void;
  onApproveGate: (record: QuotationRecord, gate: QuotationApprovalGate) => void;
  canEditEmail: boolean;
  editingEmail: boolean;
  editingEmailValue: string;
  onEditingEmailChange: (value: string) => void;
  onStartEmailEdit: (record: QuotationRecord) => void;
  onCancelEmailEdit: () => void;
  onSaveEmail: (record: QuotationRecord) => void;
  updatingEmail: boolean;
  approvingGate: boolean;
  canApproveInternally: boolean;
  canRecordCustomerApproval: boolean;
  sendingEmail: boolean;
}) {
  const [storedPdf, setStoredPdf] = useState<{ url: string; blob: Blob; fileName: string } | null>(null);
  const [storedPdfStatus, setStoredPdfStatus] = useState<"loading" | "available" | "unavailable">("loading");
  const [storedPdfError, setStoredPdfError] = useState("");
  const [storedPdfPopupBlocked, setStoredPdfPopupBlocked] = useState(false);
  const storedPdfBusyRef = useRef(false);
  const analysis = analyzeQuotation(record);
  // 발행 시 자동 생성된 필름 견적서(payload 저장분)를 우선 사용, 없으면 조회 시 생성
  const storedFilmQuotation = record.payload.filmQuotation as import("@/lib/film-quotation").FilmQuotationData | undefined;
  const expectedFilmQuotationNumber = filmQuotationNumberFor(record.quotationNumber, record.issueDate);
  const legacyFilmQuotation = !storedFilmQuotation
    || !storedFilmQuotation.endCustomerName
    || !storedFilmQuotation.filmComposition
    || !storedFilmQuotation.printingMethodLabel
    || !storedFilmQuotation.colorCountLabel
    || !storedFilmQuotation.items[0]?.specification
    || storedFilmQuotation.pouchQuotationNumber !== record.quotationNumber
    || storedFilmQuotation.quotationNumber !== expectedFilmQuotationNumber;
  const filmQuotation = legacyFilmQuotation
    ? buildFilmQuotationFromRecord(record)
    : storedFilmQuotation;
  const [detailTab, setDetailTab] = useState<"document" | "film" | "data">(
    initialTab === "film" && !filmQuotation ? "document" : initialTab,
  );
  const calculationChecklistSnapshot = record.payload.calculationChecklistSnapshot as {
    fillMlPerChamber?: string;
    connectedChambers?: number;
    totalFillMlPerPouch?: string;
  } | null | undefined;
  const snapshotCalculationVersion = typeof record.payload.calculationChecklistSnapshot === "object"
    && record.payload.calculationChecklistSnapshot !== null
    && typeof (record.payload.calculationChecklistSnapshot as { calculationVersion?: unknown }).calculationVersion === "string"
    ? (record.payload.calculationChecklistSnapshot as { calculationVersion: string }).calculationVersion
    : "";
  const calculationVersionStale = snapshotCalculationVersion !== ""
    && snapshotCalculationVersion !== CALCULATION_VERSION;
  const composition = filmCompositionOf(record);
  const payloadEntries = Object.entries(record.payload);
  const recordEntries = Object.entries(record).filter(([key]) => key !== "payload");
  const amountDifference = analysis.grandTotal.minus(analysis.subtotal.plus(analysis.tax));
  const displayedAdjustment = analysis.displayedAdjustment === "-"
    ? "-"
    : (analysis.displayedAdjustment !== "" ? formatCurrency(analysis.displayedAdjustment, 0) : "-");
  const costTotal = analysis.costUnit.times(analysis.quantity);
  const finalProfit = analysis.subtotal.minus(costTotal);
  const finalProfitRate = analysis.subtotal.gt(0)
    ? finalProfit.div(analysis.subtotal).times(100)
    : analysis.profitRate;
  const finalProfitPerPiece = analysis.quantity.gt(0)
    ? finalProfit.div(analysis.quantity)
    : analysis.profitUnit;

  const rows = [
    {
      name: "充填・加工",
      cost: analysis.fillingCostUnit,
      selling: analysis.fillingUnit,
      profit: analysis.fillingUnit.minus(analysis.fillingCostUnit),
      quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`,
      amount: analysis.fillingAmount,
    },
    { name: "フィルム", cost: analysis.filmCostUnit, selling: analysis.filmUnit, profit: analysis.filmUnit.minus(analysis.filmCostUnit), quantity: `${formatNumber(analysis.filmOrderLength.toNumber(), 0)} m`, amount: analysis.filmAmount },
  ];
  if (printingMethodOf(record) === "gravure") {
    rows.push({
      name: "新規銅版", cost: analysis.copperCostUnit, selling: analysis.copperUnit,
      profit: analysis.copperUnit.minus(analysis.copperCostUnit),
      quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`, amount: analysis.copperAmount,
    });
  }
  if (analysis.hasSeparatedBulkLine && analysis.bulkAmount.gt(0)) {
    rows.push({
      name: "バルク費用",
      cost: analysis.bulkCostUnit,
      selling: analysis.bulkUnit,
      profit: analysis.bulkUnit.minus(analysis.bulkCostUnit),
      quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`,
      amount: analysis.bulkAmount,
    });
  }
  const payloadText = (key: string, fallback = "") => {
    const value = record.payload[key];
    return typeof value === "string" && value.trim() ? value : fallback;
  };
  const issuerName = payloadText("issuerName", "株式会社セブン化学");
  const issuerEnglishName = payloadText("issuerEnglishName", "SEVEN CHEMICAL CO., LTD.");
  const issuerPostalCode = payloadText("issuerPostalCode", "〒582-0017");
  const issuerAddress = payloadText("issuerAddress", "大阪府柏原市太平寺1丁目12番1号");
  const issuerTelephone = payloadText("issuerTelephone", "TEL 072-971-0726");
  const issuerWebsite = payloadText("issuerWebsite", "https://7chemical.co.jp/");
  const issuerRepresentative = payloadText("representative", "代表取締役社長 吾藤 靖");
  const copperColorCountValue = (() => {
    const value = Number(record.payload.copperColorCount ?? 1);
    return Number.isFinite(value) && value > 0 ? D(value) : D(1);
  })();
  const fillingCostTotal = analysis.fillingCostUnit.times(analysis.quantity);
  const processingCostTotal = analysis.processingCostUnit.times(analysis.quantity);
  const bulkCostTotal = analysis.bulkCostUnit.times(analysis.quantity);
  const filmCostTotal = analysis.filmCostUnit.times(analysis.quantity);
  const copperCostTotal = analysis.copperCostUnit.times(analysis.quantity);
  const customCostTotal = analysis.customCostUnit.times(analysis.quantity);
  const filmMeterCost = analysis.filmOrderLength.gt(0)
    ? filmCostTotal.div(analysis.filmOrderLength)
    : D(0);
  const copperCostPerColor = copperColorCountValue.gt(0) ? copperCostTotal.div(copperColorCountValue) : D(0);
  const storedCostDifference = analysis.costUnit.minus(analysis.storedCostUnit);
  const profitVerificationDifference = finalProfit.minus(analysis.storedProfitUnit.times(analysis.quantity));
  const fitContentRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    if (!record.id) return;
    let active = true;
    let objectUrl: string | null = null;
    const loadStoredPdf = async () => {
      try {
        const pdf = await fetchStoredQuotationPdf(record.id, `${record.quotationNumber}.pdf`);
        if (!active) return;
        objectUrl = URL.createObjectURL(pdf.blob);
        setStoredPdf({
          blob: pdf.blob,
          fileName: pdf.fileName,
          url: objectUrl,
        });
        setStoredPdfStatus("available");
      } catch (error) {
        if (!active) return;
        setStoredPdfStatus("unavailable");
        setStoredPdfError(error instanceof StoredQuotationPdfUnavailableError
          ? error.message
          : "見積書PDFを取得できませんでした。");
      }
    };
    void loadStoredPdf();
    const fitForPrint = () => {
      for (const content of fitContentRefs.current) {
        if (!content) continue;
        content.style.removeProperty("--history-a4-fit-scale");
        // scrollHeight is measured before zoom is applied and therefore
        // remains the unscaled content height; clientHeight is the A4 page box.
        const availableHeight = content.clientHeight;
        const requiredHeight = content.scrollHeight;
        const scale = availableHeight > 0 && requiredHeight > availableHeight
          ? availableHeight / requiredHeight
          : 1;
        content.style.setProperty("--history-a4-fit-scale", scale.toFixed(5));
      }
    };
    const resetFit = () => {
      for (const content of fitContentRefs.current) content?.style.removeProperty("--history-a4-fit-scale");
    };
    const printMedia = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
    const handleMediaChange = (event: MediaQueryListEvent) => {
      if (event.matches) fitForPrint();
      else resetFit();
    };
    window.addEventListener("beforeprint", fitForPrint);
    window.addEventListener("afterprint", resetFit);
    printMedia?.addEventListener("change", handleMediaChange);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      window.removeEventListener("beforeprint", fitForPrint);
      window.removeEventListener("afterprint", resetFit);
      printMedia?.removeEventListener("change", handleMediaChange);
    };
  }, [record.id, record.quotationNumber]);

  const loadStoredQuotationPdf = async (): Promise<{ blob: Blob; fileName: string } | null> => {
    if (storedPdfBusyRef.current) return null;
    storedPdfBusyRef.current = true;
    setStoredPdfError("");
    try {
      return await fetchStoredQuotationPdf(record.id, `${record.quotationNumber}.pdf`);
    } catch (error) {
      setStoredPdfStatus("unavailable");
      setStoredPdfError(error instanceof StoredQuotationPdfUnavailableError
        ? error.message
        : "見積書PDFを取得できませんでした。");
      return null;
    } finally {
      storedPdfBusyRef.current = false;
    }
  };

  const downloadStoredPdf = async () => {
    const pdf = await loadStoredQuotationPdf();
    if (!pdf) return;
    const objectUrl = URL.createObjectURL(pdf.blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = pdf.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  // Opening the already-fetched blob in a dedicated PDF viewer avoids
  // window.print() falling back to a page snapshot or another history tab.
  const printStoredPdf = () => {
    if (!storedPdf) return;
    setStoredPdfPopupBlocked(false);
    // Some browsers return null for successful opens when window features are
    // supplied. Keep a normal tab and detach opener instead, so a null result
    // remains a trustworthy popup-block signal.
    const viewer = window.open(storedPdf.url, "_blank");
    if (!viewer) {
      setStoredPdfError("ポップアップがブロックされました。PDFをダウンロードして印刷してください。");
      setStoredPdfPopupBlocked(true);
      return;
    }
    viewer.opener = null;
  };

  const printCurrentDocument = async () => {
    // ブランド印などのAPI画像は印刷直後に空白になることがあるため、描画完了を待つ。
    await Promise.all(
      Array.from(document.querySelectorAll<HTMLImageElement>(".history-detail-panel img")).map(async (image) => {
        if (image.complete && image.naturalWidth > 0) return;
        try {
          await image.decode();
        } catch {
          // 読み込み失敗時は既存のalt表示で印刷を妨げない。
        }
      }),
    );
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print());
    });
  };

  const customerEmail = record.payload.customerEmail;
  const mailtoLink = (() => {
    if (typeof customerEmail !== "string" || !customerEmail.trim()) return null;
    const subject = encodeURIComponent(`お見積書 ${record.quotationNumber} のご案内`);
    const body = encodeURIComponent(
      `${record.customerName} 御中\n\nお見積書 ${record.quotationNumber} をご案内いたします。\n` +
      `品名：${record.productName}\n数量：${formatNumber(Number(record.quantity))} 枚\n` +
      `税込合計：${formatCurrency(record.grandTotal, 0)}\n有効期限：${record.validUntil || "-"}\n\n` +
      `ご確認のほどよろしくお願いいたします。\nパッケージラボ\n`,
    );
    return `mailto:${customerEmail.trim()}?subject=${subject}&body=${body}`;
  })();

  return (
    <div className="history-detail-layer printable-detail" role="dialog" aria-modal="true" aria-labelledby="history-detail-title">
      <div className="history-detail-panel">
        <header className="history-detail-header">
          <div>
            <span className="side-kicker">QUOTATION DETAIL</span>
            <h2 id="history-detail-title">{record.quotationNumber}</h2>
            <div className="history-detail-meta">
              <p data-testid="history-customer-name">{record.customerName || "得意先未設定"}</p>
              <p data-testid="history-product-name">{record.productName}</p>
              <p data-testid="history-film-composition">フィルム構成 {composition || DEFAULT_FILM_COMPOSITION}</p>
              <div className="approval-state-row" data-testid="approval-gate-state">
                <span className="approval-state-chip pending">
                  {record.internalApproval ? `内部承認済み（${new Date(record.internalApproval.approvedAt).toLocaleString("ja-JP")}）` : "内部承認待ち"}
                </span>
                <span className="approval-state-chip pending">
                  {record.customerApproval ? `顧客承認済み（${new Date(record.customerApproval.approvedAt).toLocaleString("ja-JP")}）` : "顧客承認待ち"}
                </span>
              </div>
            </div>
          </div>
          <div className="detail-header-actions">
            {canEditEmail ? (
              <div className="history-email-editor">
                <label>
                  <span>宛先メール</span>
                  <input
                    type="email"
                    value={editingEmail ? editingEmailValue : typeof customerEmail === "string" ? customerEmail : ""}
                    readOnly={!editingEmail}
                    onChange={(event) => onEditingEmailChange(event.target.value)}
                    placeholder="未登録"
                    data-testid="history-customer-email"
                  />
                </label>
                {editingEmail ? (
                  <>
                    <button
                      className="button small"
                      type="button"
                      disabled={updatingEmail || !editingEmailValue.trim()}
                      onClick={() => onSaveEmail(record)}
                      data-testid="history-email-save"
                    >{updatingEmail ? "保存中..." : "保存"}</button>
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={updatingEmail}
                      onClick={onCancelEmailEdit}
                    >取消</button>
                  </>
                ) : (
                  <button
                    className="button secondary small"
                    type="button"
                    onClick={() => onStartEmailEdit(record)}
                    data-testid="history-email-edit"
                  >編集</button>
                )}
              </div>
            ) : null}
            {detailTab === "document" ? (
              <button
                className="button small"
                type="button"
                onClick={downloadStoredPdf}
                data-testid="detail-download-current"
                disabled={storedPdfStatus !== "available"}
              >PDFダウンロード</button>
            ) : null}
            <button
              className="button small"
              type="button"
              onClick={() => {
                if (detailTab === "document") printStoredPdf();
                else void printCurrentDocument();
              }}
              data-testid="detail-print-current"
              disabled={detailTab === "document" && storedPdfStatus !== "available"}
            >
              {detailTab === "document" ? "PDFを開いて印刷"
                : detailTab === "film" ? "フィルム見積書PDF"
                  : "詳細データPDF"}
            </button>
            {mailtoLink ? (
              <a className="button small" href={mailtoLink} data-testid="history-mail-link">メール作成</a>
            ) : null}
            {record.status === "draft" && !record.internalApproval && canApproveInternally ? (
              <button
                className="button small"
                type="button"
                disabled={approvingGate}
                onClick={() => onApproveGate(record, "internal")}
                data-testid="history-internal-approve"
              >{approvingGate ? "承認中..." : "内部承認する"}</button>
            ) : null}
            {record.status === "draft" && typeof record.payload.customerEmail === "string" && record.payload.customerEmail.trim() ? (
              <button
                className="button small"
                type="button"
                disabled={sendingEmail || !record.internalApproval}
                title={record.internalApproval
                  ? "保存済み見積書PDFを添付して送信し、状態を送付済みにします。テスト設定では宛先が強制変更される場合があります。"
                  : "送信前に内部承認が必要です。"}
                onClick={() => onSendEmail(record)}
                data-testid="history-auto-send"
              >
                {sendingEmail ? "送信中..." : "メール送信（PDF添付）"}
              </button>
            ) : null}
            {record.status === "sent" && record.internalApproval && canRecordCustomerApproval ? (
              <button
                className="button small"
                type="button"
                disabled={approvingGate}
                onClick={() => onApproveGate(record, "customerApproval")}
                data-testid="history-customer-approval-record"
              >{approvingGate ? "承認中..." : "顧客承認を記録して成約"}</button>
            ) : null}
            <button className="button secondary small" type="button" onClick={onClose}>閉じる</button>
          </div>
        </header>

        <div className="detail-scroll">
          <nav className="detail-tabbar no-print" aria-label="詳細表示切替">
            <button
              className={detailTab === "document" ? "active" : ""}
              type="button"
              onClick={() => setDetailTab("document")}
              aria-current={detailTab === "document"}
            >見積書A4</button>
            {filmQuotation ? (
              <button
                className={detailTab === "film" ? "active" : ""}
                type="button"
                onClick={() => setDetailTab("film")}
                aria-current={detailTab === "film"}
                data-testid="film-quote-tab"
              >フィルム見積書</button>
            ) : null}
            <button
              className={detailTab === "data" ? "active" : ""}
              type="button"
              onClick={() => setDetailTab("data")}
              aria-current={detailTab === "data"}
            >詳細データ</button>
          </nav>

          {detailTab === "film" && filmQuotation ? (
            <article className="a4-sheet history-a4 film-quote-a4" aria-label="フィルム見積書A4">
              <div className="history-a4-fit" ref={(element) => { fitContentRefs.current[0] = element; }}>
                {/* ── 発行ヘッダ ── */}
                <header className="film-quote-header">
                  <div className="film-quote-issuer">
                    <div className="film-quote-brand-row">
                      <img
                        src="/api/brand-assets/kanei-trade-logo.png"
                        alt="金井貿易株式会社 ロゴ"
                        className="film-quote-kanei-logo"
                        width={612}
                        height={408}
                      />
                      <div className="film-quote-company">
                        <strong className="film-quote-company-name">{kaneiTrade.name}</strong>
                        <span className="film-quote-division">
                          <strong>{kaneiTrade.divisionName}</strong>
                          <span>{kaneiTrade.divisionLabel}</span>
                        </span>
                      </div>
                      <img
                        src="/api/brand-assets/epackage-lab-logo.png"
                        alt="Epackage-Lab ロゴ"
                        className="film-quote-division-logo"
                        width={2172}
                        height={724}
                      />
                    </div>
                    <small>{kaneiTrade.englishName}</small>
                    <address>
                      {kaneiTrade.postalCode}<br />
                      {kaneiTrade.address}<br />
                      {kaneiTrade.telephone}<br />
                      {kaneiTrade.email}
                    </address>
                  </div>
                  <div className="film-quote-title">
                    <p className="english">QUOTATION</p>
                    <h2>お見積書</h2>
                    <dl>
                      <div><dt>見積番号</dt><dd>{filmQuotation.quotationNumber}</dd></div>
                      <div><dt>パウチ見積番号</dt><dd>{filmQuotation.pouchQuotationNumber}</dd></div>
                      <div><dt>発行日</dt><dd>{filmQuotation.issueDate}</dd></div>
                      <div><dt>有効期限</dt><dd>{filmQuotation.validUntil}</dd></div>
                    </dl>
                  </div>
                </header>

                {/* ── 宛先・背景説明 ── */}
                <section className="film-quote-recipient">
                  <p className="to">株式会社セブン化学 御中</p>
                  <p className="subject">貴社パウチ充填用フィルムにつきまして、下記の通りお見積りを申し上げます。</p>
                </section>

                <section className="film-quote-background">
                  <h3>お見積りの背景</h3>
                  <dl className="film-quote-bg-list">
                    <div><dt>発注顧客</dt><dd>{filmQuotation.endCustomerName || "-"}</dd></div>
                    <div><dt>対象製品</dt><dd>{filmQuotation.productName}</dd></div>
                    <div><dt>パウチ仕様</dt><dd>{record.sizeSummary}</dd></div>
                    <div><dt>フィルム仕様</dt><dd>{filmQuotation.filmComposition}／{filmQuotation.printingMethodLabel}／{filmQuotation.colorCountLabel}</dd></div>
                    {calculationChecklistSnapshot ? (
                      <>
                        <div><dt>充填量</dt><dd>{formatNumber(Number(calculationChecklistSnapshot.fillMlPerChamber))}ml/室 × {calculationChecklistSnapshot.connectedChambers}室 ＝ {formatNumber(Number(calculationChecklistSnapshot.totalFillMlPerPouch))}ml/枚</dd></div>
                        <div><dt>パウチ数量</dt><dd>{Number(filmQuotation.quantity).toLocaleString("ja-JP")} 枚（総室数 {Number(D(filmQuotation.quantity).times(calculationChecklistSnapshot?.connectedChambers ?? 1)).toLocaleString("ja-JP")} 室）</dd></div>
                      </>
                    ) : null}
                    <div><dt>発注フィルム</dt><dd>原反幅 {filmQuotation.items[0]?.webWidthMm ?? "-"}mm × {Number(filmQuotation.items[0]?.orderLengthM ?? 0).toLocaleString("ja-JP")}m</dd></div>
                  </dl>
                  <div className="film-quote-bg-chain">
                    <p className="chain-label">発注に至る経緯</p>
                    <p className="chain-text">
                      {filmQuotation.productName}（{record.sizeSummary}）を{Number(filmQuotation.quantity).toLocaleString("ja-JP")}枚充填するため、
                      原反幅{filmQuotation.items[0]?.webWidthMm ?? "-"}mmのフィルムが{Number(filmQuotation.items[0]?.orderLengthM ?? 0).toLocaleString("ja-JP")}m必要です。
                      金井貿易よりこのフィルムを調達させていただきます。
                    </p>
                  </div>
                </section>

                {/* ── 明細テーブル ── */}
                <table className="film-quote-table">
                  <thead>
                    <tr>
                      <th>品名・仕様</th>
                      <th>原反幅</th>
                      <th>数量</th>
                      <th>単価</th>
                      <th>金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filmQuotation.items.map((item, i) => (
                      <tr key={i}>
                        <td className="desc">
                          <div className="film-item-name">{item.description}</div>
                          {item.specification ? <small className="film-item-spec">{item.specification}</small> : null}
                        </td>
                        <td className="num">{item.webWidthMm}mm</td>
                        <td className="num">{Number(item.orderLengthM).toLocaleString("ja-JP")} m</td>
                        <td className="num">{Number(item.unitPriceYenPerM).toLocaleString("ja-JP")} 円/m</td>
                        <td className="num amt">{Number(item.amountYen).toLocaleString("ja-JP")} 円</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={4}>小計（税抜）</td><td className="num">{Number(filmQuotation.subtotal).toLocaleString("ja-JP")} 円</td></tr>
                    <tr><td colSpan={4}>消費税（10%）</td><td className="num">{Number(filmQuotation.tax).toLocaleString("ja-JP")} 円</td></tr>
                    <tr className="grand"><td colSpan={4}>合計（税込）</td><td className="num">{Number(filmQuotation.grandTotal).toLocaleString("ja-JP")} 円</td></tr>
                  </tfoot>
                </table>

                {/* ── 備考 ── */}
                <section className="film-quote-notes">
                  <h3>備考</h3>
                  <ul>
                    {filmQuotation.notes.map((note, i) => <li key={i}>{note}</li>)}
                  </ul>
                </section>

                {/* ── 署名 ── */}
                <footer className="film-quote-footer">
                  <div className="greeting">
                    <p>上記の通りお見積り申し上げます。<br />ご検討のほどよろしくお願いいたします。</p>
                  </div>
                  <div className="issuer-seal">
                    <strong>{kaneiTrade.name}</strong>
                    <img
                      src="/api/brand-assets/kanei-trade-seal.png"
                      alt="金井貿易株式会社各印"
                      className="film-quote-seal-image"
                      width={1254}
                      height={1254}
                    />
                  </div>
                </footer>
              </div>
            </article>
          ) : null}

          {detailTab === "document" ? (
          storedPdfPopupBlocked ? (
            <p className="empty" role="alert" data-testid="stored-quotation-pdf-error">
              {storedPdfError}
            </p>
          ) : null) : null}
          {detailTab === "document" ? (
          storedPdf ? (
            <iframe
              src={storedPdf.url}
              className="history-pdf-frame"
              title="見積書PDF"
              data-testid="stored-quotation-pdf"
              style={{ width: "100%", height: "800px", border: "1px solid #d7deea", borderRadius: 8, background: "white" }}
            />
          ) : (
            <p className="empty" role="alert" data-testid="stored-quotation-pdf-error">
              {storedPdfStatus === "loading" ? "PDFを読み込んでいます..." : storedPdfError}
            </p>
          )
          ) : null}
          {detailTab === "data" ? (
          <>
            <article className="a4-sheet history-a4 data-report-a4" aria-label="詳細データA4帳票" data-testid="data-report-a4">
              <div className="history-a4-fit" ref={(element) => { fitContentRefs.current[1] = element; }}>
                <header className="sheet-header">
                  <div className="issuer">
                    <div className="issuer-logo">
                      <span className="logo-mark large" aria-hidden="true">7</span>
                      <div>
                        <strong>{issuerName}</strong>
                        <small>{issuerEnglishName}</small>
                      </div>
                    </div>
                    <address>
                      {issuerRepresentative}<br />
                      {issuerPostalCode} {issuerAddress}<br />
                      {issuerTelephone} / {issuerWebsite}
                    </address>
                  </div>
                  <div className="document-title">
                    <p className="english">INTERNAL DATA REPORT</p>
                    <h2>詳細データ</h2>
                    <dl>
                      <div><dt>見積番号</dt><dd>{record.quotationNumber}</dd></div>
                      <div><dt>作成日</dt><dd>{new Date(record.createdAt).toLocaleDateString("ja-JP")}</dd></div>
                    </dl>
                  </div>
                </header>

                <section className="history-a4-section">
                  <header><span>01</span><h2>基本情報</h2></header>
                  <dl className="history-facts">
                    <div><dt>得意先</dt><dd>{record.customerName || "-"}</dd></div>
                    <div><dt>品名</dt><dd>{record.productName}</dd></div>
                    <div><dt>仕様</dt><dd>{record.sizeSummary}</dd></div>
                    <div><dt>状態</dt><dd>{statusLabels[record.status]}</dd></div>
                    <div><dt>数量</dt><dd>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</dd></div>
                    <div><dt>印刷方式</dt><dd>{printingMethodOf(record) === "gravure" ? "グラビア印刷（ロール）" : "デジタル印刷"}</dd></div>
                    <div><dt>フィルム構成</dt><dd>{composition || DEFAULT_FILM_COMPOSITION}</dd></div>
                    <div><dt>計算バージョン</dt><dd>{snapshotCalculationVersion || record.calculationVersion || "-"}</dd></div>
                  </dl>
                </section>

                <section className="history-a4-section">
                  <header><span>02</span><h2>損益サマリー</h2></header>
                  <table className="data-report-table">
                    <thead><tr><th>項目</th><th>原価 /枚</th><th>見積 /枚</th><th>差益 /枚</th><th>差益率</th><th>差益総額</th></tr></thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.name}>
                          <th scope="row">{row.name}</th>
                          <td className="num">{formatCurrency(row.cost.toFixed(2), 2)}</td>
                          <td className="num">{formatCurrency(row.selling.toFixed(2), 2)}</td>
                          <td className="num">{formatCurrency(row.profit.toFixed(2), 2)}</td>
                          <td className="num">{row.selling.gt(0) ? `${formatNumber(row.profit.div(row.selling).times(100).toNumber(), 2)}%` : "-"}</td>
                          <td className="num">{formatCurrency(row.profit.times(analysis.quantity).toFixed(0), 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr><th scope="row">合計</th><td className="num">{formatCurrency(analysis.costUnit.toFixed(2), 2)}</td><td className="num">{formatCurrency(analysis.sellingUnit.toFixed(2), 2)}</td><td className="num">{formatCurrency(analysis.profitUnit.toFixed(2), 2)}</td><td className="num">{formatNumber(finalProfitRate.toNumber(), 2)}%</td><td className="num">{formatCurrency(finalProfit.toFixed(0), 0)}</td></tr>
                    </tfoot>
                  </table>
                  <p className="data-report-note">総原価 {formatCurrency(costTotal.toFixed(0), 0)} 円 ／ 税抜見積 {formatCurrency(analysis.subtotal.toFixed(0), 0)} 円 ／ 最終利益 {formatCurrency(finalProfit.toFixed(0), 0)} 円</p>
                </section>

                <section className="history-a4-section">
                  <header><span>03</span><h2>原価・金額検証</h2></header>
                  <dl className="history-facts">
                    <div><dt>充填・加工原価</dt><dd>{formatCurrency(analysis.fillingCostUnit.toFixed(2), 2)} /枚</dd></div>
                    <div><dt>フィルム購入原価</dt><dd>{formatCurrency(analysis.filmMeterPrice.toFixed(2), 2)} /m</dd></div>
                    <div><dt>フィルム発注長</dt><dd>{formatNumber(analysis.filmOrderLength.toNumber(), 0)} m</dd></div>
                    <div><dt>フィルム原価</dt><dd>{formatCurrency(filmCostTotal.toFixed(0), 0)} 円</dd></div>
                    <div><dt>目標利益率</dt><dd>{formatNumber(analysis.targetMargin.times(100).toNumber(), 2)}%</dd></div>
                    <div><dt>端数調整</dt><dd>{displayedAdjustment}</dd></div>
                    <div><dt>小計 / 消費税</dt><dd>{formatCurrency(analysis.subtotal.toFixed(0), 0)} / {formatCurrency(analysis.tax.toFixed(0), 0)}</dd></div>
                    <div><dt>税込合計</dt><dd>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}</dd></div>
                  </dl>
                </section>

                <section className="history-a4-section">
                  <header><span>04</span><h2>条件・監査</h2></header>
                  <dl className="history-facts">
                    <div><dt>納期</dt><dd>{record.deliveryDate || "-"}</dd></div>
                    <div><dt>支払条件</dt><dd>{record.paymentTerms || "-"}</dd></div>
                    <div><dt>作成 / 更新</dt><dd>{new Date(record.createdAt).toLocaleString("ja-JP")} / {new Date(record.updatedAt).toLocaleString("ja-JP")}</dd></div>
                    <div><dt>DB保存原価 /枚</dt><dd>{formatCurrency(analysis.storedCostUnit.toFixed(4), 4)}</dd></div>
                    <div><dt>再計算整合差</dt><dd>{formatCurrency(storedCostDifference.toFixed(4), 4)}</dd></div>
                    <div><dt>利益検算整合差</dt><dd>{formatCurrency(profitVerificationDifference.toFixed(0), 0)}</dd></div>
                    <div><dt>備考</dt><dd>{record.notes || "-"}</dd></div>
                  </dl>
                  <footer className="history-a4-footer">内部管理用。顧客提出用の見積書ではありません。</footer>
                </section>
              </div>
            </article>

          <section className="profit-summary no-print" aria-label="損益サマリー">
            <div className="profit-summary-head">
              <div>
                <span>最終損益サマリー</span>
                <strong>{formatCurrency(finalProfitPerPiece.toFixed(2), 2)} /枚 利益</strong>
                <small>原価 {formatCurrency(analysis.costUnit.toFixed(2), 2)} → 見積 {formatCurrency(analysis.sellingUnit.toFixed(2), 2)}</small>
              </div>
              <div className="profit-summary-total">
                <span>総利益（税抜）</span>
                <strong>{formatCurrency(finalProfit.toFixed(0), 0)}</strong>
                <small>{formatNumber(analysis.quantity.toNumber(), 0)}枚 ／ 利益率 {formatNumber(finalProfitRate.toNumber(), 2)}%</small>
              </div>
            </div>
            <div className="detail-table-wrap">
              <table className="table profit-summary-table">
                <thead>
                  <tr>
                    <th>項目</th><th>原価 /枚</th><th>見積価格 /枚</th><th>差益 /枚</th>
                    <th>差益率</th><th>原価総額</th><th>見積金額</th><th>差益総額</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>充填・加工{analysis.hasFillingCostBreakdown ? <><br /><small>加工 {formatCurrency(analysis.processingCostUnit.toFixed(2), 2)}／バルク {formatCurrency(analysis.bulkCostUnit.toFixed(2), 2)}</small></> : null}</td>
                    <td>{formatCurrency(analysis.fillingCostUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.fillingUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.fillingUnit.minus(analysis.fillingCostUnit).toFixed(2), 2)}</td>
                    <td>{analysis.fillingUnit.gt(0) ? `${formatNumber(analysis.fillingUnit.minus(analysis.fillingCostUnit).div(analysis.fillingUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                    <td>{formatCurrency(analysis.fillingCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.fillingAmount.toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.fillingAmount.minus(analysis.fillingCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
                  </tr>
	                  <tr>
	                    <td>フィルム</td>
                    <td>{formatCurrency(analysis.filmCostUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.filmUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.filmUnit.minus(analysis.filmCostUnit).toFixed(2), 2)}</td>
                    <td>{analysis.filmUnit.gt(0) ? `${formatNumber(analysis.filmUnit.minus(analysis.filmCostUnit).div(analysis.filmUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                    <td>{formatCurrency(analysis.filmCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.filmAmount.toFixed(0), 0)}</td>
	                    <td>{formatCurrency(analysis.filmAmount.minus(analysis.filmCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
	                  </tr>
                  {analysis.customCostUnit.gt(0) ? (
                    <tr>
                      <td>金型</td>
                      <td>{formatCurrency(analysis.customCostUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.customUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.customUnit.minus(analysis.customCostUnit).toFixed(2), 2)}</td>
                      <td>{analysis.customUnit.gt(0) ? `${formatNumber(analysis.customUnit.minus(analysis.customCostUnit).div(analysis.customUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                      <td>{formatCurrency(analysis.customCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.customAmount.toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.customAmount.minus(analysis.customCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
                    </tr>
                  ) : null}
                  {printingMethodOf(record) === "gravure" ? (
                    <tr>
                      <td>新規銅版</td>
                      <td>{formatCurrency(analysis.copperCostUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.copperUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.copperUnit.minus(analysis.copperCostUnit).toFixed(2), 2)}</td>
                      <td>{analysis.copperUnit.gt(0) ? `${formatNumber(analysis.copperUnit.minus(analysis.copperCostUnit).div(analysis.copperUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                      <td>{formatCurrency(analysis.copperCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.copperAmount.toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.copperAmount.minus(analysis.copperCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
                    </tr>
                  ) : null}
                  {analysis.adjustment.abs().gt(0) ? (
                    <tr>
                      <td>端数調整</td>
                      <td>-</td><td>-</td><td>-</td><td>-</td>
                      <td>-</td>
                      <td>{formatCurrency(analysis.adjustment.toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.adjustment.toFixed(0), 0)}</td>
                    </tr>
                  ) : null}
                  <tr className="profit-total-row">
                    <td>合計</td>
                    <td>{formatCurrency(analysis.costUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.sellingUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.profitUnit.toFixed(2), 2)}</td>
                    <td>{formatNumber(analysis.profitRate.toNumber(), 2)}%</td>
                    <td>{formatCurrency(costTotal.toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</td>
                    <td>{formatCurrency(finalProfit.toFixed(0), 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="formula-note">
              最終利益 ＝ 見積金額 {formatCurrency(analysis.subtotal.toFixed(0), 0)} − 総原価 {formatCurrency(costTotal.toFixed(0), 0)} ＝ {formatCurrency(finalProfit.toFixed(0), 0)} 円
            </p>
          </section>

          <details className="editor-group" open>
            <summary>見積書表示値（DB snapshot）</summary>
            <div className="detail-grid">
              <div><span>お見積単価</span><strong>{formatCurrency(analysis.sellingUnit.toFixed(2), 2)} /枚</strong></div>
              <div><span>充填・加工単価</span><strong>{formatCurrency(analysis.fillingUnit.toFixed(2), 2)}</strong></div>
              <div><span>充填・加工金額</span><strong>{formatCurrency(analysis.fillingAmount.toFixed(0), 0)}</strong></div>
              <div><span>フィルム m単価</span><strong>{analysis.displayedFilmMeterUnit ? `${formatCurrency(analysis.displayedFilmMeterUnit.toFixed(2), 2)} /m` : "-"}</strong></div>
              <div><span>フィルム パウチ換算</span><strong>{formatCurrency(analysis.filmUnit.toFixed(2), 2)} /枚</strong></div>
              <div><span>フィルム金額</span><strong>{formatCurrency(analysis.filmAmount.toFixed(0), 0)}</strong></div>
              {printingMethodOf(record) === "gravure" ? (
                <>
                  <div><span>銅版単価</span><strong>{formatCurrency(analysis.copperUnit.toFixed(2), 2)}</strong></div>
                  <div><span>銅版金額</span><strong>{formatCurrency(analysis.copperAmount.toFixed(0), 0)}</strong></div>
                </>
              ) : null}
              <div><span>端数調整</span><strong>{displayedAdjustment}</strong></div>
              <div><span>小計（税抜）</span><strong>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</strong></div>
              <div><span>消費税</span><strong>{formatCurrency(analysis.tax.toFixed(0), 0)}</strong></div>
              <div><span>税込合計</span><strong>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}</strong></div>
            </div>
          </details>

          <details className="editor-group">
            <summary>原価・見積・利益の逆算明細</summary>
            <div className="detail-table-wrap">
              <table className="table">
                <thead>
                  <tr><th>項目</th><th>原価 /枚</th><th>見積単価</th><th>利益 /枚</th><th>利益率</th><th>数量</th><th>見積金額</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{formatCurrency(row.cost.toFixed(4), 4)}</td>
                      <td>{formatCurrency(row.selling.toFixed(4), 4)}</td>
                      <td>{formatCurrency(row.profit.toFixed(4), 4)}</td>
                      <td>{row.selling.gt(0) ? `${formatNumber(row.profit.div(row.selling).times(100).toNumber(), 2)}%` : "-"}</td>
                      <td>{row.quantity}</td>
                      <td>{formatCurrency(row.amount.toFixed(0), 0)}</td>
                    </tr>
                  ))}
                  <tr className="detail-total-row">
                    <td>合計</td>
                    <td>{formatCurrency(analysis.costUnit.toFixed(4), 4)}</td>
                    <td>{formatCurrency(analysis.sellingUnit.toFixed(4), 4)}</td>
                    <td>{formatCurrency(analysis.profitUnit.toFixed(4), 4)}</td>
                    <td>{formatNumber(analysis.profitRate.toNumber(), 2)}%</td>
                    <td>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</td>
                    <td>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="formula-note">
              利益 / 枚 ＝ 表示見積単価 − 総原価 ＝ {formatCurrency(analysis.sellingUnit.toFixed(4), 4)} − {formatCurrency(analysis.costUnit.toFixed(4), 4)} ＝ {formatCurrency(analysis.profitUnit.toFixed(4), 4)}<br />
              利益率 ＝ 利益 ÷ 表示見積単価 × 100 ＝ {formatNumber(analysis.profitRate.toNumber(), 2)}％／ 総利益 ＝ 利益 × 数量 ＝ {formatCurrency(analysis.totalProfit.toFixed(2), 2)}
            </div>
          </details>

          <details className="editor-group" open>
            <summary>表示金額・税・調整</summary>
            <div className="detail-grid">
              <div><span>原価 / 枚（充填＋フィルム＋銅版）</span><strong>{formatCurrency(analysis.costUnit.toFixed(4), 4)}</strong></div>
              <div><span>自動目標利益率</span><strong>{formatNumber(analysis.targetMargin.times(100).toNumber(), 2)}%</strong></div>
              <div><span>端数調整</span><strong>{displayedAdjustment}</strong></div>
              <div><span>小計（税抜）</span><strong>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</strong></div>
              <div><span>消費税（{formatNumber(analysis.taxRate.toNumber(), 2)}%）</span><strong>{formatCurrency(analysis.tax.toFixed(0), 0)}</strong></div>
              <div><span>税込合計</span><strong>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}</strong></div>
              <div><span>マークアップ率</span><strong>{formatNumber(analysis.markupRate.toNumber(), 2)}%</strong></div>
              <div><span>合計整合差</span><strong>{formatCurrency(amountDifference.toFixed(0), 0)}</strong></div>
            </div>
            <p className="help">保存済みDB値の逆算：単価 {formatCurrency(analysis.storedSellingUnit.toFixed(4), 4)} / 利益 {formatCurrency(analysis.storedProfitUnit.toFixed(4), 4)} / 利益率 {formatNumber(analysis.storedProfitRate.toNumber(), 2)}%。上段は見積書の表示override値を優先した実表示金額です。</p>
          </details>

          <details className="editor-group" open>
            <summary>基本情報・フィルム構成</summary>
            <div className="detail-grid">
              <div><span>見積番号</span><strong>{record.quotationNumber}</strong></div>
              <div><span>状態</span><strong>{statusLabels[record.status]}</strong></div>
              <div><span>発行日</span><strong>{record.issueDate}</strong></div>
              <div><span>有効期限</span><strong>{record.validUntil || "-"}</strong></div>
              <div><span>得意先</span><strong>{record.customerName || "-"}</strong></div>
              <div><span>担当</span><strong>{record.customerContact || "-"}</strong></div>
              <div><span>品名</span><strong>{record.productName}</strong></div>
              <div><span>仕様</span><strong>{record.sizeSummary}</strong></div>
              <div><span>印刷方式</span><strong>{printingMethodOf(record) === "gravure" ? "グラビア印刷（ロール）" : "デジタル印刷"}</strong></div>
              {printingMethodOf(record) === "gravure" ? (
                <>
                  <div><span>発注パターン</span><strong>{formatNumber(analysis.orderPatternCount.toNumber(), 0)} 回</strong></div>
                  <div><span>納品パターン長</span><strong>{formatNumber(analysis.deliverablePatternLengthM.toNumber(), 0)} m</strong></div>
                  <div><span>推奨発注数量</span><strong>{analysis.recommendedQuantity.gt(0) ? `${formatNumber(analysis.recommendedQuantity.toNumber(), 0)} 枚` : "-"}</strong></div>
                </>
              ) : null}
              <div><span>発注数量</span><strong>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</strong></div>
              <div><span>フィルム構成</span><strong>{composition || DEFAULT_FILM_COMPOSITION}</strong></div>
              <div><span>フィルム購入単価</span><strong>{formatCurrency(analysis.filmMeterPrice.toFixed(0), 0)} /m</strong></div>
              <div><span>フィルム見積単価</span><strong>{analysis.displayedFilmMeterUnit ? `${formatCurrency(analysis.displayedFilmMeterUnit.toFixed(2), 2)} /m` : "-"}</strong></div>
              <div><span>フィルム発注長</span><strong>{formatNumber(analysis.filmOrderLength.toNumber(), 0)} m</strong></div>
              <div><span>納期</span><strong>{record.deliveryDate || "-"}</strong></div>
              <div><span>支払条件</span><strong>{record.paymentTerms || "-"}</strong></div>
              <div><span>計算バージョン</span><strong>{snapshotCalculationVersion || record.calculationVersion || "-"}{calculationVersionStale ? "（要再計算）" : ""}</strong></div>
              <div><span>作成日時</span><strong>{new Date(record.createdAt).toLocaleString("ja-JP")}</strong></div>
              <div><span>更新日時</span><strong>{new Date(record.updatedAt).toLocaleString("ja-JP")}</strong></div>
            </div>
            <p className="help">備考：{record.notes || "-"}</p>
          </details>

          <details className="editor-group">
            <summary>DBレコード全項目</summary>
            <div className="raw-grid">
              {recordEntries.map(([key, value]) => (
                <div key={key}><span>{key}</span><strong>{String(value ?? "-")}</strong></div>
              ))}
            </div>
          </details>

          <details className="editor-group">
            <summary>保存payload全項目（編集内容含む）</summary>
            <div className="raw-grid">
              {payloadEntries.map(([key, value]) => (
                <div key={key}><span>{key}</span><strong>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "-")}</strong></div>
              ))}
            </div>
            <textarea className="payload-json" readOnly rows={10} value={JSON.stringify(record.payload, null, 2)} aria-label="保存payload JSON" />
          </details>
          </>) : null}
        </div>
      </div>
      <div className="history-detail-overlay" onClick={onClose} aria-hidden="true" />
    </div>
  );
}
