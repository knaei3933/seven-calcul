"use client";

import { useCallback, useEffect, useState } from "react";
import type { PublicUser, UserRole } from "@/lib/auth-store";

const roleLabels: Record<UserRole, string> = {
  admin: "管理者",
  user: "一般ユーザー",
};

export default function AdminUsersClient() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/users", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "user_list_failed");
      setUsers(payload.users as PublicUser[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ユーザーを読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const createUser = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, role, password }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error === "duplicate_email" ? "このメールアドレスは既に登録されています。" : "ユーザーを作成できませんでした。");
        return;
      }
      setEmail("");
      setName("");
      setRole("user");
      setPassword("");
      setStatus("ユーザーを作成しました。");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const patchUser = async (user: PublicUser, patch: object, successMessage: string) => {
    setError("");
    setStatus("");
    const response = await fetch(`/api/users/${user.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error === "last_active_admin"
        ? "少なくとも1人の有効な管理者が必要です。"
        : payload.error === "invalid_password"
          ? "パスワードは10文字以上にしてください。"
          : "ユーザーを更新できませんでした。");
      return;
    }
    setStatus(successMessage);
    await load();
  };

  const resetPassword = async (user: PublicUser) => {
    const password = window.prompt(`${user.name} の新しいパスワード（10文字以上）`);
    if (!password) return;
    await patchUser(user, { password }, "パスワードを直ちに変更しました。");
  };

  return (
    <main className="admin-users-page">
      <section className="panel" aria-labelledby="admin-users-title">
        <h1 id="admin-users-title">ユーザー管理</h1>
        <p>内部アカウントを作成し、パスワード・権限・有効状態を管理します。</p>
        {error ? <p className="error" role="alert">{error}</p> : null}
        {status ? <p className="help" role="status">{status}</p> : null}

        <form className="admin-user-form" onSubmit={createUser}>
          <div className="field">
            <label htmlFor="new-email">メールアドレス</label>
            <input id="new-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} data-testid="new-user-email" />
          </div>
          <div className="field">
            <label htmlFor="new-name">表示名</label>
            <input id="new-name" type="text" required value={name} onChange={(event) => setName(event.target.value)} data-testid="new-user-name" />
          </div>
          <div className="field">
            <label htmlFor="new-role">権限</label>
            <select id="new-role" value={role} onChange={(event) => setRole(event.target.value as UserRole)} data-testid="new-user-role">
              <option value="user">{roleLabels.user}</option>
              <option value="admin">{roleLabels.admin}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-password">初期パスワード</label>
            <input id="new-password" type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} data-testid="new-user-password" />
          </div>
          <button className="button" type="submit" disabled={saving}>作成</button>
        </form>
      </section>

      <section className="panel" aria-labelledby="admin-user-list-title">
        <div className="history-meta">
          <h2 id="admin-user-list-title">アカウント一覧</h2>
          <span>{loading ? "読み込み中..." : `${users.length} 件`}</span>
        </div>
        <div className="history-table-wrap">
          <table className="table" data-testid="admin-users-table">
            <thead>
              <tr><th>メールアドレス</th><th>表示名</th><th>権限</th><th>状態</th><th>作成日時</th><th>操作</th></tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{user.name}</td>
                  <td>
                    <select
                      aria-label={`${user.name} の権限`}
                      value={user.role}
                      onChange={(event) => void patchUser(user, { role: event.target.value }, "権限を更新しました。")}
                    >
                      <option value="user">{roleLabels.user}</option>
                      <option value="admin">{roleLabels.admin}</option>
                    </select>
                  </td>
                  <td>{user.isActive ? "有効" : "無効"}</td>
                  <td>{new Date(user.createdAt).toLocaleString("ja-JP")}</td>
                  <td className="history-actions">
                    <button className="button small" type="button" onClick={() => void resetPassword(user)}>パスワード変更</button>
                    <button
                      className={user.isActive ? "button secondary small" : "button small"}
                      type="button"
                      onClick={() => void patchUser(user, { isActive: !user.isActive }, user.isActive ? "アカウントを無効化しました。" : "アカウントを有効化しました。")}
                    >{user.isActive ? "無効化" : "有効化"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
