"use client";

import { useCallback, useEffect, useState } from "react";

interface ProofInfo {
  order: {
    orderNumber: string;
    productName: string;
    proofStatus: string;
    requestedAt: string | null;
    approvedAt: string | null;
    correctionReason: string | null;
  };
  latestProof: { id: number; fileName: string; version: number } | null;
  priorProofs: Array<{ id: number; fileName: string; version: number }>;
  decision: string;
  canDecide: boolean;
}

export default function CustomerProofReviewClient({ token }: { token: string }) {
  const [info, setInfo] = useState<ProofInfo | null>(null);
  const [decision, setDecision] = useState<"approve" | "correction" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/film-orders/proof-review/${encodeURIComponent(token)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "failed");
      setInfo(payload as ProofInfo);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? "ページを表示できません。" : "ページを表示できません。");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- トークン案件の公開レビュー情報を初期取得します。
    void load();
  }, [load]);

  const submit = async (kind: "approve" | "correction") => {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/film-orders/proof-review/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: kind, reason: kind === "correction" ? reason.trim() : undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "failed");
      setInfo(payload as ProofInfo);
      setDecision(null); setReason("");
      setMessage(kind === "approve" ? "校正を承認しました。" : "修正依頼を受け付けました。");
    } catch (cause) {
      setError(cause instanceof Error ? `失敗しました（${cause.message}）` : "処理に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const proxyUrl = (fileId: number) => `/api/film-orders/proof-review/${encodeURIComponent(token)}/file/${fileId}`;

  return (
    <main className="eta-page">
      <section className="panel eta-panel" aria-labelledby="proof-review-title">
        <p className="eta-eyebrow">PROOF REVIEW</p>
        <h1 id="proof-review-title">校正ご確認</h1>
        {loading ? <p className="help">読み込み中です...</p> : null}
        {error ? <p className="eta-error" role="alert">{error}</p> : null}
        {message ? <p className="eta-ok" role="status">{message}</p> : null}
        {info ? (
          <>
            <dl className="eta-form">
              <div><dt>発注番号</dt><dd>{info.order.orderNumber}</dd></div>
              <div><dt>品名</dt><dd>{info.order.productName || "-"}</dd></div>
              <div><dt>状態</dt><dd>{info.order.proofStatus}</dd></div>
              {info.order.correctionReason ? <div><dt>前回修正依頼</dt><dd>{info.order.correctionReason}</dd></div> : null}
            </dl>
            {info.latestProof ? (
              <>
                <p><strong>最新校正：</strong>v{info.latestProof.version} / {info.latestProof.fileName}</p>
                <a className="button secondary" href={proxyUrl(info.latestProof.id)} target="_blank" rel="noreferrer">校正PDFを開く</a>
              </>
            ) : <p>校正データがありません。</p>}
            {info.priorProofs.length ? (
              <ul>{info.priorProofs.map((proof) => <li key={proof.id}>過去版 v{proof.version} / {proof.fileName}</li>)}</ul>
            ) : null}
            {info.canDecide ? (
              <div className="eta-form">
                <button className="button" type="button" disabled={busy} onClick={() => void submit("approve")}>承認する</button>
                <button className="button secondary" type="button" disabled={busy} onClick={() => setDecision("correction")}>修正を依頼</button>
                {decision === "correction" ? (
                  <form onSubmit={(event) => { event.preventDefault(); void submit("correction"); }}>
                    <label>修正箇所・内容<textarea value={reason} rows={4} onChange={(event) => setReason(event.target.value)} required /></label>
                    <button className="button" type="submit" disabled={busy || !reason.trim()}>修正依頼を送信</button>
                  </form>
                ) : null}
              </div>
            ) : <p>この校正の判定は処理済みです。</p>}
          </>
        ) : null}
      </section>
    </main>
  );
}
