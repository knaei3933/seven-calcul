"use client";

import { useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const rawSnapshot = sessionStorage.getItem(SNAPSHOT_KEY);
        if (!rawSnapshot) {
          setMissing(true);
          return;
        }
        const parsedSnapshot = readCalculationChecklistSnapshot(JSON.parse(rawSnapshot));
        if (!parsedSnapshot || parsedSnapshot.checklistVersion !== CHECKLIST_VERSION) {
          setMissing(true);
          return;
        }
        setSnapshot(parsedSnapshot);
        const rawConfirmations = sessionStorage.getItem(CONFIRMATIONS_KEY);
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
      sessionStorage.setItem(CONFIRMATIONS_KEY, JSON.stringify({ sourceHash, ...next }));
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
      ? reviewerName.trim() || (activeAudience === "CUSTOMER" ? "顧客" : "カネイ貿易 社内QA")
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
          <p className="empty">現在の計算結果がありません。原価シミュレーターでサーバー再計算を実行してから開いてください。</p>
        </section>
      </main>
    );
  }

  return (
    <main className="checklist-page">
      <section className="panel checklist-header">
        <h1>計算確認チェックリスト（保存前）</h1>
        <p>原価シミュレーターで再計算した入力条件・計算式・結果を確認できます。確認状態はブラウザに一時保存されます。</p>
        {snapshot.checklistVersion !== CHECKLIST_VERSION ? (
          <p className="warning">保存済みの一時データが旧形式です。最新の入力値を反映するため、原価シミュレーターで「サーバーで再計算する」を実行してください。</p>
        ) : null}
      </section>

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

      <section className="panel checklist-progress-panel">
        <h2>確認進捗</h2>
        <p>{acceptedCount} / {activeItems.length} 項目確認（{progressPercent}%）</p>
        <div className="progress"><div style={{ width: `${progressPercent}%` }} /></div>
        <label>
          確認者
          <input value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} placeholder={activeAudience === "CUSTOMER" ? "顧客" : "カネイ貿易 社内QA"} />
        </label>
      </section>

      {grouped.map(([category, checklistItems]) => (
        <section key={category} className="panel checklist-category">
          <h3>{category}</h3>
          <div className="checklist-items">
            {checklistItems.map((item) => {
              const state = confirmations[activeAudience]?.[item.id];
              const accepted = state?.accepted ?? false;
              return (
                <article key={item.id} className={accepted ? "checklist-item accepted" : "checklist-item"}>
                  <label>
                    <input
                      type="checkbox"
                      checked={accepted}
                      disabled={updatingItemId === item.id}
                      onChange={(event) => void toggleItem(item, event.target.checked)}
                    />
                    <div>
                        <strong>{item.variable}</strong>
                        <p>{item.explanation}</p>
                        <dl>
                          <div><dt>入力値</dt><dd>{item.inputs || "-"}</dd></div>
                          <div><dt>計算式</dt><dd>{item.formula}</dd></div>
                        <div><dt>代入値</dt><dd>{item.substitution}</dd></div>
                        <div><dt>結果</dt><dd>{item.unit ? `${item.result} ${item.unit}` : item.result}</dd></div>
                      </dl>
                      {accepted ? (
                        <small>確認済み：{state?.checkedBy || "-"} / {state?.checkedAt ? new Date(state.checkedAt).toLocaleString("ja-JP") : "-"}</small>
                      ) : <small className="unchecked">未確認</small>}
                    </div>
                  </label>
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
