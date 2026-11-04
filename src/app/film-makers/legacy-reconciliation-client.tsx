"use client";

import { useCallback, useEffect, useState } from "react";

type Classification = "internal" | "ambiguous" | "external_exact" | "external_no_match";

type Suggestion = {
  makerId: number;
  makerCode: string;
  companyName: string;
  email: string;
  language: "ja" | "ko";
  printMethod: "gravure" | "digital";
  procurementRoute: "K" | "Y";
  matchedByEmail: string;
  confidence: "exact";
  rule: "normalized_email_route_print";
};

type ReconciliationOrder = {
  orderId: number;
  orderNumber: string;
  productName: string;
  customerName: string;
  supplierName: string;
  supplierEmail: string;
  procurementRoute: string;
  printMethod: string;
  resolution: "legacy_unresolved";
  classification: Classification;
  suggestedMaker: Suggestion | null;
};

const classificationLabels: Record<Classification, string> = {
  internal: "社内アドレス/社名",
  ambiguous: "あいまい・不完全",
  external_exact: "外部・完全一致候補",
  external_no_match: "外部・一致なし",
};

export default function LegacyReconciliationClient({ adminEmail }: { adminEmail: string }) {
  const [orders, setOrders] = useState<ReconciliationOrder[]>([]);
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/film-makers/legacy-reconciliation", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      setOrders(payload.orders as ReconciliationOrder[]);
      setError("");
    } catch {
      setError("レガシー案件を読み込めませんでした。");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時に未解決レガシー案件を取得する意図的な処理です。
    void load();
  }, [load]);

  const submit = async (body: Record<string, unknown>, success: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/film-makers/legacy-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "reconciliation_failed");
      setOrders(payload.orders as ReconciliationOrder[]);
      if (body.action === "exempt") setReasons((current) => ({ ...current, [Number(body.orderId)]: "" }));
      setMessage(success);
    } catch (caught) {
      const code = caught instanceof Error && caught.message !== "reconciliation_failed" ? caught.message : "";
      setError(code === "legacy_classification_conflict"
        ? "分類が変わったため操作を中止しました。一覧を再読込してください。"
        : "操作を完了できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <h1>レガシー供給者整理</h1>
      <p className="help">管理者: {adminEmail}</p>
      <section aria-labelledby="legacy-reconciliation-list-title" data-testid="legacy-reconciliation">
        <h2 id="legacy-reconciliation-list-title">legacy_unresolved 案件</h2>
        <p className="help">
          正規化メール・調達ルート・印刷方式が有効メーカーと完全一致する場合のみ提案します。提案は代入ではありません。
        </p>
        {message ? <p className="success" role="status" data-testid="legacy-reconciliation-message">{message}</p> : null}
        {error ? <p className="form-error" role="alert" data-testid="legacy-reconciliation-error">{error}</p> : null}
        {busy ? <p role="status">読み込み中...</p> : null}
        {!busy && orders.length === 0 ? <p role="status">未解決のレガシー案件はありません。</p> : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>発注</th><th>履歴供給者</th><th>現在条件</th><th>分類</th><th>一致候補</th><th>明示操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.orderId} data-testid={`legacy-order-${order.orderId}`}>
                  <td>
                    <strong>{order.orderNumber}</strong>
                    <div>{order.productName}</div>
                    <div>{order.customerName}</div>
                  </td>
                  <td data-testid={`legacy-supplier-${order.orderId}`}>
                    {order.supplierName || "-"}
                    <div>{order.supplierEmail || "-"}</div>
                  </td>
                  <td>
                    {order.procurementRoute || "-"} / {order.printMethod || "-"}
                  </td>
                  <td data-testid={`legacy-classification-${order.orderId}`}>
                    {classificationLabels[order.classification]}
                  </td>
                  <td>
                    {order.suggestedMaker ? (
                      <div data-testid={`legacy-suggestion-${order.orderId}`}>
                        <strong>{order.suggestedMaker.companyName}</strong>
                        <div>{order.suggestedMaker.makerCode}</div>
                        <div>{order.suggestedMaker.email}</div>
                        <div>正規化メール完全一致</div>
                      </div>
                    ) : (
                      <span>提案なし</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button small"
                      disabled={busy || !order.suggestedMaker}
                      data-testid={`legacy-select-${order.orderId}`}
                      onClick={() => void submit({
                        action: "select",
                        orderId: order.orderId,
                        makerId: order.suggestedMaker?.makerId,
                      }, "フィルムメーカーを選択しました。")}
                    >
                      このメーカーを選択
                    </button>
                    <label>
                      除外理由（{order.orderNumber}）
                      <input
                        value={reasons[order.orderId] ?? ""}
                        onChange={(event) => setReasons((current) => ({
                          ...current,
                          [order.orderId]: event.target.value,
                        }))}
                      />
                    </label>
                    <button
                      type="button"
                      className="button secondary small"
                      disabled={busy || (reasons[order.orderId] ?? "").trim() === ""}
                      data-testid={`legacy-exempt-${order.orderId}`}
                      onClick={() => void submit({
                        action: "exempt",
                        orderId: order.orderId,
                        classification: order.classification,
                        reason: reasons[order.orderId] ?? "",
                      }, "明示的なレガシー除外を記録しました。")}
                    >
                      レガシー除外にする
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          data-testid="legacy-backfill"
          onClick={() => void submit({ action: "backfill" }, "完全一致候補を再分類しました。")}
        >
          完全一致候補を再分類
        </button>
      </section>
    </main>
  );
}
