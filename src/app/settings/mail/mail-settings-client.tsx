"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthenticatedUser } from "@/lib/api-auth";
import {
  getMailTemplateCategory,
  getMailTemplateCategoryLabel,
  MAIL_TEMPLATES,
  MAIL_TEMPLATE_CATEGORY_META,
  MAIL_TEMPLATE_DEFAULTS,
} from "@/lib/mail-template-catalog";
import type { MailSettings } from "@/lib/mail-settings";

const EMPTY: MailSettings = {
  version: 1,
  testMode: { enabled: false, recipient: "" },
  sender: { name: "", email: "" },
  globalCc: [],
  recipients: {
    design: "",
    seven: "",
    kaneiApprovals: "",
    supplierKorean: "",
    supplierJapanese: "",
  },
  templates: {},
};

type CategoryKey = "all" | "workflow" | "customer" | "supplier" | "portal" | "system";

function csv(value: string): string[] {
  return value.split(/[,\n]/u).map((item) => item.trim()).filter(Boolean);
}

function isCustomTemplate(value: MailSettings["templates"][string] | undefined): boolean {
  return Boolean(
    value?.subject?.trim()
    || value?.body?.trim()
    || value?.cc?.length,
  );
}

function TemplateEditor({
  templateKey,
  override,
  onUpdate,
}: {
  templateKey: string;
  override: MailSettings["templates"][string];
  onUpdate: (patch: { subject?: string; body?: string; cc?: string[] }) => void;
}) {
  const template = MAIL_TEMPLATES.find((item) => item.key === templateKey)!;
  const defaults = MAIL_TEMPLATE_DEFAULTS[templateKey];
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const insertVariable = (variable: string) => {
    const token = `{{${variable}}}`;
    const element = bodyRef.current;
    const current = override.body ?? "";
    if (!element) {
      onUpdate({ body: `${current}${token}` });
      return;
    }
    const start = element.selectionStart ?? current.length;
    const end = element.selectionEnd ?? current.length;
    const next = `${current.slice(0, start)}${token}${current.slice(end)}`;
    onUpdate({ body: next });
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="mail-template-editor" id={`mail-template-${templateKey}`}>
      <p className="mail-template-description">{template.description}</p>

      <div className="mail-template-columns">
        <section className="mail-template-pane default" aria-label="現在の自動生成本文">
          <h4>現在の自動生成</h4>
          <label>
            基本件名
            <input readOnly data-testid="default-subject" value={defaults?.subject ?? ""} tabIndex={-1} />
          </label>
          <label>
            基本本文
            <textarea readOnly data-testid="default-body" rows={12} value={defaults?.body ?? ""} tabIndex={-1} />
          </label>
        </section>

        <section className="mail-template-pane override" aria-label="カスタム設定">
          <h4>カスタム設定</h4>
          <label>
            件名
            <input
              data-testid="override-subject"
              value={override.subject ?? ""}
              placeholder="空欄＝基本件名"
              onChange={(event) => onUpdate({ subject: event.target.value })}
            />
          </label>
          <label>
            CC（カンマ / 改行）
            <textarea
              data-testid="override-cc"
              rows={2}
              value={(override.cc ?? []).join(",\n")}
              placeholder="空欄＝全体CCのみ"
              onChange={(event) => onUpdate({ cc: csv(event.target.value) })}
            />
          </label>
          <label>
            本文
            <textarea
              ref={bodyRef}
              data-testid="override-body"
              rows={12}
              value={override.body ?? ""}
              placeholder="空欄＝基本本文"
              onChange={(event) => onUpdate({ body: event.target.value })}
            />
          </label>
        </section>
      </div>

      <div className="mail-template-tools">
        <div className="mail-variable-list" aria-label="利用できる変数">
          {template.variables.map((variable) => (
            <button
              key={variable}
              type="button"
              className="mail-variable-chip"
              onClick={() => insertVariable(variable)}
            >
              {`{{${variable}}}`}
            </button>
          ))}
        </div>
        <div className="mail-template-tools-actions">
          <button
            className="button secondary small"
            type="button"
            onClick={() => onUpdate({ subject: defaults?.subject ?? "", body: defaults?.body ?? "" })}
          >
            基本本文を読み込む
          </button>
          <button
            className="button secondary small"
            type="button"
            onClick={() => onUpdate({ subject: "", body: "", cc: [] })}
          >
            カスタムを解除
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MailSettingsClient({ currentUser }: { currentUser: AuthenticatedUser }) {
  const [settings, setSettings] = useState<MailSettings>(EMPTY);
  const [baseline, setBaseline] = useState<MailSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [openTemplate, setOpenTemplate] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryKey>("all");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/settings/mail", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "load_failed");
      const loaded = { ...EMPTY, ...payload.settings } as MailSettings;
      setSettings(loaded);
      setBaseline(loaded);
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "load_failed"
        ? caught.message
        : "設定を読み込めませんでした。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時に保存済み設定を取得します。
    void load();
  }, [load]);

  const dirty = JSON.stringify(settings) !== JSON.stringify(baseline);

  const save = async () => {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/settings/mail", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "save_failed");
      const saved = { ...EMPTY, ...payload.settings } as MailSettings;
      setSettings(saved);
      setBaseline(saved);
      setStatus("メール設定を保存しました。");
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "save_failed"
        ? caught.message
        : "保存できませんでした。");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setSettings(baseline);
    setStatus("変更を破棄しました。");
  };

  const sendTest = async () => {
    setTesting(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/settings/mail/test", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "test_failed");
      setStatus(`テストメールを ${settings.testMode.recipient} へ送信しました。`);
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== "test_failed"
        ? caught.message
        : "テストメールを送信できませんでした。");
    } finally {
      setTesting(false);
    }
  };

  const updateSettings = (patch: Partial<MailSettings>) => {
    setSettings((old) => ({ ...old, ...patch }));
  };

  const updateTemplate = (key: string, patch: { subject?: string; body?: string; cc?: string[] }) => {
    setSettings((old) => ({
      ...old,
      templates: {
        ...old.templates,
        [key]: { ...old.templates[key], ...patch },
      },
    }));
  };

  const customCount = MAIL_TEMPLATES.filter((template) => isCustomTemplate(settings.templates[template.key])).length;
  const categoryCounts = useMemo(() => {
    const counts = new Map<CategoryKey, number>();
    for (const template of MAIL_TEMPLATES) {
      const key = getMailTemplateCategory(template.key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, []);

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLowerCase();
    return MAIL_TEMPLATES.filter((template) => {
      if (category !== "all" && getMailTemplateCategory(template.key) !== category) return false;
      if (!query) return true;
      const haystack = [
        template.title,
        template.description,
        template.key,
        ...template.variables,
        MAIL_TEMPLATE_DEFAULTS[template.key]?.subject ?? "",
        MAIL_TEMPLATE_DEFAULTS[template.key]?.body ?? "",
      ].join("\n").toLowerCase();
      return haystack.includes(query);
    });
  }, [category, search]);

  const effectiveTestRecipient = settings.testMode.enabled
    ? settings.testMode.recipient || "未設定"
    : "無効";

  if (loading) {
    return (
      <main className="mail-settings-page">
        <section className="panel mail-settings-loading"><p>読み込み中...</p></section>
      </main>
    );
  }

  return (
    <main className="mail-settings-page">
      <header className="mail-settings-head">
        <div className="mail-settings-title">
          <p className="mail-settings-eyebrow">KANEI MAIL ADMIN</p>
          <h1 id="mail-settings-title">メール送信設定</h1>
          <p>宛先・送信者・CC・本文テンプレートを一括管理します。</p>
        </div>
        <div className="mail-settings-identity">
          <span>操作者</span>
          <strong>{currentUser.name}</strong>
          <small>{currentUser.email}</small>
        </div>
      </header>

      <div className="mail-settings-summary" aria-label="設定サマリー">
        <article className={`mail-summary-card ${settings.testMode.enabled ? "warning" : "neutral"}`}>
          <span>テストモード</span>
          <strong>{settings.testMode.enabled ? "有効" : "無効"}</strong>
          <small>{settings.testMode.enabled ? effectiveTestRecipient : "実宛先へ送信"}</small>
        </article>
        <article className="mail-summary-card neutral">
          <span>送信者</span>
          <strong>{settings.sender.name || settings.sender.email || "SMTP設定"}</strong>
          <small>{settings.sender.email || "環境変数を使用"}</small>
        </article>
        <article className="mail-summary-card neutral">
          <span>全体CC</span>
          <strong>{settings.globalCc.length}件</strong>
          <small>{settings.globalCc[0] || "未設定"}</small>
        </article>
        <article className="mail-summary-card neutral">
          <span>カスタム本文</span>
          <strong>{customCount} / {MAIL_TEMPLATES.length}</strong>
          <small>テンプレート上書き</small>
        </article>
      </div>

      {error ? <p className="mail-settings-alert" role="alert">{error}</p> : null}
      {status ? <p className="mail-settings-status" role="status">{status}</p> : null}
      {dirty ? (
        <p className="mail-settings-dirty" role="status">未保存の変更があります。</p>
      ) : null}

      <div className="mail-settings-layout">
        <div className="mail-settings-main">
          <section className="panel mail-settings-card" aria-labelledby="delivery-test-title">
            <div className="mail-card-head">
              <div>
                <p className="mail-card-kicker">TEST ROUTING</p>
                <h2 id="delivery-test-title">テストモード</h2>
              </div>
              <span className={`mail-status-pill ${settings.testMode.enabled ? "on" : "off"}`}>
                {settings.testMode.enabled ? "ON" : "OFF"}
              </span>
            </div>
            <p className="mail-card-help">
              有効にすると、顧客・Seven・メーカー宛てのメールをすべて指定した宛先へ強制します。
            </p>
            <div className="mail-test-grid">
              <label className="mail-switch">
                <input
                  type="checkbox"
                  checked={settings.testMode.enabled}
                  onChange={(event) => updateSettings({
                    testMode: { enabled: event.target.checked, recipient: settings.testMode.recipient },
                  })}
                />
                <span>テストモード</span>
              </label>
              <label>
                テスト送信先
                <input
                  type="email"
                  value={settings.testMode.recipient}
                  placeholder="kim@kanei-trade.co.jp"
                  disabled={!settings.testMode.enabled}
                  onChange={(event) => updateSettings({
                    testMode: { enabled: settings.testMode.enabled, recipient: event.target.value },
                  })}
                />
              </label>
              <div className="mail-test-actions">
                <button
                  className="button secondary"
                  type="button"
                  disabled={!settings.testMode.enabled || testing || saving}
                  onClick={() => void sendTest()}
                >
                  {testing ? "送信中..." : "テストメール送信"}
                </button>
              </div>
            </div>
          </section>

          <section className="panel mail-settings-card" aria-labelledby="sender-title">
            <div className="mail-card-head">
              <div>
                <p className="mail-card-kicker">SENDER</p>
                <h2 id="sender-title">送信者・CC</h2>
              </div>
            </div>
            <div className="mail-form-grid">
              <label>送信者名
                <input
                  value={settings.sender.name}
                  placeholder="空欄＝SMTP設定"
                  onChange={(event) => updateSettings({ sender: { ...settings.sender, name: event.target.value } })}
                />
              </label>
              <label>送信者メールアドレス
                <input
                  type="email"
                  value={settings.sender.email}
                  placeholder="空欄＝SMTP設定"
                  onChange={(event) => updateSettings({ sender: { ...settings.sender, email: event.target.value } })}
                />
              </label>
              <label className="wide">
                全体CC（カンマ / 改行）
                <textarea
                  rows={2}
                  value={settings.globalCc.join(",\n")}
                  placeholder="qa@kanei-trade.co.jp"
                  onChange={(event) => updateSettings({ globalCc: csv(event.target.value) })}
                />
              </label>
            </div>
          </section>

          <section className="panel mail-settings-card" aria-labelledby="recipients-title">
            <div className="mail-card-head">
              <div>
                <p className="mail-card-kicker">ROUTING</p>
                <h2 id="recipients-title">固定宛先</h2>
              </div>
            </div>
            <p className="mail-card-help">空欄の場合は現在のシステム宛先を使用します。</p>
            <div className="mail-recipient-grid">
              {([
                ["design", "デザイン / 製作パートナー", "design"],
                ["seven", "Seven化学通知", "seven"],
                ["kaneiApprovals", "Kanei承認通知", "kaneiApprovals"],
                ["supplierKorean", "세중산업/이패키지", "supplierKorean"],
                ["supplierJapanese", "国内メーカー", "supplierJapanese"],
              ] as const).map(([key, label, field]) => (
                <label key={key}>
                  {label}
                  <input
                    type="email"
                    value={settings.recipients[field]}
                    placeholder="空欄＝システム宛先"
                    onChange={(event) => updateSettings({
                      recipients: { ...settings.recipients, [field]: event.target.value },
                    })}
                  />
                </label>
              ))}
            </div>
          </section>
        </div>

        <aside className="mail-settings-side">
          <section className="panel mail-settings-card" aria-labelledby="usage-title">
            <h2 id="usage-title">使い方</h2>
            <ol>
              <li>テストモードをONにして宛先を確認</li>
              <li>送信者・CC・固定宛先を調整</li>
              <li>本文変更はテンプレートから実施</li>
              <li>保存後、テストメールで確認</li>
            </ol>
          </section>
        </aside>
      </div>

      <section className="panel mail-template-section" aria-labelledby="templates-title">
        <div className="mail-template-head">
          <div>
            <p className="mail-card-kicker">TEMPLATES</p>
            <h2 id="templates-title">メール本文テンプレート</h2>
            <p className="mail-card-help">
              基本文を確認し、必要な場合だけ上書きします。空欄は自動生成本文です。
            </p>
          </div>
          <label className="mail-template-search">
            <span>検索</span>
            <input
              type="search"
              value={search}
              placeholder="件名・本文・変数を検索"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        <div className="mail-category-bar" role="tablist" aria-label="テンプレート分類">
          {MAIL_TEMPLATE_CATEGORY_META.map((item) => {
            const key = item.key as CategoryKey;
            const count = key === "all" ? MAIL_TEMPLATES.length : categoryCounts.get(key) ?? 0;
            return (
              <button
                key={key}
                type="button"
                className={category === key ? "active" : ""}
                aria-pressed={category === key}
                onClick={() => setCategory(key)}
              >
                {item.label}
                <b>{count}</b>
              </button>
            );
          })}
        </div>

        <div className="mail-template-list">
          {filteredTemplates.length === 0 ? (
            <p className="mail-template-empty">該当するテンプレートはありません。</p>
          ) : filteredTemplates.map((template) => {
            const override = settings.templates[template.key] ?? {};
            const category = getMailTemplateCategory(template.key);
            const custom = isCustomTemplate(override);
            const open = openTemplate === template.key;
            const defaults = MAIL_TEMPLATE_DEFAULTS[template.key];
            return (
              <article
                key={template.key}
                className={`mail-template-card ${custom ? "custom" : "default"} ${open ? "open" : ""}`}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={`mail-template-${template.key}`}
                  onClick={() => setOpenTemplate(open ? null : template.key)}
                >
                  <span className="mail-template-titleline">
                    <span className={`mail-template-role ${getMailTemplateCategory(template.key)}`}>
                      {getMailTemplateCategoryLabel(category)}
                    </span>
                    <strong>{template.title}</strong>
                  </span>
                  <span className="mail-template-description">{template.description}</span>
                  <span className="mail-template-badges">
                    <b className={custom ? "custom" : "default"}>{custom ? "カスタム" : "基本"}</b>
                    <small aria-hidden="true">{open ? "▲" : "▼"}</small>
                  </span>
                </button>

                {open ? (
                  <TemplateEditor
                    templateKey={template.key}
                    override={override}
                    onUpdate={(patch) => updateTemplate(template.key, patch)}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <div className="mail-save-bar">
        <div>
          <strong>{dirty ? "未保存の変更があります" : "すべての変更を保存済み"}</strong>
          <span>{`表示中 ${filteredTemplates.length} / ${MAIL_TEMPLATES.length}件`}</span>
        </div>
        <div className="mail-save-actions">
          <button className="button secondary" type="button" disabled={!dirty || saving} onClick={discard}>
            変更を破棄
          </button>
          <button className="button" type="button" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "保存中..." : "変更を保存"}
          </button>
        </div>
      </div>
    </main>
  );
}
