"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import { sizeMaster } from "@/lib/constants";
import { D } from "@/lib/decimal";
import type { PurchaseOrderSnapshot } from "@/lib/purchase-order";
import { analyzeQuotation, filmCompositionOf, printingMethodOf } from "@/lib/quotation-history";
import {
  DEFAULT_FILM_COMPOSITION,
  QUOTATION_RESTORE_KEY,
  quotationStatuses,
  type QuotationRecord,
  type QuotationStatus,
} from "@/lib/quotation-shared";

const statusLabels: Record<QuotationStatus, string> = {
  draft: "下書き",
  sent: "送付済み",
  approved: "成約",
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const requestOrder = useRef(0);
  const selectedRecord = records.find((record) => record.id === selectedId) ?? null;
  const [purchaseRecord, setPurchaseRecord] = useState<QuotationRecord | null>(null);

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

  useEffect(() => {
    if (!purchaseRecord) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPurchaseRecord(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [purchaseRecord]);

  useEffect(() => {
    if (!selectedRecord) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedRecord]);

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
                  <td>{formatCurrency(record.pricePerPiece, 2)}</td>
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
                    <button className="button small" type="button" onClick={() => setSelectedId(record.id)}>詳細</button>
                    <button
                      className="button small"
                      type="button"
                      disabled={record.status !== "approved"}
                      title={record.status === "approved" ? "カネイ貿易向け発注内容を表示" : "成約処理後に表示できます"}
                      onClick={() => setPurchaseRecord(record)}
                    >発注内容</button>
                    <button className="button secondary small" type="button" onClick={() => restore(record)}>復元</button>
                    <button className="button danger small" type="button" onClick={() => void remove(record)}>削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRecord ? (
        <QuotationDetailModal record={selectedRecord} onClose={() => setSelectedId(null)} onPurchase={setPurchaseRecord} />
      ) : null}
      {purchaseRecord ? (
        <PurchaseOrderModal record={purchaseRecord} onClose={() => setPurchaseRecord(null)} />
      ) : null}
    </main>
  );
}

function QuotationDetailModal({ record, onClose, onPurchase }: { record: QuotationRecord; onClose: () => void; onPurchase: (record: QuotationRecord) => void }) {
  const analysis = analyzeQuotation(record);
  const composition = filmCompositionOf(record);
  const payloadEntries = Object.entries(record.payload);
  const recordEntries = Object.entries(record).filter(([key]) => key !== "payload");
  const amountDifference = analysis.grandTotal.minus(analysis.subtotal.plus(analysis.tax));
  const displayedAdjustment = analysis.displayedAdjustment === "-"
    ? "-"
    : (analysis.displayedAdjustment !== "" ? formatCurrency(analysis.displayedAdjustment, 0) : "-");
  const costTotal = analysis.costUnit.times(analysis.quantity);
  const finalProfit = analysis.subtotal.minus(costTotal);
  const finalProfitRate = analysis.subtotal.gt(0)
    ? finalProfit.div(analysis.subtotal).times(100)
    : analysis.profitRate;
  const finalProfitPerPiece = analysis.quantity.gt(0)
    ? finalProfit.div(analysis.quantity)
    : analysis.profitUnit;

  const rows = [
    { name: "充填・加工", cost: analysis.fillingCostUnit, selling: analysis.fillingUnit, profit: analysis.fillingUnit.minus(analysis.fillingCostUnit), quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`, amount: analysis.fillingAmount },
    { name: "フィルム", cost: analysis.filmCostUnit, selling: analysis.filmUnit, profit: analysis.filmUnit.minus(analysis.filmCostUnit), quantity: `${formatNumber(analysis.filmOrderLength.toNumber(), 0)} m`, amount: analysis.filmAmount },
  ];
  if (printingMethodOf(record) === "gravure") {
    rows.push({
      name: "新規銅版", cost: analysis.copperCostUnit, selling: analysis.copperUnit,
      profit: analysis.copperUnit.minus(analysis.copperCostUnit),
      quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`, amount: analysis.copperAmount,
    });
  }

  return (
    <div className="history-detail-layer no-print" role="dialog" aria-modal="true" aria-labelledby="history-detail-title">
      <div className="history-detail-panel">
        <header className="history-detail-header">
          <div>
            <span className="side-kicker">QUOTATION DETAIL</span>
            <h2 id="history-detail-title">{record.quotationNumber}</h2>
            <p data-testid="history-film-composition">{record.customerName || "得意先未設定"} / {record.productName} / フィルム構成 {composition || DEFAULT_FILM_COMPOSITION}</p>
          </div>
          <div className="detail-header-actions">
            {record.status === "approved" ? (
              <button className="button small" type="button" onClick={() => onPurchase(record)}>発注内容</button>
            ) : null}
            <button className="button secondary small" type="button" onClick={onClose}>閉じる</button>
          </div>
        </header>

        <div className="detail-scroll">
          <section className="profit-summary" aria-label="損益サマリー">
            <div className="profit-summary-head">
              <div>
                <span>最終損益サマリー</span>
                <strong>{formatCurrency(finalProfitPerPiece.toFixed(2), 2)} /枚 利益</strong>
                <small>原価 {formatCurrency(analysis.costUnit.toFixed(2), 2)} → 見積 {formatCurrency(analysis.sellingUnit.toFixed(2), 2)}</small>
              </div>
              <div className="profit-summary-total">
                <span>総利益（税抜）</span>
                <strong>{formatCurrency(finalProfit.toFixed(0), 0)}</strong>
                <small>{formatNumber(analysis.quantity.toNumber(), 0)}枚 ／ 利益率 {formatNumber(finalProfitRate.toNumber(), 2)}%</small>
              </div>
            </div>
            <div className="detail-table-wrap">
              <table className="table profit-summary-table">
                <thead>
                  <tr>
                    <th>項目</th><th>原価 /枚</th><th>見積価格 /枚</th><th>差益 /枚</th>
                    <th>差益率</th><th>原価総額</th><th>見積金額</th><th>差益総額</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>充填・加工</td>
                    <td>{formatCurrency(analysis.fillingCostUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.fillingUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.fillingUnit.minus(analysis.fillingCostUnit).toFixed(2), 2)}</td>
                    <td>{analysis.fillingUnit.gt(0) ? `${formatNumber(analysis.fillingUnit.minus(analysis.fillingCostUnit).div(analysis.fillingUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                    <td>{formatCurrency(analysis.fillingCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.fillingAmount.toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.fillingAmount.minus(analysis.fillingCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
                  </tr>
	                  <tr>
	                    <td>フィルム</td>
                    <td>{formatCurrency(analysis.filmCostUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.filmUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.filmUnit.minus(analysis.filmCostUnit).toFixed(2), 2)}</td>
                    <td>{analysis.filmUnit.gt(0) ? `${formatNumber(analysis.filmUnit.minus(analysis.filmCostUnit).div(analysis.filmUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                    <td>{formatCurrency(analysis.filmCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.filmAmount.toFixed(0), 0)}</td>
	                    <td>{formatCurrency(analysis.filmAmount.minus(analysis.filmCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
	                  </tr>
                  {analysis.customCostUnit.gt(0) ? (
                    <tr>
                      <td>金型</td>
                      <td>{formatCurrency(analysis.customCostUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.customUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.customUnit.minus(analysis.customCostUnit).toFixed(2), 2)}</td>
                      <td>{analysis.customUnit.gt(0) ? `${formatNumber(analysis.customUnit.minus(analysis.customCostUnit).div(analysis.customUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                      <td>{formatCurrency(analysis.customCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.customAmount.toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.customAmount.minus(analysis.customCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
                    </tr>
                  ) : null}
                  {printingMethodOf(record) === "gravure" ? (
                    <tr>
                      <td>新規銅版</td>
                      <td>{formatCurrency(analysis.copperCostUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.copperUnit.toFixed(2), 2)}</td>
                      <td>{formatCurrency(analysis.copperUnit.minus(analysis.copperCostUnit).toFixed(2), 2)}</td>
                      <td>{analysis.copperUnit.gt(0) ? `${formatNumber(analysis.copperUnit.minus(analysis.copperCostUnit).div(analysis.copperUnit).times(100).toNumber(), 2)}%` : "-"}</td>
                      <td>{formatCurrency(analysis.copperCostUnit.times(analysis.quantity).toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.copperAmount.toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.copperAmount.minus(analysis.copperCostUnit.times(analysis.quantity)).toFixed(0), 0)}</td>
                    </tr>
                  ) : null}
                  {analysis.adjustment.abs().gt(0) ? (
                    <tr>
                      <td>端数調整</td>
                      <td>-</td><td>-</td><td>-</td><td>-</td>
                      <td>-</td>
                      <td>{formatCurrency(analysis.adjustment.toFixed(0), 0)}</td>
                      <td>{formatCurrency(analysis.adjustment.toFixed(0), 0)}</td>
                    </tr>
                  ) : null}
                  <tr className="profit-total-row">
                    <td>合計</td>
                    <td>{formatCurrency(analysis.costUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.sellingUnit.toFixed(2), 2)}</td>
                    <td>{formatCurrency(analysis.profitUnit.toFixed(2), 2)}</td>
                    <td>{formatNumber(analysis.profitRate.toNumber(), 2)}%</td>
                    <td>{formatCurrency(costTotal.toFixed(0), 0)}</td>
                    <td>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</td>
                    <td>{formatCurrency(finalProfit.toFixed(0), 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="formula-note">
              最終利益 ＝ 見積金額 {formatCurrency(analysis.subtotal.toFixed(0), 0)} − 総原価 {formatCurrency(costTotal.toFixed(0), 0)} ＝ {formatCurrency(finalProfit.toFixed(0), 0)} 円
            </p>
          </section>

          <details className="editor-group" open>
            <summary>見積書表示値（DB snapshot）</summary>
            <div className="detail-grid">
              <div><span>お見積単価</span><strong>{formatCurrency(analysis.sellingUnit.toFixed(2), 2)} /枚</strong></div>
              <div><span>充填・加工単価</span><strong>{formatCurrency(analysis.fillingUnit.toFixed(2), 2)}</strong></div>
              <div><span>充填・加工金額</span><strong>{formatCurrency(analysis.fillingAmount.toFixed(0), 0)}</strong></div>
              <div><span>フィルム m単価</span><strong>{analysis.displayedFilmMeterUnit ? `${formatCurrency(analysis.displayedFilmMeterUnit.toFixed(0), 0)} /m` : "-"}</strong></div>
              <div><span>フィルム パウチ換算</span><strong>{formatCurrency(analysis.filmUnit.toFixed(2), 2)} /枚</strong></div>
              <div><span>フィルム金額</span><strong>{formatCurrency(analysis.filmAmount.toFixed(0), 0)}</strong></div>
              {printingMethodOf(record) === "gravure" ? (
                <>
                  <div><span>銅版単価</span><strong>{formatCurrency(analysis.copperUnit.toFixed(2), 2)}</strong></div>
                  <div><span>銅版金額</span><strong>{formatCurrency(analysis.copperAmount.toFixed(0), 0)}</strong></div>
                </>
              ) : null}
              <div><span>端数調整</span><strong>{displayedAdjustment}</strong></div>
              <div><span>小計（税抜）</span><strong>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</strong></div>
              <div><span>消費税</span><strong>{formatCurrency(analysis.tax.toFixed(0), 0)}</strong></div>
              <div><span>税込合計</span><strong>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}</strong></div>
            </div>
          </details>

          <details className="editor-group">
            <summary>原価・見積・利益の逆算明細</summary>
            <div className="detail-table-wrap">
              <table className="table">
                <thead>
                  <tr><th>項目</th><th>原価 /枚</th><th>見積単価</th><th>利益 /枚</th><th>利益率</th><th>数量</th><th>見積金額</th></tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{formatCurrency(row.cost.toFixed(4), 4)}</td>
                      <td>{formatCurrency(row.selling.toFixed(4), 4)}</td>
                      <td>{formatCurrency(row.profit.toFixed(4), 4)}</td>
                      <td>{row.selling.gt(0) ? `${formatNumber(row.profit.div(row.selling).times(100).toNumber(), 2)}%` : "-"}</td>
                      <td>{row.quantity}</td>
                      <td>{formatCurrency(row.amount.toFixed(0), 0)}</td>
                    </tr>
                  ))}
                  <tr className="detail-total-row">
                    <td>合計</td>
                    <td>{formatCurrency(analysis.costUnit.toFixed(4), 4)}</td>
                    <td>{formatCurrency(analysis.sellingUnit.toFixed(4), 4)}</td>
                    <td>{formatCurrency(analysis.profitUnit.toFixed(4), 4)}</td>
                    <td>{formatNumber(analysis.profitRate.toNumber(), 2)}%</td>
                    <td>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</td>
                    <td>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="formula-note">
              利益 / 枚 ＝ 表示見積単価 − 総原価 ＝ {formatCurrency(analysis.sellingUnit.toFixed(4), 4)} − {formatCurrency(analysis.costUnit.toFixed(4), 4)} ＝ {formatCurrency(analysis.profitUnit.toFixed(4), 4)}<br />
              利益率 ＝ 利益 ÷ 表示見積単価 × 100 ＝ {formatNumber(analysis.profitRate.toNumber(), 2)}％／ 総利益 ＝ 利益 × 数量 ＝ {formatCurrency(analysis.totalProfit.toFixed(2), 2)}
            </div>
          </details>

          <details className="editor-group" open>
            <summary>表示金額・税・調整</summary>
            <div className="detail-grid">
              <div><span>原価 / 枚（充填＋フィルム＋銅版）</span><strong>{formatCurrency(analysis.costUnit.toFixed(4), 4)}</strong></div>
              <div><span>自動目標利益率</span><strong>{formatNumber(analysis.targetMargin.times(100).toNumber(), 2)}%</strong></div>
              <div><span>端数調整</span><strong>{displayedAdjustment}</strong></div>
              <div><span>小計（税抜）</span><strong>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</strong></div>
              <div><span>消費税（{formatNumber(analysis.taxRate.toNumber(), 2)}%）</span><strong>{formatCurrency(analysis.tax.toFixed(0), 0)}</strong></div>
              <div><span>税込合計</span><strong>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}</strong></div>
              <div><span>マークアップ率</span><strong>{formatNumber(analysis.markupRate.toNumber(), 2)}%</strong></div>
              <div><span>合計整合差</span><strong>{formatCurrency(amountDifference.toFixed(0), 0)}</strong></div>
            </div>
            <p className="help">保存済みDB値の逆算：単価 {formatCurrency(analysis.storedSellingUnit.toFixed(4), 4)} / 利益 {formatCurrency(analysis.storedProfitUnit.toFixed(4), 4)} / 利益率 {formatNumber(analysis.storedProfitRate.toNumber(), 2)}%。上段は見積書の表示override値を優先した実表示金額です。</p>
          </details>

          <details className="editor-group" open>
            <summary>基本情報・フィルム構成</summary>
            <div className="detail-grid">
              <div><span>見積番号</span><strong>{record.quotationNumber}</strong></div>
              <div><span>状態</span><strong>{statusLabels[record.status]}</strong></div>
              <div><span>発行日</span><strong>{record.issueDate}</strong></div>
              <div><span>有効期限</span><strong>{record.validUntil || "-"}</strong></div>
              <div><span>得意先</span><strong>{record.customerName || "-"}</strong></div>
              <div><span>担当</span><strong>{record.customerContact || "-"}</strong></div>
              <div><span>品名</span><strong>{record.productName}</strong></div>
              <div><span>仕様</span><strong>{record.sizeSummary}</strong></div>
              <div><span>印刷方式</span><strong>{printingMethodOf(record) === "gravure" ? "グラビア印刷（ロール）" : "デジタル印刷"}</strong></div>
              {printingMethodOf(record) === "gravure" ? (
                <>
                  <div><span>発注パターン</span><strong>{formatNumber(analysis.orderPatternCount.toNumber(), 0)} 回</strong></div>
                  <div><span>納品パターン長</span><strong>{formatNumber(analysis.deliverablePatternLengthM.toNumber(), 0)} m</strong></div>
                  <div><span>推奨発注数量</span><strong>{analysis.recommendedQuantity.gt(0) ? `${formatNumber(analysis.recommendedQuantity.toNumber(), 0)} 枚` : "-"}</strong></div>
                </>
              ) : null}
              <div><span>発注数量</span><strong>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</strong></div>
              <div><span>フィルム構成</span><strong>{composition || DEFAULT_FILM_COMPOSITION}</strong></div>
              <div><span>フィルム購入単価</span><strong>{formatCurrency(analysis.filmMeterPrice.toFixed(0), 0)} /m</strong></div>
              <div><span>フィルム見積単価</span><strong>{analysis.displayedFilmMeterUnit ? `${formatCurrency(analysis.displayedFilmMeterUnit.toFixed(0), 0)} /m` : "-"}</strong></div>
              <div><span>フィルム発注長</span><strong>{formatNumber(analysis.filmOrderLength.toNumber(), 0)} m</strong></div>
              <div><span>納期</span><strong>{record.deliveryDate || "-"}</strong></div>
              <div><span>支払条件</span><strong>{record.paymentTerms || "-"}</strong></div>
              <div><span>計算バージョン</span><strong>{record.calculationVersion || "-"}</strong></div>
              <div><span>作成日時</span><strong>{new Date(record.createdAt).toLocaleString("ja-JP")}</strong></div>
              <div><span>更新日時</span><strong>{new Date(record.updatedAt).toLocaleString("ja-JP")}</strong></div>
            </div>
            <p className="help">備考：{record.notes || "-"}</p>
          </details>

          <details className="editor-group">
            <summary>DBレコード全項目</summary>
            <div className="raw-grid">
              {recordEntries.map(([key, value]) => (
                <div key={key}><span>{key}</span><strong>{String(value ?? "-")}</strong></div>
              ))}
            </div>
          </details>

          <details className="editor-group">
            <summary>保存payload全項目（編集内容含む）</summary>
            <div className="raw-grid">
              {payloadEntries.map(([key, value]) => (
                <div key={key}><span>{key}</span><strong>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "-")}</strong></div>
              ))}
            </div>
            <textarea className="payload-json" readOnly rows={10} value={JSON.stringify(record.payload, null, 2)} aria-label="保存payload JSON" />
          </details>
        </div>
      </div>
      <div className="history-detail-overlay" onClick={onClose} aria-hidden="true" />
    </div>
  );
}

function fallbackPurchaseOrder(record: QuotationRecord): PurchaseOrderSnapshot {
  const quantity = Number(record.quantity) || 0;
  const match = record.sizeSummary.match(/([0-9.]+)\s*×\s*([0-9.]+)/);
  const width = match ? Number(match[1]) : 0;
  const length = match ? Number(match[2]) : 0;
  const size = Object.values(sizeMaster).find((item) => Number(item.widthMm) === width && Number(item.lengthMm) === length);
  const lanes = size?.lanes ?? 4;
  const pitchMm = size ? D(size.lengthMm).plus(size.pitchAddMm).toString() : String(length + 6);
  const webWidthMm = size?.webWidthMm ?? 500;
  const lossRate = 0.1;
  const colorCount = Number(record.payload.colorCount) || 0;
  const requiredLengthM = pitchMm && lanes > 0 && quantity > 0
    ? D(quantity).div(1 - lossRate).times(pitchMm).div(1000).div(lanes).toString()
    : "0";
  const orderLengthM = D(record.filmOrderLengthM).toString();
  const effectiveLengthM = D(orderLengthM).minus(D(orderLengthM).times(lossRate)).toString();

  if (printingMethodOf(record) === "gravure") {
    const savedDeliverable = typeof record.payload.deliverablePatternLengthM === "string"
      ? record.payload.deliverablePatternLengthM
      : "0";
    const deliverablePatternLengthM = savedDeliverable
      ? D(savedDeliverable).toString()
      : D(orderLengthM).div(Number(record.payload.orderPatternCount) || 1).toString();
    return {
      printingMethod: "gravure",
      pouchQuantity: record.quantity,
      filmComposition: typeof record.payload.filmComposition === "string" ? record.payload.filmComposition : "PET12+AL7+PET12+LLDPE50",
      requiredLengthM,
      orderLengthM,
      effectiveLengthM: record.payload.deliverablePatternLengthM
        ? D(String(record.payload.deliverablePatternLengthM ?? 0)).times(Number(record.payload.orderPatternCount) || 1).toString()
        : effectiveLengthM,
      lossM: D(orderLengthM).minus(D(savedDeliverable)).toString(),
      lossRate: String(lossRate),
      webWidthMm,
      lanes,
      pitchMm,
      prodMultiplier: size?.prodMultiplier ?? 1,
      colorCount,
      skuColorCounts: [],
      skuOrderDetails: [],
      orderPatternCount: Number(record.payload.orderPatternCount) || 1,
      deliverablePatternLengthM,
      productionPatternLengthM: orderLengthM,
      gravureLossM: D(orderLengthM).minus(D(savedDeliverable)).toString(),
      copperPlate: {
        quantity: colorCount,
        plateWidthMm: D(webWidthMm).plus(100).toString(),
        diameterMm: 42,
        minimumPriceYen: "32000",
        calculatedPriceYen: D(String(record.payload.copperPlateCostPerPiece ?? 0)).times(quantity).toString(),
        priceYen: D(String(record.payload.copperPlateCostPerPiece ?? 0)).times(quantity).toString(),
      },
    };
  }

  return {
    printingMethod: "digital",
    pouchQuantity: record.quantity,
    filmComposition: typeof record.payload.filmComposition === "string" ? record.payload.filmComposition : "PET12+AL7+PET12+LLDPE50",
    requiredLengthM,
    orderLengthM,
    effectiveLengthM,
    lossM: D(orderLengthM).times(lossRate).toString(),
    lossRate: String(lossRate),
    webWidthMm,
    lanes,
    pitchMm,
    prodMultiplier: size?.prodMultiplier ?? 1,
    colorCount,
    skuColorCounts: [],
    skuOrderDetails: [],
  };
}

function resolvePurchaseOrder(record: QuotationRecord): { order: PurchaseOrderSnapshot | null; legacy: boolean } {
  try {
    const value = record.payload.purchaseOrder as Record<string, unknown> | undefined;
    if (value && typeof value === "object" && typeof value.printingMethod === "string") {
      return { order: value as unknown as PurchaseOrderSnapshot, legacy: false };
    }
    if (typeof record.payload.purchaseOrderJson === "string" && record.payload.purchaseOrderJson.trim()) {
      return { order: JSON.parse(record.payload.purchaseOrderJson) as PurchaseOrderSnapshot, legacy: false };
    }
  } catch {
    // 壊れたsnapshotはlegacy再構築に任せる。
  }
  return { order: fallbackPurchaseOrder(record), legacy: true };
}

function PurchaseOrderModal({ record, onClose }: { record: QuotationRecord; onClose: () => void }) {
  const { order, legacy } = resolvePurchaseOrder(record);
  return (
    <div className="purchase-order-layer" role="dialog" aria-modal="true" aria-labelledby="purchase-order-title">
      <div className="purchase-order-panel">
        <header className="purchase-order-header">
          <div>
            <span className="side-kicker">PURCHASE ORDER</span>
            <h2 id="purchase-order-title">カネイ貿易 発注内容</h2>
            <p>{record.quotationNumber} ／ {record.customerName || "-"} ／ {record.productName}</p>
          </div>
          <button className="button secondary small" type="button" onClick={onClose}>閉じる</button>
        </header>

        <div className="purchase-order-body">
          {legacy ? <p className="warning">旧形式の見積履歴のため、一部項目は保存済み情報から再構築しています。新しい見積書では全項目が自動保存されます。</p> : null}
          {!order ? <p className="error">発注内容を構築できませんでした。</p> : (
            <>
              <section className="purchase-order-section">
                <h3>発注サマリー</h3>
                <dl className="purchase-order-grid">
                  <div><dt>発注先</dt><dd>カネイ貿易</dd></div>
                  <div><dt>印刷方式</dt><dd>{order.printingMethod === "gravure" ? "グラビア印刷" : "デジタル印刷"}</dd></div>
                  <div><dt>発注数量</dt><dd>{formatNumber(record.quantity, 0)} 枚</dd></div>
                  <div><dt>フィルム構成</dt><dd>{order.filmComposition}</dd></div>
                  <div><dt>原反幅</dt><dd>{formatNumber(order.webWidthMm, 0)} mm</dd></div>
                  <div><dt>列数</dt><dd>{formatNumber(order.lanes, 0)} 列</dd></div>
                  <div><dt>発注長</dt><dd>{formatNumber(order.orderLengthM, 0)} m</dd></div>
                  <div><dt>印刷色数</dt><dd>{order.colorCount > 0 ? `${formatNumber(order.colorCount, 0)} 色` : "旧データ（要確認）"}</dd></div>
                </dl>
              </section>

              {order.customMold && Number(order.customMold.costYen) > 0 ? (
                <section className="purchase-order-section">
                  <h3>カスタム金型 発注</h3>
                  <dl className="purchase-order-grid">
                    <div><dt>数量</dt><dd>{formatNumber(order.customMold.quantity, 0)} 式</dd></div>
                    <div><dt>発注金額</dt><dd>{formatCurrency(order.customMold.costYen, 0)}</dd></div>
                  </dl>
                  <p>カスタム仕様の金型・治具费用です。仕様変更時は再見積りしてください。</p>
                </section>
              ) : null}

              <section className="purchase-order-section">
                <h3>フィルム発注の計算根拠</h3>
                <dl className="purchase-order-grid">
                  <div><dt>必要長</dt><dd>{formatNumber(order.requiredLengthM, 3)} m</dd></div>
                  <div><dt>発注長</dt><dd>{formatNumber(order.orderLengthM, 0)} m</dd></div>
                  <div><dt>ロス</dt><dd>{formatNumber(order.lossM, 0)} m</dd></div>
                  <div><dt>有効長</dt><dd>{formatNumber(order.effectiveLengthM, 0)} m</dd></div>
                </dl>
                {order.printingMethod === "digital" ? (
                  <ol>
                    <li>必要長 ＝ 発注枚数 ÷ (1 − ロス率 {formatNumber(Number(order.lossRate) * 100, 1)}%) × ピッチ {formatNumber(order.pitchMm, 0)}mm ÷ 1000 ÷ {formatNumber(order.lanes, 0)}列 ＝ {formatNumber(order.requiredLengthM, 3)}m</li>
                    <li>SKUごとに必要長を100m単位へ切り上げ、最低発注長を満たした合計が発注長 {formatNumber(order.orderLengthM, 0)}m。</li>
                    <li>原反幅 {formatNumber(order.webWidthMm, 0)}mm は、このサイズを {formatNumber(order.lanes, 0)}列で生産する登録済み確認幅です。1列あたり {formatNumber(D(order.webWidthMm).div(order.lanes).toString(), 1)}mm 確保できます。</li>
                    {order.prodMultiplier > 1 ? <li>このサイズは大ロット切替のため生産倍率 {formatNumber(order.prodMultiplier, 0)}倍、検討幅 736mm を使用します。</li> : null}
                  </ol>
                ) : (
                  <ol>
                    <li>必要納品長 ＝ {formatNumber(order.requiredLengthM, 3)}m。</li>
                    <li>発注パターン ＝ ceil(必要納品長 ÷ {formatNumber(order.deliverablePatternLengthM ?? "0", 0)}m) ＝ {formatNumber(order.orderPatternCount ?? 1, 0)}回。</li>
                    <li>発注（製作）長 ＝ パターン数 × 製作パターン長 ＝ {formatNumber(order.orderLengthM, 0)}m。納品可能長は {formatNumber(order.deliverablePatternLengthM ?? "0", 0)}m、ロスは {formatNumber(order.gravureLossM ?? "0", 0)}m。</li>
                    <li>原反幅 {formatNumber(order.webWidthMm, 0)}mm はグラビア用に確保する幅です（最小500mm / 最大1100mm）。</li>
                  </ol>
                )}
              </section>

              <section className="purchase-order-section">
                <h3>SKU別 内訳</h3>
                {order.skuOrderDetails.length ? (
                  <table>
                    <thead><tr><th>SKU</th><th>品名</th><th>数量</th><th>色数</th><th>必要長</th><th>発注長</th><th>原反幅 / 生産</th></tr></thead>
                    <tbody>
                      {order.skuOrderDetails.map((sku, index) => (
                        <tr key={`${sku.skuCode}-${index}`}>
                          <td>{sku.skuCode}</td>
                          <td>{sku.name || "-"}</td>
                          <td>{formatNumber(sku.quantity, 0)} 枚</td>
                          <td>{formatNumber(sku.colorCount, 0)} 色</td>
                          <td>{formatNumber(sku.requiredLengthM, 3)} m</td>
                          <td>{formatNumber(sku.orderLengthM, 0)} m</td>
                          <td>{formatNumber(sku.webWidthMm, 0)}mm × {formatNumber(sku.multiplier, 0)}倍</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p>旧形式の履歴のためSKU別内訳は保存されていません。見積書の仕様をご確認ください。</p>
                )}
              </section>

              {order.printingMethod === "gravure" ? (
                <section className="purchase-order-section">
                  <h3>新規銅版 発注</h3>
                  {order.copperPlate ? (
                    <>
                      <dl className="purchase-order-grid">
                        <div><dt>銅版数</dt><dd>{formatNumber(order.copperPlate.quantity, 0)} 本</dd></div>
                        <div><dt>版幅</dt><dd>{formatNumber(order.copperPlate.plateWidthMm, 0)} mm</dd></div>
                        <div><dt>外径</dt><dd>{formatNumber(order.copperPlate.diameterMm, 0)} cm</dd></div>
                        <div><dt>金額</dt><dd>{formatCurrency(order.copperPlate.priceYen, 0)}</dd></div>
                      </dl>
                      <ol>
                        <li>銅版数 ＝ 印刷色数。</li>
                        <li>版幅 ＝ 原反幅 {formatNumber(order.webWidthMm, 0)}mm ＋ 端代100mm ＝ {formatNumber(order.copperPlate.plateWidthMm, 0)}mm。</li>
                        <li>金額 ＝ MAX(¥32,000, 銅版数 × 版幅cm × 単価 × 外径cm)。小数は切り上げ。</li>
                      </ol>
                    </>
                  ) : <p>銅版情報が保存されていません。</p>}
                </section>
              ) : null}

              <section className="purchase-order-section">
                <h3>発注時確認事項</h3>
                <ul>
                  <li>フィルム構成・幅・発注長・色数を発注書と照合してください。</li>
                  <li>グラビアは成約案件ごとに新規銅版が必要です。</li>
                  <li>仕様変更がある場合は、本発注内容を作成し直してください。</li>
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
      <div className="purchase-order-overlay" onClick={onClose} aria-hidden="true" />
    </div>
  );
}
