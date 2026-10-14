"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCurrency, formatNumber } from "@/lib/serialization";
import { CALCULATION_VERSION, sizeMaster } from "@/lib/constants";
import { buildFilmQuotationFromRecord, kaneiTrade } from "@/lib/film-quotation";
import { D, Decimal } from "@/lib/decimal";
import { analyzeQuotation, filmCompositionOf, printingMethodOf } from "@/lib/quotation-history";
import {
  DEFAULT_FILM_COMPOSITION,
  QUOTATION_RESTORE_KEY,
  quotationStatuses,
  type QuotationRecord,
  type QuotationStatus,
  type UserSummary,
} from "@/lib/quotation-shared";
import type { AuthenticatedUser } from "@/lib/auth-store";

const statusLabels: Record<QuotationStatus, string> = {
  draft: "下書き",
  sent: "送付済み",
  approved: "成約",
  rejected: "見送り",
  expired: "期限切れ",
};

export default function HistoryClient({ currentUser }: { currentUser: AuthenticatedUser }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [creatorFilter, setCreatorFilter] = useState<string>("all");
  const [records, setRecords] = useState<QuotationRecord[]>([]);
  const [creatorOptions, setCreatorOptions] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const requestOrder = useRef(0);
  const selectedRecord = records.find((record) => record.id === selectedId) ?? null;
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailMessage, setEmailMessage] = useState("");

  const load = useCallback(async (search: string, statusFilter: string, creatorFilter: string) => {
    const order = ++requestOrder.current;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: search, status: statusFilter, limit: "200" });
      if (creatorFilter !== "all") params.set("creatorId", creatorFilter);
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
    let active = true;
    const loadCreators = async () => {
      try {
        const response = await fetch("/api/quotations?limit=500", { cache: "no-store" });
        const payload = await response.json();
        if (!active || !response.ok) return;
        const recordsForCreators = payload.records as QuotationRecord[];
        setCreatorOptions(Array.from(new Map(recordsForCreators.map((record) => [record.createdBy.id, record.createdBy])).values())
          .sort((left, right) => left.name.localeCompare(right.name, "ja")));
      } catch {
        // Filter options remain at "all" when this supplemental lookup is unavailable.
      }
    };
    void loadCreators();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query, status, creatorFilter), 180);
    return () => clearTimeout(timer);
  }, [load, query, status, creatorFilter]);


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

  const sendQuotationEmail = async (record: QuotationRecord) => {
    setSendingEmail(true);
    setEmailMessage("");
    try {
      const response = await fetch(`/api/quotations/${record.id}/send`, { method: "POST" });
      const payload = await response.json();
      if (response.ok) {
        setRecords((old) => old.map((item) => (item.id === record.id ? payload.record as QuotationRecord : item)));
        setEmailMessage(`${record.quotationNumber} を ${payload.sentTo} に送信しました。`);
      } else if (payload.error === "smtp_not_configured") {
        setEmailMessage("SMTPが設定されていません。.env に SMTP_HOST / SMTP_USER / SMTP_PASS を設定してください。");
      } else if (payload.error === "customer_email_required") {
        setEmailMessage("得意先のメールアドレスが登録されていません。");
      } else {
        setEmailMessage("送信に失敗しました。");
      }
    } catch {
      setEmailMessage("送信に失敗しました。");
    } finally {
      setSendingEmail(false);
    }
  };

  const canManage = (record: QuotationRecord) => currentUser.role === "admin" || currentUser.id === record.createdBy.id;

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
          <label>作成者
            <select
              value={creatorFilter}
              onChange={(event) => setCreatorFilter(event.target.value)}
              data-testid="history-creator"
              aria-label="作成者で絞り込み"
            >
              <option value="all">すべて</option>
              {creatorOptions.map((creator) => (
                <option key={creator.id} value={String(creator.id)}>
                  {creator.name}（{creator.email}）
                </option>
              ))}
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
                <th>見積番号</th><th>発行日</th><th>得意先</th><th>品名 / 仕様</th><th>数量</th><th>単価</th><th>税込合計</th><th>状態</th><th>操作</th><th>作成者</th>
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
                  <td>{record.customerName || <span className="badge" data-testid="customer-missing-badge">得意先未入力</span>}</td>
                  <td>{record.productName}<small>{record.sizeSummary}</small></td>
                  <td>{formatNumber(record.quantity, 0)} 枚</td>
                  <td>{formatCurrency(record.pricePerPiece, 2)}</td>
                  <td>{formatCurrency(record.grandTotal, 0)}</td>
                  <td>
                    <select
                      aria-label={`${record.quotationNumber} の状態`}
                      value={record.status}
                      disabled={!canManage(record)}
                      title={canManage(record) ? undefined : "作成者または管理者のみ変更できます"}
                      onChange={(event) => void changeStatus(record, event.target.value as QuotationStatus)}
                    >
                      {quotationStatuses.map((item) => <option key={item} value={item}>{statusLabels[item]}</option>)}
                    </select>
                  </td>
                  <td className="history-actions">
                    <button className="button small" type="button" onClick={() => setSelectedId(record.id)}>詳細</button>
                    <button className="button secondary small" type="button" onClick={() => restore(record)}>復元</button>
                    <button
                      className="button danger small"
                      type="button"
                      disabled={!canManage(record)}
                      title={canManage(record) ? undefined : "作成者または管理者のみ削除できます"}
                      onClick={() => void remove(record)}
                    >削除</button>
                  </td>
                  <td data-testid="history-creator-name">
                    <strong>{record.createdBy.name}</strong>
                    <small>{record.createdBy.email}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selectedRecord ? (
        <>
          <QuotationDetailModal record={selectedRecord} onClose={() => setSelectedId(null)} onStatusChange={(record, nextStatus) => { void changeStatus(record, nextStatus); }} onSendEmail={(record) => { void sendQuotationEmail(record); }} sendingEmail={sendingEmail} />
          {emailMessage ? <p className="help" role="status" data-testid="email-message" style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 999, background: "white", padding: "8px 16px", borderRadius: 8, border: "1px solid #cbd5e1" }}>{emailMessage}</p> : null}
        </>
      ) : null}
    </main>
  );
}

function QuotationDetailModal({ record, onClose, onStatusChange, onSendEmail, sendingEmail }: { record: QuotationRecord; onClose: () => void; onStatusChange: (record: QuotationRecord, nextStatus: QuotationStatus) => void; onSendEmail: (record: QuotationRecord) => void; sendingEmail: boolean }) {
  const [detailTab, setDetailTab] = useState<"document" | "film" | "data">("document");
  const analysis = analyzeQuotation(record);
  // 발행 시 자동 생성된 필름 견적서(payload 저장분)를 우선 사용, 없으면 조회 시 생성
  const storedFilmQuotation = record.payload.filmQuotation as import("@/lib/film-quotation").FilmQuotationData | undefined;
  const legacyFilmQuotation = !storedFilmQuotation
    || !storedFilmQuotation.endCustomerName
    || !storedFilmQuotation.filmComposition
    || !storedFilmQuotation.printingMethodLabel
    || !storedFilmQuotation.colorCountLabel
    || !storedFilmQuotation.items[0]?.specification
    || !/^K-\d{6}-\d{3,}-F$/.test(storedFilmQuotation.quotationNumber);
  const filmQuotation = legacyFilmQuotation
    ? buildFilmQuotationFromRecord(record)
    : storedFilmQuotation;
  const calculationChecklistSnapshot = record.payload.calculationChecklistSnapshot as {
    fillMlPerChamber?: string;
    connectedChambers?: number;
    totalFillMlPerPouch?: string;
  } | null | undefined;
  const snapshotCalculationVersion = typeof record.payload.calculationChecklistSnapshot === "object"
    && record.payload.calculationChecklistSnapshot !== null
    && typeof (record.payload.calculationChecklistSnapshot as { calculationVersion?: unknown }).calculationVersion === "string"
    ? (record.payload.calculationChecklistSnapshot as { calculationVersion: string }).calculationVersion
    : "";
  const calculationVersionStale = snapshotCalculationVersion !== ""
    && snapshotCalculationVersion !== CALCULATION_VERSION;
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
    {
      name: "充填・加工",
      cost: analysis.fillingCostUnit,
      selling: analysis.fillingUnit,
      profit: analysis.fillingUnit.minus(analysis.fillingCostUnit),
      quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`,
      amount: analysis.fillingAmount,
    },
    { name: "フィルム", cost: analysis.filmCostUnit, selling: analysis.filmUnit, profit: analysis.filmUnit.minus(analysis.filmCostUnit), quantity: `${formatNumber(analysis.filmOrderLength.toNumber(), 0)} m`, amount: analysis.filmAmount },
  ];
  if (printingMethodOf(record) === "gravure") {
    rows.push({
      name: "新規銅版", cost: analysis.copperCostUnit, selling: analysis.copperUnit,
      profit: analysis.copperUnit.minus(analysis.copperCostUnit),
      quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`, amount: analysis.copperAmount,
    });
  }
  if (analysis.hasSeparatedBulkLine && analysis.bulkAmount.gt(0)) {
    rows.push({
      name: "バルク費用",
      cost: analysis.bulkCostUnit,
      selling: analysis.bulkUnit,
      profit: analysis.bulkUnit.minus(analysis.bulkCostUnit),
      quantity: `${formatNumber(analysis.quantity.toNumber(), 0)} 枚`,
      amount: analysis.bulkAmount,
    });
  }
  const payloadText = (key: string, fallback = "") => {
    const value = record.payload[key];
    return typeof value === "string" && value.trim() ? value : fallback;
  };
  const issuerName = payloadText("issuerName", "株式会社セブン化学");
  const issuerEnglishName = payloadText("issuerEnglishName", "SEVEN CHEMICAL CO., LTD.");
  const issuerPostalCode = payloadText("issuerPostalCode", "〒582-0017");
  const issuerAddress = payloadText("issuerAddress", "大阪府柏原市太平寺1丁目12番1号");
  const issuerTelephone = payloadText("issuerTelephone", "TEL 072-971-0726");
  const issuerWebsite = payloadText("issuerWebsite", "https://7chemical.co.jp/");
  const issuerRepresentative = payloadText("representative", "代表取締役社長 吾藤 靖");
  const copperColorCountValue = (() => {
    const value = Number(record.payload.copperColorCount ?? 1);
    return Number.isFinite(value) && value > 0 ? D(value) : D(1);
  })();
  const fillingCostTotal = analysis.fillingCostUnit.times(analysis.quantity);
  const processingCostTotal = analysis.processingCostUnit.times(analysis.quantity);
  const bulkCostTotal = analysis.bulkCostUnit.times(analysis.quantity);
  const filmCostTotal = analysis.filmCostUnit.times(analysis.quantity);
  const copperCostTotal = analysis.copperCostUnit.times(analysis.quantity);
  const customCostTotal = analysis.customCostUnit.times(analysis.quantity);
  const filmMeterCost = analysis.filmOrderLength.gt(0)
    ? filmCostTotal.div(analysis.filmOrderLength)
    : D(0);
  const copperCostPerColor = copperColorCountValue.gt(0) ? copperCostTotal.div(copperColorCountValue) : D(0);
  const storedCostDifference = analysis.costUnit.minus(analysis.storedCostUnit);
  const profitVerificationDifference = finalProfit.minus(analysis.storedProfitUnit.times(analysis.quantity));
  const fitContentRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const fitForPrint = () => {
      for (const content of fitContentRefs.current) {
        if (!content) continue;
        content.style.removeProperty("--history-a4-fit-scale");
        // scrollHeight is measured before zoom is applied and therefore
        // remains the unscaled content height; clientHeight is the A4 page box.
        const availableHeight = content.clientHeight;
        const requiredHeight = content.scrollHeight;
        const scale = availableHeight > 0 && requiredHeight > availableHeight
          ? availableHeight / requiredHeight
          : 1;
        content.style.setProperty("--history-a4-fit-scale", scale.toFixed(5));
      }
    };
    const resetFit = () => {
      for (const content of fitContentRefs.current) content?.style.removeProperty("--history-a4-fit-scale");
    };
    const printMedia = window.matchMedia("print");
    const handleMediaChange = (event: MediaQueryListEvent) => {
      if (event.matches) fitForPrint();
      else resetFit();
    };
    window.addEventListener("beforeprint", fitForPrint);
    window.addEventListener("afterprint", resetFit);
    printMedia.addEventListener("change", handleMediaChange);
    return () => {
      window.removeEventListener("beforeprint", fitForPrint);
      window.removeEventListener("afterprint", resetFit);
      printMedia.removeEventListener("change", handleMediaChange);
    };
  }, [record.id]);

  const printCurrentDocument = async () => {
    // ブランド印などのAPI画像は印刷直後に空白になることがあるため、描画完了を待つ。
    await Promise.all(
      Array.from(document.querySelectorAll<HTMLImageElement>(".history-detail-panel img")).map(async (image) => {
        if (image.complete && image.naturalWidth > 0) return;
        try {
          await image.decode();
        } catch {
          // 読み込み失敗時は既存のalt表示で印刷を妨げない。
        }
      }),
    );
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print());
    });
  };

  const customerEmail = record.payload.customerEmail;
  const mailtoLink = (() => {
    if (typeof customerEmail !== "string" || !customerEmail.trim()) return null;
    const subject = encodeURIComponent(`お見積書 ${record.quotationNumber} のご案内`);
    const body = encodeURIComponent(
      `${record.customerName} 御中\n\nお見積書 ${record.quotationNumber} をご案内いたします。\n` +
      `品名：${record.productName}\n数量：${formatNumber(Number(record.quantity))} 枚\n` +
      `税込合計：${formatCurrency(record.grandTotal, 0)}\n有効期限：${record.validUntil || "-"}\n\n` +
      `ご確認のほどよろしくお願いいたします。\nパッケージラボ\n`,
    );
    return `mailto:${customerEmail.trim()}?subject=${subject}&body=${body}`;
  })();

  return (
    <div className="history-detail-layer printable-detail" role="dialog" aria-modal="true" aria-labelledby="history-detail-title">
      <div className="history-detail-panel">
        <header className="history-detail-header">
          <div>
            <span className="side-kicker">QUOTATION DETAIL</span>
            <h2 id="history-detail-title">{record.quotationNumber}</h2>
            <p data-testid="history-film-composition">{record.customerName || "得意先未設定"} / {record.productName} / フィルム構成 {composition || DEFAULT_FILM_COMPOSITION}</p>
          </div>
          <div className="detail-header-actions">
            <button className="button small" type="button" onClick={() => void printCurrentDocument()} data-testid="detail-print-current">
              {detailTab === "document" ? "見積書PDF"
                : detailTab === "film" ? "フィルム見積書PDF"
                  : "詳細データPDF"}
            </button>
            {mailtoLink ? (
              <a className="button small" href={mailtoLink} data-testid="history-mail-link">メール作成</a>
            ) : null}
            {record.status === "draft" && typeof record.payload.customerEmail === "string" && record.payload.customerEmail.trim() ? (
              <button className="button small" type="button" disabled={sendingEmail} onClick={() => onSendEmail(record)} data-testid="history-auto-send">
                <span title="保存済みの顧客メールアドレスへ見積案内メールを送信し、状態を送付済みにします。PDFは添付されません。">
                  {sendingEmail ? "送信中..." : "メール送信（PDFなし）"}
                </span>
              </button>
            ) : null}
            {record.status === "draft" ? (
              <button className="button small" type="button" onClick={() => onStatusChange(record, "sent")} data-testid="history-send-status">送付済みにする</button>
            ) : null}
            <button className="button secondary small" type="button" onClick={onClose}>閉じる</button>
          </div>
        </header>

        <div className="detail-scroll">
          <nav className="detail-tabbar no-print" aria-label="詳細表示切替">
            <button
              className={detailTab === "document" ? "active" : ""}
              type="button"
              onClick={() => setDetailTab("document")}
              aria-current={detailTab === "document"}
            >見積書A4</button>
            {filmQuotation ? (
              <button
                className={detailTab === "film" ? "active" : ""}
                type="button"
                onClick={() => setDetailTab("film")}
                aria-current={detailTab === "film"}
                data-testid="film-quote-tab"
              >フィルム見積書</button>
            ) : null}
            <button
              className={detailTab === "data" ? "active" : ""}
              type="button"
              onClick={() => setDetailTab("data")}
              aria-current={detailTab === "data"}
            >詳細データ</button>
          </nav>

          {detailTab === "film" && filmQuotation ? (
            <article className="a4-sheet history-a4 film-quote-a4" aria-label="フィルム見積書A4">
              <div className="history-a4-fit" ref={(element) => { fitContentRefs.current[0] = element; }}>
                {/* ── 発行ヘッダ ── */}
                <header className="film-quote-header">
                  <div className="film-quote-issuer">
                    <div className="film-quote-brand-row">
                      <img
                        src="/api/brand-assets/kanei-trade-logo.png"
                        alt="金井貿易株式会社 ロゴ"
                        className="film-quote-kanei-logo"
                        width={612}
                        height={408}
                      />
                      <div className="film-quote-company">
                        <strong className="film-quote-company-name">{kaneiTrade.name}</strong>
                        <span className="film-quote-division">
                          <strong>{kaneiTrade.divisionName}</strong>
                          <span>{kaneiTrade.divisionLabel}</span>
                        </span>
                      </div>
                      <img
                        src="/api/brand-assets/epackage-lab-logo.png"
                        alt="Epackage-Lab ロゴ"
                        className="film-quote-division-logo"
                        width={2172}
                        height={724}
                      />
                    </div>
                    <small>{kaneiTrade.englishName}</small>
                    <address>
                      {kaneiTrade.postalCode}<br />
                      {kaneiTrade.address}<br />
                      {kaneiTrade.telephone}<br />
                      {kaneiTrade.email}
                    </address>
                  </div>
                  <div className="film-quote-title">
                    <p className="english">QUOTATION</p>
                    <h2>お見積書</h2>
                    <dl>
                      <div><dt>見積番号</dt><dd>{filmQuotation.quotationNumber}</dd></div>
                      <div><dt>発行日</dt><dd>{filmQuotation.issueDate}</dd></div>
                      <div><dt>有効期限</dt><dd>{filmQuotation.validUntil}</dd></div>
                    </dl>
                  </div>
                </header>

                {/* ── 宛先・背景説明 ── */}
                <section className="film-quote-recipient">
                  <p className="to">株式会社セブン化学 御中</p>
                  <p className="subject">貴社パウチ充填用フィルムにつきまして、下記の通りお見積りを申し上げます。</p>
                </section>

                <section className="film-quote-background">
                  <h3>お見積りの背景</h3>
                  <dl className="film-quote-bg-list">
                    <div><dt>発注顧客</dt><dd>{filmQuotation.endCustomerName || "-"}</dd></div>
                    <div><dt>対象製品</dt><dd>{filmQuotation.productName}</dd></div>
                    <div><dt>パウチ仕様</dt><dd>{record.sizeSummary}</dd></div>
                    <div><dt>フィルム仕様</dt><dd>{filmQuotation.filmComposition}／{filmQuotation.printingMethodLabel}／{filmQuotation.colorCountLabel}</dd></div>
                    {calculationChecklistSnapshot ? (
                      <>
                        <div><dt>充填量</dt><dd>{formatNumber(Number(calculationChecklistSnapshot.fillMlPerChamber))}ml/室 × {calculationChecklistSnapshot.connectedChambers}室 ＝ {formatNumber(Number(calculationChecklistSnapshot.totalFillMlPerPouch))}ml/枚</dd></div>
                        <div><dt>パウチ数量</dt><dd>{Number(filmQuotation.quantity).toLocaleString("ja-JP")} 枚（総室数 {Number(D(filmQuotation.quantity).times(calculationChecklistSnapshot?.connectedChambers ?? 1)).toLocaleString("ja-JP")} 室）</dd></div>
                      </>
                    ) : null}
                    <div><dt>発注フィルム</dt><dd>原反幅 {filmQuotation.items[0]?.webWidthMm ?? "-"}mm × {Number(filmQuotation.items[0]?.orderLengthM ?? 0).toLocaleString("ja-JP")}m</dd></div>
                  </dl>
                  <div className="film-quote-bg-chain">
                    <p className="chain-label">発注に至る経緯</p>
                    <p className="chain-text">
                      {filmQuotation.productName}（{record.sizeSummary}）を{Number(filmQuotation.quantity).toLocaleString("ja-JP")}枚充填するため、
                      原反幅{filmQuotation.items[0]?.webWidthMm ?? "-"}mmのフィルムが{Number(filmQuotation.items[0]?.orderLengthM ?? 0).toLocaleString("ja-JP")}m必要です。
                      金井貿易よりこのフィルムを調達させていただきます。
                    </p>
                  </div>
                </section>

                {/* ── 明細テーブル ── */}
                <table className="film-quote-table">
                  <thead>
                    <tr>
                      <th>品名・仕様</th>
                      <th>原反幅</th>
                      <th>数量</th>
                      <th>単価</th>
                      <th>金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filmQuotation.items.map((item, i) => (
                      <tr key={i}>
                        <td className="desc">
                          <div className="film-item-name">{item.description}</div>
                          {item.specification ? <small className="film-item-spec">{item.specification}</small> : null}
                        </td>
                        <td className="num">{item.webWidthMm}mm</td>
                        <td className="num">{Number(item.orderLengthM).toLocaleString("ja-JP")} m</td>
                        <td className="num">{Number(item.unitPriceYenPerM).toLocaleString("ja-JP")} 円/m</td>
                        <td className="num amt">{Number(item.amountYen).toLocaleString("ja-JP")} 円</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={4}>小計（税抜）</td><td className="num">{Number(filmQuotation.subtotal).toLocaleString("ja-JP")} 円</td></tr>
                    <tr><td colSpan={4}>消費税（10%）</td><td className="num">{Number(filmQuotation.tax).toLocaleString("ja-JP")} 円</td></tr>
                    <tr className="grand"><td colSpan={4}>合計（税込）</td><td className="num">{Number(filmQuotation.grandTotal).toLocaleString("ja-JP")} 円</td></tr>
                  </tfoot>
                </table>

                {/* ── 備考 ── */}
                <section className="film-quote-notes">
                  <h3>備考</h3>
                  <ul>
                    {filmQuotation.notes.map((note, i) => <li key={i}>{note}</li>)}
                  </ul>
                </section>

                {/* ── 署名 ── */}
                <footer className="film-quote-footer">
                  <div className="greeting">
                    <p>上記の通りお見積り申し上げます。<br />ご検討のほどよろしくお願いいたします。</p>
                  </div>
                  <div className="issuer-seal">
                    <strong>{kaneiTrade.name}</strong>
                    <img
                      src="/api/brand-assets/kanei-trade-seal.png"
                      alt="金井貿易株式会社各印"
                      className="film-quote-seal-image"
                      width={1254}
                      height={1254}
                    />
                  </div>
                </footer>
              </div>
            </article>
          ) : null}

          {detailTab === "document" ? (
          <>
            <article className="a4-sheet history-a4" aria-label="見積書A4">
              <header className="sheet-header">
                <div className="issuer">
                  <div className="issuer-logo">
                    <span className="logo-mark large" aria-hidden="true">7</span>
                    <div>
                      <strong>{issuerName}</strong>
                      <small>{issuerEnglishName}</small>
                    </div>
                  </div>
                  <address>
                    {issuerRepresentative}<br />
                    {issuerPostalCode} {issuerAddress}<br />
                    {issuerTelephone} / {issuerWebsite}
                  </address>
                </div>
                <div className="document-title">
                  <p className="english">QUOTATION</p>
                  <h2>お見積書</h2>
                  <dl>
                    <div><dt>見積番号</dt><dd>{record.quotationNumber}</dd></div>
                    <div><dt>発行日</dt><dd>{record.issueDate}</dd></div>
                    <div><dt>有効期限</dt><dd>{record.validUntil || "-"}</dd></div>
                  </dl>
                </div>
              </header>

              <div className="recipient-block">
                <p className="to">{record.customerName || "得意先未設定"} 御中</p>
                {record.customerContact ? <p className="department">{record.customerContact} 様</p> : null}
                <p className="subject">下記の通りお見積りを申し上げます。</p>
              </div>

              <section className="price-highlight">
                <div>
                  <small>見積金額（税抜）</small>
                  <strong>{formatCurrency(analysis.subtotal.toFixed(0), 0)}円</strong>
                </div>
                <div>
                  <small>消費税</small>
                  <strong>{formatCurrency(analysis.tax.toFixed(0), 0)}円</strong>
                </div>
                <div>
                  <small>見積総額（税込）</small>
                  <strong>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}円</strong>
                </div>
              </section>

              <section className="quote-spec">
                <h3>仕様明細</h3>
                <dl>
                  <div className="wide"><dt>品名</dt><dd>{record.productName || "-"}</dd></div>
                  <div className="wide"><dt>仕様</dt><dd>{record.sizeSummary || "-"}</dd></div>
                  <div><dt>数量</dt><dd>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</dd></div>
                  <div><dt>印刷方式</dt><dd>{printingMethodOf(record) === "gravure" ? "グラビア印刷" : "デジタル印刷"}</dd></div>
                  <div><dt>フィルム構成</dt><dd>{composition || DEFAULT_FILM_COMPOSITION}</dd></div>
                  {analysis.filmOrderLength.gt(0) ? <div><dt>発注長</dt><dd>{formatNumber(analysis.filmOrderLength.toNumber(), 0)} m</dd></div> : null}
                </dl>
              </section>

              <table className="quote-table">
                <thead><tr><th>項目</th><th>単価</th><th>数量</th><th>金額</th></tr></thead>
                <tbody>
                  <tr><td>充填・加工費</td><td>{formatCurrency(analysis.fillingUnit.toFixed(2), 2)}</td><td>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</td><td>{formatCurrency(analysis.fillingAmount.toFixed(0), 0)}</td></tr>
                  {analysis.hasSeparatedBulkLine && analysis.bulkAmount.gt(0) ? (
                    <tr><td>バルク費用</td><td>{formatCurrency(analysis.bulkUnit.toFixed(2), 2)}</td><td>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</td><td>{formatCurrency(analysis.bulkAmount.toFixed(0), 0)}</td></tr>
                  ) : null}
                  <tr><td>フィルム費用</td><td>{analysis.displayedFilmMeterUnit ? `${formatCurrency(analysis.displayedFilmMeterUnit.toFixed(2), 2)} /m` : "-"}</td><td>{formatNumber(analysis.filmOrderLength.toNumber(), 0)} m</td><td>{formatCurrency(analysis.filmAmount.toFixed(0), 0)}</td></tr>
                  {printingMethodOf(record) === "gravure" && analysis.copperAmount.gt(0) ? (
                    <tr><td>銅版費</td><td>-</td><td>-</td><td>{formatCurrency(analysis.copperAmount.toFixed(0), 0)}</td></tr>
                  ) : null}
                  {analysis.customCostUnit.gt(0) ? <tr><td>金型費用</td><td>-</td><td>-</td><td>{formatCurrency(analysis.customAmount.toFixed(0), 0)}</td></tr> : null}
                </tbody>
                <tfoot>
                  <tr><th colSpan={3}>小計（税抜）</th><td>{formatCurrency(analysis.subtotal.toFixed(0), 0)}</td></tr>
                  <tr><th colSpan={3}>消費税</th><td>{formatCurrency(analysis.tax.toFixed(0), 0)}</td></tr>
                  <tr><th colSpan={3}>税込合計</th><td>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}</td></tr>
                </tfoot>
              </table>

              <section className="terms">
                <dl>
                  <div><dt>納期</dt><dd>{record.deliveryDate || "-"}</dd></div>
                  <div><dt>お支払条件</dt><dd>{record.paymentTerms || "-"}</dd></div>
                  <div><dt>見積有効期限</dt><dd>{record.validUntil || "-"}</dd></div>
                </dl>
                {record.notes ? <p className="notes"><strong>備考</strong> {record.notes}</p> : null}
              </section>

              <footer className="sheet-footer">
                <p>{record.quotationNumber}</p>
                <div className="approval">
                  <span>{issuerName}</span>
                </div>
              </footer>
            </article>
          </>
                    ) : detailTab === "data" ? (
          <>
            <article className="a4-sheet history-a4 data-report-a4" aria-label="詳細データA4帳票" data-testid="data-report-a4">
              <div className="history-a4-fit" ref={(element) => { fitContentRefs.current[1] = element; }}>
                <header className="sheet-header">
                  <div className="issuer">
                    <div className="issuer-logo">
                      <span className="logo-mark large" aria-hidden="true">7</span>
                      <div>
                        <strong>{issuerName}</strong>
                        <small>{issuerEnglishName}</small>
                      </div>
                    </div>
                    <address>
                      {issuerRepresentative}<br />
                      {issuerPostalCode} {issuerAddress}<br />
                      {issuerTelephone} / {issuerWebsite}
                    </address>
                  </div>
                  <div className="document-title">
                    <p className="english">INTERNAL DATA REPORT</p>
                    <h2>詳細データ</h2>
                    <dl>
                      <div><dt>見積番号</dt><dd>{record.quotationNumber}</dd></div>
                      <div><dt>作成日</dt><dd>{new Date(record.createdAt).toLocaleDateString("ja-JP")}</dd></div>
                    </dl>
                  </div>
                </header>

                <section className="history-a4-section">
                  <header><span>01</span><h2>基本情報</h2></header>
                  <dl className="history-facts">
                    <div><dt>得意先</dt><dd>{record.customerName || "-"}</dd></div>
                    <div><dt>品名</dt><dd>{record.productName}</dd></div>
                    <div><dt>仕様</dt><dd>{record.sizeSummary}</dd></div>
                    <div><dt>状態</dt><dd>{statusLabels[record.status]}</dd></div>
                    <div><dt>数量</dt><dd>{formatNumber(analysis.quantity.toNumber(), 0)} 枚</dd></div>
                    <div><dt>印刷方式</dt><dd>{printingMethodOf(record) === "gravure" ? "グラビア印刷（ロール）" : "デジタル印刷"}</dd></div>
                    <div><dt>フィルム構成</dt><dd>{composition || DEFAULT_FILM_COMPOSITION}</dd></div>
                    <div><dt>計算バージョン</dt><dd>{snapshotCalculationVersion || record.calculationVersion || "-"}</dd></div>
                  </dl>
                </section>

                <section className="history-a4-section">
                  <header><span>02</span><h2>損益サマリー</h2></header>
                  <table className="data-report-table">
                    <thead><tr><th>項目</th><th>原価 /枚</th><th>見積 /枚</th><th>差益 /枚</th><th>差益率</th><th>差益総額</th></tr></thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.name}>
                          <th scope="row">{row.name}</th>
                          <td className="num">{formatCurrency(row.cost.toFixed(2), 2)}</td>
                          <td className="num">{formatCurrency(row.selling.toFixed(2), 2)}</td>
                          <td className="num">{formatCurrency(row.profit.toFixed(2), 2)}</td>
                          <td className="num">{row.selling.gt(0) ? `${formatNumber(row.profit.div(row.selling).times(100).toNumber(), 2)}%` : "-"}</td>
                          <td className="num">{formatCurrency(row.profit.times(analysis.quantity).toFixed(0), 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr><th scope="row">合計</th><td className="num">{formatCurrency(analysis.costUnit.toFixed(2), 2)}</td><td className="num">{formatCurrency(analysis.sellingUnit.toFixed(2), 2)}</td><td className="num">{formatCurrency(analysis.profitUnit.toFixed(2), 2)}</td><td className="num">{formatNumber(finalProfitRate.toNumber(), 2)}%</td><td className="num">{formatCurrency(finalProfit.toFixed(0), 0)}</td></tr>
                    </tfoot>
                  </table>
                  <p className="data-report-note">総原価 {formatCurrency(costTotal.toFixed(0), 0)} 円 ／ 税抜見積 {formatCurrency(analysis.subtotal.toFixed(0), 0)} 円 ／ 最終利益 {formatCurrency(finalProfit.toFixed(0), 0)} 円</p>
                </section>

                <section className="history-a4-section">
                  <header><span>03</span><h2>原価・金額検証</h2></header>
                  <dl className="history-facts">
                    <div><dt>充填・加工原価</dt><dd>{formatCurrency(analysis.fillingCostUnit.toFixed(2), 2)} /枚</dd></div>
                    <div><dt>フィルム購入原価</dt><dd>{formatCurrency(analysis.filmMeterPrice.toFixed(2), 2)} /m</dd></div>
                    <div><dt>フィルム発注長</dt><dd>{formatNumber(analysis.filmOrderLength.toNumber(), 0)} m</dd></div>
                    <div><dt>フィルム原価</dt><dd>{formatCurrency(filmCostTotal.toFixed(0), 0)} 円</dd></div>
                    <div><dt>目標利益率</dt><dd>{formatNumber(analysis.targetMargin.times(100).toNumber(), 2)}%</dd></div>
                    <div><dt>端数調整</dt><dd>{displayedAdjustment}</dd></div>
                    <div><dt>小計 / 消費税</dt><dd>{formatCurrency(analysis.subtotal.toFixed(0), 0)} / {formatCurrency(analysis.tax.toFixed(0), 0)}</dd></div>
                    <div><dt>税込合計</dt><dd>{formatCurrency(analysis.grandTotal.toFixed(0), 0)}</dd></div>
                  </dl>
                </section>

                <section className="history-a4-section">
                  <header><span>04</span><h2>条件・監査</h2></header>
                  <dl className="history-facts">
                    <div><dt>納期</dt><dd>{record.deliveryDate || "-"}</dd></div>
                    <div><dt>支払条件</dt><dd>{record.paymentTerms || "-"}</dd></div>
                    <div><dt>作成 / 更新</dt><dd>{new Date(record.createdAt).toLocaleString("ja-JP")} / {new Date(record.updatedAt).toLocaleString("ja-JP")}</dd></div>
                    <div><dt>DB保存原価 /枚</dt><dd>{formatCurrency(analysis.storedCostUnit.toFixed(4), 4)}</dd></div>
                    <div><dt>再計算整合差</dt><dd>{formatCurrency(storedCostDifference.toFixed(4), 4)}</dd></div>
                    <div><dt>利益検算整合差</dt><dd>{formatCurrency(profitVerificationDifference.toFixed(0), 0)}</dd></div>
                    <div><dt>備考</dt><dd>{record.notes || "-"}</dd></div>
                  </dl>
                  <footer className="history-a4-footer">内部管理用。顧客提出用の見積書ではありません。</footer>
                </section>
              </div>
            </article>

          <section className="profit-summary no-print" aria-label="損益サマリー">
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
                    <td>充填・加工{analysis.hasFillingCostBreakdown ? <><br /><small>加工 {formatCurrency(analysis.processingCostUnit.toFixed(2), 2)}／バルク {formatCurrency(analysis.bulkCostUnit.toFixed(2), 2)}</small></> : null}</td>
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
              <div><span>フィルム m単価</span><strong>{analysis.displayedFilmMeterUnit ? `${formatCurrency(analysis.displayedFilmMeterUnit.toFixed(2), 2)} /m` : "-"}</strong></div>
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
              <div><span>フィルム見積単価</span><strong>{analysis.displayedFilmMeterUnit ? `${formatCurrency(analysis.displayedFilmMeterUnit.toFixed(2), 2)} /m` : "-"}</strong></div>
              <div><span>フィルム発注長</span><strong>{formatNumber(analysis.filmOrderLength.toNumber(), 0)} m</strong></div>
              <div><span>納期</span><strong>{record.deliveryDate || "-"}</strong></div>
              <div><span>支払条件</span><strong>{record.paymentTerms || "-"}</strong></div>
              <div><span>計算バージョン</span><strong>{snapshotCalculationVersion || record.calculationVersion || "-"}{calculationVersionStale ? "（要再計算）" : ""}</strong></div>
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
          </>) : null}
        </div>
      </div>
      <div className="history-detail-overlay" onClick={onClose} aria-hidden="true" />
    </div>
  );
}

