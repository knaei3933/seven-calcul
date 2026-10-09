"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

type Band = "lte570" | "571to740";
type Tier = "500" | "1000" | "1500";

const BAND_LABELS: Record<Band, string> = { lte570: "570mm以下", "571to740": "571〜740mm" };
const TIER_LABELS: Record<Tier, string> = { "500": "〜999m", "1000": "1,000〜1,499m", "1500": "1,500m〜" };
const TIERS: Tier[] = ["500", "1000", "1500"];
const BANDS: Band[] = ["lte570", "571to740"];
const DEFAULTS: Record<Band, Record<Tier, number>> = {
  lte570: { "500": 328, "1000": 252, "1500": 226 },
  "571to740": { "500": 365, "1000": 280, "1500": 252 },
};
const SHIPPING_UNIT_400 = [556, 580, 620];
const DOMESTIC_PER_TRIP = 2000;
const OVERSEAS_PER_TRIP = 16000;
const CUSTOMS_THRESHOLD = 200000;
const CUSTOMS_HIGH = 6600;
const CUSTOMS_PER_TRIP = 200;

const todayStr = () => new Date().toISOString().slice(0, 10);
const isTodayIn = (from: string, to: string) => { const t = todayStr(); return t >= from.slice(0, 10) && t <= to.slice(0, 10); };
const activePrice = (prices: FilmPrice[], band: Band, tier: Tier, fallback: number): string => {
  const t = todayStr();
  const found = prices.find((p) => p.band === band && p.tier === tier && p.effectiveFrom.slice(0, 10) <= t && p.effectiveTo.slice(0, 10) >= t);
  return found ? found.unitPriceYenPerM : String(fallback);
};
const shippingUnit = (width: number): 400 | 500 => (SHIPPING_UNIT_400.includes(width) ? 400 : 500);

function simulate(width: number, orderLength: number, multiplier: number, basePrice: number) {
  const band: Band = width <= 570 ? "lte570" : "571to740";
  const tier: Tier = orderLength < 1000 ? "500" : orderLength < 1500 ? "1000" : "1500";
  const filmCost = basePrice * orderLength;
  const unit = shippingUnit(width);
  const considered = orderLength * multiplier;
  const trips = Math.ceil(considered / unit);
  const domestic = trips * DOMESTIC_PER_TRIP;
  const overseas = trips * OVERSEAS_PER_TRIP;
  const customs = filmCost > CUSTOMS_THRESHOLD ? CUSTOMS_HIGH : trips * CUSTOMS_PER_TRIP;
  const total = filmCost + domestic + overseas + customs;
  return { band, tier, filmCost, unit, considered, trips, domestic, overseas, customs, total, perM: total / orderLength };
}

const fmt = (n: number) => n.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
const yen = (n: number) => `¥${n.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}`;

export default function FilmPricesClient() {
  const [prices, setPrices] = useState<FilmPrice[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"prices" | "rules" | "calc">("prices");
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState(todayStr());
  const [memo, setMemo] = useState("");
  const [calcWidth, setCalcWidth] = useState("476");
  const [calcLength, setCalcLength] = useState("1000");
  const [calcMultiplier, setCalcMultiplier] = useState("1");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/film-prices");
      const payload = await response.json();
      if (response.ok) setPrices(payload.prices ?? []);
    } finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR後にAPIからデータ取得する意図的な処理です。
  useEffect(() => { void load(); }, [load]);

  const currentPrices = useMemo(() => {
    const map: Record<string, string> = {};
    for (const band of BANDS) for (const tier of TIERS) map[`${band}:${tier}`] = activePrice(prices, band, tier, DEFAULTS[band][tier]);
    return map;
  }, [prices]);

  const hasChanges = useMemo(() => {
    return BANDS.some((band) => TIERS.some((tier) => {
      const key = `${band}:${tier}`;
      const edited = editValues[key];
      return edited !== undefined && edited !== currentPrices[key];
    }));
  }, [editValues, currentPrices]);

  const saveAll = async () => {
    const changes = BANDS.flatMap((band) =>
      TIERS.filter((tier) => {
        const key = `${band}:${tier}`;
        const edited = editValues[key];
        return edited !== undefined && edited !== currentPrices[key];
      }).map((tier) => ({ band, tier, unitPriceYenPerM: editValues[`${band}:${tier}`], effectiveFrom, memo })),
    );
    if (changes.length === 0) { setMessage("変更がありません。"); return; }
    setSaving(true);
    setMessage("");
    try {
      for (const change of changes) {
        const response = await fetch("/api/film-prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
        if (!response.ok) {
          const payload = await response.json();
          setMessage(payload.error === "admin_required" ? "管理者権限が必要です。" : "保存に失敗しました。");
          return;
        }
      }
      setMessage(`${changes.length}件の単価を更新しました（適用開始：${effectiveFrom}）。`);
      setEditValues({});
      await load();
    } finally { setSaving(false); }
  };

  const calcResult = useMemo(() => {
    const width = Number(calcWidth) || 476;
    const length = Number(calcLength) || 1000;
    const mult = Number(calcMultiplier) || 1;
    const band: Band = width <= 570 ? "lte570" : "571to740";
    const tier: Tier = length < 1000 ? "500" : length < 1500 ? "1000" : "1500";
    const basePrice = Number(currentPrices[`${band}:${tier}`]) || DEFAULTS[band][tier];
    return simulate(width, length, mult, basePrice);
  }, [calcWidth, calcLength, calcMultiplier, currentPrices]);

  return (
    <main className="film-price-admin">
      <header className="film-price-header">
        <div>
          <h1>フィルム単価マスター</h1>
          <p className="subtitle">月次で基本m単価を管理。配送・通関はシステムが自動計算します。</p>
        </div>
        <nav className="tab-bar" role="tablist">
          <button role="tab" aria-selected={tab === "prices"} className={tab === "prices" ? "active" : ""} onClick={() => setTab("prices")}>単価管理</button>
          <button role="tab" aria-selected={tab === "rules"} className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>計算ルール</button>
          <button role="tab" aria-selected={tab === "calc"} className={tab === "calc" ? "active" : ""} onClick={() => setTab("calc")}>シミュレータ</button>
        </nav>
      </header>

      {tab === "prices" ? (
        <section>
          <div className="price-toolbar">
            <label>適用開始 <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
            <label>メモ <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="例：11月改定" /></label>
            <button className="btn-primary" disabled={saving || !hasChanges} onClick={() => void saveAll()}>
              {saving ? "保存中..." : hasChanges ? "変更を保存" : "変更なし"}
            </button>
            {message ? <span className={`msg ${message.includes("失敗") ? "msg-error" : "msg-ok"}`} role="status">{message}</span> : null}
          </div>
          <div className="price-grid">
            {BANDS.map((band) => (
              <div key={band} className="band-card">
                <h3>{BAND_LABELS[band]}</h3>
                <table>
                  <thead><tr><th>ティア</th><th>基本m単価</th><th>ソース</th></tr></thead>
                  <tbody>
                    {TIERS.map((tier) => {
                      const key = `${band}:${tier}`;
                      const current = currentPrices[key];
                      const editing = editValues[key];
                      const hasMaster = prices.some((p) => p.band === band && p.tier === tier && isTodayIn(p.effectiveFrom, p.effectiveTo));
                      return (
                        <tr key={tier}>
                          <td>{TIER_LABELS[tier]}</td>
                          <td>
                            <input className="price-input" inputMode="decimal" value={editing ?? current}
                              onChange={(e) => setEditValues((old) => ({ ...old, [key]: e.target.value }))}
                              aria-label={`${BAND_LABELS[band]} ${TIER_LABELS[tier]}`} />
                            <span className="unit">円/m</span>
                          </td>
                          <td>{hasMaster ? <span className="badge active">マスター</span> : <span className="badge fallback">既定値</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <details className="history">
            <summary>変更履歴（{prices.length}件）</summary>
            {loading ? <p>読み込み中...</p> : prices.length === 0 ? <p className="no-data">登録なし。上の表で入力して保存してください。</p> : (
              <table className="history-table">
                <thead><tr><th>帯</th><th>ティア</th><th>m単価</th><th>期間</th><th>状態</th><th>メモ</th><th>更新者</th><th>日時</th></tr></thead>
                <tbody>
                  {prices.map((p) => (
                    <tr key={p.id} className={isTodayIn(p.effectiveFrom, p.effectiveTo) ? "row-active" : "row-past"}>
                      <td>{BAND_LABELS[p.band]}</td><td>{TIER_LABELS[p.tier]}</td>
                      <td><strong>{fmt(Number(p.unitPriceYenPerM))} 円/m</strong></td>
                      <td>{p.effectiveFrom.slice(0, 10)}〜{p.effectiveTo.slice(0, 10)}</td>
                      <td>{isTodayIn(p.effectiveFrom, p.effectiveTo) ? <span className="badge active">適用中</span> : <span className="badge expired">期限切れ</span>}</td>
                      <td>{p.memo || "-"}</td><td>{p.updatedBy || "-"}</td><td>{new Date(p.updatedAt).toLocaleString("ja-JP")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        </section>
      ) : null}

      {tab === "rules" ? (
        <section className="rules-grid">
          <div className="rule-card">
            <h3>配送単位（原反幅で決定）</h3>
            <table>
              <thead><tr><th>原反幅</th><th>単位</th></tr></thead>
              <tbody>
                <tr><td>356・368・396・464・476・512・736mm</td><td><strong>500m/回</strong></td></tr>
                <tr><td>556・580・620mm</td><td><strong>400m/回</strong></td></tr>
              </tbody>
            </table>
            <p className="rule-note">※ 736mmは生産倍率2倍のため、実質250mごとに1回として計算。</p>
          </div>
          <div className="rule-card">
            <h3>配送費・通関料</h3>
            <table><tbody>
              <tr><td>国内配送費</td><td><strong>{yen(DOMESTIC_PER_TRIP)} /回</strong></td></tr>
              <tr><td>海外配送費</td><td><strong>{yen(OVERSEAS_PER_TRIP)} /回</strong></td></tr>
              <tr><td>通関（{yen(CUSTOMS_THRESHOLD)}超）</td><td><strong>{yen(CUSTOMS_HIGH)} 固定</strong></td></tr>
              <tr><td>通関（{yen(CUSTOMS_THRESHOLD)}以下）</td><td><strong>{yen(CUSTOMS_PER_TRIP)} ×回数</strong></td></tr>
            </tbody></table>
          </div>
          <div className="rule-card">
            <h3>計算式</h3>
            <div className="formula">
              <p><strong>①</strong> フィルム代 ＝ 発注長さ × 基本m単価</p>
              <p><strong>②</strong> 配送回数 ＝ 切上（検討長さ ÷ 配送単位）<br /><small>検討長さ ＝ 発注 × 生産倍率</small></p>
              <p><strong>③</strong> 総額 ＝ ① ＋ ({yen(DOMESTIC_PER_TRIP)}＋{yen(OVERSEAS_PER_TRIP)}) × ② ＋ 通関</p>
            </div>
          </div>
        </section>
      ) : null}

      {tab === "calc" ? (
        <section className="calc-section">
          <div className="calc-inputs">
            <label>原反幅 <select value={calcWidth} onChange={(e) => setCalcWidth(e.target.value)}>
              {[356, 368, 396, 464, 476, 512, 556, 580, 620, 736].map((w) => (
                <option key={w} value={w}>{w}mm{SHIPPING_UNIT_400.includes(w) ? " (400m)" : " (500m)"}{w === 736 ? " ×2" : ""}</option>
              ))}
            </select></label>
            <label>発注長さ(m) <input inputMode="numeric" value={calcLength} onChange={(e) => setCalcLength(e.target.value)} /></label>
            <label>倍率 <select value={calcMultiplier} onChange={(e) => setCalcMultiplier(e.target.value)}>
              <option value="1">1倍</option><option value="2">2倍</option>
            </select></label>
          </div>
          <div className="calc-result">
            <table className="calc-table"><tbody>
              <tr><td>基本m単価</td><td>{fmt(Number(currentPrices[`${calcResult.band}:${calcResult.tier}`]))} 円/m</td></tr>
              <tr><td>① フィルム代</td><td><strong>{yen(calcResult.filmCost)}</strong></td></tr>
              <tr><td>配送単位 / 検討長さ</td><td>{calcResult.unit}m/回 / {fmt(calcResult.considered)}m</td></tr>
              <tr><td>② 配送回数</td><td><strong>{calcResult.trips}回</strong></td></tr>
              <tr><td>国内 / 海外配送</td><td>{yen(calcResult.domestic)} / {yen(calcResult.overseas)}</td></tr>
              <tr><td>通関料</td><td>{yen(calcResult.customs)}</td></tr>
              <tr className="total"><td>③ 総額</td><td><strong>{yen(calcResult.total)}</strong></td></tr>
              <tr className="per-m"><td>換算m単価</td><td>{fmt(calcResult.perM)} 円/m</td></tr>
            </tbody></table>
          </div>
        </section>
      ) : null}
    </main>
  );
}
