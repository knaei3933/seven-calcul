"use client";

import { useState } from "react";

export default function EtaFormClient({
  token,
  currentEtaDate,
  currentNote,
}: {
  token: string;
  currentEtaDate: string;
  currentNote: string;
}) {
  const [etaDate, setEtaDate] = useState(currentEtaDate);
  const [note, setNote] = useState(currentNote);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async () => {
    if (busy || !etaDate) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/film-orders/eta/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ etaDate, note }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "failed");
      setMessage("納期見込みを登録しました。ご協力ありがとうございます。");
    } catch (err) {
      setError(err instanceof Error && err.message !== "failed" ? `登録に失敗しました（${err.message}）` : "登録に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="eta-form">
      <label>おおよその納期日（必須）
        <input type="date" value={etaDate} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setEtaDate(event.target.value)} />
      </label>
      <label>メモ（任意）
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="例: 前後する可能性があります / 銅版込み" />
      </label>
      <button className="button" type="button" disabled={busy || !etaDate} onClick={() => void submit()}>
        {busy ? "登録中..." : "納期見込みを登録"}
      </button>
      {message ? <p className="eta-ok" role="status">{message}</p> : null}
      {error ? <p className="eta-error">{error}</p> : null}
    </div>
  );
}
