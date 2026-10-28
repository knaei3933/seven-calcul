"use client";

import { useCallback, useEffect, useState } from "react";

interface AdminPortalQuote {
  publicId: string;
  quotationId: number;
  quotationNumber: string;
  sourceLabel: string;
  customerCode: string;
  customer: {
    code: string;
    name: string;
    contact: string;
    telephone: string;
    email: string;
  } | null;
  issueDate: string;
  validUntil: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  displayedTotals: {
    pricePerPiece: string;
    subtotal: string;
    tax: string;
    grandTotal: string;
  };
  status: string;
  pdfAvailable: boolean;
  mappingCreatedAt: string;
  quotationUpdatedAt: string;
}

interface AdminPortalQuotePage {
  quotes: AdminPortalQuote[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

const statusLabels: Record<string, string> = {
  draft: "下書き",
  sent: "送付済み",
  approved: "成約",
  rejected: "見送り",
  expired: "期限切れ",
};

const dateTimeFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Tokyo",
});
const numberFormatter = new Intl.NumberFormat("ja-JP");
const currencyFormatter = new Intl.NumberFormat("ja-JP", {
  style: "currency",
  currency: "JPY",
  maximumFractionDigits: 0,
});

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function formatAmount(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount) ? currencyFormatter.format(amount) : value;
}

export default function PortalQuotesClient() {
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AdminPortalQuotePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (currentSearch: string, currentPage: number) => {
    const params = new URLSearchParams({ page: String(currentPage), limit: "20" });
    if (currentSearch) params.set("q", currentSearch);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/portal-quotes?${params}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      setResult(payload as AdminPortalQuotePage);
    } catch {
      setResult(null);
      setError("ポータル見積を読み込めませんでした。時間をおいて再度お試しください。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(submittedSearch, page), 0);
    return () => clearTimeout(timer);
  }, [load, page, submittedSearch]);

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setSubmittedSearch(search.trim());
  };

  const pagination = result?.pagination;
  const quotes = result?.quotes ?? [];

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-col gap-2">
        <p className="text-sm font-medium text-blue-700">出所: {result?.quotes[0]?.sourceLabel ?? "顧客ポータル"}</p>
        <h1 className="text-2xl font-bold text-slate-900">顧客ポータル見積</h1>
        <p className="text-sm text-slate-600">
          顧客ポータルで作成された見積と顧客コードを確認できます。
        </p>
      </header>

      <form className="mb-4 flex flex-col gap-2 sm:flex-row" onSubmit={submitSearch} role="search">
        <label className="sr-only" htmlFor="portal-quote-search">見積番号・顧客名・顧客コードで検索</label>
        <input
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
          id="portal-quote-search"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="見積番号・顧客名・顧客コード"
          type="search"
          value={search}
        />
        <button
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-60"
          disabled={loading}
          type="submit"
        >
          検索
        </button>
      </form>

      <div aria-live="polite" className="min-h-24">
        {loading ? <p className="rounded-md bg-slate-50 p-4 text-sm text-slate-700">読み込み中です。</p> : null}
        {!loading && error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">{error}</p>
        ) : null}
        {!loading && !error && quotes.length === 0 ? (
          <p className="rounded-md bg-slate-50 p-4 text-sm text-slate-700">該当する顧客ポータル見積はありません。</p>
        ) : null}
      </div>

      {!loading && !error && quotes.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <caption className="sr-only">顧客ポータルで作成された見積一覧</caption>
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">出所 / 顧客コード</th>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">見積</th>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">顧客</th>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">期間</th>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">製品 / 数量</th>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">表示合計</th>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">状態 / PDF</th>
                <th className="px-3 py-3 font-semibold text-slate-700" scope="col">登録 / 更新</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {quotes.map((quote) => (
                <tr key={quote.publicId}>
                  <td className="px-3 py-3 align-top">
                    <span className="inline-flex rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700">
                      {quote.sourceLabel}
                    </span>
                    <p className="mt-1 font-mono text-xs text-slate-700">{quote.customerCode}</p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="font-medium text-slate-900">{quote.quotationNumber}</p>
                    <p className="font-mono text-xs text-slate-500">{quote.publicId}</p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="text-slate-900">{quote.customer?.name ?? quote.customerCode}</p>
                    <p className="text-xs text-slate-600">{quote.customer?.contact ?? "—"}</p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p>{quote.issueDate} 〜 {quote.validUntil}</p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p>{quote.productName}</p>
                    <p className="text-xs text-slate-600">{quote.sizeSummary} / {numberFormatter.format(Number(quote.quantity))} 袋</p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p className="font-semibold">{formatAmount(quote.displayedTotals.grandTotal)}</p>
                    <p className="text-xs text-slate-600">単価 {formatAmount(quote.displayedTotals.pricePerPiece)}</p>
                  </td>
                  <td className="px-3 py-3 align-top">
                    <p>{statusLabels[quote.status] ?? quote.status}</p>
                    <p className="text-xs text-slate-600">{quote.pdfAvailable ? "PDFあり" : "PDFなし"}</p>
                  </td>
                  <td className="px-3 py-3 align-top text-xs text-slate-600">
                    <p>登録 {formatDateTime(quote.mappingCreatedAt)}</p>
                    <p>更新 {formatDateTime(quote.quotationUpdatedAt)}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {pagination && pagination.totalPages > 1 ? (
        <nav aria-label="ポータル見積ページ" className="mt-4 flex items-center justify-between gap-3">
          <button
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            disabled={!pagination.hasPrevious || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            type="button"
          >
            前へ
          </button>
          <p className="text-sm text-slate-700">
            {pagination.page} / {pagination.totalPages} ページ（{numberFormatter.format(pagination.total)}件）
          </p>
          <button
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            disabled={!pagination.hasNext || loading}
            onClick={() => setPage((current) => current + 1)}
            type="button"
          >
            次へ
          </button>
        </nav>
      ) : null}
    </main>
  );
}
