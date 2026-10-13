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
type AdminTab = "digital" | "y" | "k" | "rules" | "audit";

const GRAVURE_K_SOURCE_FIELDS = [
  "petPriceKrwPerKg", "alPriceKrwPerKg", "lldpePriceKrwPerKg", "printingPriceKrwPerM",
  "laminationPriceKrwPerMWithAl", "laminationPriceKrwPerMWithoutAl", "newCopperPlatePriceKrw",
  "copperPlateWidthExtraMm", "copperPlateMinimumDiameterMm", "krwPer100Yen",
  "deliverablePatternLengthM", "productionPatternLengthM", "overseasShippingUnitM",
  "overseasShippingPerTripYen", "manufacturerMarginRate", "customsRate", "smallWidthThresholdMm",
  "smallWidthOrderPatternLengthM", "smallWidthProductionPatternLengthM",
  "smallWidthManufacturerUnitPriceKrwPerM",
] as const;
type GravureKSourceField = typeof GRAVURE_K_SOURCE_FIELDS[number];
type GravureKSource = Record<GravureKSourceField, string>;

interface GravureYMasterRow {
  id: number; webWidthMm: number; laneCount: number; printTierM: number; approxOutputLengthM: string;
  supplierUnitPriceYenPerM: string; plateBaseYenPerColor: string; sellerMarkup: string; memo: string;
  effectiveFrom: string; effectiveTo: string; updatedBy: string; updatedAt: string;
  supersededById: number | null; supersededAt: string | null;
}
interface GravureKMasterRow {
  id: number; source: GravureKSource; derived: Record<string, string>; memo: string;
  effectiveFrom: string; effectiveTo: string; updatedBy: string; updatedAt: string;
  supersededById: number | null; supersededAt: string | null;
}
interface GravureMasterAuditEntry {
  id: number; tableName: string; rowId: number; action: string; actor: string;
  before: unknown; after: unknown; createdAt: string;
}
interface GravureSnapshotAuditRecord {
  id: string; asOf: string; yRows: GravureYMasterRow[]; kSource: GravureKSource;
  createdBy: string; snapshotSha256: string; createdAt: string;
}

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
const LOAD_FAILURE_MESSAGE = "単価マスタを読み込めませんでした。ネットワークを確認して、もう一度お試しください。";
const SAVE_FAILURE_MESSAGE = "通信エラーにより保存できませんでした。もう一度お試しください。";

const Y_DIMENSIONS = [
  { webWidthMm: 356, laneCount: 1, printTierM: 2000, approxOutputLengthM: "1700", plateBaseYenPerColor: "26000" },
  { webWidthMm: 356, laneCount: 1, printTierM: 4000, approxOutputLengthM: "3500", plateBaseYenPerColor: "26000" },
  { webWidthMm: 356, laneCount: 2, printTierM: 2000, approxOutputLengthM: "3400", plateBaseYenPerColor: "32000" },
  { webWidthMm: 356, laneCount: 2, printTierM: 4000, approxOutputLengthM: "7000", plateBaseYenPerColor: "32000" },
  { webWidthMm: 476, laneCount: 1, printTierM: 2000, approxOutputLengthM: "1700", plateBaseYenPerColor: "27000" },
  { webWidthMm: 476, laneCount: 1, printTierM: 4000, approxOutputLengthM: "3500", plateBaseYenPerColor: "27000" },
  { webWidthMm: 476, laneCount: 2, printTierM: 2000, approxOutputLengthM: "3400", plateBaseYenPerColor: "33000" },
  { webWidthMm: 476, laneCount: 2, printTierM: 4000, approxOutputLengthM: "7000", plateBaseYenPerColor: "33000" },
  { webWidthMm: 556, laneCount: 1, printTierM: 2000, approxOutputLengthM: "1700", plateBaseYenPerColor: "28000" },
  { webWidthMm: 556, laneCount: 1, printTierM: 4000, approxOutputLengthM: "3500", plateBaseYenPerColor: "28000" },
  { webWidthMm: 620, laneCount: 1, printTierM: 2000, approxOutputLengthM: "1700", plateBaseYenPerColor: "32000" },
  { webWidthMm: 620, laneCount: 1, printTierM: 4000, approxOutputLengthM: "3500", plateBaseYenPerColor: "32000" },
] as const;

const K_FIELD_LABELS: Record<GravureKSourceField, string> = {
  petPriceKrwPerKg: "PET price (KRW/kg)",
  alPriceKrwPerKg: "AL price (KRW/kg)",
  lldpePriceKrwPerKg: "LLDPE price (KRW/kg)",
  printingPriceKrwPerM: "Printing (KRW/m)",
  laminationPriceKrwPerMWithAl: "Lamination with AL (KRW/m)",
  laminationPriceKrwPerMWithoutAl: "Lamination without AL (KRW/m)",
  newCopperPlatePriceKrw: "New copper plate (KRW)",
  copperPlateWidthExtraMm: "Copper plate width extra (mm)",
  copperPlateMinimumDiameterMm: "Copper plate minimum diameter (mm)",
  krwPer100Yen: "KRW per 100 JPY",
  deliverablePatternLengthM: "Deliverable pattern (m)",
  productionPatternLengthM: "Production pattern (m)",
  overseasShippingUnitM: "Overseas shipping unit (m)",
  overseasShippingPerTripYen: "Overseas shipping / trip (JPY)",
  manufacturerMarginRate: "Manufacturer margin rate",
  customsRate: "Customs rate",
  smallWidthThresholdMm: "Small-width threshold (mm)",
  smallWidthOrderPatternLengthM: "Small-width order pattern (m)",
  smallWidthProductionPatternLengthM: "Small-width production pattern (m)",
  smallWidthManufacturerUnitPriceKrwPerM: "Small-width manufacturer price (KRW/m)",
};

const K_GROUPS: Array<{ title: string; fields: GravureKSourceField[] }> = [
  { title: "材料・加工 KRW source", fields: ["petPriceKrwPerKg", "alPriceKrwPerKg", "lldpePriceKrwPerKg", "printingPriceKrwPerM", "laminationPriceKrwPerMWithAl", "laminationPriceKrwPerMWithoutAl"] },
  { title: "Copper plate & pattern", fields: ["newCopperPlatePriceKrw", "copperPlateWidthExtraMm", "copperPlateMinimumDiameterMm", "krwPer100Yen", "deliverablePatternLengthM", "productionPatternLengthM"] },
  { title: "Logistics & rates", fields: ["overseasShippingUnitM", "overseasShippingPerTripYen", "manufacturerMarginRate", "customsRate"] },
  { title: "Small-width rules", fields: ["smallWidthThresholdMm", "smallWidthOrderPatternLengthM", "smallWidthProductionPatternLengthM", "smallWidthManufacturerUnitPriceKrwPerM"] },
];

const todayStr = () => new Date().toISOString().slice(0, 10);
const todayJst = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
const isTodayIn = (from: string, to: string, today = todayStr()) => today >= from.slice(0, 10) && today <= to.slice(0, 10);
const nextJstDay = (date: string) => {
  const parsed = new Date(`${date}T00:00:00+09:00`);
  parsed.setDate(parsed.getDate() + 1);
  return parsed.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
};
const activePrice = (prices: FilmPrice[], band: Band, tier: Tier, fallback: number): string => {
  const t = todayStr();
  const found = prices.find((p) => p.band === band && p.tier === tier && p.effectiveFrom.slice(0, 10) <= t && p.effectiveTo.slice(0, 10) >= t);
  return found ? found.unitPriceYenPerM : String(fallback);
};
const shippingUnit = (width: number): 400 | 500 => (SHIPPING_UNIT_400.includes(width) ? 400 : 500);
const jstDateTime = (value: string) => new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const activeMaster = <T extends { effectiveFrom: string; effectiveTo: string; supersededById: number | null }>(rows: T[]): T | null =>
  rows.find((row) => !row.supersededById && isTodayIn(row.effectiveFrom, row.effectiveTo, todayJst())) ?? null;

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
const statusText = async (response: Response, fallback: string) => {
  try {
    const payload = await response.json();
    if (response.status === 409) return "期間が重複しているため保存できません。";
    if (response.status === 503 || payload.error === "durable_database_required") return "本番書き込みには永続DBが必要です。";
    if (payload.error === "forbidden" || response.status === 403) return "Kanai管理者権限が必要です。";
    return payload.error ? `${fallback} (${payload.error})` : fallback;
  } catch {
    return fallback;
  }
};

type YFormState = {
  supersedeId: number | null;
  webWidthMm: number;
  laneCount: number;
  printTierM: number;
  approxOutputLengthM: string;
  supplierUnitPriceYenPerM: string;
  plateBaseYenPerColor: string;
  sellerMarkup: string;
  effectiveFrom: string;
  effectiveTo: string;
  memo: string;
};

const yDefaultValue = Y_DIMENSIONS[0];
const defaultYForm = (): YFormState => ({
  supersedeId: null,
  ...yDefaultValue,
  supplierUnitPriceYenPerM: "120",
  sellerMarkup: "1.12",
  effectiveFrom: todayJst(),
  effectiveTo: "",
  memo: "",
});
const yFormFromRow = (row: GravureYMasterRow): YFormState => ({
  supersedeId: row.id,
  webWidthMm: row.webWidthMm,
  laneCount: row.laneCount,
  printTierM: row.printTierM,
  approxOutputLengthM: row.approxOutputLengthM,
  supplierUnitPriceYenPerM: row.supplierUnitPriceYenPerM,
  plateBaseYenPerColor: row.plateBaseYenPerColor,
  sellerMarkup: row.sellerMarkup,
  effectiveFrom: nextJstDay(row.effectiveFrom),
  effectiveTo: row.effectiveTo === "9999-12-31" ? "" : row.effectiveTo,
  memo: row.memo,
});
type KFormState = {
  supersedeId: number | null;
  source: GravureKSource;
  effectiveFrom: string;
  effectiveTo: string;
  memo: string;
};
const defaultKForm = (): KFormState => ({
  supersedeId: null,
  source: {
    petPriceKrwPerKg: "4300", alPriceKrwPerKg: "10500", lldpePriceKrwPerKg: "4500",
    printingPriceKrwPerM: "19", laminationPriceKrwPerMWithAl: "80", laminationPriceKrwPerMWithoutAl: "65",
    newCopperPlatePriceKrw: "50", copperPlateWidthExtraMm: "100", copperPlateMinimumDiameterMm: "420",
    krwPer100Yen: "850", deliverablePatternLengthM: "5500", productionPatternLengthM: "6000",
    overseasShippingUnitM: "500", overseasShippingPerTripYen: "11000", manufacturerMarginRate: "0.20",
    customsRate: "0.05", smallWidthThresholdMm: "50", smallWidthOrderPatternLengthM: "11000",
    smallWidthProductionPatternLengthM: "12000", smallWidthManufacturerUnitPriceKrwPerM: "410",
  },
  effectiveFrom: todayJst(),
  effectiveTo: "",
  memo: "",
});
const kFormFromRow = (row: GravureKMasterRow): KFormState => ({
  supersedeId: row.id,
  source: { ...row.source },
  effectiveFrom: nextJstDay(row.effectiveFrom),
  effectiveTo: row.effectiveTo === "9999-12-31" ? "" : row.effectiveTo,
  memo: row.memo,
});

export default function FilmPricesClient() {
  const [prices, setPrices] = useState<FilmPrice[]>([]);
  const [yPrices, setYPrices] = useState<GravureYMasterRow[]>([]);
  const [kSets, setKSets] = useState<GravureKMasterRow[]>([]);
  const [audit, setAudit] = useState<GravureMasterAuditEntry[]>([]);
  const [snapshots, setSnapshots] = useState<GravureSnapshotAuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [tab, setTab] = useState<AdminTab>("digital");
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [effectiveFrom, setEffectiveFrom] = useState(todayStr());
  const [memo, setMemo] = useState("");
  const [yForm, setYForm] = useState<YFormState>(defaultYForm);
  const [kForm, setKForm] = useState<KFormState>(defaultKForm);
  const [masterAvailability, setMasterAvailability] = useState({ y: true, k: true, audit: true });
  const [calcWidth, setCalcWidth] = useState("476");
  const [calcLength, setCalcLength] = useState("1000");
  const [calcMultiplier, setCalcMultiplier] = useState("1");

  const showMessage = (text: string, isError = false) => {
    setMessage(text);
    setMessageIsError(isError);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [digitalResponse, yResponse, kResponse, auditResponse] = await Promise.all([
        fetch("/api/film-prices"),
        fetch("/api/film-prices/gravure/y"),
        fetch("/api/film-prices/gravure/k"),
        fetch("/api/film-prices/gravure/audit"),
      ]);
      if (digitalResponse.ok) setPrices((await digitalResponse.json()).prices ?? []);
      const yAvailable = yResponse.ok;
      if (yAvailable) setYPrices((await yResponse.json()).prices ?? []);
      const kAvailable = kResponse.ok;
      if (kAvailable) setKSets((await kResponse.json()).parameterSets ?? []);
      const auditAvailable = auditResponse.ok;
      if (auditAvailable) {
        const payload = await auditResponse.json();
        setAudit(payload.audit ?? []);
        setSnapshots(payload.snapshots ?? []);
      }
      setMasterAvailability({ y: yAvailable, k: kAvailable, audit: auditAvailable });
    } catch {
      setMasterAvailability({ y: false, k: false, audit: false });
      showMessage(LOAD_FAILURE_MESSAGE, true);
    } finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR後にAPIからデータ取得する意図的な処理です。
  useEffect(() => { void load(); }, [load]);

  const currentPrices = useMemo(() => {
    const map: Record<string, string> = {};
    for (const band of BANDS) for (const tier of TIERS) map[`${band}:${tier}`] = activePrice(prices, band, tier, DEFAULTS[band][tier]);
    return map;
  }, [prices]);

  const hasChanges = useMemo(() => BANDS.some((band) => TIERS.some((tier) => {
    const key = `${band}:${tier}`;
    const edited = editValues[key];
    return edited !== undefined && edited !== currentPrices[key];
  })), [editValues, currentPrices]);

  const saveDigital = async () => {
    const changes = BANDS.flatMap((band) =>
      TIERS.filter((tier) => {
        const key = `${band}:${tier}`;
        const edited = editValues[key];
        return edited !== undefined && edited !== currentPrices[key];
      }).map((tier) => ({ band, tier, unitPriceYenPerM: editValues[`${band}:${tier}`], effectiveFrom, memo })),
    );
    if (changes.length === 0) { showMessage("変更がありません。"); return; }
    setSaving(true); showMessage("");
    try {
      for (const change of changes) {
        const response = await fetch("/api/film-prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
        if (!response.ok) { showMessage(await statusText(response, "保存に失敗しました。"), true); return; }
      }
      showMessage(`${changes.length}件の単価を更新しました（UTC適用開始：${effectiveFrom}）。`);
      setEditValues({});
      await load();
    } catch {
      showMessage(SAVE_FAILURE_MESSAGE, true);
    } finally { setSaving(false); }
  };

  const submitY = async () => {
    setSaving(true); showMessage("");
    const body = { ...yForm, supersedeId: undefined };
    const endpoint = yForm.supersedeId ? `/api/film-prices/gravure/y/${yForm.supersedeId}/supersede` : "/api/film-prices/gravure/y";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { showMessage(await statusText(response, "Y単価を保存できませんでした。"), true); return; }
      showMessage(yForm.supersedeId ? "Y行を監査付きで差し替えました。" : "Y行を追加しました。");
      setYForm(defaultYForm());
      await load();
    } catch {
      showMessage(SAVE_FAILURE_MESSAGE, true);
    } finally { setSaving(false); }
  };

  const submitK = async () => {
    setSaving(true); showMessage("");
    const body = { ...kForm, supersedeId: undefined };
    const endpoint = kForm.supersedeId ? `/api/film-prices/gravure/k/${kForm.supersedeId}/supersede` : "/api/film-prices/gravure/k";
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) { showMessage(await statusText(response, "Kパラメータを保存できませんでした。"), true); return; }
      showMessage(kForm.supersedeId ? "Kセットを監査付きで差し替えました。" : "Kセットを追加しました。");
      setKForm(defaultKForm());
      await load();
    } catch {
      showMessage(SAVE_FAILURE_MESSAGE, true);
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
  const activeY = useMemo(() => activeMaster(yPrices), [yPrices]);
  const activeK = useMemo(() => activeMaster(kSets), [kSets]);

  return (
    <main className="film-price-admin">
      <header className="film-price-header">
        <div>
          <h1>フィルム単価マスター</h1>
          <p className="subtitle">Digital is legacy UTC. Gravure Y/K and snapshots use Asia/Tokyo.</p>
        </div>
        <nav className="tab-bar" role="tablist" aria-label="Film price master">
          <button role="tab" aria-selected={tab === "digital"} className={tab === "digital" ? "active" : ""} onClick={() => setTab("digital")}>Digital</button>
          <button role="tab" aria-selected={tab === "y"} className={tab === "y" ? "active" : ""} onClick={() => setTab("y")}>Gravure Y</button>
          <button role="tab" aria-selected={tab === "k"} className={tab === "k" ? "active" : ""} onClick={() => setTab("k")}>Gravure K</button>
          <button role="tab" aria-selected={tab === "rules"} className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>Rules</button>
          <button role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>Audit</button>
        </nav>
      </header>
      {message ? <p className={`msg ${messageIsError ? "msg-error" : "msg-ok"}`} role="status">{message}</p> : null}
      {!masterAvailability.y || !masterAvailability.k || !masterAvailability.audit ? (
        <p className="msg msg-error" role="alert" data-testid="gravure-master-unavailable">
          Y/K監査マスタAPIが利用できません。表示中の値は未取得またはfallbackです。
        </p>
      ) : null}

      {tab === "digital" ? (
        <section>
          <p className="rule-note" data-testid="digital-precedence">
            Digital labels preserve the legacy UTC effective date. Simulator-supplied explicit film unit prices override this master when present.
          </p>
          <div className="price-toolbar">
            <label>適用開始（UTC） <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></label>
            <label>メモ <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="例：11月改定" /></label>
            <button className="btn-primary" disabled={saving || !hasChanges} onClick={() => void saveDigital()}>
              {saving ? "保存中..." : hasChanges ? "変更を保存" : "変更なし"}
            </button>
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
          <details className="history" open>
            <summary>変更履歴（{prices.length}件）</summary>
            <table className="history-table">
              <thead><tr><th>帯</th><th>ティア</th><th>m単価</th><th>期間(UTC)</th><th>状態</th><th>メモ</th><th>更新者</th><th>日時</th></tr></thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.id} className={isTodayIn(p.effectiveFrom, p.effectiveTo) ? "row-active" : "row-past"}>
                    <td>{BAND_LABELS[p.band]}</td><td>{TIER_LABELS[p.tier]}</td>
                    <td><strong>{fmt(Number(p.unitPriceYenPerM))} 円/m</strong></td>
                    <td>{p.effectiveFrom.slice(0, 10)}〜{p.effectiveTo.slice(0, 10)}</td>
                    <td>{isTodayIn(p.effectiveFrom, p.effectiveTo) ? <span className="badge active">適用中</span> : <span className="badge expired">期限切れ</span>}</td>
                    <td>{p.memo || "-"}</td><td>{p.updatedBy || "-"}</td><td>{jstDateTime(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      ) : null}

      {tab === "y" ? (
        <section>
          <div className="rule-card">
            <h3>Y merge-with-fallback policy</h3>
            <p>Active rows replace only the matching width + lane + tier dimension. Other dimensions retain the exact current fallback matrix.</p>
          </div>
          <div className="rules-grid">
            <div className="rule-card">
              <h3>{yForm.supersedeId ? `Supersede Y #${yForm.supersedeId}` : "Create normalized Y row"}</h3>
              <div className="calc-inputs">
                <label>Dimension
                  <select value={`${yForm.webWidthMm}:${yForm.laneCount}:${yForm.printTierM}`} disabled={Boolean(yForm.supersedeId)}
                    onChange={(e) => {
                      const value = Y_DIMENSIONS.find((item) => `${item.webWidthMm}:${item.laneCount}:${item.printTierM}` === e.target.value)!;
                      setYForm((old) => ({ ...old, ...value }));
                    }}>
                    {Y_DIMENSIONS.map((item) => <option key={`${item.webWidthMm}:${item.laneCount}:${item.printTierM}`}>{item.webWidthMm}mm / {item.laneCount}列 / {item.printTierM}m tier</option>)}
                  </select>
                </label>
                <label>Approx output (m) <input inputMode="decimal" value={yForm.approxOutputLengthM} onChange={(e) => setYForm((old) => ({ ...old, approxOutputLengthM: e.target.value }))} /></label>
                <label>Supplier unit price (円/m) <input data-testid="y-supplier-price" inputMode="decimal" value={yForm.supplierUnitPriceYenPerM} onChange={(e) => setYForm((old) => ({ ...old, supplierUnitPriceYenPerM: e.target.value }))} /></label>
                <label>Plate base / color (円) <input inputMode="decimal" value={yForm.plateBaseYenPerColor} onChange={(e) => setYForm((old) => ({ ...old, plateBaseYenPerColor: e.target.value }))} /></label>
                <label>Seller markup <input data-testid="y-seller-markup" inputMode="decimal" value={yForm.sellerMarkup} onChange={(e) => setYForm((old) => ({ ...old, sellerMarkup: e.target.value }))} /></label>
                <label>Effective from (JST) <input type="date" value={yForm.effectiveFrom} onChange={(e) => setYForm((old) => ({ ...old, effectiveFrom: e.target.value }))} /></label>
                <label>Effective to (JST, optional) <input type="date" value={yForm.effectiveTo} onChange={(e) => setYForm((old) => ({ ...old, effectiveTo: e.target.value }))} /></label>
                <label>Memo <input value={yForm.memo} onChange={(e) => setYForm((old) => ({ ...old, memo: e.target.value }))} /></label>
              </div>
              <button className="btn-primary" disabled={saving} onClick={() => void submitY()}>{saving ? "保存中..." : yForm.supersedeId ? "差し替え保存" : "行を作成"}</button>
              {yForm.supersedeId ? <button className="btn-secondary" onClick={() => setYForm(defaultYForm())}>新規作成に戻す</button> : null}
            </div>
            <div className="rule-card">
              <h3>Active resolution</h3>
              <p>{activeY ? `#${activeY.id} / markup ${activeY.sellerMarkup}` : "No active Y row: 12-row fallback"}</p>
              <table className="history-table">
                <thead><tr><th>#</th><th>Dimension</th><th>Supplier</th><th>Markup</th><th>Period(JST)</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {yPrices.map((row) => (
                    <tr key={row.id}>
                      <td>{row.id}</td><td>{row.webWidthMm}/{row.laneCount}/{row.printTierM}</td>
                      <td>{row.supplierUnitPriceYenPerM}</td><td>{row.sellerMarkup}</td>
                      <td>{row.effectiveFrom}〜{row.effectiveTo}</td>
                      <td>{row.supersededById ? <span className="badge expired">superseded #{row.supersededById}</span> : isTodayIn(row.effectiveFrom, row.effectiveTo, todayJst()) ? <span className="badge active">active</span> : <span className="badge expired">inactive</span>}</td>
                      <td><button onClick={() => { setYForm(yFormFromRow(row)); showMessage(`Y行 #${row.id} を差し替えフォームに複製しました。`); }}>Supersede</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {tab === "k" ? (
        <section>
          <div className="rules-grid">
            <div className="rule-card">
              <h3>{kForm.supersedeId ? `Supersede K #${kForm.supersedeId}` : "Create normalized K source set"}</h3>
              <div className="calc-inputs">
                {K_GROUPS.flatMap((group) => group.fields.map((field) => (
                  <label key={field}>{K_FIELD_LABELS[field]}
                    <input inputMode="decimal" value={kForm.source[field]} onChange={(e) => setKForm((old) => ({ ...old, source: { ...old.source, [field]: e.target.value } }))} />
                  </label>
                )))}
                <label>Effective from (JST) <input type="date" value={kForm.effectiveFrom} onChange={(e) => setKForm((old) => ({ ...old, effectiveFrom: e.target.value }))} /></label>
                <label>Effective to (JST, optional) <input type="date" value={kForm.effectiveTo} onChange={(e) => setKForm((old) => ({ ...old, effectiveTo: e.target.value }))} /></label>
                <label>Memo <input value={kForm.memo} onChange={(e) => setKForm((old) => ({ ...old, memo: e.target.value }))} /></label>
              </div>
              <button className="btn-primary" disabled={saving} onClick={() => void submitK()}>{saving ? "保存中..." : kForm.supersedeId ? "差し替え保存" : "セットを作成"}</button>
              {kForm.supersedeId ? <button onClick={() => setKForm(defaultKForm())}>新規作成に戻す</button> : null}
            </div>
            <div className="rule-card">
              <h3>Active K derived state</h3>
              <p data-testid="active-k-state">{activeK ? `#${activeK.id} マスター適用中` : "No active K set: current defaults"}</p>
              {activeK ? <pre>{JSON.stringify(activeK.derived, null, 2)}</pre> : null}
              <table className="history-table">
                <thead><tr><th>#</th><th>PET KRW</th><th>Period(JST)</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {kSets.map((row) => (
                    <tr key={row.id}>
                      <td>{row.id}</td><td>{row.source.petPriceKrwPerKg}</td>
                      <td>{row.effectiveFrom}〜{row.effectiveTo}</td>
                      <td>{row.supersededById ? <span className="badge expired">superseded #{row.supersededById}</span> : isTodayIn(row.effectiveFrom, row.effectiveTo, todayJst()) ? <span className="badge active">active</span> : <span className="badge expired">inactive</span>}</td>
                      <td><button onClick={() => { setKForm(kFormFromRow(row)); showMessage(`Kセット #${row.id} を差し替えフォームに複製しました。`); }}>Supersede</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {tab === "rules" ? (
        <section className="rules-grid">
          <div className="rule-card">
            <h3>Digital precedence</h3><p>Legacy UTC dates. Explicit simulator `filmUnitPrices` override Digital master rows.</p>
          </div>
          <div className="rule-card">
            <h3>Gravure Y policy</h3><p>Asia/Tokyo dates, append-only writes, audited supersede, atomic overlap rejection. Active rows replace only their phase-one dimension.</p>
          </div>
          <div className="rule-card">
            <h3>Gravure K policy</h3><p>One active source set overrides simulator K inputs. KRW source values and derived JPY values are snapshotted together.</p>
          </div>
          <div className="rule-card">
            <h3>配送単位（原反幅で決定）</h3>
            <table><tbody><tr><td>356・368・396・464・476・512・736mm</td><td>500m/回</td></tr><tr><td>556・580・620mm</td><td>400m/回</td></tr></tbody></table>
          </div>
          <div className="rule-card">
            <h3>配送費・通関料</h3>
            <table><tbody><tr><td>国内</td><td>{yen(DOMESTIC_PER_TRIP)} /回</td></tr><tr><td>海外</td><td>{yen(OVERSEAS_PER_TRIP)} /回</td></tr><tr><td>高額通関</td><td>{yen(CUSTOMS_HIGH)}</td></tr></tbody></table>
          </div>
        </section>
      ) : null}

      {tab === "audit" ? (
        <section className="rules-grid">
          <div className="rule-card">
            <h3>Master supersede history</h3>
            <table className="history-table">
              <thead><tr><th>#</th><th>Table</th><th>Row</th><th>Action</th><th>Actor</th><th>JST</th><th>After</th></tr></thead>
              <tbody>{audit.map((entry) => <tr key={entry.id}><td>{entry.id}</td><td>{entry.tableName}</td><td>{entry.rowId}</td><td>{entry.action}</td><td>{entry.actor}</td><td>{jstDateTime(entry.createdAt)}</td><td><code>{JSON.stringify(entry.after)}</code></td></tr>)}</tbody>
            </table>
          </div>
          <div className="rule-card">
            <h3>Source rows & snapshots</h3>
            <table className="history-table">
              <thead><tr><th>Snapshot</th><th>asOf(JST)</th><th>Y rows</th><th>K source</th><th>Hash</th><th>Creator</th><th>Created</th></tr></thead>
              <tbody>{snapshots.map((snapshot) => <tr key={snapshot.id}><td><code>{snapshot.id}</code></td><td>{snapshot.asOf}</td><td>{snapshot.yRows.map((row) => `#${row.id}:${row.webWidthMm}/${row.laneCount}/${row.printTierM}`).join(", ") || "fallback"}</td><td><code>{JSON.stringify(snapshot.kSource)}</code></td><td><code>{snapshot.snapshotSha256.slice(0, 16)}…</code></td><td>{snapshot.createdBy}</td><td>{jstDateTime(snapshot.createdAt)}</td></tr>)}</tbody>
            </table>
            {loading ? <p>読み込み中...</p> : null}
          </div>
        </section>
      ) : null}

      {tab === "digital" || tab === "rules" ? (
        <section className="calc-section">
          <h2>シミュレータ</h2>
          <div className="calc-inputs">
            <label>原反幅 <select value={calcWidth} onChange={(e) => setCalcWidth(e.target.value)}>{[356, 368, 396, 464, 476, 512, 556, 580, 620, 736].map((w) => <option key={w} value={w}>{w}mm</option>)}</select></label>
            <label>発注長さ(m) <input inputMode="numeric" value={calcLength} onChange={(e) => setCalcLength(e.target.value)} /></label>
            <label>倍率 <select value={calcMultiplier} onChange={(e) => setCalcMultiplier(e.target.value)}><option value="1">1倍</option><option value="2">2倍</option></select></label>
          </div>
          <div className="calc-result">
            <table className="calc-table"><tbody>
              <tr><td>基本m単価</td><td>{fmt(Number(currentPrices[`${calcResult.band}:${calcResult.tier}`]))} 円/m</td></tr>
              <tr><td>① フィルム代</td><td><strong>{yen(calcResult.filmCost)}</strong></td></tr>
              <tr><td>② 配送回数</td><td>{calcResult.trips}回</td></tr>
              <tr className="total"><td>③ 総額</td><td><strong>{yen(calcResult.total)}</strong></td></tr>
            </tbody></table>
          </div>
        </section>
      ) : null}
    </main>
  );
}
