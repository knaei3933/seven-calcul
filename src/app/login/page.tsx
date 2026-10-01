import LoginForm from "./login-form";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

function safeNext(value: string | undefined): string {
  if (
    !value
    || value === "/login"
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.startsWith("/\\")
  ) return "/";
  return value;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const destination = safeNext(params.next);
  const user = await getCurrentUser();
  if (user) redirect(destination as Parameters<typeof redirect>[0]);

  return (
    <main className="login-page">
      <section className="panel login-panel" aria-labelledby="login-title">
        <p className="side-kicker">QUOTATION SUITE</p>
        <h1 id="login-title">ログイン</h1>
        <p>見積システムを利用するには認証が必要です。</p>
        <LoginForm next={destination} />
      </section>
    </main>
  );
}
