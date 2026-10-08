"use client";

import { useCallback, useEffect, useState } from "react";

interface UploadOrderInfo {
  order_number: string;
  product_name: string;
  files: Array<{ name: string; url: string }>;
  proofs: Array<{ name: string; version: number; url: string }>;
  status: string;
}

export default function ProofUploadClient({
  token,
  orderNumber,
  productName,
}: {
  token: string;
  orderNumber: string;
  productName: string;
}) {
  const [info, setInfo] = useState<UploadOrderInfo | null>(null);
  const [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [uploader, setUploader] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/film-orders/proof-upload/${encodeURIComponent(token)}`);
      const payload = await response.json();
      if (!response.ok || !payload.order) throw new Error(payload.error ?? "failed");
      setInfo(payload.order as UploadOrderInfo);
      setError("");
    } catch {
      setError("情報を取得できませんでした。");
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時にサーバーから注文情報を取得する意図的な処理です。
    void load();
  }, [load]);

  const suggestedName = useCallback((version: number) => {
    const date = new Date();
    const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const clean = (productName || "無題").replace(/[\\/:*?"<>|\r\n\t]/g, "").replace(/\s+/g, "_").slice(0, 40);
    return `${clean}_${orderNumber}_校正_${datePart}${version > 1 ? `_v${version}` : ""}`;
  }, [orderNumber, productName]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 取得した校正回数から既定ファイル名を補完する処理です。
    if (info && !fileName) setFileName(`${suggestedName((info.proofs.length ?? 0) + 1)}.ai`);
  }, [info, fileName, suggestedName]);

  const submit = async () => {
    if (!file || busy) return;
    if (file.size > 15 * 1024 * 1024) {
      setError(`ファイルサイズが15MBを超えています（${(file.size / 1024 / 1024).toFixed(1)}MB）。15MB以下に圧縮してください。`);
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const sessionResponse = await fetch(`/api/film-orders/proof-upload/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "session",
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
          "Content-Range": `bytes 0-${file.size - 1}/${file.size}`,
        },
        body: file,
      });
      if (!put.ok) throw new Error(`upload_failed:${put.status}`);
      const completeResponse = await fetch(`/api/film-orders/proof-upload/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          fileName: fileName.trim(),
          uploader: uploader.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      const complete = await completeResponse.json();
      if (!completeResponse.ok) throw new Error(complete.error ?? "complete_failed");
      setMessage("校正データを登録しました。ご協力ありがとうございます。");
      setFile(null);
      setFileName("");
      setNote("");
      await load();
      if (info) setFileName(`${suggestedName(((complete.order?.proofs?.length ?? (info.proofs.length + 1))))}.ai`);
    } catch (err) {
      setError(err instanceof Error ? `失敗しました: ${err.message}` : "失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="eta-form">
      {error ? <p className="eta-error">{error}</p> : null}
      {message ? <p className="eta-ok" role="status">{message}</p> : null}

      {info && info.files.length > 0 ? (
        <div className="proof-upload-files">
          <h2>入稿データ（参考）</h2>
          <ul>
            {info.files.map((item) => (
              <li key={item.name}>
                {item.name}
                {item.url ? (
                  <a href={`/api/film-orders/proof-download/${encodeURIComponent(token)}?fileId=${encodeURIComponent(item.url.split("/d/")[1]?.split("/")[0] ?? "")}`} target="_blank" rel="noreferrer">ダウンロード</a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label>校正ファイル（AI形式推奨・15MBまで）
        <input type="file" onChange={(event) => {
          const selected = event.target.files?.[0] ?? null;
          setFile(selected);
          setMessage("");
          if (selected && fileName) {
            const extension = selected.name.includes(".") ? selected.name.slice(selected.name.lastIndexOf(".")) : "";
            const dot = fileName.lastIndexOf(".");
            setFileName(dot > 0 ? `${fileName.slice(0, dot)}${extension}` : fileName);
          }
        }} />
      </label>
      <label>ファイル名（発注番号を含めてください）
        <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
      </label>
      <label>担当者名（任意）
        <input value={uploader} onChange={(event) => setUploader(event.target.value)} placeholder="会社名・お名前" />
      </label>
      <label>メモ（任意）
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="校正内容の補足など" />
      </label>
      <button className="button" type="button" disabled={!file || !fileName.trim() || busy} onClick={() => void submit()}>
        {busy ? "アップロード中..." : "校正データをアップロード"}
      </button>

      {info && info.proofs.length > 0 ? (
        <div className="proof-upload-files">
          <h2>アップロード済み校正データ</h2>
          <ul>
            {info.proofs.map((proof) => (
              <li key={`${proof.name}-${proof.version}`}>v{proof.version} ／ {proof.name}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
