"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  FILM_ORDER_STATUSES,
  buildFilmOrderFileName,
  filmOrderStatusLabels,
  customerDesignStatusLabels,
  customerProofStatusLabels,
  sampleBulkStatusLabels,
  type FilmOrderStatus,
  type FilmOrderView,
} from "@/lib/film-order-shared";
import {
  buyerDomainOf,
  isKaneiTradeUser,
  isSevenChemicalUser,
  supplierLocaleFor,
} from "@/lib/film-order-access";
import { D } from "@/lib/decimal";
import { filmQuotationNumberFor } from "@/lib/film-quotation";

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
  receiving_registered: "メーカー校正データの返却待ちです。返却後に金井貿易が登録します。",
  proof_registered: "セブン化学が校正を承認、または再校正を依頼します。",
  re_proof_requested: "金井貿易が再校正データを登録します。",
  final_approved: "ワークフロー完了です。",
};

type FilmOrderCompany = "seven" | "kanei";

function buyerCompanyOf(order: Pick<FilmOrderView, "buyer_domain" | "created_by_email">): FilmOrderCompany {
  if (order.buyer_domain === "727.co.jp") return "seven";
  if (order.buyer_domain === "kanei-trade.co.jp") return "kanei";
  return buyerDomainOf(order.created_by_email);
}

function companyLabel(company: FilmOrderCompany): string {
  return company === "seven" ? "セブン化学" : "金井貿易";
}

function canOperate(company: FilmOrderCompany, isSeven: boolean, isKanei: boolean): boolean {
  return company === "seven" ? isSeven : isKanei;
}

export function filmOrderStepRole(
  order: Pick<FilmOrderView, "buyer_domain" | "created_by_email">,
  status: FilmOrderStatus,
): FilmOrderCompany | "none" {
  const buyer = buyerCompanyOf(order);
  if (status === "pending" || status === "ordered" || status === "proof_registered") return buyer;
  if (status === "receiving_registered" || status === "re_proof_requested") return "kanei";
  return "none";
}

type NextAction =
  | { kind: "run"; label: string; body: Record<string, unknown>; ok: string }
  | { kind: "form"; label: string; form: "receiving" | "proof" }
  | { kind: "none"; label: string };

export function nextActionOf(order: FilmOrderView, isSeven: boolean, isKanei: boolean): NextAction {
  const buyer = buyerCompanyOf(order);
  const buyerCanOperate = canOperate(buyer, isSeven, isKanei);
  switch (order.status) {
    case "pending":
      return buyerCanOperate
        ? { kind: "run", label: "発注書送信済みにする", body: { action: "mark-ordered" }, ok: "発注書送信済みにしました。" }
        : { kind: "none", label: `${companyLabel(buyer)}の発注書送信待ち` };
    case "ordered":
      return buyerCanOperate
        ? { kind: "form", label: "入稿データを登録", form: "receiving" }
        : { kind: "none", label: `${companyLabel(buyer)}の入稿登録待ち` };
    case "receiving_registered":
      return isKanei
        ? { kind: "form", label: "校正データを登録", form: "proof" }
        : { kind: "none", label: "金井貿易の校正データ登録待ち" };
    case "proof_registered":
      return buyerCanOperate
        ? { kind: "run", label: "校正を承認する", body: { action: "approve" }, ok: "校正を承認しました。" }
        : { kind: "none", label: `${companyLabel(buyer)}の承認待ち` };
    case "re_proof_requested":
      return isKanei
        ? { kind: "form", label: "再校正データを登録", form: "proof" }
        : { kind: "none", label: "金井貿易の再校正データ登録待ち" };
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
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const [detailError, setDetailError] = useState("");
  const [focusForm, setFocusForm] = useState<{ id: number; kind: "receiving" | "proof" } | null>(null);
  const [driveReady, setDriveReady] = useState(false);
  const isSeven = isSevenChemicalUser(userEmail);
  const isKanei = isKaneiTradeUser(userEmail);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/film-orders", {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.orders)) throw new Error();
      setOrders(payload.orders as FilmOrderView[]);
      setCreated(Number(payload.created ?? 0));
      setDriveReady(payload.driveConfigured === true);
    } catch (error) {
      setError(error instanceof DOMException && error.name === "TimeoutError"
        ? "発注データの取得がタイムアウトしました。更新してください。"
        : "発注データを読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: number) => {
    setDetailLoadingId(id);
    setDetailError("");
    try {
      const response = await fetch(`/api/film-orders/${id}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json();
      if (!response.ok || !payload.order) throw new Error();
      const order = payload.order as FilmOrderView;
      setOrders((old) => old.map((item) => item.id === id ? order : item));
    } catch (error) {
      setDetailError(error instanceof DOMException && error.name === "TimeoutError"
        ? "発注詳細の取得がタイムアウトしました。更新してください。"
        : "発注詳細を読み込めませんでした。");
    } finally {
      setDetailLoadingId((current) => current === id ? null : current);
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

  const toggleOrder = (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      setFocusForm(null);
      return;
    }
    setExpandedId(id);
    void loadDetail(id);
  };

  const expandWithForm = (id: number, kind: "receiving" | "proof") => {
    toggleOrder(id);
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
            {isSeven ? "セブン化学" : "金井貿易"}
          </span>
          <span className="film-orders-myturn" role="status" aria-live="polite">
            あなたの操作待ち <strong>{myTurnCount}</strong> 件
          </span>
          <button className="button secondary small" type="button" onClick={() => {
            void load().then(() => {
              if (expandedId != null) return loadDetail(expandedId);
            });
          }}>
            {loading ? "読み込み中..." : "更新"}
          </button>
        </div>
      </header>
      <p className="film-orders-lead">成約見積から自動作成された発注を、ステップに沿って管理します。</p>

      <div className="film-orders-alerts">
        {created > 0 ? <p className="film-orders-sync">成約見積 {created} 件を発注管理に反映しました。</p> : null}
        {error ? <p className="film-orders-error">{error}</p> : null}
        {detailError ? <p className="film-orders-error">{detailError}</p> : null}
      </div>

      <details className="film-order-guide">
        <summary>{isSeven ? "セブン化学担当者の流れ" : "金井貿易担当者の流れ"}</summary>
        {isSeven ? (
          <ol>
            <li>見積履歴で見積を「成約」にすると、ここに発注が自動作成されます。</li>
            <li>発注内容を確認し、発注書をメールで金井貿易へ送付したら「発注書送信済みにする」を押します。</li>
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
            loadingDetail={detailLoadingId === order.id}
            onToggle={() => toggleOrder(order.id)}
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
  loadingDetail,
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
  loadingDetail: boolean;
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
        body: JSON.stringify({ origin: window.location.origin, ...body }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.order) throw new Error(payload.error ?? "failed");
      onUpdated(order.id, payload as { order: FilmOrderView });
      setMails((payload.mails ?? []) as MailResult[]);
      setMessage(okMessage);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "failed";
      const humanMessages: Record<string, string> = {
        invalid_ai_file: "AIファイルが必要です。.ai ファイルを選択してください。",
        invalid_pdf_file: "PDFファイル名が不正です。.pdf ファイルをアップロードするか、PDFチェックを外してください。",
        invalid_pdf_file_url: "PDFのDriveアップロードが完了していません。完了後に登録してください。",
        invalid_ai_file_url: "AIのDriveアップロードが完了していません。完了後に登録してください。",
        invalid_file_url: "ファイルURLが正しくありません。",
      };
      setMessage(error instanceof Error && error.message !== "failed"
        ? `失敗しました（${humanMessages[error.message] ?? error.message}）`
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

      <OrderSteps order={order} status={order.status} reProofCount={order.re_proof_count} poSent={Boolean(order.po_sent_at)} etaDate={order.eta_date} />
      {order.eta_date ? (
        <div className="film-order-eta-row">
          <span className="film-order-eta-badge">納期見込み {order.eta_date}</span>
          {order.eta_note ? <small>{order.eta_note}</small> : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="film-order-detail">
          {loadingDetail ? <p className="film-order-message" role="status">詳細データを読み込み中...</p> : null}
          {loadingDetail ? null : (
          <>
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
            </div>
          </div>

          <SampleBulkPanel order={order} isSeven={isSeven} isKanei={isKanei} busy={busy} onRun={run} />
          <CustomerDesignPanel order={order} isKanei={isKanei} busy={busy} onRun={run} />
          <CustomerProofPanel order={order} isKanei={isKanei} busy={busy} onRun={run} />

          <section className="film-order-section">
            <h3>入稿・校正データ履歴</h3>
            {order.files.length === 0 ? <p>まだ登録されていません。</p> : (
              <div className="table-scroll">
                <table className="film-order-files">
                  <thead><tr><th>種別</th><th>ファイル名</th><th>リンク</th><th>プレビュー</th><th>v</th><th>登録者</th><th>日時</th></tr></thead>
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
          </>
          )}
        </div>
      ) : null}
    </article>
  );
}

function OrderSteps({
  order,
  status,
  reProofCount,
  poSent,
  etaDate,
}: {
  order: FilmOrderView;
  status: FilmOrderStatus;
  reProofCount: number;
  poSent: boolean;
  etaDate: string | null;
}) {
  const effective = poSent ? "po_sent" : etaDate ? "eta" : status;
  const activeIndex = status === "re_proof_requested"
    ? STEP_DEFS.findIndex((step) => step.key === "proof_registered")
    : STEP_DEFS.findIndex((step) => step.key === effective);
  const nextRole = filmOrderStepRole(order, status);
  return (
    <div className="film-order-steps" aria-label="進捗">
      {STEP_DEFS.map((step, index) => (
        <span key={step.key} className={`film-order-step ${index < activeIndex ? "done" : index === activeIndex ? "active" : ""}`}>
          <em>{index + 1}</em>{step.label}
        </span>
      ))}
      {status === "re_proof_requested" ? <span className="film-order-reproof">再校正 {reProofCount}回目</span> : null}
      {status !== "final_approved" && nextRole !== "none" ? (
        <span className={`film-order-step-role ${nextRole}`}>{nextRole === "seven" ? "次の操作: セブン化学" : "次の操作: 金井貿易"}</span>
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
  const proofFileCount = order.files.filter((file) => file.category === "proof").length;
  const proofVersion = Math.floor(proofFileCount / 2) + 1;
  return (
    <section className={`film-order-section next-step ${next.kind === "none" ? "waiting" : "mine"}`}>
      <p className="next-step-kicker">{next.kind === "none" ? "WAITING" : "NEXT STEP"}</p>
      <h3>{STATUS_HINTS[order.status]}</h3>
      {order.status === "receiving_registered" && isSeven ? (
        <div className="next-step-submitted">
          <p>入稿済みデータ:</p>
          <ul>
            {order.files.filter((file) => file.category === "receiving").map((file) => (
              <li key={file.id}>
                {file.file_name}
                {file.url ? <a href={file.url} target="_blank" rel="noreferrer">開く</a> : null}
              </li>
            ))}
          </ul>
          <p className="next-step-note">↑ 修正・追加がある場合は再度「入稿データを登録」で上書きせず追加登録できます。</p>
        </div>
      ) : null}
      {next.kind === "none" && order.status !== "final_approved" ? (
        <div className="next-step-wait">
          <p>{next.label}</p>
          <button className="button small" type="button" disabled title="担当部署のみ操作できます">
            {filmOrderStepRole(order, order.status) === "seven" ? "入稿・承認操作（セブン化学）" : "校正データ操作（金井貿易）"}
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
      {order.status === "receiving_registered" && buyerCompanyOf(order) === "seven" && isSeven ? (
        <details className="film-order-additional">
          <summary>入稿データを追加する</summary>
          <FileActionForm
            title="入稿データ 追加登録"
            submitLabel="追加登録"
            defaultFileName={`${buildFilmOrderFileName(order, "receiving", (order.files.filter((f) => f.category === "receiving").length ?? 0) + 1)}`}
            busy={busy}
            orderId={order.id}
            category="receiving"
            onSubmit={(fileName, note, fileUrl) => {
              void onRun(
                { action: "register-receiving-extra", fileName, fileUrl, note },
                "入稿データを追加登録しました。",
              );
            }}
          />
        </details>
      ) : null}
      {next.kind === "form" && next.form === "proof" ? (
        <div className="film-order-inline-actions">
          {order.status === "receiving_registered" ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => void onRun({ action: "send-proof-notice" }, "校正アップロード案内を送信しました。")}>
              校正アップロード案内を送信
            </button>
          ) : null}
          <ProofRegistrationForm
            title={order.status === "re_proof_requested" ? "再校正データ登録" : "校正データ登録"}
            autofocus={focused === "proof"}
            driveReady={driveReady}
            order={order}
            version={proofVersion}
            submitLabel={order.status === "re_proof_requested" ? "再校正データを登録" : "校正データを登録"}
            onSubmit={(aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note) =>
              void onRun({ action: "register-proof", aiFileName, aiFileUrl, pdfFileName, pdfFileUrl, note }, "校正データを登録しました。")}
          />
        </div>
      ) : null}
      {order.status === "proof_registered" && canOperate(buyerCompanyOf(order), isSeven, isKanei) ? (
        <div className="film-order-inline-actions">
          {(() => {
            const proofs = order.files.filter((f) => f.category === "proof").sort((a, b) => b.version - a.version);
            const latest = proofs[0];
            if (!latest?.url) return null;
            const fileId = latest.url.split("/d/")[1]?.split("/")[0];
            if (!fileId) return null;
            const isPdf = latest.file_name.toLowerCase().endsWith(".pdf");
            return (
              <div className="film-order-proof-preview">
                <p className="film-order-preview-label">最新校正データ: {latest.file_name} (v{latest.version})</p>
                {isPdf ? (
                  <iframe
                    src={`/api/film-orders/preview?fileId=${encodeURIComponent(fileId)}`}
                    className="film-order-preview-iframe"
                    title="校正データプレビュー"
                  />
                ) : (
                  <p className="film-order-preview-note">AI形式はブラウザプレビュー不可。ダウンロードして確認してください。</p>
                )}
              </div>
            );
          })()}
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
          <ReProofForm
            order={order}
            busy={busy}
            onSubmit={({ internalComment, supplierMessage }) => void onRun({ action: "request-re-proof", comment: internalComment, supplierMessage }, "再校正を依頼しました。")}
          />
        </div>
      ) : null}
      {order.status === "final_approved" ? (
        <div className="film-order-inline-actions">
          <p className="film-order-final">最終承認済み（金井貿易の最終受注処理が確定）。{order.po_sent_at ? "発注書は送信済みです。" : "発注書をメーカーへ送信してください。"}</p>
          <div className="film-delivery-summary">
            <span>出荷: {order.delivery.shippedOn ?? "未報告"}</span>
            <span>納品: {order.delivery.deliveredOn ?? "未報告"}</span>
            <span>受領: {order.delivery.receivedAt ? new Date(order.delivery.receivedAt).toLocaleDateString("ja-JP") : "未確認"}</span>
            {order.delivery.carrier ? <small>{order.delivery.carrier}{order.delivery.trackingNumber ? ` / ${order.delivery.trackingNumber}` : ""}</small> : null}
            {order.delivery.deliveryDocumentUrl ? <a href={order.delivery.deliveryDocumentUrl} target="_blank" rel="noreferrer">{order.delivery.deliveryDocumentName || "納品書"}</a> : null}
          </div>
          {isKanei && !order.po_sent_at ? (
            <button className="button" type="button" disabled={busy} onClick={() => void onRun({ action: "send-po" }, "発注書をメーカーへ送信しました。納期入力フォームを案内しました。")}>
              発注書をメーカーへ送信
            </button>
          ) : null}
          {isKanei && order.po_sent_at ? (
            <button className="button secondary" type="button" disabled={busy} onClick={() => void onRun({ action: "send-po" }, "発注書URLを再発行し、メーカーへ再送しました。")}>
              発注書URLを再発行して再送
            </button>
          ) : null}
          {canOperate(buyerCompanyOf(order), isSeven, isKanei) && order.delivery.deliveredOn && !order.delivery.receivedAt ? (
            <FilmReceiptConfirmForm busy={busy} onSubmit={(note) => void onRun({ action: "confirm-film-receipt", note }, "フィルムの受領を確認しました。")} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function FilmReceiptConfirmForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(note.trim()); }}>
      <label>受領メモ（任意）
        <textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "確認中..." : "フィルムを受領確認する"}</button>
    </form>
  );
}

function CustomerDesignPanel({
  order,
  isKanei,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  isKanei: boolean;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const design = order.customerDesign;
  const files = order.files.filter((file) => file.category === "customer_design");
  return (
    <section className="film-order-section" aria-label="顧客デザイン管理" data-testid="customer-design-panel">
      <h3>顧客デザイン管理</h3>
      <div className="film-order-columns">
        <dl>
          <div><dt>状態</dt><dd data-testid="customer-design-status">{customerDesignStatusLabels[design.status]}</dd></div>
          <div><dt>依頼日時</dt><dd>{design.requestedAt ? new Date(design.requestedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div><dt>受領日時</dt><dd>{design.receivedAt ? new Date(design.receivedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div><dt>確定日時</dt><dd>{design.confirmedAt ? new Date(design.confirmedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          {design.correctionReason ? <div><dt>修正理由</dt><dd>{design.correctionReason}</dd></div> : null}
        </dl>
        <div className="film-order-inline-actions">
          {files.length ? (
            <ul>
              {files.map((file) => <li key={file.id}>v{file.version} / {file.file_name}</li>)}
            </ul>
          ) : <p>まだアップロードはありません。</p>}
          {isKanei && design.status === "pending" ? (
            <CustomerDesignRequestForm busy={busy} onSubmit={(note) => void onRun({ action: "request-customer-design-upload", note }, "顧客デザイン依頼を送信しました。")} />
          ) : null}
          {isKanei && design.status === "received" ? (
            <>
              <button className="button" type="button" disabled={busy} onClick={() => void onRun({ action: "confirm-customer-design" }, "顧客デザインを確定しました。")}>確定する</button>
              <CustomerDesignCorrectionForm busy={busy} onSubmit={({ internalReason, customerMessage }) => void onRun({ action: "request-customer-design-correction", reason: internalReason, customerMessage }, "顧客修正依頼を送信しました。")} />
            </>
          ) : null}
          {isKanei && ["pending","requested","received","correction_requested"].includes(design.status) ? (
            <CustomerDesignNotRequiredForm busy={busy} onSubmit={(reason) => void onRun({ action: "set-customer-design-not-required", reason }, "顧客デザインを不要に設定しました。")} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CustomerDesignRequestForm({ busy, onSubmit }: { busy: boolean; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(note.trim()); }}>
      <label>依頼メモ（任意）<textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} /></label>
      <button className="button" type="submit" disabled={busy}>{busy ? "送信中..." : "顧客にアップロード依頼"}</button>
    </form>
  );
}

function CustomerDesignCorrectionForm({ busy, onSubmit }: { busy: boolean; onSubmit: (values: { internalReason: string; customerMessage: string }) => void }) {
  const [internalReason, setInternalReason] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ internalReason: internalReason.trim(), customerMessage: customerMessage.trim() }); }}>
      <label>内部確認メモ（任意）<textarea value={internalReason} rows={2} onChange={(event) => setInternalReason(event.target.value)} /></label>
      <label>顧客向けメッセージ（日本語推奨・한국어も可）<textarea value={customerMessage} rows={3} onChange={(event) => setCustomerMessage(event.target.value)} required /></label>
      <button className="button secondary" type="submit" disabled={busy}>{busy ? "送信中..." : "修正を依頼"}</button>
    </form>
  );
}

function CustomerDesignNotRequiredForm({ busy, onSubmit }: { busy: boolean; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <details>
      <summary className="button secondary small">顧客デザイン不要にする</summary>
      <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(reason.trim()); }}>
        <label>理由<textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} required /></label>
        <button className="button danger" type="submit" disabled={busy}>設定</button>
      </form>
    </details>
  );
}

function CustomerProofPanel({
  order,
  isKanei,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  isKanei: boolean;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const review = order.customerProof;
  const latestProof = order.files
    .filter((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf"))
    .at(-1);
  return (
    <section className="film-order-section" aria-label="顧客校正レビュー" data-testid="customer-proof-panel">
      <h3>顧客校正レビュー</h3>
      <div className="film-order-columns">
        <dl>
          <div><dt>状態</dt><dd data-testid="customer-proof-status">{customerProofStatusLabels[review.status]}</dd></div>
          <div><dt>依頼日時</dt><dd>{review.requestedAt ? new Date(review.requestedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div><dt>承認日時</dt><dd>{review.approvedAt ? new Date(review.approvedAt).toLocaleString("ja-JP") : "-"}</dd></div>
          <div><dt>最新校正</dt><dd>{latestProof ? `v${latestProof.version} / ${latestProof.file_name}` : "-"}</dd></div>
          {review.correctionReason ? <div><dt>顧客修正依頼</dt><dd>{review.correctionReason}</dd></div> : null}
        </dl>
        <div className="film-order-inline-actions">
          {isKanei && order.status === "proof_registered" && latestProof && ["pending","requested","correction_requested"].includes(review.status) ? (
            <button className="button" type="button" disabled={busy} onClick={() => void onRun({ action: "send-customer-proof-review" }, "顧客校正レビュー依頼を送信しました。")}>
              顧客レビューリンク送信
            </button>
          ) : null}
          {isKanei && ["receiving_registered","re_proof_requested"].includes(order.status) ? (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              title="기존 업로드 링크를 폐기하고 새 링크로 재안내합니다."
              onClick={() => void onRun({ action: "rotate-supplier-proof-token" }, "업로드 링크를 강제 재발급하고 재안내했습니다.")}
            >
              업로드 링크 강제 재발급
            </button>
          ) : null}
          {isKanei && order.status === "proof_registered" && ["pending","requested"].includes(review.status) ? (
            <CustomerProofOfflineForm busy={busy} onSubmit={(approverName, evidence) => void onRun({ action: "record-customer-proof-approval", approverName, evidence }, "オフライン承認を記録しました。")} />
          ) : null}
          {review.status === "approved" ? <p className="film-order-final">顧客承認済み。Seven最終承認に進めます。</p> : null}
          {order.status === "proof_registered" && ["pending","requested","correction_requested"].includes(review.status) ? (
            <p className="film-order-final">顧客承認前に最終承認はできません。</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function CustomerProofOfflineForm({ busy, onSubmit }: { busy: boolean; onSubmit: (approverName: string, evidence: string) => void }) {
  const [approverName, setApproverName] = useState("");
  const [evidence, setEvidence] = useState("");
  return (
    <details>
      <summary className="button secondary small">オフライン承認を記録</summary>
      <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(approverName.trim(), evidence.trim()); }}>
        <label>承認者<input value={approverName} onChange={(event) => setApproverName(event.target.value)} required /></label>
        <label>証拠・経緯<textarea value={evidence} rows={3} onChange={(event) => setEvidence(event.target.value)} required /></label>
        <button className="button" type="submit" disabled={busy}>記録</button>
      </form>
    </details>
  );
}

function OrderSheet({ order }: { order: FilmOrderView }) {
  const po = order.purchaseOrder;
  const filmTotal = D(po?.filmCostYen ?? "0");
  const copperTotal = po?.copperPlate ? D(po.copperPlate.priceYen) : D(0);
  const moldTotal = po?.customMold ? D(po.customMold.costYen) : D(0);
  const orderTotal = filmTotal.plus(copperTotal).plus(moldTotal);
  const yen = (value: ReturnType<typeof D>) => `￥${Number(value.toFixed(0)).toLocaleString("ja-JP")}`;
  const filmQuotationNumber = filmQuotationNumberFor(order.quotation_number, order.created_at);
  return (
    <section className="film-order-section film-order-sheet" aria-label="発注内容">
      <div className="no-print film-order-sheet-head">
        <h3>発注内容（フィルム仕様）</h3>
        <div className="film-order-sheet-actions">
          <Link
            className="button secondary small"
            href={`/history?record=${order.quotation_id}&tab=film`}
            target="_blank"
            data-testid="open-film-quotation"
          >
            フィルム見積書
          </Link>
          <button className="button secondary small" type="button" onClick={() => window.print()}>発注書を印刷</button>
        </div>
      </div>
      <div className="film-order-sheet-body">
        <h2>フィルム発注書</h2>
        <dl>
          <div><dt>発注番号</dt><dd>{order.order_number}</dd></div>
          <div><dt>見積番号</dt><dd>{order.quotation_number}</dd></div>
          <div><dt>フィルム見積番号</dt><dd>{filmQuotationNumber}</dd></div>
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
        <p className="film-order-sheet-note">発注書はセブン化学から金井貿易へメールで送付してください。送信後に「発注書送信済みにする」でステータスを進めます。</p>
      </div>
    </section>
  );
}

function SampleBulkPanel({
  order,
  isSeven,
  isKanei,
  busy,
  onRun,
}: {
  order: FilmOrderView;
  isSeven: boolean;
  isKanei: boolean;
  busy: boolean;
  onRun: (body: Record<string, unknown>, ok: string) => Promise<void>;
}) {
  const bulk = order.sampleBulk;
  const ml = (value: string | null | undefined) => value
    ? `${Number(value).toLocaleString("ja-JP")}ml`
    : "-";
  return (
    <section className="film-order-section" aria-label="サンプルバルク支給管理" data-testid="sample-bulk-panel">
      <h3>サンプルバルク支給管理</h3>
      <div className="film-order-columns">
        <dl>
          <div><dt>状態</dt><dd data-testid="sample-bulk-status">{sampleBulkStatusLabels[bulk.status]}</dd></div>
          {Number(bulk.productionBulkUsageMl || 0) > 0 ? <div><dt>本生産用バルク量（参考）</dt><dd>{ml(bulk.productionBulkUsageMl)}</dd></div> : null}
          <div><dt>サンプル依頼量</dt><dd>{ml(bulk.sampleQuantityMl)}</dd></div>
          <div><dt>サンプル受領量</dt><dd>{ml(bulk.sampleReceivedMl)}</dd></div>
          {bulk.sampleAdjustedMl ? <div><dt>変更希望サンプル量</dt><dd>{ml(bulk.sampleAdjustedMl)}</dd></div> : null}
          <div><dt>送付先</dt><dd>{bulk.recipientName}<br />{bulk.recipientPostalCode} {bulk.recipientAddress}</dd></div>
          {bulk.adjustmentReason ? <div><dt>変更理由</dt><dd>{bulk.adjustmentReason}</dd></div> : null}
        </dl>

        <div className="film-order-inline-actions">
          {bulk.status === "pending" && isKanei ? (
            <SampleBulkRequestForm busy={busy} onSubmit={(sampleQuantityMl, note) => void onRun({ action: "request-sample-bulk", sampleQuantityMl, note }, "サンプルバルク送付依頼を送信しました。")} />
          ) : null}

          {(bulk.status === "requested" || bulk.status === "adjustment_requested") && isSeven ? (
            <SampleBulkReceiveForm
              busy={busy}
              expectedMl={bulk.sampleAdjustedMl ?? bulk.sampleQuantityMl ?? ""}
              onSubmit={(receivedMl, note) => void onRun({ action: "register-sample-bulk", receivedMl, note }, "バルクサンプルを受領登録しました。")}
            />
          ) : null}

          {bulk.status === "received" && isKanei ? (
            <>
              <button className="button" type="button" disabled={busy} onClick={() => void onRun({ action: "confirm-sample-bulk" }, "サンプル量を確認しました。")}>
                サンプル量OKとして確認
              </button>
              <SampleBulkAdjustmentForm
                busy={busy}
                receivedMl={bulk.sampleReceivedMl}
                onSubmit={({ adjustedMl, internalReason, customerMessage }) => void onRun({ action: "request-sample-bulk-adjustment", adjustedMl, reason: internalReason, customerMessage }, "サンプル量変更依頼を送信しました。")}
              />
            </>
          ) : null}

          {bulk.status === "confirmed" ? <p className="film-order-final">サンプル量は確認済みです。</p> : null}
          {bulk.status === "not_required" ? <p className="film-order-final">この案件はサンプルバルク支給が不要です。</p> : null}
        </div>
      </div>
    </section>
  );
}

function SampleBulkRequestForm({ busy, onSubmit }: { busy: boolean; onSubmit: (sampleQuantityMl: string, note: string) => void }) {
  const [sampleQuantityMl, setSampleQuantityMl] = useState("");
  const [note, setNote] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(sampleQuantityMl.trim(), note.trim()); }}>
      <label>サンプル支給量 (ml)
        <input value={sampleQuantityMl} inputMode="decimal" onChange={(event) => setSampleQuantityMl(event.target.value)} required />
      </label>
      <label>依頼メモ（任意）
        <textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "送信中..." : "サンプル送付を依頼"}</button>
    </form>
  );
}

function SampleBulkReceiveForm({
  busy,
  expectedMl,
  onSubmit,
}: {
  busy: boolean;
  expectedMl: string;
  onSubmit: (receivedMl: string, note: string) => void;
}) {
  const [receivedMl, setReceivedMl] = useState(expectedMl);
  const [note, setNote] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit(receivedMl.trim(), note.trim()); }}>
      <label>受領量 (ml)
        <input value={receivedMl} inputMode="decimal" onChange={(event) => setReceivedMl(event.target.value)} required />
      </label>
      <label>受領メモ（任意）
        <textarea value={note} rows={2} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button className="button" type="submit" disabled={busy}>{busy ? "登録中..." : "受領を登録"}</button>
    </form>
  );
}

function SampleBulkAdjustmentForm({
  busy,
  receivedMl,
  onSubmit,
}: {
  busy: boolean;
  receivedMl: string | null;
  onSubmit: (values: { adjustedMl: string; internalReason: string; customerMessage: string }) => void;
}) {
  const [adjustedMl, setAdjustedMl] = useState(receivedMl ?? "");
  const [internalReason, setInternalReason] = useState("");
  const [customerMessage, setCustomerMessage] = useState("");
  return (
    <form className="film-order-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ adjustedMl: adjustedMl.trim(), internalReason: internalReason.trim(), customerMessage: customerMessage.trim() }); }}>
      <label>変更希望量 (ml)
        <input value={adjustedMl} inputMode="decimal" onChange={(event) => setAdjustedMl(event.target.value)} required />
      </label>
      <label>内部確認メモ（任意）<textarea value={internalReason} rows={2} onChange={(event) => setInternalReason(event.target.value)} /></label>
      <label>顧客向けメッセージ（日本語推奨・한국어も可）<textarea value={customerMessage} rows={3} onChange={(event) => setCustomerMessage(event.target.value)} required /></label>
      <button className="button secondary" type="submit" disabled={busy}>{busy ? "送信中..." : "変更依頼を送信"}</button>
    </form>
  );
}

function openPreview(url: string, fileName: string): void {
  const fileId = url.split("/d/")[1]?.split("/")[0];
  if (!fileId) return;
  window.open(`/api/film-orders/preview?fileId=${encodeURIComponent(fileId)}`, "_blank");
}

function isPreviewable(fileName: string): boolean {
  return /\.(pdf|png|jpe?g|gif|svg)$/iu.test(fileName);
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
  const [aiUploaded, setAiUploaded] = useState(false);
  const [pdfFileName, setPdfFileName] = useState(`${baseName}.pdf`);
  const [pdfFileUrl, setPdfFileUrl] = useState("");
  const [pdfUploaded, setPdfUploaded] = useState(false);
  const [withPdf, setWithPdf] = useState(true);
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value.trim());
  const aiReady = driveReady ? aiUploaded : isHttpUrl(aiFileUrl);
  const pdfReady = driveReady ? pdfUploaded : isHttpUrl(pdfFileUrl);
  const receivingReady = aiFileName.trim().toLowerCase().endsWith(".ai")
    && aiReady
    && (!withPdf || (pdfFileName.trim().toLowerCase().endsWith(".pdf") && pdfReady));
  const submitReceiving = () => {
    if (!receivingReady) {
      setFormError(
        driveReady
          ? "AIファイルはDriveへアップロードしてください。PDFを含める場合はPDFのアップロードも完了させてください。"
          : "AIファイルのDrive URLは必須です。PDFを含める場合はPDFのURLも入力してください。",
      );
      return;
    }
    setFormError("");
    onSubmit(aiFileName.trim(), aiFileUrl.trim(), withPdf ? pdfFileName.trim() : "", withPdf ? pdfFileUrl.trim() : "", note);
  };
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
        onUploadedChange={setAiUploaded}
        accept=".ai"
        autofocus={autofocus}
        driveReady={driveReady === true}
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
          onUploadedChange={setPdfUploaded}
          accept=".pdf"
          driveReady={driveReady === true}
        />
      ) : null}
      <label>メモ<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" /></label>
      {formError ? <p className="film-order-upload-error" role="alert">{formError}</p> : null}
      <button
        className="button"
        type="button"
        disabled={busy || !receivingReady}
        onClick={submitReceiving}
      >
        入稿してデザインへ連絡
      </button>
    </div>
  );
}

function ProofRegistrationForm({
  order,
  version,
  autofocus,
  busy,
  driveReady,
  title,
  submitLabel,
  onSubmit,
}: {
  order: FilmOrderView;
  version: number;
  autofocus?: boolean;
  busy?: boolean;
  driveReady?: boolean;
  title: string;
  submitLabel: string;
  onSubmit: (aiFileName: string, aiFileUrl: string, pdfFileName: string, pdfFileUrl: string, note: string) => void;
}) {
  const baseName = buildFilmOrderFileName(order, "proof", version);
  const [aiFileName, setAiFileName] = useState(`${baseName}.ai`);
  const [aiFileUrl, setAiFileUrl] = useState("");
  const [aiUploaded, setAiUploaded] = useState(false);
  const [pdfFileName, setPdfFileName] = useState(`${baseName}.pdf`);
  const [pdfFileUrl, setPdfFileUrl] = useState("");
  const [pdfUploaded, setPdfUploaded] = useState(false);
  const [withPdf, setWithPdf] = useState(true);
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value.trim());
  const aiReady = driveReady ? aiUploaded : isHttpUrl(aiFileUrl);
  const pdfReady = driveReady ? pdfUploaded : isHttpUrl(pdfFileUrl);
  const proofReady = aiFileName.trim().toLowerCase().endsWith(".ai")
    && aiReady
    && (!withPdf || (pdfFileName.trim().toLowerCase().endsWith(".pdf") && pdfReady));
  const submitProof = () => {
    if (!proofReady) {
      setFormError(
        driveReady
          ? "AIファイルはDriveへアップロードしてください。PDFを含める場合はPDFのアップロードも完了させてください。"
          : "AIファイルのDrive URLは必須です。PDFを含める場合はPDFのURLも入力してください。",
      );
      return;
    }
    setFormError("");
    onSubmit(aiFileName.trim(), aiFileUrl.trim(), withPdf ? pdfFileName.trim() : "", pdfFileUrl.trim(), note);
  };
  return (
    <div className="film-order-file-form">
      <strong>{title}</strong>
      {!driveReady ? <p className="film-order-upload-hint">直接アップロードは未設定です。Driveへ手動アップロード後、URLを入力してください。</p> : null}
      <DriveFileField
        label="AIファイル（必須）"
        orderId={order.id}
        category="proof"
        fileName={aiFileName}
        onFileNameChange={setAiFileName}
        url={aiFileUrl}
        onUrlChange={setAiFileUrl}
        onUploadedChange={setAiUploaded}
        accept=".ai"
        autofocus={autofocus}
        driveReady={driveReady === true}
      />
      <label className="film-order-pdf-toggle">
        <input type="checkbox" checked={withPdf} onChange={(event) => setWithPdf(event.target.checked)} />
        PDFも登録する（任意）
      </label>
      {withPdf ? (
        <DriveFileField
          label="PDFファイル"
          orderId={order.id}
          category="proof"
          fileName={pdfFileName}
          onFileNameChange={setPdfFileName}
          url={pdfFileUrl}
          onUrlChange={setPdfFileUrl}
          onUploadedChange={setPdfUploaded}
          accept=".pdf"
          driveReady={driveReady === true}
        />
      ) : null}
      <label>メモ<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="任意" /></label>
      <button
        className="button"
        type="button"
        disabled={busy || !aiFileName.trim().toLowerCase().endsWith(".ai")}
        onClick={() => onSubmit(aiFileName.trim(), aiFileUrl.trim(), withPdf ? pdfFileName.trim() : "", withPdf ? pdfFileUrl.trim() : "", note)}
      >
        {submitLabel}
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
  const [fileUploaded, setFileUploaded] = useState(false);
  const [formError, setFormError] = useState("");
  const isHttpUrl = (value: string) => /^https?:\/\//iu.test(value.trim());
  const fileReady = driveReady ? fileUploaded : isHttpUrl(fileUrl);
  const submitFile = () => {
    if (!fileReady) {
      setFormError(driveReady ? "ファイルをDriveへアップロードしてください。" : "ファイルのDrive URLを入力してください。");
      return;
    }
    setFormError("");
    onSubmit(fileName.trim(), note, fileUrl.trim());
  };
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
          onUploadedChange={setFileUploaded}
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
      {formError ? <p className="film-order-upload-error" role="alert">{formError}</p> : null}
      <button className="button" type="button" disabled={busy || !fileName.trim() || !fileReady} onClick={submitFile}>
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
  onUploadedChange,
  accept,
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
  onUploadedChange?: (uploaded: boolean) => void;
  accept?: string;
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
    onUploadedChange?.(false);
    setError("");
    if (selected) {
      if (selected.size <= 0) {
        setError("ファイルが読み取れませんでした。ローカルに保存したファイルを選択してください。");
        setFile(null);
        return;
      }
      if (selected.size > 15 * 1024 * 1024) {
        setError(`ファイルサイズが15MBを超えています（${(selected.size / 1024 / 1024).toFixed(1)}MB）。圧縮するか、Driveへ直接アップロードしてURLを登録してください。`);
        setFile(null);
        return;
      }
      const extension = selected.name.includes(".") ? selected.name.slice(selected.name.lastIndexOf(".")).toLowerCase() : "";
      const expectedExtension = accept === ".pdf" ? ".pdf" : accept === ".ai" ? ".ai" : null;
      const looksLikePdf = extension === ".pdf" || selected.type === "application/pdf";
      const valid = expectedExtension === ".pdf"
        ? (extension === ".pdf" || looksLikePdf)
        : expectedExtension == null || extension === expectedExtension;
      if (!valid) {
        setError(`ファイル形式が正しくありません。${expectedExtension} を選択してください（選択: ${selected.name}）。`);
        setFile(null);
        return;
      }
      const dot = fileName.lastIndexOf(".");
      const normalizedExtension = expectedExtension ?? extension;
      onFileNameChange(dot > 0 ? `${fileName.slice(0, dot)}${normalizedExtension}` : `${fileName}${normalizedExtension}`);
    }
  };

  const upload = async () => {
    if (!file || uploading) return;
    setUploading(true);
    onUploadedChange?.(false);
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
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          // 小さなファイルでも最終リクエストとして扱わせるために必須。
          "Content-Range": `bytes 0-${file.size - 1}/${file.size}`,
        },
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
      onUploadedChange?.(true);
    } catch (err) {
      onUploadedChange?.(false);
      setError(err instanceof Error ? `アップロード失敗: ${err.message}` : "アップロードに失敗しました。");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="film-order-drive-field">
      <label>{label}
        <input value={fileName} onChange={(event) => { onFileNameChange(event.target.value); setUploaded(false); onUploadedChange?.(false); }} autoFocus={autofocus} />
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
      {!driveReady ? (
        <label>URL（Drive手動登録用・任意）
          <input value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder="https://drive.google.com/..." inputMode="url" />
        </label>
      ) : null}
      {error ? <p className="film-order-upload-error">{error}</p> : null}
    </div>
  );
}

function ReProofForm({
  order,
  busy,
  onSubmit,
}: {
  order: FilmOrderView;
  busy: boolean;
  onSubmit: (values: { internalComment: string; supplierMessage: string }) => void;
}) {
  const locale = supplierLocaleFor(order);
  const isKorean = locale === "ko";
  const [comment, setComment] = useState("");
  const [supplierMessage, setSupplierMessage] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="button danger" type="button" onClick={() => setOpen(true)}>再校正を依頼</button>
    );
  }
  return (
    <div className="film-order-file-form">
      <strong>再校正依頼</strong>
      <label>내부 확인용 메모 / 内部確認用メモ
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={3} placeholder="修正内容を記入してください" />
      </label>
      <label>{isKorean ? "공급사 전달용 한국어 메시지" : "供給先用メッセージ（日本語推奨・한국어も可）"}
        <textarea
          value={supplierMessage}
          onChange={(event) => setSupplierMessage(event.target.value)}
          rows={3}
          placeholder={isKorean ? "필름업체에 그대로 전달됩니다. 한국어로 입력하세요." : "フィルムメーカーにそのまま送付されます。日本語で入力してください。"}
          required
        />
      </label>
      <button className="button danger" type="button" disabled={busy || !comment.trim() || !supplierMessage.trim()} onClick={() => onSubmit({ internalComment: comment.trim(), supplierMessage: supplierMessage.trim() })}>
        再校正依頼を送信
      </button>
      <button className="button secondary small" type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
    </div>
  );
}
