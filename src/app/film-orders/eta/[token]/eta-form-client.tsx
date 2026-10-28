"use client";

import { useCallback, useEffect, useState } from "react";
import type { FilmDeliveryTracking } from "@/lib/film-order-shared";
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
    deliveryState: "납품 진행 상태",
    shipmentTitle: "출하 보고",
    deliveryTitle: "납품 보고",
    shipped: "출하 보고 완료",
    delivered: "납품 보고 완료",
    notShipped: "미출하",
    shipmentDate: "출하일(필수)",
    deliveryDate: "납품일(필수)",
    carrier: "운송사",
    tracking: "운송장 번호",
    document: "납품서·인보이스 PDF（최대 3개, 1개 필수）",
    report: "보고 등록",
    shipmentRequired: "납품 보고 전에 출하 보고를 등록해 주십시오.",
  },
  ja: {
    date: "おおよその納期日（必須）",
    note: "メモ（任意）",
    notePlaceholder: "例: 前後する可能性があります / 銅版込み",
    submit: "納期見込みを登録",
    submitting: "登録中...",
    complete: "納期見込みを登録しました。ご協力ありがとうございます。",
    fail: "登録に失敗しました",
    deliveryState: "納品進行状況",
    shipmentTitle: "出荷報告",
    deliveryTitle: "納品報告",
    shipped: "出荷報告済み",
    delivered: "納品報告済み",
    notShipped: "未出荷",
    shipmentDate: "出荷日（必須）",
    deliveryDate: "納品日（必須）",
    carrier: "運送会社",
    tracking: "追跡番号",
    document: "納品書・インボイスPDF（最大3通、1通必須）",
    report: "報告を登録",
    shipmentRequired: "納品報告の前に出荷報告を登録してください。",
  },
} as const;

export default function EtaFormClient({
  token,
  currentEtaDate,
  currentNote,
  delivery,
  locale,
}: {
  token: string;
  currentEtaDate: string;
  currentNote: string;
  delivery: FilmDeliveryTracking;
  locale: SupplierLocale;
}) {
  const t = TEXT[locale];
  const [etaDate, setEtaDate] = useState(currentEtaDate);
  const [note, setNote] = useState(currentNote);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [shipmentDate, setShipmentDate] = useState(delivery.shippedOn ?? "");
  const [carrier, setCarrier] = useState(delivery.carrier);
  const [trackingNumber, setTrackingNumber] = useState(delivery.trackingNumber);
  const [shipmentNote, setShipmentNote] = useState(delivery.shipmentNote);
  const [documentFiles, setDocumentFiles] = useState<File[]>([]);
  const [driveReady, setDriveReady] = useState(false);
  const [deliveredDate, setDeliveredDate] = useState(delivery.deliveredOn ?? "");
  const [deliveryNote, setDeliveryNote] = useState(delivery.deliveryNote);

  const applyDelivery = (next?: FilmDeliveryTracking) => {
    if (!next) return;
    setShipmentDate(next.shippedOn ?? "");
    setCarrier(next.carrier);
    setTrackingNumber(next.trackingNumber);
    setShipmentNote(next.shipmentNote);
    setDeliveredDate(next.deliveredOn ?? "");
    setDeliveryNote(next.deliveryNote);
  };

  useEffect(() => {
    let active = true;
    void fetch(`/api/film-orders/delivery-upload/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!active) return;
        setDriveReady(Boolean(response.ok && payload.driveConfigured && payload.folderConfigured));
      })
      .catch(() => { if (active) setDriveReady(false); });
    return () => { active = false; };
  }, [token]);

  const uploadDeliveryDocument = async (documentFile: File, shipmentDate: string) => {
    const uploadId = crypto.randomUUID().replaceAll("-", "");
    if (!documentFile.name.toLowerCase().endsWith(".pdf")) throw new Error("invalid_delivery_document_type");
    if (documentFile.size <= 0 || documentFile.size > 15 * 1024 * 1024) throw new Error("file_too_large");
    const sessionResponse = await fetch(`/api/film-orders/delivery-upload/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "session",
        originalFileName: documentFile.name,
        shipmentDate,
        uploadId,
        sizeBytes: documentFile.size,
        contentType: documentFile.type || "application/pdf",
      }),
    });
    const session = await sessionResponse.json();
    if (!sessionResponse.ok || !session.sessionUri) throw new Error(session.error ?? "session_failed");
    const put = await fetch(session.sessionUri, {
      method: "PUT",
      headers: { "Content-Type": documentFile.type || "application/pdf" },
      body: documentFile,
    });
    const uploaded = await put.json().catch(() => ({})) as { id?: unknown };
    if (!put.ok || typeof uploaded.id !== "string") throw new Error(`upload_failed:${put.status}`);
    const completeResponse = await fetch(`/api/film-orders/delivery-upload/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "complete",
        fileName: session.fileName,
        fileId: uploaded.id,
        originalFileName: documentFile.name,
        shipmentDate,
        uploadId,
        recordShipment: false,
      }),
    });
    const complete = await completeResponse.json();
    if (!completeResponse.ok || !complete.document) throw new Error(complete.error ?? "complete_failed");
    return complete.document as { name: string; url: string };
  };

  const uploadShipment = async () => {
    if (!documentFiles.length || !shipmentDate || busy) return;
    if (documentFiles.length > 3) throw new Error("too_many_delivery_documents");
    const documents = [];
    for (const documentFile of documentFiles) {
      documents.push(await uploadDeliveryDocument(documentFile, shipmentDate));
    }
    const response = await fetch(`/api/film-orders/eta/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "shipment",
        date: shipmentDate,
        carrier,
        trackingNumber,
        note: shipmentNote,
        documents,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "failed");
    applyDelivery(payload.order?.delivery);
  };

  const submitDeliveryReport = async () => {
    if (busy || !deliveredDate) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/film-orders/eta/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: deliveredDate, note: deliveryNote }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "failed");
      applyDelivery(payload.order?.delivery);
      setMessage("납품 보고를 등록했습니다。 / 納品報告を登録しました。");
    } catch (err) {
      setError(err instanceof Error && err.message !== "failed" ? `${t.fail}（${err.message}）` : t.fail);
    } finally {
      setBusy(false);
    }
  };

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

      <div className="eta-delivery-state">
        <strong>{t.deliveryState}</strong>
        <span>{delivery.deliveredOn ? t.delivered : delivery.shippedOn ? t.shipped : t.notShipped}</span>
      </div>

      {!delivery.deliveredOn ? (
        delivery.shippedOn ? (
          <form className="eta-form eta-delivery-form" onSubmit={(event) => { event.preventDefault(); void submitDeliveryReport(); }}>
            <strong>{t.deliveryTitle}</strong>
            <label>{t.deliveryDate}
              <input type="date" value={deliveredDate} min={delivery.shippedOn ?? undefined} onChange={(event) => setDeliveredDate(event.target.value)} required />
            </label>
            <label>메모 / メモ
              <textarea value={deliveryNote} rows={2} onChange={(event) => setDeliveryNote(event.target.value)} />
            </label>
            <button className="button" type="submit" disabled={busy || !deliveredDate}>{busy ? t.submitting : t.report}</button>
          </form>
        ) : (
          <form className="eta-form eta-delivery-form" onSubmit={(event) => {
            event.preventDefault();
            setBusy(true); setError(""); setMessage("");
            uploadShipment().then(() => {
              setMessage("출하 보고를 등록했습니다. / 出荷報告を登録しました。");
            }).catch((cause: unknown) => {
              setError(cause instanceof Error ? `${t.fail}（${cause.message}）` : t.fail);
            }).finally(() => setBusy(false));
          }}>
            <strong>{t.shipmentTitle}</strong>
            <label>{t.shipmentDate}
              <input type="date" value={shipmentDate} onChange={(event) => setShipmentDate(event.target.value)} required />
            </label>
            <label>{t.carrier}
              <input value={carrier} onChange={(event) => setCarrier(event.target.value)} />
            </label>
            <label>{t.tracking}
              <input value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} />
            </label>
            <label>{t.document}
              <input
                type="file"
                accept=".pdf,application/pdf"
                multiple
                onChange={(event) => setDocumentFiles(Array.from(event.target.files ?? []).slice(0, 3))}
              />
            </label>
            {documentFiles.length ? (
              <ul>
                {documentFiles.map((file, index) => (
                  <li key={`${file.name}-${index}`}>
                    {index + 1}. {file.name}（{Math.round(file.size / 1024)}KB）
                    <button
                      className="button small secondary"
                      type="button"
                      onClick={() => setDocumentFiles((old) => old.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      削除
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <label>메모 / メモ
              <textarea value={shipmentNote} rows={2} onChange={(event) => setShipmentNote(event.target.value)} />
            </label>
            <button className="button" type="submit" disabled={busy || !shipmentDate || !documentFiles.length || !driveReady}>
              {busy ? t.submitting : t.report}
            </button>
            {!driveReady ? <p className="help">Drive upload is not configured.（Driveアップロード未設定）</p> : null}
          </form>
        )
      ) : (
        <p className="help">{t.delivered}</p>
      )}
    </div>
  );
}
