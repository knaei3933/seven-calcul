"use client";

import { useCallback, useEffect, useState } from "react";

type FilmMaker = {
  id: number;
  makerCode: string;
  companyName: string;
  contactName: string;
  email: string;
  language: "ja" | "ko";
  printMethod: "gravure" | "digital";
  procurementRoute: "K" | "Y";
  isActive: boolean;
  note: string;
};

type FormState = {
  makerCode: string;
  companyName: string;
  contactName: string;
  email: string;
  language: "ja" | "ko";
  printMethod: "gravure" | "digital";
  procurementRoute: "K" | "Y";
  note: string;
};

const emptyForm: FormState = {
  makerCode: "",
  companyName: "",
  contactName: "",
  email: "",
  language: "ja",
  printMethod: "gravure",
  procurementRoute: "K",
  note: "",
};

const labels = {
  ja: "日本語",
  ko: "한국어",
  gravure: "グラビア",
  digital: "デジタル",
  K: "韓国輸入",
  Y: "国内調達",
};

export default function FilmMakersClient({ userEmail }: { userEmail: string }) {
  const [makers, setMakers] = useState<FilmMaker[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/film-makers");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      setMakers(payload.makers as FilmMaker[]);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "load_failed" ? caught.message : "フィルムメーカーを読み込めませんでした。");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時にフィルムメーカー一覧を取得する意図的な処理です。
    void load();
  }, [load]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingId(null);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(editingId ? `/api/film-makers/${editingId}` : "/api/film-makers", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, isActive: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "save_failed");
      setMessage(editingId ? "フィルムメーカーを更新しました。" : "フィルムメーカーを登録しました。");
      resetForm();
      await load();
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "save_failed" ? caught.message : "保存できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (maker: FilmMaker) => {
    setEditingId(maker.id);
    setForm({
      makerCode: maker.makerCode,
      companyName: maker.companyName,
      contactName: maker.contactName,
      email: maker.email,
      language: maker.language,
      printMethod: maker.printMethod,
      procurementRoute: maker.procurementRoute,
      note: maker.note,
    });
  };

  const deactivate = async (maker: FilmMaker) => {
    if (busy || !maker.isActive) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/film-makers/${maker.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("deactivate_failed");
      setMessage(`${maker.makerCode} を非活性化しました。`);
      await load();
    } catch {
      setError("非活性化できませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const heading = `${makers.length} 件のフィルムメーカー`;
  return (
    <main className="page">
      <h1>フィルムメーカー管理</h1>
      <p className="help">管理者: {userEmail}</p>
      <section aria-labelledby="film-maker-form-title">
        <h2 id="film-maker-form-title">{editingId ? "フィルムメーカー編集" : "フィルムメーカー新規登録"}</h2>
        <div className="form-grid">
          <label>フィルムメーカーコード
            <input value={form.makerCode} onChange={(e) => setForm({ ...form, makerCode: e.target.value })} />
          </label>
          <label>会社名
            <input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
          </label>
          <label>担当者（任意）
            <input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
          </label>
          <label>メールアドレス
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label>言語
            <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value as "ja" | "ko" })}>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
            </select>
          </label>
          <label>印刷方式
            <select value={form.printMethod} onChange={(e) => setForm({ ...form, printMethod: e.target.value as "gravure" | "digital" })}>
              <option value="gravure">グラビア</option>
              <option value="digital">デジタル</option>
            </select>
          </label>
          <label>調達経路
            <select value={form.procurementRoute} onChange={(e) => setForm({ ...form, procurementRoute: e.target.value as "K" | "Y" })}>
              <option value="K">韓国輸入</option>
              <option value="Y">国内調達</option>
            </select>
          </label>
          <label>備考
            <textarea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} rows={3} />
          </label>
        </div>
        <div className="actions">
          <button className="button" type="button" disabled={busy} onClick={() => void submit()}>
            {editingId ? "更新する" : "登録する"}
          </button>
          {editingId ? <button className="button secondary" type="button" onClick={resetForm}>取消</button> : null}
        </div>
      </section>
      <section aria-labelledby="film-maker-list-title">
        <h2 id="film-maker-list-title">{heading}</h2>
        {message ? <p className="success" role="status">{message}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="table-wrap">
          <table>
            <thead><tr><th>コード</th><th>会社名</th><th>担当者</th><th>メール</th><th>条件</th><th>状態</th><th>操作</th></tr></thead>
            <tbody>
              {makers.map((maker) => (
                <tr key={maker.id} data-testid={`film-maker-${maker.makerCode}`}>
                  <td>{maker.makerCode}</td>
                  <td>{maker.companyName}</td>
                  <td>{maker.contactName || "-"}</td>
                  <td>{maker.email}</td>
                  <td>{labels[maker.language]} / {labels[maker.printMethod]} / {labels[maker.procurementRoute]}</td>
                  <td>{maker.isActive ? "有効" : "停止"}</td>
                  <td>
                    <button className="button secondary small" type="button" onClick={() => startEdit(maker)}>編集</button>
                    {maker.isActive ? <button className="button secondary small" type="button" disabled={busy} onClick={() => void deactivate(maker)}>停止</button> : null}
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
