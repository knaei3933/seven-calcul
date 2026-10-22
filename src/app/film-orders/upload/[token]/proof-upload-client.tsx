"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupplierLocale } from "@/lib/film-order-access";

interface UploadOrderInfo {
  order_number: string;
  product_name: string;
  files: Array<{ name: string; fileId: string }>;
  proofs: Array<{ name: string; version: number; fileId: string }>;
  status: string;
}

const TEXT = {
  ko: {
    title: "교정 데이터 업로드",
    loadError: "정보를 가져올 수 없습니다.",
    reference: "입고 데이터(참고)",
    download: "다운로드",
    ai: "AI 파일(필수 · 15MB까지)",
    pdf: "PDF 파일(선택 · 15MB까지)",
    baseName: "공통 파일명(발주번호를 포함해 주십시오)",
    uploader: "담당자명(선택)",
    uploaderPlaceholder: "회사명 · 성함",
    note: "메모(선택)",
    notePlaceholder: "교정 내용 보충 등",
    submit: "교정 데이터 업로드",
    uploading: "업로드 중...",
    aiExt: "AI 파일 확장자는 .ai로 해 주십시오.",
    pdfExt: "PDF 파일 확장자는 .pdf로 해 주십시오.",
    size: "파일 크기가 15MB를 초과합니다",
    complete: "교정 데이터를 등록했습니다. 협조 감사합니다.",
    fail: "실패했습니다",
    uploaded: "업로드된 교정 데이터",
    correction: "교정",
    untitled: "제목 없음",
  },
  ja: {
    title: "校正データ アップロード",
    loadError: "情報を取得できませんでした。",
    reference: "入稿データ（参考）",
    download: "ダウンロード",
    ai: "AIファイル（必須・15MBまで）",
    pdf: "PDFファイル（任意・15MBまで）",
    baseName: "共通ファイル名（発注番号を含めてください）",
    uploader: "担当者名（任意）",
    uploaderPlaceholder: "会社名・お名前",
    note: "メモ（任意）",
    notePlaceholder: "校正内容の補足など",
    submit: "校正データをアップロード",
    uploading: "アップロード中...",
    aiExt: "AIファイルの拡張子は .ai にしてください。",
    pdfExt: "PDFファイルの拡張子は .pdf にしてください。",
    size: "ファイルサイズが15MBを超えています",
    complete: "校正データを登録しました。ご協力ありがとうございます。",
    fail: "失敗しました",
    uploaded: "アップロード済み校正データ",
    correction: "校正",
    untitled: "無題",
  },
} as const;

export default function ProofUploadClient({
  token,
  orderNumber,
  productName,
  locale,
}: {
  token: string;
  orderNumber: string;
  productName: string;
  locale: SupplierLocale;
}) {
  const t = TEXT[locale];
  const [info, setInfo] = useState<UploadOrderInfo | null>(null);
  const [error, setError] = useState("");
  const [aiFile, setAiFile] = useState<File | null>(null);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [baseName, setBaseName] = useState("");
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
      setError(t.loadError);
    }
  }, [token, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時に注文情報を取得する意図的な処理です。
    void load();
  }, [load]);

  const suggestedBaseName = useCallback((version: number) => {
    const date = new Date();
    const datePart = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
    const clean = (productName || t.untitled).replace(/[\\/:*?"<>|\r\n\t]/g, "").replace(/\s+/g, "_").slice(0, 40);
    return `${clean}_${orderNumber}_${t.correction}_${datePart}${version > 1 ? `_v${version}` : ""}`;
  }, [orderNumber, productName, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 取得した校正回数から既定ファイル名を補完する処理です。
    if (info && !baseName) setBaseName(suggestedBaseName(Math.floor((info.proofs.length ?? 0) / 2) + 1));
  }, [info, baseName, suggestedBaseName]);

  const aiFileName = baseName ? `${baseName}.ai` : "";
  const pdfFileName = baseName ? `${baseName}.pdf` : "";

  const uploadOne = async (file: File, fileName: string): Promise<string> => {
    const sessionResponse = await fetch(`/api/film-orders/proof-upload/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "session",
        fileName,
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
    const uploaded = await put.json().catch(() => ({})) as { id?: unknown };
    if (!put.ok || typeof uploaded.id !== "string") throw new Error(`upload_failed:${put.status}`);
    return uploaded.id;
  };

  const submit = async () => {
    if (!aiFile || busy) return;
    if (!aiFileName.toLowerCase().endsWith(".ai")) {
      setError(t.aiExt);
      return;
    }
    if (pdfFile && !pdfFileName.toLowerCase().endsWith(".pdf")) {
      setError(t.pdfExt);
      return;
    }
    const files = [aiFile, pdfFile].filter((item): item is File => Boolean(item));
    const tooLarge = files.find((file) => file.size > 15 * 1024 * 1024);
    if (tooLarge) {
      setError(`${t.size}（${tooLarge.name}）`);
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const aiFileId = await uploadOne(aiFile, aiFileName.trim());
      const pdfFileId = pdfFile ? await uploadOne(pdfFile, pdfFileName.trim()) : undefined;
      const completeResponse = await fetch(`/api/film-orders/proof-upload/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          aiFileName: aiFileName.trim(),
          pdfFileName: pdfFile ? pdfFileName.trim() : undefined,
          aiFileId,
          pdfFileId,
          uploader: uploader.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
      const complete = await completeResponse.json();
      if (!completeResponse.ok) throw new Error(complete.error ?? "complete_failed");
      setMessage(t.complete);
      setAiFile(null);
      setPdfFile(null);
      setBaseName("");
      setNote("");
      await load();
      if (info) setBaseName(suggestedBaseName(Math.floor((complete.order?.proofs?.length ?? (info.proofs.length + 2)) / 2) + 1));
    } catch (err) {
      setError(`${t.fail}: ${err instanceof Error ? err.message : ""}`);
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
          <h2>{t.reference}</h2>
          <ul>
            {info.files.map((item) => (
              <li key={item.name}>
                {item.name}
                {item.fileId ? (
                  <a href={`/api/film-orders/proof-download/${encodeURIComponent(token)}?fileId=${encodeURIComponent(item.fileId)}`} target="_blank" rel="noreferrer">{t.download}</a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <label>{t.ai}
        <input type="file" accept=".ai" onChange={(event) => {
          setAiFile(event.target.files?.[0] ?? null);
          setMessage("");
        }} />
      </label>
      <label>{t.pdf}
        <input type="file" accept=".pdf" onChange={(event) => {
          setPdfFile(event.target.files?.[0] ?? null);
          setMessage("");
        }} />
      </label>
      <label>{t.baseName}
        <input value={baseName} onChange={(event) => setBaseName(event.target.value.trim())} />
      </label>
      <label>{t.uploader}
        <input value={uploader} onChange={(event) => setUploader(event.target.value)} placeholder={t.uploaderPlaceholder} />
      </label>
      <label>{t.note}
        <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder={t.notePlaceholder} />
      </label>
      <button className="button" type="button" disabled={!aiFile || !baseName.trim() || busy} onClick={() => void submit()}>
        {busy ? t.uploading : t.submit}
      </button>

      {info && info.proofs.length > 0 ? (
        <div className="proof-upload-files">
          <h2>{t.uploaded}</h2>
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
