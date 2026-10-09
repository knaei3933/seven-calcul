"use client";

import { useCallback, useEffect, useState } from "react";

interface FilmPrice {
  id: number;
  band: "lte570" | "571to740";
  tier: "500" | "1000" | "1500";
  unitPriceYenPerM: string;
  effectiveFrom: string;
  effectiveTo: string;
  memo: string;
  updatedBy: string;
  updatedAt: string;
}

const BAND_LABELS: Record<string, string> = { lte570: "570mm以下", "571to740": "571〜740mm" };
const TIER_LABELS: Record<string, string> = { "500": "〜999m", "1000": "1,000〜1,499m", "1500": "1,500m〜" };

export default function FilmPricesClient() {
  const [prices, setPrices] = useState<FilmPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState({
    band: "lte570",
    tier: "500",
    unitPriceYenPerM: "328",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    memo: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/film-prices");
      const payload = await response.json();
      if (response.ok) setPrices(payload.prices ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR後にlocalStorage/sessionStorageを読む必要がある意図的な復元処理です。
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/film-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error === "admin_required" ? "管理者権限が必要です。" : "保存できませんでした。");
        return;
      }
      setMessage(`${BAND_LABELS[draft.band]} ${TIER_LABELS[draft.tier]} = ${draft.unitPriceYenPerM}円/m を保存しました。`);
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="admin-page">
      <section className="panel">
        <h1>フィルム単価マスター</h1>
        <p className="help">月次で基本m単価を更新します。有効期間は1ヶ月（自動計算）。配送・通関は自動計算のため入力不要です。</p>

        <div className="field-row" style={{ marginBottom: 14 }}>
          <label>価格帯
            <select value={draft.band} onChange={(e) => setDraft((old) => ({ ...old, band: e.target.value }))}>
              <option value="lte570">570mm以下</option>
              <option value="571to740">571〜740mm</option>
            </select>
          </label>
          <label>発注ティア
            <select value={draft.tier} onChange={(e) => setDraft((old) => ({ ...old, tier: e.target.value }))}>
              <option value="500">〜999m</option>
              <option value="1000">1,000〜1,499m</option>
              <option value="1500">1,500m〜</option>
            </select>
          </label>
          <label>基本m単価（円/m）
            <input inputMode="decimal" value={draft.unitPriceYenPerM} onChange={(e) => setDraft((old) => ({ ...old, unitPriceYenPerM: e.target.value }))} />
          </label>
          <label>適用開始
            <input type="date" value={draft.effectiveFrom} onChange={(e) => setDraft((old) => ({ ...old, effectiveFrom: e.target.value }))} />
          </label>
          <label className="wide">メモ
            <input value={draft.memo} onChange={(e) => setDraft((old) => ({ ...old, memo: e.target.value }))} placeholder="例：10月改定" />
          </label>
        </div>
        <div className="button-row" style={{ marginBottom: 8 }}>
          <button className="button" type="button" disabled={saving || !draft.unitPriceYenPerM} onClick={() => void submit()}>
            {saving ? "保存中..." : "単価を登録"}
          </button>
          {message ? <span className="help" role="status">{message}</span> : null}
        </div>

        {loading ? <p>読み込み中...</p> : prices.length === 0 ? (
          <p className="help">登録された単価はありません。既定値（constants）で計算されます。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>価格帯</th><th>ティア</th><th>基本m単価</th><th>適用期間</th><th>メモ</th><th>更新者</th><th>更新日時</th>
              </tr>
            </thead>
            <tbody>
              {prices.map((price) => (
                <tr key={price.id} className={new Date() >= new Date(price.effectiveFrom) && new Date() <= new Date(price.effectiveTo) ? "" : "muted"}>
                  <td>{BAND_LABELS[price.band]}</td>
                  <td>{TIER_LABELS[price.tier]}</td>
                  <td><strong>{Number(price.unitPriceYenPerM).toLocaleString("ja-JP")} 円/m</strong></td>
                  <td>{price.effectiveFrom.slice(0, 10)} 〜 {price.effectiveTo.slice(0, 10)}</td>
                  <td>{price.memo || "-"}</td>
                  <td>{price.updatedBy || "-"}</td>
                  <td>{new Date(price.updatedAt).toLocaleString("ja-JP")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
