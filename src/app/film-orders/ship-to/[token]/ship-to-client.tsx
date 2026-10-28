"use client";

import { useCallback, useEffect, useState } from "react";

interface ShipToValues {
  label: string;
  companyName: string;
  department: string;
  contactName: string;
  postalCode: string;
  address: string;
  building: string;
  phone: string;
  email: string;
  note: string;
}

interface ShipToDestinationOption extends ShipToValues {
  id: number;
  isDefault: boolean;
}

interface ShipToRequest {
  orderNumber: string;
  productName: string;
  customerName: string;
  customerCode: string;
  requestedAt: string | null;
  expiresAt: string;
  status: "not_provided" | "registered" | "confirmed";
  currentDestination: ShipToValues | null;
  defaultDestination: ShipToValues | null;
  destinations: ShipToDestinationOption[];
}

const EMPTY: ShipToValues = {
  label: "",
  companyName: "",
  department: "",
  contactName: "",
  postalCode: "",
  address: "",
  building: "",
  phone: "",
  email: "",
  note: "",
};

export default function ShipToRequestClient({ token }: { token: string }) {
  const [request, setRequest] = useState<ShipToRequest | null>(null);
  const [selection, setSelection] = useState<"default" | "new" | number>("default");
  const [values, setValues] = useState<ShipToValues>(EMPTY);
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/film-orders/ship-to/${encodeURIComponent(token)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.orderNumber) throw new Error(payload.error ?? "load_failed");
      const loaded = payload as ShipToRequest;
      setRequest(loaded);
      setValues(loaded.defaultDestination ?? EMPTY);
      if (loaded.status === "registered") setMessage("納品先は登録済みです。内容を変更する場合は再度登録できます。");
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "load_failed" ? caught.message : "情報を取得できませんでした。");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部トークンで初期情報を取得する意図的な処理です。
    void load();
  }, [load]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body = selection === "new"
        ? { values, saveAsDefault }
        : { destinationId: selection };
      const response = await fetch(`/api/film-orders/ship-to/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload.saved) throw new Error(payload.error ?? "save_failed");
      setMessage("納品先を登録しました。担当者へ通知しました。");
      await load();
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "save_failed" ? caught.message : "登録できませんでした。入力内容をご確認ください。");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="eta-page">
        <section className="panel eta-panel"><p className="eta-summary">読み込み中...</p></section>
      </main>
    );
  }

  if (!request) {
    return (
      <main className="eta-page">
        <section className="panel eta-panel">
          <p className="eta-eyebrow">DELIVERY DESTINATION</p>
          <h1>納品先登録</h1>
          <p className="eta-error">{error || "リンクが無効または期限切れです。"}</p>
        </section>
      </main>
    );
  }

  const current = request.currentDestination;
  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">DELIVERY DESTINATION</p>
        <h1>納品先登録</h1>
        <p className="eta-summary">
          {request.orderNumber} ／ {request.productName || "-"}<br />
          {request.customerName || "顧客未設定"}
        </p>

        {message ? <p className="eta-ok" role="status">{message}</p> : null}
        {error ? <p className="eta-error" role="alert">{error}</p> : null}

        {current ? (
          <section className="ship-to-current" aria-label="登録済み納品先">
            <h2>現在の登録内容</h2>
            <p>
              {current.companyName}{current.department ? ` / ${current.department}` : ""}<br />
              {current.contactName ? `${current.contactName}<br />` : ""}
              〒{current.postalCode} {current.address}{current.building ? ` ${current.building}` : ""}<br />
              {current.phone}
            </p>
          </section>
        ) : null}

        {request.status !== "confirmed" ? (
          <form className="eta-form" onSubmit={submit} aria-busy={busy}>
            <fieldset className="ship-to-options">
              <legend>納品先を選択</legend>
              {request.defaultDestination ? (
                <label className={`ship-to-option ${selection === "default" ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="ship-to-selection"
                    checked={selection === "default"}
                    onChange={() => setSelection("default")}
                  />
                  <span>
                    <strong>既定の顧客住所を使用</strong>
                    <small>
                      〒{request.defaultDestination.postalCode} {request.defaultDestination.address}
                      {request.defaultDestination.companyName ? ` / ${request.defaultDestination.companyName}` : ""}
                    </small>
                  </span>
                </label>
              ) : null}
              {request.destinations.map((destination) => (
                <label key={destination.id} className={`ship-to-option ${selection === destination.id ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="ship-to-selection"
                    checked={selection === destination.id}
                    onChange={() => setSelection(destination.id)}
                  />
                  <span>
                    <strong>{destination.label || destination.companyName}{destination.isDefault ? "（既定）" : ""}</strong>
                    <small>
                      〒{destination.postalCode} {destination.address}{destination.building ? ` ${destination.building}` : ""}
                      {destination.contactName ? ` / ${destination.contactName}` : ""}
                    </small>
                  </span>
                </label>
              ))}
              <label className={`ship-to-option ${selection === "new" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="ship-to-selection"
                  checked={selection === "new"}
                  onChange={() => setSelection("new")}
                />
                <span><strong>別の納品先を入力</strong><small>登録内容は住所録に保存できます。</small></span>
              </label>
            </fieldset>

            {selection === "new" ? (
              <div className="film-order-form ship-to-form">
                <label>ラベル<input value={values.label} onChange={(event) => setValues((old) => ({ ...old, label: event.target.value }))} /></label>
                <label>会社名 ★<input required autoComplete="organization" value={values.companyName} onChange={(event) => setValues((old) => ({ ...old, companyName: event.target.value }))} /></label>
                <label>部署<input value={values.department} onChange={(event) => setValues((old) => ({ ...old, department: event.target.value }))} /></label>
                <label>担当者<input autoComplete="name" value={values.contactName} onChange={(event) => setValues((old) => ({ ...old, contactName: event.target.value }))} /></label>
                <label>郵便番号 ★<input required inputMode="numeric" autoComplete="postal-code" placeholder="582-0017" value={values.postalCode} onChange={(event) => setValues((old) => ({ ...old, postalCode: event.target.value }))} /></label>
                <label>住所 ★<input required autoComplete="address-line1" value={values.address} onChange={(event) => setValues((old) => ({ ...old, address: event.target.value }))} /></label>
                <label>建物名<input autoComplete="address-line2" value={values.building} onChange={(event) => setValues((old) => ({ ...old, building: event.target.value }))} /></label>
                <label>電話番号 ★<input required type="tel" autoComplete="tel" value={values.phone} onChange={(event) => setValues((old) => ({ ...old, phone: event.target.value }))} /></label>
                <label>メール<input type="email" autoComplete="email" value={values.email} onChange={(event) => setValues((old) => ({ ...old, email: event.target.value }))} /></label>
                <label>備考<textarea value={values.note} rows={2} onChange={(event) => setValues((old) => ({ ...old, note: event.target.value }))} /></label>
                <label className="inline-check">
                  <input type="checkbox" checked={saveAsDefault} onChange={(event) => setSaveAsDefault(event.target.checked)} />
                  この納品先を既定に設定
                </label>
              </div>
            ) : null}

            <button className="button workflow-action role-customer" type="submit" disabled={busy} aria-busy={busy}>
              {busy ? "登録中..." : "納品先を登録する"}
            </button>
            <p className="help">リンク有効期限：{new Date(request.expiresAt).toLocaleString("ja-JP")}</p>
          </form>
        ) : (
          <p className="eta-ok">この案件の納品先は確定済みです。</p>
        )}
      </section>
    </main>
  );
}
