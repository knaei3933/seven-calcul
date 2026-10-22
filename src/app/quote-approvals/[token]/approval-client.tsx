"use client";

import { useCallback, useEffect, useState } from "react";

interface ApprovalSummary {
  quotationNumber: string;
  customerName: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  grandTotal: string;
  validUntil: string;
  status: string;
  approvedAt: string | null;
  customerApprovalRecorded: boolean;
}

function formatNumber(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("ja-JP") : value;
}

function formatCurrency(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `¥${parsed.toLocaleString("ja-JP")}` : value;
}

export default function CustomerApprovalClient({ token }: { token: string }) {
  const [quotation, setQuotation] = useState<ApprovalSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/quotations/approvals/${encodeURIComponent(token)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.error === "customer_approval_expired") throw new Error("このお見積書の有効期限が経過しています。");
        throw new Error("承認ページを表示できません。リンクをご確認ください。");
      }
      setQuotation(payload.quotation as ApprovalSummary);
      if (payload.quotation.customerApprovalRecorded) {
        setMessage("このお見積書は承認済みです。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "承認ページを表示できません。");
    } finally {
      setLoading(false);
    }
  }, [token]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時にトークンで承認状況を取得する意図的な処理です。
  useEffect(() => { void load(); }, [load]);

  const approve = async () => {
    if (approving || quotation?.customerApprovalRecorded) return;
    setApproving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/quotations/approvals/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledge: true }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.error === "customer_approval_expired") throw new Error("このお見積書の有効期限が経過しています。");
        if (payload.error === "invalid_customer_approval_token") throw new Error("承認リンクが無効です。最新のお見積メールをご確認ください。");
        throw new Error("承認処理に失敗しました。時間をおいて再度お試しください。");
      }
      setQuotation(payload.quotation as ApprovalSummary);
      setMessage("承認を受け付けました。担当者が確認のうえ、成約処理を行います。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "承認処理に失敗しました。");
    } finally {
      setApproving(false);
    }
  };

  return (
    <main className="eta-page">
      <section className="panel eta-panel" aria-labelledby="customer-approval-title">
        <p className="eta-eyebrow">QUOTATION APPROVAL</p>
        <h1 id="customer-approval-title">お見積書ご確認・ご承認</h1>

        {loading ? <p className="help">読み込み中です...</p> : null}
        {error ? <p className="eta-error" role="alert">{error}</p> : null}
        {message ? <p className="eta-ok" role="status">{message}</p> : null}

        {quotation ? (
          <>
            <dl className="eta-form">
              <div><dt>見積番号</dt><dd>{quotation.quotationNumber}</dd></div>
              <div><dt>得意先</dt><dd>{quotation.customerName || "-"}</dd></div>
              <div><dt>品名</dt><dd>{quotation.productName || "-"}</dd></div>
              <div><dt>仕様</dt><dd>{quotation.sizeSummary || "-"}</dd></div>
              <div><dt>数量</dt><dd>{formatNumber(quotation.quantity)} 枚</dd></div>
              <div><dt>税込合計</dt><dd>{formatCurrency(quotation.grandTotal)}</dd></div>
              <div><dt>有効期限</dt><dd>{quotation.validUntil || "-"}</dd></div>
            </dl>

            {quotation.customerApprovalRecorded ? (
              <p className="eta-ok">承認日時：{quotation.approvedAt ? new Date(quotation.approvedAt).toLocaleString("ja-JP") : "-"}</p>
            ) : (
              <>
                <p className="help">
                  内容をご確認のうえ、下記のお見積書に同意される場合のみ承認してください。承認記録は担当者に共有され、営業確認後に成約処理されます。
                </p>
                <button className="button" type="button" disabled={approving} onClick={() => void approve()}>
                  {approving ? "承認処理中..." : "このお見積書を承認する"}
                </button>
              </>
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}
