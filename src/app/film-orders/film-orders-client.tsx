"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FILM_ORDER_STATUSES,
  buildFilmOrderFileName,
  filmOrderStatusLabels,
  type FilmOrderStatus,
  type FilmOrderView,
} from "@/lib/film-order-shared";
import {
  isKaneiTradeUser,
  isSevenChemicalUser,
} from "@/lib/film-order-access";
import { D } from "@/lib/decimal";

interface MailResult {
  to: string;
  subject: string;
  dryRun: boolean;
  error?: string;
}

export default function FilmOrdersClient({ userEmail }: { userEmail: string }) {
  const [orders, setOrders] = useState<FilmOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"all" | FilmOrderStatus>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const isSeven = isSevenChemicalUser(userEmail);
  const isKanei = isKaneiTradeUser(userEmail);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/film-orders");
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.orders)) throw new Error();
      setOrders(payload.orders as FilmOrderView[]);
      setCreated(Number(payload.created ?? 0));
    } catch {
      setError("発注データを読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時にサーバーから発注一覧を取得する意図的な処理です。
    void load();
  }, [load]);

  const filtered = useMemo(
    () => statusFilter === "all" ? orders : orders.filter((order) => order.status === statusFilter),
    [orders, statusFilter],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>([["all", orders.length]]);
    for (const status of FILM_ORDER_STATUSES) {
      map.set(status, orders.filter((order) => order.status === status).length);
    }
    return map;
  }, [orders]);

  const applyResult = (id: number, result: { order: FilmOrderView }) => {
    setOrders((old) => old.map((order) => order.id === id ? result.order : order));
  };

  return (
    <main className="film-orders-page">
      <header className="film-orders-head">
        <div>
          <p className="film-orders-eyebrow">FILM PROCUREMENT WORKFLOW</p>
          <h1>フィルム発注管理</h1>
          <p>成約見積から自動作成された発注を管理します。発注書確認 → 入荷登録 → 校正 → 承認の流れで進めます。</p>
        </div>
        <div className="film-orders-actions">
          <span className="film-orders-role">{isSeven ? "セブン化学" : isKanei ? "カネイ貿易" : "-"}</span>
          <button className="button secondary small" type="button" onClick={() => void load()}>
            {loading ? "読み込み中..." : "更新"}
          </button>
        </div>
      </header>

      {created > 0 ? <p className="film-orders-sync">成約見積 {created} 件を発注管理に反映しました。</p> : null}
      {error ? <p className="film-orders-error">{error}</p> : null}

      <nav className="film-orders-tabs" aria-label="発注ステータス">
        <button
          type="button"
          className={statusFilter === "all" ? "button small" : "button secondary small"}
          onClick={() => setStatusFilter("all")}
        >
          全件 ({counts.get("all") ?? 0})
        </button>
        {FILM_ORDER_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className={statusFilter === status ? "button small" : "button secondary small"}
            onClick={() => setStatusFilter(status)}
          >
            {filmOrderStatusLabels[status]} ({counts.get(status) ?? 0})
          </button>
        ))}
      </nav>

      {loading && orders.length === 0 ? <p className="film-orders-empty">読み込み中...</p> : null}
      {!loading && filtered.length === 0 ? <p className="film-orders-empty">該当する発注はありません。見積履歴で成約処理を行うと自動的に作成されます。</p> : null}

      <div className="film-orders-list">
        {filtered.map((order) => (
          <OrderCard
            key={order.id}
            order={order}
            expanded={expandedId === order.id}
            onToggle={() => setExpandedId(expandedId === order.id ? null : order.id)}
            onUpdated={applyResult}
            isSeven={isSeven}
            isKanei={isKanei}
          />
        ))}
      </div>
    </main>
  );
}

function OrderCard({
  order,
  expanded,
  onToggle,
  onUpdated,
  isSeven,
  isKanei,
}: {
  order: FilmOrderView;
  expanded: boolean;
  onToggle: () => void;
  onUpdated: (id: number, result: { order: FilmOrderView }) => void;
  isSeven: boolean;
  isKanei: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [mails, setMails] = useState<MailResult[]>([]);

  const run = async (body: Record<string, unknown>, okMessage: string) => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setMails([]);
    try {
      const response = await fetch(`/api/film-orders/${order.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok || !payload.order) throw new Error(payload.error ?? "failed");
      onUpdated(order.id, payload as { order: FilmOrderView });
      setMails((payload.mails ?? []) as MailResult[]);
      setMessage(okMessage);
    } catch (error) {
      setMessage(error instanceof Error && error.message !== "failed"
        ? `失敗しました（${error.message}）`
        : "失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  const statusBadgeClass = order.status === "final_approved" ? "final" : order.status === "re_proof_requested" ? "warn" : "";

  return (
    <article className={`film-order-card ${expanded ? "expanded" : ""}`} data-print-target={expanded ? "true" : undefined}>
      <button className="film-order-summary" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="film-order-number">{order.order_number}</span>
        <span className="film-order-product">{order.product_name || "-"}</span>
        <span className="film-order-customer">{order.customer_name || "-"}</span>
        <span className="film-order-meta">{order.procurement_route ? `調達 ${order.procurement_route}` : "-"}</span>
        <span className="film-order-meta">{order.order_length_m ? `${Number(order.order_length_m).toLocaleString("ja-JP")}m` : "-"}</span>
        <span className={`film-order-status ${statusBadgeClass}`}>{filmOrderStatusLabels[order.status]}</span>
      </button>

      {expanded ? (
        <div className="film-order-detail">
          {message ? <p className="film-order-message" role="status">{message}</p> : null}
          {mails.length > 0 ? (
            <ul className="film-order-mails">
              {mails.map((mail) => (
                <li key={`${mail.to}-${mail.subject}`} className={mail.error ? "error" : ""}>
                  {mail.dryRun ? "[dry-run] " : ""}→ {mail.to} 「{mail.subject}」{mail.error ? ` 送信エラー: ${mail.error}` : ""}
                </li>
              ))}
            </ul>
          ) : null}

          <OrderSheet order={order} />

          {isKanei ? <SupplierEditor order={order} busy={busy} onSave={(body) => run(body, "仕入先情報を保存しました。")} /> : null}

          <section className="film-order-section">
            <h3>アクション</h3>
            {order.status === "pending" ? (
              <button className="button" type="button" disabled={busy} onClick={() => void run({ action: "mark-ordered" }, "発注書送信済みにしました。")}>
                発注書送信済みにする
              </button>
            ) : null}
            {order.status === "ordered" && isSeven ? (
              <FileActionForm
                title="入荷データ登録（セブン化学）"
                defaultFileName={buildFilmOrderFileName(order, "receiving", 1)}
                submitLabel="入荷を登録してデザインへ連絡"
                busy={busy}
                onSubmit={(fileName, note) => run({ action: "register-receiving", fileName, note }, "入荷データを登録し、デザイン宛てに連絡しました。")}
              />
            ) : null}
            {order.status === "receiving_registered" && isKanei ? (
              <div className="film-order-inline-actions">
                <button className="button secondary" type="button" disabled={busy} onClick={() => void run({ action: "send-proof-notice" }, "校正アップロード案内を送信しました。")}>
                  校正アップロード案内を送信
                </button>
                <FileActionForm
                  title="校正データ登録（カネイ貿易）"
                  defaultFileName={buildFilmOrderFileName(order, "proof", (order.files.filter((f) => f.category === "proof").length ?? 0) + 1)}
                  submitLabel="校正データを登録"
                  busy={busy}
                  onSubmit={(fileName, note) => run({ action: "register-proof", fileName, note }, "校正データを登録しました。セブン化学の承認待ちです。")}
                />
              </div>
            ) : null}
            {order.status === "re_proof_requested" && isKanei ? (
              <FileActionForm
                title="再校正データ登録（カネイ貿易）"
                defaultFileName={buildFilmOrderFileName(order, "proof", (order.files.filter((f) => f.category === "proof").length ?? 0) + 1)}
                submitLabel="再校正データを登録"
                busy={busy}
                onSubmit={(fileName, note) => run({ action: "register-proof", fileName, note }, "再校正データを登録しました。")}
              />
            ) : null}
            {order.status === "proof_registered" && isSeven ? (
              <div className="film-order-inline-actions">
                <button className="button" type="button" disabled={busy} onClick={() => void run({ action: "approve" }, "校正を承認しました。")}>
                  校正を承認する
                </button>
                <ReProofForm busy={busy} onSubmit={(comment) => run({ action: "request-re-proof", comment }, "再校正を依頼しました。")} />
              </div>
            ) : null}
            {order.status === "final_approved" ? <p className="film-order-final">最終承認済み。最終データは別途管理します。</p> : null}
            {!isSeven && !isKanei ? <p className="film-order-message">このアカウントには発注ワークフローの権限がありません。</p> : null}
          </section>

          <section className="film-order-section">
            <h3>入荷・校正データ履歴</h3>
            {order.files.length === 0 ? <p>まだ登録されていません。</p> : (
              <table className="film-order-files">
                <thead><tr><th>種別</th><th>ファイル名</th><th>v</th><th>登録者</th><th>日時</th></tr></thead>
                <tbody>
                  {order.files.map((file) => (
                    <tr key={file.id}>
                      <td>{file.category === "receiving" ? "入荷" : file.category === "proof" ? "校正" : "最終"}</td>
                      <td>{file.file_name}</td>
                      <td>{file.version}</td>
                      <td>{file.uploaded_by_email}</td>
                      <td>{new Date(file.created_at).toLocaleString("ja-JP")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="film-order-section">
            <h3>履歴</h3>
            <ul className="film-order-events">
              {order.events.map((event) => (
                <li key={event.id}>
                  <span className="film-order-event-type">{event.type}</span>
                  <span>{event.detail}</span>
                  <small>{event.actor_email} / {new Date(event.created_at).toLocaleString("ja-JP")}</small>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </article>
  );
}

function OrderSheet({ order }: { order: FilmOrderView }) {
  const po = order.purchaseOrder;
  const filmTotal = D(po?.filmCostYen ?? "0");
  const copperTotal = po?.copperPlate ? D(po.copperPlate.priceYen) : D(0);
  const moldTotal = po?.customMold ? D(po.customMold.costYen) : D(0);
  const orderTotal = filmTotal.plus(copperTotal).plus(moldTotal);
  const yen = (value: ReturnType<typeof D>) => `￥${Number(value.toFixed(0)).toLocaleString("ja-JP")}`;
  return (
    <section className="film-order-section film-order-sheet" aria-label="発注内容">
      <div className="no-print">
        <h3>発注内容（セブン化学 → カネイ貿易）</h3>
        <button className="button secondary small" type="button" onClick={() => window.print()}>発注書を印刷</button>
      </div>
      <div className="film-order-sheet-body">
        <h2>フィルム発注書</h2>
        <dl>
          <div><dt>発注番号</dt><dd>{order.order_number}</dd></div>
          <div><dt>見積番号</dt><dd>{order.quotation_number}</dd></div>
          <div><dt>商品名</dt><dd>{order.product_name || "-"}</dd></div>
          <div><dt>印刷方式</dt><dd>{order.printing_method === "gravure" ? "グラビア印刷" : order.printing_method === "digital" ? "デジタル印刷" : "-"}</dd></div>
          <div><dt>フィルム構成</dt><dd>{order.film_composition || "-"}</dd></div>
          <div><dt>原反幅</dt><dd>{order.web_width_mm ? `${order.web_width_mm}mm` : "-"}</dd></div>
          <div><dt>発注長</dt><dd>{order.order_length_m ? `${Number(order.order_length_m).toLocaleString("ja-JP")}m` : "-"}</dd></div>
          {po?.webWidthsMm && po.webWidthsMm.length > 1 ? (
            <div className="wide"><dt>SKU別原反幅</dt><dd>{po.webWidthsMm.map((width) => `${width}mm`).join(" / ")}</dd></div>
          ) : null}
          {order.procurement_route ? <div><dt>調達経路</dt><dd>{order.procurement_route === "Y" ? "国内調達" : "韓国輸入"}</dd></div> : null}
          {po?.filmCostYen ? <div><dt>フィルム金額</dt><dd>{yen(filmTotal)}</dd></div> : null}
          {po?.copperPlate ? (
            <div><dt>銅版</dt><dd>{po.copperPlate.quantity}枚 ／ {po.copperPlate.plateWidthMm}mm ／ {yen(copperTotal)}</dd></div>
          ) : null}
          {po?.customMold ? <div><dt>カスタム金型</dt><dd>{yen(moldTotal)}</dd></div> : null}
          <div className="film-order-total wide"><dt>発注金額合計（税抜）</dt><dd>{yen(orderTotal)}</dd></div>
        </dl>
        {po?.skuOrderDetails?.length ? (
          <table className="film-order-sku">
            <thead><tr><th>SKU</th><th>色数</th><th>発注長</th><th>原反幅</th><th>倍率</th></tr></thead>
            <tbody>
              {po.skuOrderDetails.map((sku) => (
                <tr key={sku.skuCode}>
                  <td>{sku.skuCode}</td>
                  <td>{sku.colorCount}</td>
                  <td>{Number(sku.orderLengthM).toLocaleString("ja-JP")}m</td>
                  <td>{sku.webWidthMm}mm</td>
                  <td>×{sku.multiplier}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <p className="film-order-sheet-note">発注書はセブン化学からカネイ貿易へメールで送付してください。送信後に「発注書送信済みにする」でステータスを進めます。</p>
      </div>
    </section>
  );
}

function SupplierEditor({ order, busy, onSave }: { order: FilmOrderView; busy: boolean; onSave: (body: Record<string, unknown>) => void }) {
  const [name, setName] = useState(order.supplier_name);
  const [email, setEmail] = useState(order.supplier_email);
  return (
    <section className="film-order-section">
      <h3>仕入先・校正担当（カネイ貿易）</h3>
      <div className="film-order-supplier">
        <label>仕入先名<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>校正データ送付先メール<input value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button
          className="button small"
          type="button"
          disabled={busy}
          onClick={() => onSave({ action: "set-supplier", supplierName: name, supplierEmail: email })}
        >
          保存
        </button>
      </div>
    </section>
  );
}

function FileActionForm({
  title,
  defaultFileName,
  submitLabel,
  busy,
  onSubmit,
}: {
  title: string;
  defaultFileName: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (fileName: string, note: string) => void;
}) {
  const [fileName, setFileName] = useState(defaultFileName);
  const [note, setNote] = useState("");
  return (
    <div className="film-order-file-form">
      <strong>{title}</strong>
      <label>ファイル名（Driveへアップロードした名前）
        <input value={fileName} onChange={(event) => setFileName(event.target.value)} />
      </label>
      <label>メモ<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" /></label>
      <button className="button" type="button" disabled={busy || !fileName.trim()} onClick={() => onSubmit(fileName.trim(), note)}>
        {submitLabel}
      </button>
    </div>
  );
}

function ReProofForm({ busy, onSubmit }: { busy: boolean; onSubmit: (comment: string) => void }) {
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="button danger" type="button" onClick={() => setOpen(true)}>再校正を依頼</button>
    );
  }
  return (
    <div className="film-order-file-form">
      <strong>再校正依頼（セブン化学）</strong>
      <label>再校正内容
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="修正内容を記入してください" />
      </label>
      <button className="button danger" type="button" disabled={busy || !comment.trim()} onClick={() => onSubmit(comment.trim())}>
        再校正依頼を送信
      </button>
      <button className="button secondary small" type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
    </div>
  );
}

