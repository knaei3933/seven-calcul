export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ code?: string; error?: string }>;
};

export default async function OAuthCallbackPage({ searchParams }: PageProps) {
  const { code, error } = await searchParams;
  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">GOOGLE OAUTH</p>
        <h1>認証コード</h1>
        {error ? (
          <p className="eta-error">エラー: {error}</p>
        ) : (
          <>
            <p className="eta-summary">下記のコードをコピーして管理者に渡してください（1回のみ有効）。</p>
            <textarea className="oauth-code" readOnly value={code ?? ""} rows={8} />
          </>
        )}
      </section>
    </main>
  );
}
