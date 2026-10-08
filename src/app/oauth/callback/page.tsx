export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function exchangeCode(code: string, redirectUri: string): Promise<{
  ok: boolean;
  refreshToken?: string;
  scopes?: string;
  status?: number;
  body?: string;
}> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return { ok: false, body: "client_credentials_missing" };
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, body: text.slice(0, 600) };
    const payload = JSON.parse(text) as { refresh_token?: string; scope?: string };
    return { ok: true, refreshToken: payload.refresh_token, scopes: payload.scope };
  } catch (error) {
    return { ok: false, body: error instanceof Error ? error.message : "exchange_failed" };
  }
}

export default async function OAuthCallbackPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const code = typeof params.code === "string" ? params.code : "";
  const error = typeof params.error === "string" ? params.error : "";
  const origin = process.env.PUBLIC_ORIGIN
    ?? (process.env.VERCEL === "1" ? "https://seven-calcul.vercel.app" : "http://localhost:3002");
  const redirectUri = `${origin}/oauth/callback`;
  const result = code ? await exchangeCode(code, redirectUri) : null;
  const consentUrl = process.env.GOOGLE_OAUTH_CLIENT_ID
    ? `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(process.env.GOOGLE_OAUTH_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent("https://www.googleapis.com/auth/drive")}&access_type=offline&prompt=consent`
    : null;

  return (
    <main className="eta-page">
      <section className="panel eta-panel">
        <p className="eta-eyebrow">GOOGLE OAUTH</p>
        <h1>認証結果</h1>
        {error ? <p className="eta-error">Googleエラー: {error}</p> : null}
        {!code ? (
          <>
            <p className="eta-error">認証コードがURLに含まれていません。</p>
            <p className="eta-summary">
              診断用 — このページが受け取ったパラメータ:
            </p>
            <textarea className="oauth-code" readOnly rows={3} value={JSON.stringify(params)} />
            {consentUrl ? (
              <p style={{ margin: "14px 0 0" }}>
                <a className="button" href={consentUrl}>Google同意を開始（このボタンを押してください）</a>
              </p>
            ) : null}
          </>
        ) : result?.ok ? (
          result.refreshToken ? (
            <>
              <p className="eta-ok">リフレッシュトークンを取得しました。下記を管理者に渡してください。</p>
              <textarea className="oauth-code" readOnly rows={8} value={result.refreshToken} />
              <p className="eta-summary">Scopes: {result.scopes}</p>
            </>
          ) : (
            <p className="eta-error">アクセストークンは取得できましたが refresh_token が返されませんでした。同意画面で再度許可してください（prompt=consent 必須）。</p>
          )
        ) : (
          <>
            <p className="eta-error">トークン交換に失敗しました ({result?.status ?? "-"})</p>
            <textarea className="oauth-code" readOnly rows={6} value={result?.body ?? ""} />
          </>
        )}
      </section>
    </main>
  );
}
