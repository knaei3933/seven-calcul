"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { buildCalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import { defaultParameters, sizeMaster } from "@/lib/constants";
import { deriveCustomSizeMaster } from "@/lib/size-calculations";
import type { SizeKey } from "@/lib/types";
import {
  CHECKLIST_VERSION,
  CURRENT_CHECKLIST_SNAPSHOT_KEY,
  buildChecklistItems,
  readCalculationChecklistSnapshot,
  type CalculationChecklistSnapshot,
  type ChecklistAudience,
  type ChecklistItem,
} from "@/lib/calculation-checklist";

const SNAPSHOT_KEY = CURRENT_CHECKLIST_SNAPSHOT_KEY;
const CONFIRMATIONS_KEY = "pouch-current-checklist-confirmations-v1";
const LOCAL_SNAPSHOT_KEY = "pouch-current-checklist-snapshot-persistent-v1";
const LOCAL_CONFIRMATIONS_KEY = "pouch-current-checklist-confirmations-persistent-v1";
const SIMULATOR_SESSION_KEY = "pouch-simulator-state-v1";
const SIMULATOR_LOCAL_KEY = "pouch-simulator-state-persistent-v1";

type ConfirmationState = {
  accepted: boolean;
  checkedAt: string | null;
  checkedBy: string | null;
};

type PreliminaryConfirmations = Partial<Record<ChecklistAudience, Record<string, ConfirmationState>>>;

const audienceLabels: Record<ChecklistAudience, string> = {
  CUSTOMER: "顧客確認用",
  INTERNAL_QA: "社内QA確認用",
};

export default function CurrentChecklistPage() {
  const [snapshot, setSnapshot] = useState<CalculationChecklistSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [activeAudience, setActiveAudience] = useState<ChecklistAudience>("CUSTOMER");
  const [confirmations, setConfirmations] = useState<PreliminaryConfirmations>({
    CUSTOMER: {},
    INTERNAL_QA: {},
  });
  const [reviewerName, setReviewerName] = useState("");
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);

  function readFirstRawValue(keys: string[]): string | null {
    for (const key of keys) {
      const value = sessionStorage.getItem(key) ?? localStorage.getItem(key);
      if (value) return value;
    }
    return null;
  }

  function writeRawValues(keys: string[], value: string) {
    for (const key of keys) {
      try {
        sessionStorage.setItem(key, value);
      } catch {
        // sessionStorage가 사용 불가능한 경우 localStorage만 유지한다.
      }
      try {
        localStorage.setItem(key, value);
      } catch {
        // private mode 등 저장 실패 시에도 화면은 유지한다.
      }
    }
  }

  function removeRawValues(keys: string[]) {
    for (const key of keys) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // 무시: 저장소 접근 불가능 상태에서도 삭제 시도를 계속한다.
      }
      try {
        localStorage.removeItem(key);
      } catch {
        // 무시: 저장소 접근 불가능 상태에서도 삭제 시도를 계속한다.
      }
    }
  }

  function buildSnapshotFromSimulatorFallback(raw: string | null) {
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw) as {
        form?: {
          sizeKey?: SizeKey;
          custom?: boolean;
          widthMm?: string;
          lengthMm?: string;
          bulkPrice?: string;
          skus?: { name?: string; quantity?: string; fillMl?: string; colorCount?: string }[];
        };
        parameters?: typeof defaultParameters;
        gravureParameters?: Parameters<typeof buildCalculationChecklistSnapshot>[1]["gravureParameters"];
        serverResult?: { result?: Parameters<typeof buildCalculationChecklistSnapshot>[0] };
      };
      const result = saved.serverResult?.result;
      const form = saved.form;
      if (!result || !form?.widthMm || !form.lengthMm) return null;

      const standardSize = sizeMaster[form.sizeKey ?? "round-50x60"];
      const dimensionsValid = Number(form.widthMm) > 0 && Number(form.lengthMm) > 0;
      const effectiveSize = form.custom && dimensionsValid
        ? deriveCustomSizeMaster(standardSize, form.widthMm, form.lengthMm)
        : standardSize;
      const skus = form.skus?.length
        ? form.skus.map((sku, index) => ({
          name: sku.name?.trim() || `充填物${index + 1}`,
          quantity: sku.quantity ?? "0",
          fillMl: sku.fillMl ?? "0",
          colorCount: sku.colorCount ?? "0",
        }))
        : [];

      return buildCalculationChecklistSnapshot(result, {
        quotationNumber: "保存前",
        printingMethod: result.gravure ? "gravure" : "digital",
        sourceHash: result.audit.resultJsonSha256,
        resultHash: result.audit.resultJsonSha256,
        widthMm: form.widthMm,
        lengthMm: form.lengthMm,
        parameters: { ...defaultParameters, ...(saved.parameters ?? {}) },
        filmComposition: "PET12+AL7+PET12+LLDPE50",
        webWidthMm: effectiveSize.webWidthMm,
        lanes: effectiveSize.lanes,
        pitchMm: String(Number(effectiveSize.lengthMm) + Number(effectiveSize.pitchAddMm)),
        pitchAddMm: effectiveSize.pitchAddMm,
        prodMultiplier: effectiveSize.prodMultiplier,
        colorCount: Math.max(0, ...skus.map((sku) => Number(sku.colorCount) || 0)),
        skus,
        bulkUnitPrice: form.bulkPrice ?? "0",
        gravureParameters: saved.gravureParameters,
      });
    } catch {
      return null;
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const rawSnapshot = readFirstRawValue([SNAPSHOT_KEY, LOCAL_SNAPSHOT_KEY]);
        let parsedSnapshot = rawSnapshot ? readCalculationChecklistSnapshot(JSON.parse(rawSnapshot)) : null;
        if (!parsedSnapshot) {
          parsedSnapshot = buildSnapshotFromSimulatorFallback(readFirstRawValue([SIMULATOR_SESSION_KEY, SIMULATOR_LOCAL_KEY]));
          if (parsedSnapshot) {
            writeRawValues([SNAPSHOT_KEY, LOCAL_SNAPSHOT_KEY], JSON.stringify(parsedSnapshot));
            removeRawValues([CONFIRMATIONS_KEY, LOCAL_CONFIRMATIONS_KEY]);
          }
        }
        if (!parsedSnapshot || parsedSnapshot.checklistVersion !== CHECKLIST_VERSION) {
          setMissing(true);
          return;
        }
        setSnapshot(parsedSnapshot);
        const rawConfirmations = readFirstRawValue([CONFIRMATIONS_KEY, LOCAL_CONFIRMATIONS_KEY]);
        if (rawConfirmations) {
          const parsed = JSON.parse(rawConfirmations) as PreliminaryConfirmations;
          if (parsed.CUSTOMER || parsed.INTERNAL_QA) {
            setConfirmations({
              CUSTOMER: parsed.CUSTOMER ?? {},
              INTERNAL_QA: parsed.INTERNAL_QA ?? {},
            });
          }
        }
      } catch {
        setMissing(true);
      } finally {
        setLoaded(true);
      }
    });
  }, []);

  const items = useMemo(
    () => snapshot ? buildChecklistItems(snapshot) : [],
    [snapshot],
  );

  const activeItems = useMemo(
    () => items.map((item) => ({
      ...item,
      ...(confirmations[activeAudience]?.[item.id] ?? { accepted: false, checkedAt: null, checkedBy: null }),
    })),
    [confirmations, activeAudience, items],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, ChecklistItem[]>();
    for (const item of activeItems) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }
    return Array.from(groups.entries());
  }, [activeItems]);

  const acceptedCount = activeItems.filter((item) => item.accepted).length;
  const progressPercent = activeItems.length > 0
    ? Math.floor((acceptedCount / activeItems.length) * 1000) / 10
    : 0;

  function persist(next: PreliminaryConfirmations, sourceHash: string) {
    try {
      writeRawValues([CONFIRMATIONS_KEY, LOCAL_CONFIRMATIONS_KEY], JSON.stringify({ sourceHash, ...next }));
    } catch {
      // プライベートモード等で保存できない場合も画面は維持する。
    }
  }

  async function toggleItem(item: ChecklistItem, nextAccepted: boolean) {
    if (updatingItemId || !snapshot) return;
    const itemId = item.id;
    setUpdatingItemId(itemId);
    const checkedAt = nextAccepted ? new Date().toISOString() : null;
    const reviewer = nextAccepted
      ? reviewerName.trim() || (activeAudience === "CUSTOMER" ? "顧客" : "金井貿易株式会社 社内QA")
      : null;

    setConfirmations((old) => ({
      CUSTOMER: { ...(old.CUSTOMER ?? {}) },
      INTERNAL_QA: { ...(old.INTERNAL_QA ?? {}) },
      [activeAudience]: {
        ...(old[activeAudience] ?? {}),
        [itemId]: { accepted: nextAccepted, checkedAt, checkedBy: reviewer },
      },
    }));
    persist(
      {
        CUSTOMER: { ...(confirmations.CUSTOMER ?? {}) },
        INTERNAL_QA: { ...(confirmations.INTERNAL_QA ?? {}) },
        [activeAudience]: {
          ...(confirmations[activeAudience] ?? {}),
          [itemId]: { accepted: nextAccepted, checkedAt, checkedBy: reviewer },
        },
      },
      snapshot.sourceHash,
    );
    setUpdatingItemId(null);
  }

  if (!loaded) return <main className="checklist-page"><p>読み込み中...</p></main>;

  if (missing || !snapshot) {
    return (
      <main className="checklist-page">
        <section className="panel">
          <h1>計算確認チェックリスト</h1>
          <p className="empty">
            表示できる保存前計算がありません。最新の入力条件を反映するため、原価シミュレーターで「サーバーで再計算する」を実行してください。
            <br />
            <Link className="button" href="/">原価シミュレーターへ移動</Link>
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="checklist-page current-checklist">
      <section className="panel current-console">
        <div className="current-console-head">
          <div>
            <p className="current-eyebrow">SAVE前 CALCULATION CHECK</p>
            <h1>計算確認チェックリスト（保存前）</h1>
            <p>原価シミュレーターで再計算した値を分野順に確認します。確認状態はブラウザに一時保存されます。</p>
          </div>
          <div className="current-progress" aria-live="polite">
            <small>確認進捗</small>
            <strong>{acceptedCount}<span> / {activeItems.length}</span></strong>
            <em>{progressPercent}%</em>
          </div>
        </div>

        <div className="current-progress-bar" aria-hidden="true">
          <div style={{ width: `${progressPercent}%` }} />
        </div>

        <div className="current-controls">
          <div className="checklist-tabs" role="tablist">
            {(["CUSTOMER", "INTERNAL_QA"] as ChecklistAudience[]).map((audience) => (
              <button
                key={audience}
                type="button"
                role="tab"
                aria-selected={activeAudience === audience}
                className={activeAudience === audience ? "button" : "button secondary"}
                onClick={() => setActiveAudience(audience)}
              >
                {audienceLabels[audience]}
              </button>
            ))}
          </div>
          <label className="current-reviewer">
            確認者
            <input value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} placeholder={activeAudience === "CUSTOMER" ? "顧客" : "金井貿易株式会社 社内QA"} />
          </label>
        </div>

        <nav className="current-nav" aria-label="確認分野">
          {grouped.map(([category, checklistItems], index) => {
            const accepted = checklistItems.filter((item) => item.accepted).length;
            return (
              <a key={category} href={`#check-group-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{category}</strong>
                <small>{accepted}/{checklistItems.length}</small>
              </a>
            );
          })}
        </nav>
      </section>

      {grouped.map(([category, checklistItems], groupIndex) => {
        const acceptedCountByGroup = checklistItems.filter((item) => item.accepted).length;
        const complete = acceptedCountByGroup === checklistItems.length;
        return (
          <section
            key={category}
            id={`check-group-${groupIndex}`}
            className={complete ? "current-group complete" : "current-group"}
          >
            <header className="current-group-head">
              <span className="current-group-no">{String(groupIndex + 1).padStart(2, "0")}</span>
              <div>
                <h2>{category}</h2>
                <p>{checklistItems.length}項目を確認します。</p>
              </div>
              <span className="current-group-state">{complete ? "確認済" : `${acceptedCountByGroup}/${checklistItems.length}`}</span>
            </header>

            <div className="current-items">
              {checklistItems.map((item) => {
                const state = confirmations[activeAudience]?.[item.id];
                const accepted = state?.accepted ?? false;
                return (
                  <article key={item.id} className={accepted ? "current-item accepted" : "current-item"}>
                    <label>
                      <input
                        type="checkbox"
                        checked={accepted}
                        disabled={updatingItemId === item.id}
                        onChange={(event) => void toggleItem(item, event.target.checked)}
                      />
                      <span className="current-checkbox" aria-hidden="true" />
                      <div className="current-item-main">
                        <div className="current-item-title">
                          <strong>{item.variable}</strong>
                          <small>{accepted ? "確認済み" : "未確認"}</small>
                        </div>
                        <p>{item.explanation}</p>

                        <dl className="current-calc">
                          <div className="current-step">
                            <dt>入力値</dt>
                            <dd>{item.inputs || "-"}</dd>
                          </div>
                          <div className="current-step">
                            <dt>計算式</dt>
                            <dd>{item.formula}</dd>
                          </div>
                          <div className="current-step">
                            <dt>代入値</dt>
                            <dd>{item.substitution}</dd>
                          </div>
                          <div className="current-result">
                            <dt>結果</dt>
                            <dd>
                              <strong>{item.result}</strong>
                              {item.unit ? <span>{item.unit}</span> : null}
                            </dd>
                          </div>
                        </dl>

                        {accepted ? (
                          <small className="current-status accepted">
                            確認済み：{state?.checkedBy || "-"} ／ {state?.checkedAt ? new Date(state.checkedAt).toLocaleString("ja-JP") : "-"}
                          </small>
                        ) : (
                          <small className="current-status">チェックして確認を記録してください。</small>
                        )}
                      </div>
                    </label>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}
