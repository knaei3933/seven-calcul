import LoginForm from "./login-form";

function safeNext(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="login-page">
      <section className="panel login-panel" aria-labelledby="login-title">
        <p className="side-kicker">QUOTATION SUITE</p>
        <h1 id="login-title">ログイン</h1>
        <p>見積システムを利用するには認証が必要です。</p>
        <LoginForm next={safeNext(params.next)} />
      </section>
    </main>
  );
}
