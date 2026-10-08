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

const STEP_DEFS: Array<{ key: string; label: string }> = [
  { key: "pending", label: "発注待ち" },
  { key: "ordered", label: "発注送信" },
  { key: "receiving_registered", label: "入稿" },
  { key: "proof_registered", label: "校正" },
  { key: "final_approved", label: "承認" },
  { key: "po_sent", label: "発注" },
  { key: "eta", label: "納期" },
];

const STATUS_HINTS: Record<FilmOrderStatus, string> = {
  pending: "セブン化学が発注書をメール送付し、「発注書送信済み」にします。",
  ordered: "フィルム製作を開始するため、セブン化学が製作データ（AI必須・PDF任意）を入稿登録します。",
  receiving_registered: "メーカー校正データの返却待ちです。返却後にカネイ貿易が登録します。",
  proof_registered: "セブン化学が校正を承認、または再校正を依頼します。",
  re_proof_requested: "カネイ貿易が再校正データを登録します。",
  final_approved: "ワークフロー完了です。",
};

const STATUS_STEP_ROLE: Record<FilmOrderStatus, "seven" | "kanei" | "none"> = {
  pending: "seven",
  ordered: "seven",
  receiving_registered: "kanei",
  proof_registered: "seven",
  re_proof_requested: "kanei",
  final_approved: "none",
};

type NextAction =
  | { kind: "run"; label: string; body: Record<string, unknown>; ok: string }
  | { kind: "form"; label: string; form: "receiving" | "proof" }
  | { kind: "none"; label: string };

function nextActionOf(order: FilmOrderView, isSeven: boolean, isKanei: boolean): NextAction {
  switch (order.status) {
    case "pending":
      return { kind: "run", label: "発注書送信済みにする", body: { action: "mark-ordered" }, ok: "発注書送信済みにしました。" };
    case "ordered":
      return isSeven
        ? { kind: "form", label: "入稿データを登録", form: "receiving" }
        : { kind: "none", label: "セブン化学の入荷登録待ち" };
    case "receiving_registered":
      return isKanei
        ? { kind: "form", label: "校正データを登録", form: "proof" }
        : { kind: "none", label: "カネイ貿易の校正データ登録待ち" };
    case "proof_registered":
      return isSeven
        ? { kind: "run", label: "校正を承認する", body: { action: "approve" }, ok: "校正を承認しました。" }
        : { kind: "none", label: "セブン化学の承認待ち" };
    case "re_proof_requested":
      return isKanei
        ? { kind: "form", label: "再校正データを登録", form: "proof" }
        : { kind: "none", label: "カネイ貿易の再校正データ登録待ち" };
    case "final_approved":
      return { kind: "none", label: "完了" };
  }
}

function orderTotalText(order: FilmOrderView): string {
  const po = order.purchaseOrder;
  const total = D(po?.filmCostYen ?? "0")
    .plus(po?.copperPlate ? D(po.copperPlate.priceYen) : D(0))
    .plus(po?.customMold ? D(po.customMold.costYen) : D(0));
  return `￥${Number(total.toFixed(0)).toLocaleString("ja-JP")}`;
}

export default function FilmOrdersClient({ userEmail }: { userEmail: string }) {
  const [orders, setOrders] = useState<FilmOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"all" | FilmOrderStatus>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [focusForm, setFocusForm] = useState<{ id: number; kind: "receiving" | "proof" } | null>(null);
  const [driveReady, setDriveReady] = useState(false);
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
      setDriveReady(payload.driveConfigured === true);
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
  const myTurnCount = useMemo(() => orders.filter((order) => {
    const next = nextActionOf(order, isSeven, isKanei);
    return next.kind !== "none";
  }).length, [orders, isSeven, isKanei]);

  const applyResult = (id: number, result: { order: FilmOrderView }) => {
    setOrders((old) => old.map((order) => order.id === id ? result.order : order));
  };

  const expandWithForm = (id: number, kind: "receiving" | "proof") => {
    setExpandedId(id);
    setFocusForm({ id, kind });
  };

  return (
    <main className="film-orders-page">
      <header className="film-orders-head">
        <div>
          <p className="film-orders-eyebrow">FILM PROCUREMENT WORKFLOW</p>
          <h1>フィルム発注管理</h1>
        </div>
        <div className="film-orders-toolbar">
          <span className={`film-orders-role ${isSeven ? "seven" : "kanei"}`}>
            {isSeven ? "セブン化学" : "カネイ貿易"}
          </span>
          <span className="film-orders-myturn" role="status" aria-live="polite">
            あなたの操作待ち <strong>{myTurnCount}</strong> 件
          </span>
          <button className="button secondary small" type="button" onClick={() => void load()}>
            {loading ? "読み込み中..." : "更新"}
          </button>
        </div>
      </header>
      <p className="film-orders-lead">成約見積から自動作成された発注を、ステップに沿って管理します。</p>

      <div className="film-orders-alerts">
        {created > 0 ? <p className="film-orders-sync">成約見積 {created} 件を発注管理に反映しました。</p> : null}
        {error ? <p className="film-orders-error">{error}</p> : null}
      </div>

      <details className="film-order-guide">
        <summary>{isSeven ? "セブン化学担当者の流れ" : "カネイ貿易担当者の流れ"}</summary>
        {isSeven ? (
          <ol>
            <li>見積履歴で見積を「成約」にすると、ここに発注が自動作成されます。</li>
            <li>発注内容を確認し、発注書をメールでカネイ貿易へ送付したら「発注書送信済みにする」を押します。</li>
            <li>フィルム製作用データを「入稿データを登録」します（AI必須・PDF任意。design@ へ自動連絡）。</li>
            <li>校正データが登録されたら「校正を承認」または「再校正を依頼」します。</li>
          </ol>
        ) : (
          <ol>
            <li>成約後の発注は自動的にここに表示されます（発注番号 F-…）。</li>
            <li>仕入先・校正データ送付先を設定します。</li>
            <li>メーカーから校正データが返却されたら「校正データを登録」します（セブン化学へ自動連絡）。</li>
            <li>再校正依頼が来たら再校正データを登録します。</li>
          </ol>
        )}
      </details>

      <nav className="film-orders-tabs" aria-label="発注ステータスで絞り込む">
        <button
          type="button"
          aria-pressed={statusFilter === "all"}
          className={statusFilter === "all" ? "active" : ""}
          onClick={() => setStatusFilter("all")}
        >
          全件 <b>{counts.get("all") ?? 0}</b>
        </button>
        {FILM_ORDER_STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={statusFilter === status}
            className={statusFilter === status ? "active" : ""}
            onClick={() => setStatusFilter(status)}
          >
            {filmOrderStatusLabels[status]} <b>{counts.get(status) ?? 0}</b>
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
            onExpandWithForm={expandWithForm}
            focusForm={focusForm}
            isSeven={isSeven}
            isKanei={isKanei}
            driveReady={driveReady}
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
  onExpandWithForm,
  focusForm,
  isSeven,
  isKanei,
  driveReady,
}: {
  order: FilmOrderView;
  expanded: boolean;
  onToggle: () => void;
  onUpdated: (id: number, result: { order: FilmOrderView }) => void;
  onExpandWithForm: (id: number, kind: "receiving" | "proof" ) => void;
  focusForm: { id: number; kind: "receiving" | "proof" } | null;
  isSeven: boolean;
  isKanei: boolean;
  driveReady: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [mails, setMails] = useState<MailResult[]>([]);
  const next = nextActionOf(order, isSeven, isKanei);
  const statusBadgeClass = order.status === "final_approved" ? "final" : order.status === "re_proof_requested" ? "warn" : "";

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

  return (
    <article className={`film-order-card ${expanded ? "expanded" : ""}`} data-print-target={expanded ? "true" : undefined}>
      <div className="film-order-summary" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggle(); } }}
        aria-expanded={expanded}>
        <div className="film-order-summary-main">
          <div className="film-order-titleline">
            <span className="film-order-number">{order.order_number}</span>
            <span className="film-order-product">{order.product_name || "-"}</span>
            <span className={`film-order-status ${statusBadgeClass}`}>{filmOrderStatusLabels[order.status]}</span>
          </div>
          <div className="film-order-metaline">
            <span className="film-order-chip">{order.customer_name || "顧客未設定"}</span>
            {order.procurement_route ? <span className="film-order-chip">調達 {order.procurement_route}</span> : null}
            {order.web_width_mm ? <span className="film-order-chip">{order.web_width_mm}mm</span> : null}
            {order.order_length_m ? <span className="film-order-chip">{Number(order.order_length_m).toLocaleString("ja-JP")}m</span> : null}
            <span className="film-order-chip total">{orderTotalText(order)}</span>
          </div>
        </div>
        <div className="film-order-summary-actions" onClick={(event) => event.stopPropagation()}>
          {next.kind === "run" ? (
            <button className="button small" type="button" disabled={busy} onClick={() => void run(next.body, next.ok)}>
              {next.label}
            </button>
          ) : null}
          {next.kind === "form" ? (
            <button className="button small" type="button" onClick={() => onExpandWithForm(order.id, next.form)}>
              {next.label}
            </button>
          ) : null}
          {next.kind === "none" ? <span className="film-order-next-wait">{next.label}</span> : null}
          <button className="film-order-toggle" type="button" onClick={onToggle} aria-label={expanded ? "詳細を閉じる" : "詳細を開く"}>
            {expanded ? "▲" : "▼"}
          </button>
        </div>
      </div>

      <OrderSteps status={order.status} reProofCount={order.re_proof_count} poSent={Boolean(order.po_sent_at)} etaDate={order.eta_date} />
      {order.eta_date ? (
        <div className="film-order-eta-row">
          <span className="film-order-eta-badge">納期見込み {order.eta_date}</span>
          {order.eta_note ? <small>{order.eta_note}</small> : null}
        </div>
      ) : null}

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

          <div className="film-order-columns">
            <OrderSheet order={order} />
            <div className="film-order-side">
              <NextStepPanel
                order={order}
                isSeven={isSeven}
                isKanei={isKanei}
                busy={busy}
                focused={focusForm?.id === order.id ? focusForm.kind : null}
                onRun={run}
                onExpandWithForm={onExpandWithForm}
                driveReady={driveReady}
              />
              {isKanei ? <SupplierEditor order={order} busy={busy} onSave={(body) => run(body, "仕入先情報を保存しました。")} /> : null}
            </div>
          </div>

          <section className="film-order-section">
            <h3>入稿・校正データ履歴</h3>
            {order.files.length === 0 ? <p>まだ登録されていません。</p> : (
              <div className="table-scroll">
                <table className="film-order-files">
                  <thead><tr><th>種別</th><th>ファイル名</th><th>リンク</th><th>v</th><th>登録者</th><th>日時</th></tr></thead>
                  <tbody>
                    {order.files.map((file) => (
                      <tr key={file.id}>
                        <td><span className={`film-order-file-badge ${file.category}`}>{file.category === "receiving" ? "入稿" : file.category === "proof" ? "校正" : "最終"}</span></td>
                        <td>{file.file_name}</td>
                        <td>{file.url ? <a href={file.url} target="_blank" rel="noreferrer">開く</a> : "-"}</td>
                        <td>{file.version}</td>
                        <td>{file.uploaded_by_email}</td>
                        <td>{new Date(file.created_at).toLocaleString("ja-JP")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="film-order-section">
            <h3>履歴</h3>
            <ul className="film-order-events">
              {order.events.map((event) => (
                <li key={event.id}>
                  <span className={`film-order-event-type ${event.type}`}>{event.type}</span>
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

function OrderSteps({
  status,
  reProofCount,
  poSent,
  etaDate,
}: {
  status: FilmOrderStatus;
  reProofCount: number;
  poSent: boolean;
  etaDate: string | null;
}) {
  const effective = poSent ? "po_sent" : etaDate ? "eta" : status;
  const activeIndex = status === "re_proof_requested"
    ? STEP_DEFS.findIndex((step) => step.key === "proof_registered")
    : STEP_DEFS.findIndex((step) => step.key === effective);
  const nextRole = STATUS_STEP_ROLE[status];
  return (
    <div className="film-order-steps" aria-label="進捗">
      {STEP_DEFS.map((step, index) => (
        <span key={step.key} className={`film-order-step ${index < activeIndex ? "done" : index === activeIndex ? "active" : ""}`}>
          <em>{index + 1}</em>{step.label}
        </span>
      ))}
      {status === "re_proof_requested" ? <span className="film-order-reproof">再校正 {reProofCount}回目</span> : null}
      {status !== "final_approved" && nextRole !== "none" ? (
        <span className={`film-order-step-role ${nextRole}`}>{nextRole === "seven" ? "次の操作: セブン化学" : "次の操作: カネイ貿易"}</span>
      ) : null}
    </div>
  );
}

function NextStepPanel({
  order,
  isSeven,
  isKanei,
  busy,
  focused,
  onRun,
  onExpandWithForm,
  driveReady,
}: {
  order: FilmOrderView;
  isSeven: boolean;
  isKanei: boolean;
  busy: boolean;
  focused: "receiving" | "proof" | null;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
  onExpandWithForm: (id: number, kind: "receiving" | "proof") => void;
  driveReady: boolean;
}) {
  const next = nextActionOf(order, isSeven, isKanei);
  const proofVersion = (order.files.filter((file) => file.category === "proof").length ?? 0) + 1;
  return (
    <section className={`film-order-section next-step ${next.kind === "none" ? "waiting" : "mine"}`}>
      <p className="next-step-kicker">{next.kind === "none" ? "WAITING" : "NEXT STEP"}</p>
      <h3>{STATUS_HINTS[order.status]}</h3>
      {next.kind === "none" && order.status !== "final_approved" ? (
        <div className="next-step-wait">
          <p>{next.label}</p>
          <button className="button small" type="button" disabled title="担当部署のみ操作できます">
            {STATUS_STEP_ROLE[order.status] === "seven" ? "入稿・承認操作（セブン化学）" : "校正データ操作（カネイ貿易）"}
          </button>
        </div>
      ) : null}
      {next.kind === "run" ? (
        <button className="button" type="button" disabled={busy} onClick={() => void onRun(next.body, next.ok)}>
          {next.label}
        </button>
      ) : null}
      {next.kind === "form" && next.form === "receiving" ? (
        <ReceivingForm
          order={order}
          autofocus={focused === "receiving"}
          busy={busy}
          driveReady={driveReady}
          onSubmit={(aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note) =>
            void onRun({ action: "register-receiving", aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note }, "入稿データを登録し、デザイン宛てに連絡しました。")}
        />
      ) : null}
      {next.kind === "form" && next.form === "proof" ? (
        <div className="film-order-inline-actions">
          {order.status === "receiving_registered" ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => void onRun({ action: "send-proof-notice" }, "校正アップロード案内を送信しました。")}>
              校正アップロード案内を送信
            </button>
          ) : null}
          <FileActionForm
            title={order.status === "re_proof_requested" ? "再校正データ登録" : "校正データ登録"}
            defaultFileName={buildFilmOrderFileName(order, "proof", proofVersion)}
            autofocus={focused === "proof"}
            driveReady={driveReady}
            orderId={order.id}
            category="proof"
            submitLabel={order.status === "re_proof_requested" ? "再校正データを登録" : "校正データを登録"}
            onSubmit={(fileName, note, fileUrl) => void onRun({ action: "register-proof", fileName, fileUrl, note }, "校正データを登録しました。")}
          />
        </div>
      ) : null}
      {order.status === "proof_registered" && isSeven ? (
        <div className="film-order-inline-actions">
          {(() => {
            const latest = [...order.files].filter((file) => file.category === "proof").sort((a, b) => b.version - a.version)[0];
            return latest ? (
              <p className="next-step-file">
                最新校正: <strong>{latest.file_name}</strong>（v{latest.version}）
                {latest.url ? (
                  <a className="button secondary small" href={latest.url} target="_blank" rel="noreferrer">校正ファイルを開く</a>
                ) : <span className="film-order-url-missing">URL未登録（データ履歴のファイル名でDriveを確認）</span>}
              </p>
            ) : null;
          })()}
          <button className="button" type="button" disabled={busy} onClick={() => void onRun({ action: "approve" }, "校正を承認しました。")}>
            校正を承認する
          </button>
          <ReProofForm busy={busy} onSubmit={(comment) => void onRun({ action: "request-re-proof", comment }, "再校正を依頼しました。")} />
        </div>
      ) : null}
      {order.status === "final_approved" ? (
        <div className="film-order-inline-actions">
          <p className="film-order-final">最終承認済み（カネイ貿易の最終受注処理が確定）。{order.po_sent_at ? "発注書は送信済みです。" : "発注書をメーカーへ送信してください。"}</p>
          {isKanei && !order.po_sent_at ? (
            <button className="button" type="button" disabled={busy} onClick={() => void onRun({ action: "send-po" }, "発注書をメーカーへ送信しました。納期入力フォームを案内しました。")}>
              発注書をメーカーへ送信
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
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
      <div className="no-print film-order-sheet-head">
        <h3>発注内容（フィルム仕様）</h3>
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
          <div className="table-scroll">
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
          </div>
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
      <h3>仕入先・校正担当</h3>
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

function ReceivingForm({
  order,
  autofocus,
  busy,
  driveReady,
  onSubmit,
}: {
  order: FilmOrderView;
  autofocus?: boolean;
  busy?: boolean;
  driveReady: boolean;
  onSubmit: (aiFileName: string, aiFileUrl: string, pdfFileName: string, pdfFileUrl: string, note: string) => void;
}) {
  const baseName = buildFilmOrderFileName(order, "receiving", 1);
  const [aiFileName, setAiFileName] = useState(`${baseName}.ai`);
  const [aiFileUrl, setAiFileUrl] = useState("");
  const [pdfFileName, setPdfFileName] = useState(`${baseName}.pdf`);
  const [pdfFileUrl, setPdfFileUrl] = useState("");
  const [withPdf, setWithPdf] = useState(true);
  const [note, setNote] = useState("");
  return (
    <div className="film-order-file-form">
      <strong>入稿データ登録（フィルム製作用）</strong>
      {!driveReady ? <p className="film-order-upload-hint">直接アップロードは未設定です。Driveへ手動アップロード後、URLを入力してください。</p> : null}
      <DriveFileField
        label="AIファイル（必須）"
        orderId={order.id}
        category="receiving"
        fileName={aiFileName}
        onFileNameChange={setAiFileName}
        url={aiFileUrl}
        onUrlChange={setAiFileUrl}
        accept=".ai"
        required
        autofocus={autofocus}
        driveReady={driveReady}
      />
      <label className="film-order-pdf-toggle">
        <input type="checkbox" checked={withPdf} onChange={(event) => setWithPdf(event.target.checked)} />
        PDFも登録する（任意）
      </label>
      {withPdf ? (
        <DriveFileField
          label="PDFファイル"
          orderId={order.id}
          category="receiving"
          fileName={pdfFileName}
          onFileNameChange={setPdfFileName}
          url={pdfFileUrl}
          onUrlChange={setPdfFileUrl}
          accept=".pdf"
          driveReady={driveReady}
        />
      ) : null}
      <label>メモ<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" /></label>
      <button
        className="button"
        type="button"
        disabled={busy || !aiFileName.trim().toLowerCase().endsWith(".ai")}
        onClick={() => onSubmit(aiFileName.trim(), aiFileUrl.trim(), withPdf ? pdfFileName.trim() : "", withPdf ? pdfFileUrl.trim() : "", note)}
      >
        入稿してデザインへ連絡
      </button>
    </div>
  );
}

function FileActionForm({
  title,
  defaultFileName,
  submitLabel,
  busy,
  autofocus,
  driveReady,
  orderId,
  category,
  onSubmit,
}: {
  title: string;
  defaultFileName: string;
  submitLabel: string;
  busy?: boolean;
  autofocus?: boolean;
  driveReady?: boolean;
  orderId?: number;
  category?: "receiving" | "proof";
  onSubmit: (fileName: string, note: string, fileUrl: string) => void;
}) {
  const [fileName, setFileName] = useState(defaultFileName);
  const [fileUrl, setFileUrl] = useState("");
  const [note, setNote] = useState("");
  return (
    <div className="film-order-file-form">
      <strong>{title}</strong>
      {orderId && category ? (
        <DriveFileField
          label="ファイル"
          orderId={orderId}
          category={category}
          fileName={fileName}
          onFileNameChange={setFileName}
          url={fileUrl}
          onUrlChange={setFileUrl}
          driveReady={driveReady === true}
          autofocus={autofocus}
        />
      ) : (
        <>
          <label>ファイル名
            <input value={fileName} onChange={(event) => setFileName(event.target.value)} autoFocus={autofocus} />
          </label>
          <label>ファイルURL（任意）
            <input value={fileUrl} onChange={(event) => setFileUrl(event.target.value)} placeholder="https://drive.google.com/..." inputMode="url" />
          </label>
        </>
      )}
      <label>メモ<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" /></label>
      <button className="button" type="button" disabled={busy || !fileName.trim()} onClick={() => onSubmit(fileName.trim(), note, fileUrl.trim())}>
        {submitLabel}
      </button>
    </div>
  );
}

function DriveFileField({
  label,
  orderId,
  category,
  fileName,
  onFileNameChange,
  url,
  onUrlChange,
  accept,
  required,
  autofocus,
  driveReady,
}: {
  label: string;
  orderId: number;
  category: "receiving" | "proof";
  fileName: string;
  onFileNameChange: (value: string) => void;
  url: string;
  onUrlChange: (value: string) => void;
  accept?: string;
  required?: boolean;
  autofocus?: boolean;
  driveReady: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [error, setError] = useState("");

  const pickFile = (selected: File | null) => {
    setFile(selected);
    setUploaded(false);
    setError("");
    if (selected) {
      const dot = fileName.lastIndexOf(".");
      const extension = selected.name.includes(".") ? selected.name.slice(selected.name.lastIndexOf(".")) : "";
      onFileNameChange(dot > 0 ? `${fileName.slice(0, dot)}${extension}` : fileName);
    }
  };

  const upload = async () => {
    if (!file || uploading) return;
    setUploading(true);
    setError("");
    try {
      const sessionResponse = await fetch(`/api/film-orders/${orderId}/upload-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          fileName: fileName.trim(),
          sizeBytes: file.size,
          contentType: file.type || "application/octet-stream",
        }),
      });
      const session = await sessionResponse.json() as { sessionUri?: string; error?: string };
      if (!sessionResponse.ok || !session.sessionUri) throw new Error(session.error ?? "session_failed");
      const put = await fetch(session.sessionUri, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!put.ok) throw new Error(`upload_failed:${put.status}`);
      const completeResponse = await fetch(`/api/film-orders/${orderId}/upload-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, fileName: fileName.trim() }),
      });
      const complete = await completeResponse.json() as { url?: string; error?: string };
      if (!completeResponse.ok || !complete.url) throw new Error(complete.error ?? "complete_failed");
      onUrlChange(complete.url);
      setUploaded(true);
    } catch (err) {
      setError(err instanceof Error ? `アップロード失敗: ${err.message}` : "アップロードに失敗しました。");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="film-order-drive-field">
      <label>{label}
        <input value={fileName} onChange={(event) => { onFileNameChange(event.target.value); setUploaded(false); }} autoFocus={autofocus} />
      </label>
      <label>ファイル選択
        <input type="file" accept={accept} onChange={(event) => pickFile(event.target.files?.[0] ?? null)} />
      </label>
      {driveReady ? (
        <button className="button secondary small" type="button" disabled={!file || uploading || uploaded} onClick={() => void upload()}>
          {uploaded ? "アップロード済み ✓" : uploading ? "アップロード中..." : "Driveへアップロード"}
        </button>
      ) : null}
      {uploaded && url ? <a href={url} target="_blank" rel="noreferrer">アップロード済みファイルを開く</a> : null}
      <label>URL（手動入力・{required ? "アップロード時は自動設定" : "任意"}）
        <input value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder="https://drive.google.com/..." inputMode="url" />
      </label>
      {error ? <p className="film-order-upload-error">{error}</p> : null}
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
      <strong>再校正依頼</strong>
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
