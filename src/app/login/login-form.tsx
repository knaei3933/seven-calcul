"use client";

import { useState } from "react";

export default function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setError("");
    setSubmitting(true);
    let waitingForBrowserNavigation = false;
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        setError("メールアドレスまたはパスワードが正しくありません。");
        return;
      }
      // The API response installs the session cookie. A hard navigation makes
      // the browser send that cookie to the protected RSC request immediately;
      // replacing and refreshing the App Router concurrently can race on some
      // production clients and leave the user on the login screen.
      waitingForBrowserNavigation = true;
      window.location.assign(next);
    } catch {
      setError("ログイン処理中にエラーが発生しました。");
    } finally {
      if (!waitingForBrowserNavigation) setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate={false}>
      <div className="field">
        <label htmlFor="login-email">メールアドレス</label>
        <input
          id="login-email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          data-testid="login-email"
        />
      </div>
      <div className="field">
        <label htmlFor="login-password">パスワード</label>
        <input
          id="login-password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          minLength={10}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          data-testid="login-password"
        />
      </div>
      {error ? <p className="error" role="alert" data-testid="login-error">{error}</p> : null}
      <button className="button" type="submit" disabled={submitting} data-testid="login-submit">
        {submitting ? "認証中..." : "ログイン"}
      </button>
    </form>
  );
}
