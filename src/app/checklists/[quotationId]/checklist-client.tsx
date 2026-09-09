"use client";

import { useMemo, useState } from "react";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import type { ChecklistAudience, ChecklistItem, ChecklistRecord } from "@/lib/calculation-checklist";

type Props = {
  quotationId: number;
  quotationNumber: string;
  customerName: string;
  records: ChecklistRecord[];
};

const audienceLabels: Record<ChecklistAudience, string> = {
  CUSTOMER: "顧客確認用",
  INTERNAL_QA: "社内QA確認用",
};

export function CalculationChecklistClient({ quotationId, quotationNumber, customerName, records: initialRecords }: Props) {
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
    <div className="checklist-client">
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
            <small>{record.acceptedCount}/{record.totalCount}</small>
          </button>
        ))}
      </div>

      {activeRecord ? (
        <>
          <section className="panel checklist-progress-panel">
            <h2>確認進捗</h2>
            <p data-testid="checklist-progress">
              {activeRecord.acceptedCount} / {activeRecord.totalCount} 項目確認
              （{formatNumber(activeRecord.progressPercent, 1)}%）
            </p>
            <div className="progress">
              <div style={{ width: `${activeRecord.progressPercent}%` }} />
            </div>
            <label>
              確認者
              <input value={checkedBy} onChange={(event) => setCheckedBy(event.target.value)} placeholder={activeAudience === "CUSTOMER" ? customerName || "顧客" : "金井貿易株式会社 社内QA"} />
            </label>
            <p className="warning">チェック完了は確認記録です。見積発行・成約処理を自動的に禁止/解除するものではありません。</p>
          </section>

          {error ? <p className="error" role="alert">{error}</p> : null}

          {grouped.map(([category, items]) => (
            <section key={category} className="panel checklist-category">
              <h3>{category}</h3>
              <div className="checklist-items">
                {items.map((item) => (
                  <article key={item.id} className={item.accepted ? "checklist-item accepted" : "checklist-item"}>
                    <label>
                      <input
                        type="checkbox"
                        checked={item.accepted}
                        disabled={updatingItemId === item.id}
                        onChange={(event) => void toggleItem(item.id, event.target.checked)}
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
                        {item.accepted ? (
                          <small>確認済み：{item.checkedBy || "-"} / {item.checkedAt ? new Date(item.checkedAt).toLocaleString("ja-JP") : "-"}</small>
                        ) : <small className="unchecked">未確認</small>}
                      </div>
                    </label>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </>
      ) : (
        <p className="error">チェックリストが見つかりません。</p>
      )}
    </div>
  );
}
