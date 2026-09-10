"use client";

import { useMemo, useState } from "react";
import type { ChecklistAudience, ChecklistItem, ChecklistRecord } from "@/lib/calculation-checklist";

type Props = {
  quotationId: number;
  quotationNumber: string;
  customerName: string;
  records: ChecklistRecord[];
  isLegacy?: boolean;
};

const audienceLabels: Record<ChecklistAudience, string> = {
  CUSTOMER: "顧客確認用",
  INTERNAL_QA: "社内QA確認用",
};

export function CalculationChecklistClient({
  quotationId,
  quotationNumber,
  customerName,
  records: initialRecords,
  isLegacy = false,
}: Props) {
  const [records, setRecords] = useState<ChecklistRecord[]>(initialRecords);
  const [activeAudience, setActiveAudience] = useState<ChecklistAudience>(initialRecords[0]?.audience ?? "CUSTOMER");
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const [checkedBy, setCheckedBy] = useState("");
  const [error, setError] = useState("");

  const activeRecord = records.find((record) => record.audience === activeAudience) ?? null;
  const grouped = useMemo(() => {
    const groups = new Map<string, ChecklistItem[]>();
    for (const item of activeRecord?.items ?? []) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }
    return Array.from(groups.entries());
  }, [activeRecord]);

  async function toggleItem(itemId: string, nextAccepted: boolean) {
    if (!activeRecord || updatingItemId) return;
    setUpdatingItemId(itemId);
    setError("");
    try {
      const response = await fetch(`/api/quotations/${quotationId}/checklists`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience: activeAudience,
          itemId,
          accepted: nextAccepted,
          checkedBy: checkedBy.trim() || (activeAudience === "CUSTOMER" ? customerName || "顧客" : "金井貿易株式会社 社内QA"),
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.checklist) throw new Error();
      const updated = payload.checklist as ChecklistRecord;
      setRecords((old) => old.map((record) => record.audience === updated.audience ? updated : record));
    } catch {
      setError("確認状態を保存できませんでした。");
    } finally {
      setUpdatingItemId(null);
    }
  }

  return (
    <div className="current-checklist-body">
      <section className="panel current-console">
        <div className="current-console-head">
          <div>
            <p className="current-eyebrow">SAVED CALCULATION CHECK</p>
            <h1>計算確認チェックリスト</h1>
            <p>
              {quotationNumber} ／ {customerName || "-"} ／ 分野順に計算根拠と確認状態を記録します。
            </p>
          </div>
          <div className="current-progress" aria-live="polite">
            <small>確認進捗</small>
            <strong>
              {activeRecord?.acceptedCount ?? 0}
              <span> / {activeRecord?.totalCount ?? 0}</span>
            </strong>
            <em>{activeRecord?.progressPercent ?? 0}%</em>
          </div>
        </div>

        <div className="current-progress-bar" aria-hidden="true">
          <div style={{ width: `${activeRecord?.progressPercent ?? 0}%` }} />
        </div>

        <div className="current-controls">
          <div className="checklist-tabs" role="tablist">
            {records.map((record) => (
              <button
                key={record.audience}
                type="button"
                role="tab"
                aria-selected={record.audience === activeAudience}
                className={record.audience === activeAudience ? "button" : "button secondary"}
                onClick={() => setActiveAudience(record.audience)}
              >
                {audienceLabels[record.audience]}
              </button>
            ))}
          </div>
          <label className="current-reviewer">
            確認者
            <input
              value={checkedBy}
              onChange={(event) => setCheckedBy(event.target.value)}
              placeholder={activeAudience === "CUSTOMER" ? customerName || "顧客" : "金井貿易株式会社 社内QA"}
            />
          </label>
        </div>

        <nav className="current-nav" aria-label="確認分野">
          {grouped.map(([category, items], index) => {
            const accepted = items.filter((item) => item.accepted).length;
            return (
              <a key={category} href={`#saved-check-group-${index}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{category}</strong>
                <small>{accepted}/{items.length}</small>
              </a>
            );
          })}
        </nav>
      </section>

      {error ? <p className="error" role="alert">{error}</p> : null}

      {grouped.map(([category, items], groupIndex) => {
        const acceptedCountByGroup = items.filter((item) => item.accepted).length;
        const complete = acceptedCountByGroup === items.length;
        return (
          <section
            key={category}
            id={`saved-check-group-${groupIndex}`}
            className={complete ? "current-group complete" : "current-group"}
          >
            <header className="current-group-head">
              <span className="current-group-no">{String(groupIndex + 1).padStart(2, "0")}</span>
              <div>
                <h2>{category}</h2>
                <p>{items.length}項目を確認します。</p>
              </div>
              <span className="current-group-state">
                {complete ? "確認済" : `${acceptedCountByGroup}/${items.length}`}
              </span>
            </header>

            <div className="current-items">
              {items.map((item) => (
                <article key={item.id} className={item.accepted ? "current-item accepted" : "current-item"}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.accepted}
                      disabled={updatingItemId === item.id}
                      onChange={(event) => void toggleItem(item.id, event.target.checked)}
                    />
                    <span className="current-checkbox" aria-hidden="true" />
                    <div className="current-item-main">
                      <div className="current-item-title">
                        <strong>{item.variable}</strong>
                        <small>{item.accepted ? "確認済み" : "未確認"}</small>
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

                      {item.accepted ? (
                        <small className="current-status accepted">
                          確認済み：{item.checkedBy || "-"} ／ {item.checkedAt ? new Date(item.checkedAt).toLocaleString("ja-JP") : "-"}
                        </small>
                      ) : (
                        <small className="current-status">チェックして確認を記録してください。</small>
                      )}
                    </div>
                  </label>
                </article>
              ))}
            </div>
          </section>
        );
      })}

      {isLegacy ? (
        <p className="warning">この見積りはチェックリスト機能導入前に保存されています。保存済み情報から計算根拠を再構築しています。</p>
      ) : null}
    </div>
  );
}
