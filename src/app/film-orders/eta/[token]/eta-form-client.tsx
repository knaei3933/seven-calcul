"use client";

import { useState } from "react";
import type { SupplierLocale } from "@/lib/film-order-access";

const TEXT = {
  ko: {
    date: "대략적인 납기일(필수)",
    note: "메모(선택)",
    notePlaceholder: "예: 일정이 앞뒤로 변동될 수 있음 / 동판 포함",
    submit: "납기 전망 등록",
    submitting: "등록 중...",
    complete: "납기 전망을 등록했습니다. 협조 감사합니다.",
    fail: "등록에 실패했습니다",
  },
  ja: {
    date: "おおよその納期日（必須）",
    note: "メモ（任意）",
    notePlaceholder: "例: 前後する可能性があります / 銅版込み",
    submit: "納期見込みを登録",
    submitting: "登録中...",
    complete: "納期見込みを登録しました。ご協力ありがとうございます。",
    fail: "登録に失敗しました",
  },
} as const;

export default function EtaFormClient({
  token,
  currentEtaDate,
  currentNote,
  locale,
}: {
  token: string;
  currentEtaDate: string;
  currentNote: string;
  locale: SupplierLocale;
}) {
  const t = TEXT[locale];
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
      setMessage(t.complete);
    } catch (err) {
      setError(err instanceof Error && err.message !== "failed" ? `${t.fail}（${err.message}）` : t.fail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="eta-form">
      <label>{t.date}
        <input type="date" value={etaDate} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setEtaDate(event.target.value)} />
      </label>
      <label>{t.note}
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder={t.notePlaceholder} />
      </label>
      <button className="button" type="button" disabled={busy || !etaDate} onClick={() => void submit()}>
        {busy ? t.submitting : t.submit}
      </button>
      {message ? <p className="eta-ok" role="status">{message}</p> : null}
      {error ? <p className="eta-error">{error}</p> : null}
    </div>
  );
}
