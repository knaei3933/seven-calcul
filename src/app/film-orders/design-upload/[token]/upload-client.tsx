"use client";

import { useCallback, useEffect, useState } from "react";

interface DesignInfo {
  order: {
    orderNumber: string;
    productName: string;
    designStatusLabel: string;
    requestedAt: string | null;
    note: string | null;
  };
  policy: { allowedExtensions: string[]; maxBytes: number };
  files: Array<{
    id: number;
    fileName: string;
    version: number;
    uploadedAt: string;
    sizeBytes: number | null;
    note: string | null;
  }>;
  canUpload: boolean;
}

export default function CustomerDesignUploadClient({ token }: { token: string }) {
  const [info, setInfo] = useState<DesignInfo | null>(null);
  const [aiFile, setAiFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [uploader, setUploader] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/film-orders/design-upload/${encodeURIComponent(token)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "failed");
      setInfo(payload as DesignInfo);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? `ページを表示できません（${cause.message}）` : "ページを表示できません。");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時に公開トークンから案件情報を取得する意図的な処理です。
    void load();
  }, [load]);

  const uploadOne = async (file: File) => {
    const sessionResponse = await fetch(`/api/film-orders/design-upload/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "session",
        originalFileName: file.name,
        sizeBytes: file.size,
        contentType: file.type || "application/octet-stream",
      }),
    });
    const session = await sessionResponse.json();
    if (!sessionResponse.ok || !session.sessionUri) throw new Error(session.error ?? "session_failed");
    const put = await fetch(session.sessionUri, {
      method: "PUT",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    const uploaded = await put.json().catch(() => ({})) as { id?: unknown };
    if (!put.ok || typeof uploaded.id !== "string") throw new Error(`upload_failed:${put.status}`);
    const completeResponse = await fetch(`/api/film-orders/design-upload/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "complete",
        originalFileName: file.name,
        fileId: uploaded.id,
        uploader: uploader.trim() || undefined,
        note: note.trim() || undefined,
      }),
    });
    const complete = await completeResponse.json();
    if (!completeResponse.ok) throw new Error(complete.error ?? "complete_failed");
    return complete as DesignInfo;
  };

  const submit = async () => {
    if (!aiFile || busy || !info?.canUpload) return;
    if (aiFile.size > info.policy.maxBytes) {
      setError(`AIファイルサイズが上限（${Math.floor(info.policy.maxBytes / 1024 / 1024)}MB）を超えています。`);
      return;
    }
    if (pdfFile && pdfFile.size > info.policy.maxBytes) {
      setError(`PDFファイルサイズが上限（${Math.floor(info.policy.maxBytes / 1024 / 1024)}MB）を超えています。`);
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      let latest = await uploadOne(aiFile);
      if (pdfFile) latest = await uploadOne(pdfFile);
      setInfo(latest);
      setMessage("デザインデータを入稿しました。AI原稿を必須とし、確認用PDFも受け付けました。");
      setAiFile(null); setPdfFile(null); setNote("");
    } catch (cause) {
      setError(cause instanceof Error ? `失敗しました（${cause.message}）` : "アップロードに失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="eta-page">
      <section className="panel eta-panel" aria-labelledby="customer-design-title">
        <p className="eta-eyebrow">CUSTOMER DESIGN</p>
        <h1 id="customer-design-title">デザインデータ入稿</h1>
        {loading ? <p className="help">読み込み中です...</p> : null}
        {error ? <p className="eta-error" role="alert">{error}</p> : null}
        {message ? <p className="eta-ok" role="status">{message}</p> : null}
        {info ? (
          <>
            <dl className="eta-form">
              <div><dt>見積 / 発注番号</dt><dd>{info.order.orderNumber}</dd></div>
              <div><dt>品名</dt><dd>{info.order.productName || "-"}</dd></div>
              <div><dt>状態</dt><dd>{info.order.designStatusLabel}</dd></div>
              {info.order.note ? <div><dt>依頼内容</dt><dd>{info.order.note}</dd></div> : null}
            </dl>
            {info.files.length ? (
              <div className="proof-upload-files">
                <h2>入稿済みデータ</h2>
                <ul>{info.files.map((item) => <li key={item.id}>v{item.version} / {item.fileName}</li>)}</ul>
              </div>
            ) : null}
            {info.canUpload ? (
              <div className="eta-form">
                <label>AIデータ（必須）
                  <input type="file" accept=".ai" onChange={(event) => setAiFile(event.target.files?.[0] ?? null)} />
                </label>
                <label>確認用PDF（任意）
                  <input type="file" accept=".pdf" onChange={(event) => setPdfFile(event.target.files?.[0] ?? null)} />
                </label>
                <label>担当者名（任意）<input value={uploader} onChange={(event) => setUploader(event.target.value)} /></label>
                <label>備考（任意）<textarea value={note} rows={3} onChange={(event) => setNote(event.target.value)} /></label>
                <button className="button" type="button" disabled={!aiFile || busy} onClick={() => void submit()}>
                  {busy ? "アップロード中..." : "デザインデータを入稿"}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
