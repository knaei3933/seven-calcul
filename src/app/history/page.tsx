"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import { QUOTATION_RESTORE_KEY, quotationStatuses, type QuotationRecord, type QuotationStatus } from "@/lib/quotation-shared";

const statusLabels: Record<QuotationStatus, string> = {
  draft: "下書き",
  sent: "送付済み",
  approved: "承認",
  rejected: "見送り",
  expired: "期限切れ",
};

export default function QuotationHistoryPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [records, setRecords] = useState<QuotationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestOrder = useRef(0);

  const load = useCallback(async (search: string, statusFilter: string) => {
    const order = ++requestOrder.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: search, status: statusFilter, limit: "200" });
      const response = await fetch(`/api/quotations?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      if (order === requestOrder.current) setRecords(payload.records as QuotationRecord[]);
    } catch {
      if (order === requestOrder.current) {
        setRecords([]);
        setError("履歴を読み込めませんでした。DB接続を確認してください。");
      }
    } finally {
      if (order === requestOrder.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query, status), 180);
    return () => clearTimeout(timer);
  }, [load, query, status]);

  const restore = (record: QuotationRecord) => {
    sessionStorage.setItem(QUOTATION_RESTORE_KEY, JSON.stringify(record.payload));
    router.push("/quote");
  };

  const changeStatus = async (record: QuotationRecord, nextStatus: QuotationStatus) => {
    const response = await fetch(`/api/quotations/${record.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (response.ok) {
      const payload = await response.json();
      setRecords((old) => old.map((item) => (item.id === record.id ? payload.record as QuotationRecord : item)));
    }
  };

  const remove = async (record: QuotationRecord) => {
    if (!window.confirm(`${record.quotationNumber} を削除しますか？`)) return;
    const response = await fetch(`/api/quotations/${record.id}`, { method: "DELETE" });
    if (response.ok) setRecords((old) => old.filter((item) => item.id !== record.id));
  };

  return (
    <main className="history-page">
      <nav className="top-menu page-menu" aria-label="メインメニュー">
        <div className="menu-brand">
          <span className="logo-mark" aria-hidden="true">7</span>
          <span>セブン化学 <small>Quotation Suite</small></span>
        </div>
        <div className="menu-links">
          <Link href="/">原価シミュレーター</Link>
          <Link href="/quote">見積書発行</Link>
          <Link href="/history" aria-current="page">見積履歴</Link>
        </div>
      </nav>

      <section className="panel history-toolbar" aria-labelledby="history-title">
        <div>
          <h1 id="history-title">見積履歴（SQLite）</h1>
          <p>保存済み見積書を検索し、状態管理・復元・削除ができます。</p>
        </div>
        <div className="history-controls">
          <label>検索
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="見積番号 / 得意先 / 品名"
              data-testid="history-search"
            />
          </label>
          <label>状態
            <select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="history-status">
              <option value="all">すべて</option>
              {quotationStatuses.map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="panel" aria-labelledby="history-list-title">
        <div className="history-meta">
          <h2 id="history-list-title">保存済み見積書</h2>
          <span>{loading ? "読み込み中..." : `${formatNumber(records.length, 0)} 件`}</span>
        </div>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {!loading && records.length === 0 && !error ? (
          <p className="empty">保存された見積書はありません。見積書画面から保存またはPDF出力してください。</p>
        ) : null}
        <div className="history-table-wrap">
          <table className="table history-table" data-testid="history-table">
            <thead>
              <tr>
                <th>見積番号</th><th>発行日</th><th>得意先</th><th>品名 / 仕様</th><th>数量</th><th>単価</th><th>税込合計</th><th>状態</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{record.quotationNumber}</strong>
                    <small>{record.resultHash ? `ID ${record.resultHash.slice(0, 8)}` : "手入力"}</small>
                  </td>
                  <td>{record.issueDate}</td>
                  <td>{record.customerName || "-"}</td>
                  <td>{record.productName}<small>{record.sizeSummary}</small></td>
                  <td>{formatNumber(record.quantity, 0)} 枚</td>
                  <td>{formatCurrency(record.pricePerPiece, 0)}</td>
                  <td>{formatCurrency(record.grandTotal, 0)}</td>
                  <td>
                    <select
                      aria-label={`${record.quotationNumber} の状態`}
                      value={record.status}
                      onChange={(event) => void changeStatus(record, event.target.value as QuotationStatus)}
                    >
                      {quotationStatuses.map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}
                    </select>
                  </td>
                  <td className="history-actions">
                    <button className="button secondary small" type="button" onClick={() => restore(record)}>復元</button>
                    <button className="button danger small" type="button" onClick={() => void remove(record)}>削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
