import { getSqlClient } from "./db";
import { MAIL_TEMPLATES, type MailTemplateMeta } from "./mail-template-catalog";

export type { MailTemplateMeta };
export { MAIL_TEMPLATES };

export type MailTemplateOverride = {
  subject?: string;
  body?: string;
  cc?: string[];
};

export type MailSettings = {
  version: 1;
  testMode: { enabled: boolean; recipient: string };
  sender: { name: string; email: string };
  globalCc: string[];
  recipients: {
    design: string;
    seven: string;
    kaneiApprovals: string;
    supplierKorean: string;
    supplierJapanese: string;
  };
  templates: Record<string, MailTemplateOverride>;
};

const DEFAULT_SETTINGS: MailSettings = {
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function normalizeAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function normalizeSettings(value: unknown): MailSettings {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, any>;
  const templatesSource = typeof source.templates === "object" && source.templates ? source.templates : {};
  const templates: MailSettings["templates"] = {};
  for (const template of MAIL_TEMPLATES) {
    const raw = templatesSource[template.key];
    if (!raw || typeof raw !== "object") continue;
    const subject = typeof raw.subject === "string" ? raw.subject.trim() : "";
    const body = typeof raw.body === "string" ? raw.body : "";
    const cc = normalizeAddressList(raw.cc);
    if (!subject && !body.trim() && cc.length === 0) continue;
    templates[template.key] = {
      ...(subject ? { subject } : {}),
      ...(body.trim() ? { body } : {}),
      ...(cc.length ? { cc } : {}),
    };
  }
  const testRecipient = typeof source.testMode?.recipient === "string" ? source.testMode.recipient.trim() : "";
  return {
    version: 1,
    testMode: {
      enabled: source.testMode?.enabled === true,
      recipient: testRecipient,
    },
    sender: {
      name: typeof source.sender?.name === "string" ? source.sender.name.trim() : "",
      email: typeof source.sender?.email === "string" ? source.sender.email.trim() : "",
    },
    globalCc: normalizeAddressList(source.globalCc),
    recipients: {
      design: typeof source.recipients?.design === "string" ? source.recipients.design.trim() : "",
      seven: typeof source.recipients?.seven === "string" ? source.recipients.seven.trim() : "",
      kaneiApprovals: typeof source.recipients?.kaneiApprovals === "string" ? source.recipients.kaneiApprovals.trim() : "",
      supplierKorean: typeof source.recipients?.supplierKorean === "string" ? source.recipients.supplierKorean.trim() : "",
      supplierJapanese: typeof source.recipients?.supplierJapanese === "string" ? source.recipients.supplierJapanese.trim() : "",
    },
    templates,
  };
}

let schemaReady: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS mail_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT ''
      );
    `);
  })();
  return schemaReady;
}

export async function getMailSettings(): Promise<MailSettings> {
  await ensureSchema();
  const db = await getSqlClient("quotations");
  const row = await db.get<{ settings_json: string }>("SELECT settings_json FROM mail_settings WHERE id = 1");
  if (!row) return { ...DEFAULT_SETTINGS, templates: {} };
  try {
    return normalizeSettings(JSON.parse(row.settings_json));
  } catch {
    return { ...DEFAULT_SETTINGS, templates: {} };
  }
}

export async function saveMailSettings(input: unknown, updatedBy: string): Promise<MailSettings> {
  const settings = normalizeSettings(input);
  if (settings.testMode.enabled) {
    if (!EMAIL_PATTERN.test(settings.testMode.recipient)) throw new Error("invalid_test_recipient");
  }
  if (settings.sender.email && !EMAIL_PATTERN.test(settings.sender.email)) throw new Error("invalid_sender_email");
  if (settings.globalCc.some((email) => !EMAIL_PATTERN.test(email))) throw new Error("invalid_global_cc");
  const recipientValues = Object.values(settings.recipients);
  if (recipientValues.some((email) => email && !EMAIL_PATTERN.test(email))) throw new Error("invalid_recipient");
  for (const override of Object.values(settings.templates)) {
    if (override.cc?.some((email) => !EMAIL_PATTERN.test(email))) throw new Error("invalid_template_cc");
  }
  await ensureSchema();
  const db = await getSqlClient("quotations");
  await db.run(`
    INSERT INTO mail_settings (id,settings_json,updated_at,updated_by) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by
  `, [JSON.stringify(settings), new Date().toISOString(), updatedBy]);
  return settings;
}

export function interpolateMailTemplate(template: string, variables: Record<string, unknown> = {}): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (_, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

export function resolveMailTemplate(
  settings: MailSettings,
  key: string,
  fallback: { subject: string; body: string },
  variables: Record<string, unknown> = {},
): { subject: string; body: string; cc: string[] } {
  const override = settings.templates[key];
  const subject = override?.subject ? interpolateMailTemplate(override.subject, variables) : fallback.subject;
  const body = override?.body?.trim() ? interpolateMailTemplate(override.body, variables) : fallback.body;
  const cc = override?.cc ?? [];
  return { subject, body, cc };
}
