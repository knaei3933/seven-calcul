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
  owner: {
    ownerDomain: string;
    brandLabel: string;
    portalBrandName: string;
    englishName: string;
    legalName: string;
    representative: string;
    postalCode: string;
    address: string;
    telephone: string;
    fax: string;
    website: string;
    logoUrl: string;
    logoAlt: string;
    defaultContactEmail: string;
    defaultContactTelephone: string;
    approvalIntro: string;
    approvalActionLabel: string;
    approvalFooterNote: string;
  };
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
        {quotation?.owner ? (
          <header className="quote-owner-header" data-testid="approval-owner-brand">
            {quotation.owner.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Approval pages intentionally render the owner's static brand asset directly.
              <img
                src={quotation.owner.logoUrl}
                alt={quotation.owner.logoAlt}
                className="quote-owner-logo"
                data-testid="approval-owner-logo"
              />
            ) : null}
            <div>
              <p className="eta-eyebrow">{quotation.owner.brandLabel} / QUOTATION APPROVAL</p>
              <p>{quotation.owner.legalName}</p>
              <p>{quotation.owner.englishName}</p>
            </div>
          </header>
        ) : (
          <p className="eta-eyebrow">QUOTATION APPROVAL</p>
        )}
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
                <p className="help" data-testid="approval-owner-intro">{quotation.owner.approvalIntro}</p>
                <button className="button" type="button" disabled={approving} onClick={() => void approve()}>
                  {approving ? "承認処理中..." : quotation.owner.approvalActionLabel}
                </button>
              </>
            )}
          </>
        ) : null}
        {quotation?.owner ? (
          <footer className="quote-owner-footer" data-testid="approval-owner-footer">
            <p>{quotation.owner.approvalFooterNote}</p>
            <p>{quotation.owner.postalCode} {quotation.owner.address}</p>
            <p>{[quotation.owner.telephone, quotation.owner.fax].filter(Boolean).join(" / ")}</p>
            <p>{quotation.owner.defaultContactEmail}</p>
            {quotation.owner.defaultContactTelephone ? <p>{quotation.owner.defaultContactTelephone}</p> : null}
            {quotation.owner.website ? <p>{quotation.owner.website}</p> : null}
          </footer>
        ) : null}
      </section>
    </main>
  );
}
