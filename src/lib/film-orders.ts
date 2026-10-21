import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSqlClient, type SqlClient } from "./db";
import { sendMail, type MailSendResult } from "./mailer";
import type { PurchaseOrderSnapshot } from "./purchase-order";
import type { QuotationRecord } from "./quotation-shared";
import { isSevenChemicalUser, isKaneiTradeUser, type SupplierLocale } from "./film-order-access";
import {
  DEFAULT_FILM_PROOF_EMAIL,
  type CustomerDesignTracking,
  type FilmOrderRow as SharedFilmOrderRow,
  type SampleBulkStatus,
  type SampleBulkTracking,
  type CustomerDesignStatus,
  type CustomerProofStatus,
  type CustomerProofTracking,
} from "./film-order-shared";
import { customerDesignFolderId, findDriveFiles } from "./google-drive";

interface FilmOrderRow extends SharedFilmOrderRow {
  purchase_order_json: string;
  sample_bulk_status: SampleBulkStatus;
  bulk_usage_reference_ml: string;
  sample_requested_ml: string | null;
  sample_received_ml: string | null;
  sample_adjusted_ml: string | null;
  sample_bulk_adjustment_count: number;
  sample_bulk_recipient_name: string;
  sample_bulk_recipient_postal_code: string;
  sample_bulk_recipient_address: string;
  sample_bulk_requested_at: string | null;
  sample_bulk_received_at: string | null;
  sample_bulk_confirmed_at: string | null;
  sample_bulk_adjustment_requested_at: string | null;
  sample_bulk_request_note: string;
  sample_bulk_receive_note: string;
  sample_bulk_adjustment_reason: string;
}

export function filmDesignNotificationTo(): string {
  return process.env.FILM_DESIGN_TO ?? DEFAULT_FILM_PROOF_EMAIL;
}

export function filmPracticeSupplierEmail(): string {
  return process.env.FILM_SUPPLIER_A_EMAIL ?? "arwg22@gmail.com";
}

export function filmPracticeOverrideTo(): string {
  // 練習期間中は外部宛てメールをこのアドレスへ集約する（誤送信防止）。
  return process.env.FILM_PRACTICE_TO ?? "";
}

function externalTo(address: string): string {
  const practice = filmPracticeOverrideTo();
  return practice ? practice : address;
}

/**
 * 調達経路別の校正依頼宛先。
 * - digital / K(韓国輸入) → A宛先（既定 arwg22）
 * - Y(国内調達)        → B宛先（環境変数。未設定なら送信しない）
 * 案件個別の supplier_email があればそれを優先する。
 */
export function supplierDestinationFor(order: Pick<FilmOrder, "procurement_route" | "supplier_email">): { to: string | null; route: "A" | "B" | "custom" } {
  if (order.supplier_email.trim()) return { to: externalTo(order.supplier_email.trim()), route: "custom" };
  if (order.procurement_route === "Y") {
    const b = process.env.FILM_SUPPLIER_B_EMAIL?.trim();
    return { to: b ? externalTo(b) : null, route: "B" };
  }
  return { to: externalTo(filmPracticeSupplierEmail()), route: "A" };
}

interface FilmOrderRow {
  id: number;
  order_number: string;
  quotation_id: number;
  quotation_number: string;
  product_name: string;
  customer_name: string;
  printing_method: string;
  procurement_route: string;
  film_composition: string;
  order_length_m: string;
  web_width_mm: string;
  pouch_quantity: string;
  supplier_name: string;
  supplier_email: string;
  seven_contact_email: string;
  buyer_domain: string;
  po_sent_at: string | null;
  eta_token: string | null;
  eta_expires_at: string | null;
  eta_date: string | null;
  eta_note: string | null;
  eta_updated_at: string | null;
  proof_upload_token: string | null;
  proof_upload_expires_at: string | null;
  status: FilmOrderStatus;
  re_proof_count: number;
  ordered_at: string | null;
  receiving_registered_at: string | null;
  proof_registered_at: string | null;
  re_proof_requested_at: string | null;
  final_approved_at: string | null;
  customer_design_status: CustomerDesignStatus;
  customer_design_requested_at: string | null;
  customer_design_received_at: string | null;
  customer_design_confirmed_at: string | null;
  customer_design_correction_count: number;
  customer_design_correction_reason: string;
  customer_proof_status: CustomerProofStatus;
  customer_proof_requested_at: string | null;
  customer_proof_approved_at: string | null;
  customer_proof_correction_count: number;
  customer_proof_correction_reason: string;
  purchase_order_json: string;
  notes: string;
  sample_bulk_status: SampleBulkStatus;
  bulk_usage_reference_ml: string;
  sample_requested_ml: string | null;
  sample_received_ml: string | null;
  sample_adjusted_ml: string | null;
  sample_bulk_adjustment_count: number;
  sample_bulk_recipient_name: string;
  sample_bulk_recipient_postal_code: string;
  sample_bulk_recipient_address: string;
  sample_bulk_requested_at: string | null;
  sample_bulk_received_at: string | null;
  sample_bulk_confirmed_at: string | null;
  sample_bulk_adjustment_requested_at: string | null;
  sample_bulk_request_note: string;
  sample_bulk_receive_note: string;
  sample_bulk_adjustment_reason: string;
  created_at: string;
  updated_at: string;
  created_by_email: string;
  updated_by_email: string;
}

export {
  FILM_ORDER_STATUSES,
  filmOrderStatusLabels,
  FILM_RECEIVING_FOLDER_URL,
  FILM_PROOF_FOLDER_URL,
  buildFilmOrderFileName,
} from "./film-order-shared";
export type {
  FilmOrderStatus,
  FilmOrderFileCategory,
  FilmOrderFileRecord,
  FilmOrderEventRecord,
  FilmOrder,
  FilmOrderView,
} from "./film-order-shared";


import {
  buildFilmOrderFileName,
  FILM_PROOF_FOLDER_URL,
  FILM_RECEIVING_FOLDER_URL,
  type FilmOrder,
  type FilmOrderFileCategory,
  type FilmOrderFileRecord,
  type FilmOrderEventRecord,
  type FilmOrderStatus,
  type FilmOrderView,
} from "./film-order-shared";

export type FilmOrderAction =
  | "mark-ordered"
  | "set-supplier"
  | "register-receiving"
  | "send-proof-notice"
  | "register-proof"
  | "approve"
  | "request-re-proof"
  | "send-po"
  | "resend-receiving-notice"
  | "register-receiving-extra"
  | "request-sample-bulk"
  | "rotate-supplier-proof-token"
  | "register-sample-bulk"
  | "confirm-sample-bulk"
  | "request-sample-bulk-adjustment"
  | "request-customer-design-upload"
  | "confirm-customer-design"
  | "request-customer-design-correction"
  | "set-customer-design-not-required"
  | "send-customer-proof-review"
  | "record-customer-proof-approval";

let schemaReady: Promise<SqlClient> | null = null;

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS film_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    quotation_id INTEGER NOT NULL REFERENCES quotations(id),
    quotation_number TEXT NOT NULL,
    product_name TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    printing_method TEXT NOT NULL DEFAULT '',
    procurement_route TEXT NOT NULL DEFAULT '',
    film_composition TEXT NOT NULL DEFAULT '',
    order_length_m TEXT NOT NULL DEFAULT '',
    web_width_mm TEXT NOT NULL DEFAULT '',
    pouch_quantity TEXT NOT NULL DEFAULT '',
    supplier_name TEXT NOT NULL DEFAULT '',
    supplier_email TEXT NOT NULL DEFAULT '',
    seven_contact_email TEXT NOT NULL DEFAULT '',
    buyer_domain TEXT NOT NULL DEFAULT '',
    po_sent_at TEXT,
    eta_token TEXT,
    eta_expires_at TEXT,
    eta_date TEXT,
    eta_note TEXT,
    eta_updated_at TEXT,
    proof_upload_token TEXT,
    proof_upload_expires_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','ordered','receiving_registered','proof_registered','re_proof_requested','final_approved')),
    customer_design_status TEXT NOT NULL DEFAULT 'pending' CHECK(customer_design_status IN ('pending','requested','received','correction_requested','confirmed','not_required','legacy_exempt')),
    customer_design_requested_at TEXT,
    customer_design_received_at TEXT,
    customer_design_confirmed_at TEXT,
    customer_design_correction_count INTEGER NOT NULL DEFAULT 0,
    customer_design_correction_reason TEXT NOT NULL DEFAULT '',
    customer_proof_status TEXT NOT NULL DEFAULT 'pending' CHECK(customer_proof_status IN ('pending','requested','approved','correction_requested','legacy_exempt')),
    customer_proof_requested_at TEXT,
    customer_proof_approved_at TEXT,
    customer_proof_correction_count INTEGER NOT NULL DEFAULT 0,
    customer_proof_correction_reason TEXT NOT NULL DEFAULT '',
    re_proof_count INTEGER NOT NULL DEFAULT 0,
    ordered_at TEXT,
    receiving_registered_at TEXT,
    proof_registered_at TEXT,
    re_proof_requested_at TEXT,
    final_approved_at TEXT,
    purchase_order_json TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    sample_bulk_status TEXT NOT NULL DEFAULT 'pending' CHECK(sample_bulk_status IN ('not_required','pending','requested','received','confirmed','adjustment_requested')),
    bulk_usage_reference_ml TEXT NOT NULL DEFAULT '0',
    sample_requested_ml TEXT,
    sample_received_ml TEXT,
    sample_adjusted_ml TEXT,
    sample_bulk_adjustment_count INTEGER NOT NULL DEFAULT 0,
    sample_bulk_recipient_name TEXT NOT NULL DEFAULT '株式会社セブン化学 責任技術者：福井　健二',
    sample_bulk_recipient_postal_code TEXT NOT NULL DEFAULT '〒582-0017',
    sample_bulk_recipient_address TEXT NOT NULL DEFAULT '大阪府柏原市太平寺1丁目12番1号',
    sample_bulk_requested_at TEXT,
    sample_bulk_received_at TEXT,
    sample_bulk_confirmed_at TEXT,
    sample_bulk_adjustment_requested_at TEXT,
    sample_bulk_request_note TEXT NOT NULL DEFAULT '',
    sample_bulk_receive_note TEXT NOT NULL DEFAULT '',
    sample_bulk_adjustment_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL DEFAULT '',
    updated_by_email TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS film_order_external_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    film_order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po')),
    token_hash TEXT NOT NULL UNIQUE,
    audience_email TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    last_used_ip_hash TEXT,
    created_by_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_film_external_active_token
    ON film_order_external_tokens(film_order_id, purpose)
    WHERE revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_film_orders_status ON film_orders(status);
  CREATE INDEX IF NOT EXISTS idx_film_orders_quotation ON film_orders(quotation_id);
  CREATE TABLE IF NOT EXISTS film_order_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('customer_design','receiving','proof','final')),
    file_name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    uploaded_by_email TEXT NOT NULL DEFAULT '',
    file_size_bytes INTEGER,
    content_type TEXT,
    checksum TEXT,
    checksum_algorithm TEXT,
    drive_file_id TEXT,
    uploaded_via TEXT,
    client_ip_hash TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_film_order_files_order ON film_order_files(order_id);
  CREATE TABLE IF NOT EXISTS film_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    actor_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_film_order_events_order ON film_order_events(order_id);
`;

const POSTGRES_SCHEMA = BASE_SCHEMA.replaceAll(
  "INTEGER PRIMARY KEY AUTOINCREMENT",
  "INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
);

const EXTERNAL_TOKEN_PURPOSES = [
  "supplier_proof",
  "customer_design",
  "customer_proof_review",
  "supplier_po",
] as const;

export type ExternalTokenPurpose = typeof EXTERNAL_TOKEN_PURPOSES[number];

const PUBLIC_PROOF_EXTENSIONS = [".ai", ".pdf"] as const;
const PUBLIC_PROOF_MAX_BYTES = 15 * 1024 * 1024;

export interface ExternalTokenRow {
  id: number;
  film_order_id: number;
  purpose: ExternalTokenPurpose;
  token_hash: string;
  audience_email: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  last_used_ip_hash: string | null;
  created_by_email: string;
  created_at: string;
  updated_at: string;
}

export interface IssuedExternalToken {
  token: string;
  expiresAt: Date;
}

function externalTokenSecret(): string {
  const secret = process.env.FILM_EXTERNAL_TOKEN_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("film_external_token_secret_required");
  }
  return secret;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signExternalToken(orderId: number, purpose: ExternalTokenPurpose, expiresAt: number, nonce: string): string {
  return createHmac("sha256", `${externalTokenSecret()}:film-external-token`)
    .update(`${orderId}.${purpose}.${expiresAt}.${nonce}`)
    .digest("base64url");
}

function parseExternalToken(raw: string, expectedPurpose: ExternalTokenPurpose): { orderId: number; expiresAt: number } | null {
  const parts = raw.split(".");
  if (parts.length !== 5) return null;
  const orderId = Number(parts[0]);
  const purpose = parts[1];
  const expiresAt = Number(parts[2]);
  const nonce = parts[3];
  const signature = parts[4];
  if (!Number.isInteger(orderId) || orderId <= 0) return null;
  if (purpose !== expectedPurpose) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  if (!nonce || !signature) return null;
  const expected = signExternalToken(orderId, purpose, expiresAt, nonce);
  if (!safeEqualStrings(signature, expected)) return null;
  return { orderId, expiresAt };
}

export function externalClientIpHash(request: {
  headers: { get(name: string): string | null };
}): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim();
  if (!ip) return null;
  return createHmac("sha256", `${externalTokenSecret()}:external-client`).update(ip).digest("hex");
}

export function assertSupplierProofUploadPolicy(
  order: FilmOrder,
  fileName: string,
  sizeBytes?: number,
): void {
  if (order.status !== "receiving_registered" && order.status !== "re_proof_requested") {
    throw new Error("invalid_status_transition");
  }
  if (!validFileName(fileName) || !fileName.includes(order.order_number)) {
    throw new Error("invalid_file_name");
  }
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (!fileName.includes(".") || !PUBLIC_PROOF_EXTENSIONS.includes(extension as typeof PUBLIC_PROOF_EXTENSIONS[number])) {
    throw new Error("unsupported_file_type");
  }
  if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > PUBLIC_PROOF_MAX_BYTES)) {
    throw new Error("file_too_large");
  }
}

export function proofUploadMaxBytes(): number {
  return PUBLIC_PROOF_MAX_BYTES;
}

const CUSTOMER_DESIGN_EXTENSIONS = [".ai", ".pdf"] as const;

export function customerDesignMaxBytes(): number {
  const parsed = Number(process.env.CUSTOMER_DESIGN_MAX_MB ?? 100);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed * 1024 * 1024) : 100 * 1024 * 1024;
}

function customerDesignAllowed(status: CustomerDesignStatus): boolean {
  return status === "requested" || status === "received" || status === "correction_requested";
}

export function assertCustomerDesignUploadPolicy(
  order: FilmOrder,
  fileName: string,
  sizeBytes?: number,
  hasAiFile = false,
): void {
  const normalized = validFileName(fileName);
  if (!normalized) throw new Error("invalid_file_name");
  const extension = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
  if (!normalized.includes(".") || !CUSTOMER_DESIGN_EXTENSIONS.includes(extension as typeof CUSTOMER_DESIGN_EXTENSIONS[number])) {
    throw new Error("unsupported_file_type");
  }
  if (extension === ".ai") {
    if (!["requested","received","correction_requested"].includes(order.customerDesign.status)) {
      throw new Error("invalid_status_transition");
    }
  } else {
    if (!hasAiFile) throw new Error("ai_file_required");
    if (!customerDesignAllowed(order.customerDesign.status)) throw new Error("invalid_status_transition");
  }
  const max = customerDesignMaxBytes();
  if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > max)) {
    throw new Error("file_too_large");
  }
}

function safeDesignBaseName(fileName: string): string {
  const raw = validFileName(fileName) ?? "design";
  const withoutExtension = raw.includes(".") ? raw.slice(0, raw.lastIndexOf(".")) : raw;
  return withoutExtension.replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "design";
}

function customerDesignFileName(order: FilmOrder, originalFileName: string): string {
  const version = 0; // The public complete route passes the next version.
  const extension = originalFileName.slice(originalFileName.lastIndexOf(".")).toLowerCase();
  return `${order.order_number}_design_v${version}_${safeDesignBaseName(originalFileName)}${extension}`;
}

async function issueExternalToken(
  db: SqlClient,
  orderId: number,
  purpose: ExternalTokenPurpose,
  actorEmail: string,
  options: { audienceEmail?: string | null; ttlDays?: number } = {},
): Promise<IssuedExternalToken> {
  const expiresAtMs = Date.now() + (options.ttlDays ?? 30) * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(expiresAtMs);
  const nonce = randomBytes(18).toString("base64url");
  const token = `${orderId}.${purpose}.${expiresAtMs}.${nonce}.${signExternalToken(orderId, purpose, expiresAtMs, nonce)}`;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE film_order_external_tokens
      SET revoked_at = ?, updated_at = ?
      WHERE film_order_id = ? AND purpose = ? AND revoked_at IS NULL
    `, [now, now, orderId, purpose]);
    await tx.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,audience_email,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `, [
      orderId,
      purpose,
      sha256(token),
      options.audienceEmail?.trim() || null,
      expiresAt.toISOString(),
      actorEmail,
      now,
      now,
    ]);
  });
  await addEvent(db, orderId, "token", `外部トークンを発行/更新: ${purpose}`, actorEmail);
  return { token, expiresAt };
}

async function resolveExternalToken(
  db: SqlClient,
  rawToken: string,
  expectedPurpose: ExternalTokenPurpose,
): Promise<{ orderId: number; token: ExternalTokenRow } | null> {
  const parsed = parseExternalToken(rawToken, expectedPurpose);
  if (!parsed) return null;
  const row = await db.get<ExternalTokenRow>(
    "SELECT * FROM film_order_external_tokens WHERE token_hash = ? AND purpose = ? AND film_order_id = ?",
    [sha256(rawToken), expectedPurpose, parsed.orderId],
  );
  if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { orderId: parsed.orderId, token: row };
}

async function markExternalTokenUse(
  db: SqlClient,
  token: ExternalTokenRow,
  request?: { headers: { get(name: string): string | null } },
): Promise<void> {
  const now = new Date().toISOString();
  const ipHash = request ? externalClientIpHash(request) : null;
  await db.run(
    "UPDATE film_order_external_tokens SET last_used_at = ?, last_used_ip_hash = COALESCE(?, last_used_ip_hash), updated_at = ? WHERE id = ?",
    [now, ipHash, now, token.id],
  );
}

async function recordExternalTokenEvent(
  request: { headers: { get(name: string): string | null } } | undefined,
  rawToken: string,
  expectedPurpose: ExternalTokenPurpose,
  outcome: "allowed" | "denied",
  detail: string,
): Promise<void> {
  try {
    const db = await getDatabase();
    const resolved = await resolveExternalToken(db, rawToken, expectedPurpose);
    if (!resolved) return;
    await markExternalTokenUse(db, resolved.token, request);
    await addEvent(
      db,
      resolved.orderId,
      "token_access",
      `${expectedPurpose} ${outcome}: ${detail}`,
      `external:${expectedPurpose}`,
    );
  } catch {
    // アクセス記録失敗でファイル応答を壊さない。
  }
}

async function migrateFilmOrderFileCategory(db: SqlClient): Promise<void> {
  if (db.dialect === "sqlite") {
    const row = await db.get<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'film_order_files'"
    );
    if (!row?.sql || row.sql.includes("'customer_design'")) return;
    await db.exec(`
      CREATE TABLE film_order_files_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK(category IN ('customer_design','receiving','proof','final')),
        file_name TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        uploaded_by_email TEXT NOT NULL DEFAULT '',
        file_size_bytes INTEGER,
        content_type TEXT,
        checksum TEXT,
        checksum_algorithm TEXT,
        drive_file_id TEXT,
        uploaded_via TEXT,
        client_ip_hash TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO film_order_files_new (
        id,order_id,category,file_name,url,version,note,uploaded_by_email,
        file_size_bytes,content_type,checksum,checksum_algorithm,drive_file_id,
        uploaded_via,client_ip_hash,user_agent,created_at
      )
      SELECT id,order_id,category,file_name,url,version,note,uploaded_by_email,
             file_size_bytes,content_type,checksum,checksum_algorithm,drive_file_id,
             uploaded_via,client_ip_hash,user_agent,created_at
      FROM film_order_files;
      DROP TABLE film_order_files;
      ALTER TABLE film_order_files_new RENAME TO film_order_files;
      CREATE INDEX IF NOT EXISTS idx_film_order_files_order ON film_order_files(order_id);
    `);
    return;
  }

  await db.exec("ALTER TABLE film_order_files DROP CONSTRAINT IF EXISTS film_order_files_category_check");
  await db.exec("ALTER TABLE film_order_files ADD CONSTRAINT film_order_files_category_check CHECK(category IN ('customer_design','receiving','proof','final'))");
}

async function migrateExternalTokenPurposes(db: SqlClient): Promise<void> {
  if (db.dialect === "sqlite") {
    const row = await db.get<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'film_order_external_tokens'"
    );
    if (!row?.sql || row.sql.includes("'supplier_po'")) return;
    await db.exec(`
      DROP INDEX IF EXISTS idx_film_external_active_token;
      ALTER TABLE film_order_external_tokens RENAME TO film_order_external_tokens_legacy_purpose;
      CREATE TABLE film_order_external_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        film_order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po')),
        token_hash TEXT NOT NULL UNIQUE,
        audience_email TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        last_used_ip_hash TEXT,
        created_by_email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO film_order_external_tokens (
        id,film_order_id,purpose,token_hash,audience_email,expires_at,revoked_at,
        last_used_at,last_used_ip_hash,created_by_email,created_at,updated_at
      )
      SELECT id,film_order_id,purpose,token_hash,audience_email,expires_at,revoked_at,
             last_used_at,last_used_ip_hash,created_by_email,created_at,updated_at
      FROM film_order_external_tokens_legacy_purpose;
      DROP TABLE film_order_external_tokens_legacy_purpose;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_film_external_active_token
        ON film_order_external_tokens(film_order_id, purpose)
        WHERE revoked_at IS NULL;
    `);
    return;
  }

  await db.exec("ALTER TABLE film_order_external_tokens DROP CONSTRAINT IF EXISTS film_order_external_tokens_purpose_check");
  await db.exec(`
    ALTER TABLE film_order_external_tokens
    ADD CONSTRAINT film_order_external_tokens_purpose_check
    CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po'))
  `);
}

async function migrateLegacyProofTokens(db: SqlClient): Promise<void> {
  const rows = await db.all<{ id: number; proof_upload_token: string | null; proof_upload_expires_at: string | null }>(
    "SELECT id, proof_upload_token, proof_upload_expires_at FROM film_orders WHERE proof_upload_token IS NOT NULL AND proof_upload_token != ''",
  );
  const now = Date.now();
  for (const row of rows) {
    const raw = row.proof_upload_token;
    if (!raw) continue;
    const expires = row.proof_upload_expires_at ? new Date(row.proof_upload_expires_at).getTime() : 0;
    if (!Number.isFinite(expires) || expires <= now) {
      await db.run(
        "UPDATE film_orders SET proof_upload_token = NULL, proof_upload_expires_at = NULL WHERE id = ?",
        [row.id],
      );
      continue;
    }
    const existing = await db.get<ExternalTokenRow>(
      "SELECT id FROM film_order_external_tokens WHERE token_hash = ? AND purpose = 'supplier_proof'",
      [sha256(raw)],
    );
    await db.transaction(async (tx) => {
      if (!existing) {
        await tx.run(`
          INSERT INTO film_order_external_tokens (
            film_order_id,purpose,token_hash,expires_at,created_by_email,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?)
        `, [row.id, "supplier_proof", sha256(raw), new Date(expires).toISOString(), "legacy-migration", now, now]);
      }
      await tx.run(
        "UPDATE film_orders SET proof_upload_token = NULL, proof_upload_expires_at = NULL WHERE id = ?",
        [row.id],
      );
    });
  }
}

export interface UploadFileMetadata {
  fileSizeBytes?: number | null;
  contentType?: string | null;
  checksum?: string | null;
  checksumAlgorithm?: string | null;
  driveFileId?: string | null;
  uploadedVia?: string | null;
  clientIpHash?: string | null;
  userAgent?: string | null;
}

async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : BASE_SCHEMA);
    const migrations: Array<[string, string]> = [
      ["film_order_files", "ALTER TABLE film_order_files ADD COLUMN url TEXT NOT NULL DEFAULT ''"],
      ["film_orders_seven_contact", "ALTER TABLE film_orders ADD COLUMN seven_contact_email TEXT NOT NULL DEFAULT ''"],
      ["film_orders_po_sent", "ALTER TABLE film_orders ADD COLUMN po_sent_at TEXT"],
      ["film_orders_eta_token", "ALTER TABLE film_orders ADD COLUMN eta_token TEXT"],
      ["film_orders_eta_expires", "ALTER TABLE film_orders ADD COLUMN eta_expires_at TEXT"],
      ["film_orders_eta_date", "ALTER TABLE film_orders ADD COLUMN eta_date TEXT"],
      ["film_orders_eta_note", "ALTER TABLE film_orders ADD COLUMN eta_note TEXT"],
      ["film_orders_eta_updated", "ALTER TABLE film_orders ADD COLUMN eta_updated_at TEXT"],
      ["film_orders_proof_token", "ALTER TABLE film_orders ADD COLUMN proof_upload_token TEXT"],
      ["film_orders_proof_expires", "ALTER TABLE film_orders ADD COLUMN proof_upload_expires_at TEXT"],
      // 既存テーブル（buyer_domain 導入前）向け。新規テーブルでは重複エラーを無視する。
      ["film_orders_buyer_domain", "ALTER TABLE film_orders ADD COLUMN buyer_domain TEXT NOT NULL DEFAULT ''"],
      ["film_orders_sample_bulk_status", "ALTER TABLE film_orders ADD COLUMN sample_bulk_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_bulk_usage_reference", "ALTER TABLE film_orders ADD COLUMN bulk_usage_reference_ml TEXT NOT NULL DEFAULT '0'"],
      ["film_orders_sample_requested", "ALTER TABLE film_orders ADD COLUMN sample_requested_ml TEXT"],
      ["film_orders_sample_received", "ALTER TABLE film_orders ADD COLUMN sample_received_ml TEXT"],
      ["film_orders_sample_adjusted", "ALTER TABLE film_orders ADD COLUMN sample_adjusted_ml TEXT"],
      ["film_orders_sample_bulk_adjustment_count", "ALTER TABLE film_orders ADD COLUMN sample_bulk_adjustment_count INTEGER NOT NULL DEFAULT 0"],
      ["film_orders_sample_bulk_recipient_name", "ALTER TABLE film_orders ADD COLUMN sample_bulk_recipient_name TEXT NOT NULL DEFAULT '株式会社セブン化学 責任技術者：福井　健二'"],
      ["film_orders_sample_bulk_recipient_postal_code", "ALTER TABLE film_orders ADD COLUMN sample_bulk_recipient_postal_code TEXT NOT NULL DEFAULT '〒582-0017'"],
      ["film_orders_sample_bulk_recipient_address", "ALTER TABLE film_orders ADD COLUMN sample_bulk_recipient_address TEXT NOT NULL DEFAULT '大阪府柏原市太平寺1丁目12番1号'"],
      ["film_orders_sample_bulk_requested_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_requested_at TEXT"],
      ["film_orders_sample_bulk_received_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_received_at TEXT"],
      ["film_orders_sample_bulk_confirmed_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_confirmed_at TEXT"],
      ["film_orders_sample_bulk_adjustment_requested_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_adjustment_requested_at TEXT"],
      ["film_orders_sample_bulk_request_note", "ALTER TABLE film_orders ADD COLUMN sample_bulk_request_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_sample_bulk_receive_note", "ALTER TABLE film_orders ADD COLUMN sample_bulk_receive_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_sample_bulk_adjustment_reason", "ALTER TABLE film_orders ADD COLUMN sample_bulk_adjustment_reason TEXT NOT NULL DEFAULT ''"],
      ["film_order_files_size", "ALTER TABLE film_order_files ADD COLUMN file_size_bytes INTEGER"],
      ["film_order_files_content_type", "ALTER TABLE film_order_files ADD COLUMN content_type TEXT"],
      ["film_order_files_checksum", "ALTER TABLE film_order_files ADD COLUMN checksum TEXT"],
      ["film_order_files_checksum_algorithm", "ALTER TABLE film_order_files ADD COLUMN checksum_algorithm TEXT"],
      ["film_order_files_drive_id", "ALTER TABLE film_order_files ADD COLUMN drive_file_id TEXT"],
      ["film_order_files_uploaded_via", "ALTER TABLE film_order_files ADD COLUMN uploaded_via TEXT"],
      ["film_order_files_ip_hash", "ALTER TABLE film_order_files ADD COLUMN client_ip_hash TEXT"],
      ["film_order_files_user_agent", "ALTER TABLE film_order_files ADD COLUMN user_agent TEXT"],
      ["film_orders_customer_design_status", "ALTER TABLE film_orders ADD COLUMN customer_design_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_customer_design_requested_at", "ALTER TABLE film_orders ADD COLUMN customer_design_requested_at TEXT"],
      ["film_orders_customer_design_received_at", "ALTER TABLE film_orders ADD COLUMN customer_design_received_at TEXT"],
      ["film_orders_customer_design_confirmed_at", "ALTER TABLE film_orders ADD COLUMN customer_design_confirmed_at TEXT"],
      ["film_orders_customer_design_correction_count", "ALTER TABLE film_orders ADD COLUMN customer_design_correction_count INTEGER NOT NULL DEFAULT 0"],
      ["film_orders_customer_design_correction_reason", "ALTER TABLE film_orders ADD COLUMN customer_design_correction_reason TEXT NOT NULL DEFAULT ''"],
      ["film_orders_customer_proof_status", "ALTER TABLE film_orders ADD COLUMN customer_proof_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_customer_proof_requested_at", "ALTER TABLE film_orders ADD COLUMN customer_proof_requested_at TEXT"],
      ["film_orders_customer_proof_approved_at", "ALTER TABLE film_orders ADD COLUMN customer_proof_approved_at TEXT"],
      ["film_orders_customer_proof_correction_count", "ALTER TABLE film_orders ADD COLUMN customer_proof_correction_count INTEGER NOT NULL DEFAULT 0"],
      ["film_orders_customer_proof_correction_reason", "ALTER TABLE film_orders ADD COLUMN customer_proof_correction_reason TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [, sql] of migrations) {
      try {
        await db.exec(sql);
      } catch {
        // 既存カラムの場合は無視する。
      }
    }
    if (db.dialect === "sqlite") {
      const columns = await db.all<{ name: string }>("PRAGMA table_info(film_orders)");
      const names = new Set(columns.map((column) => column.name));
      if (names.has("sample_bulk_required_ml")) {
        await db.exec(`
          UPDATE film_orders
          SET bulk_usage_reference_ml = CASE WHEN sample_bulk_required_ml IS NOT NULL AND sample_bulk_required_ml != ''
            THEN sample_bulk_required_ml ELSE bulk_usage_reference_ml END,
            sample_bulk_required_ml = '0',
            sample_bulk_received_ml = NULL,
            sample_bulk_adjusted_ml = NULL,
            sample_bulk_status = CASE WHEN sample_bulk_status IN ('not_required') THEN sample_bulk_status ELSE 'pending' END
        `);
      }
    } else {
      const legacyColumn = await db.get<{ exists: number | boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'film_orders' AND column_name = 'sample_bulk_required_ml'
        ) AS exists
      `);
      if (legacyColumn?.exists) {
        await db.exec(`
          UPDATE film_orders
          SET bulk_usage_reference_ml = CASE WHEN sample_bulk_required_ml IS NOT NULL AND sample_bulk_required_ml != ''
            THEN sample_bulk_required_ml ELSE bulk_usage_reference_ml END,
            sample_bulk_required_ml = '0',
            sample_bulk_received_ml = NULL,
            sample_bulk_adjusted_ml = NULL,
            sample_bulk_status = CASE WHEN sample_bulk_status IN ('not_required') THEN sample_bulk_status ELSE 'pending' END
        `);
      }
    }
    try {
      // 空の buyer_domain は元見積の発注者会社から補完する。
      await db.exec(`
        UPDATE film_orders f
        SET buyer_domain = CASE WHEN u.email LIKE '%@727.co.jp' THEN '727.co.jp' ELSE 'kanei-trade.co.jp' END,
            created_by_email = COALESCE(NULLIF(f.created_by_email, ''), u.email)
        FROM quotations q
        JOIN users u ON u.id = q.created_by
        WHERE f.quotation_id = q.id
      `);
      await db.exec("UPDATE film_orders SET buyer_domain = 'kanei-trade.co.jp' WHERE buyer_domain IS NULL OR buyer_domain = ''");
    } catch {
      // 無視（初回は空）。
    }
    {
      // 既存発注にも見積のバルク使用量から追跡カードを作成する。
      const existing = await db.all<{ id: number; payload_json: string }>(`
        SELECT f.id, q.payload_json
        FROM film_orders f
        JOIN quotations q ON q.id = f.quotation_id
        WHERE f.bulk_usage_reference_ml = '0'
      `);
      for (const row of existing) {
        try {
          const quotation = { payload: JSON.parse(row.payload_json) } as unknown as QuotationRecord;
          await db.run(
            "UPDATE film_orders SET bulk_usage_reference_ml = ? WHERE id = ?",
            [productionBulkUsageMlOf(quotation), row.id],
          );
        } catch {
          // 不正な旧payloadは参考値0のまま残す。
        }
      }
    }
    for (const [, sql] of migrations) {
      try {
        await db.exec(sql);
      } catch {
        // 既存カラムの場合は無視する。
      }
    }
    await migrateFilmOrderFileCategory(db);
    await migrateExternalTokenPurposes(db);
    await db.exec(`
      UPDATE film_orders
      SET customer_design_status = 'legacy_exempt'
      WHERE status IN ('receiving_registered','proof_registered','re_proof_requested','final_approved')
        AND customer_design_status = 'pending'
    `);
    await db.exec(`
      UPDATE film_orders
      SET customer_proof_status = 'legacy_exempt'
      WHERE status IN ('proof_registered','re_proof_requested','final_approved')
        AND customer_proof_status = 'pending'
    `);
    await migrateLegacyProofTokens(db);
    return db;
  })();
  return schemaReady;
}

function parsePurchaseOrder(value: unknown): PurchaseOrderSnapshot | null {
  if (value && typeof value === "object") return value as PurchaseOrderSnapshot;
  if (typeof value === "string" && value.trim()) {
    try {
      return JSON.parse(value) as PurchaseOrderSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

function purchaseOrderOf(quotation: QuotationRecord): PurchaseOrderSnapshot | null {
  const payload = quotation.payload as Record<string, unknown>;
  return parsePurchaseOrder(payload.purchaseOrder ?? payload.purchaseOrderJson);
}

async function nextOrderNumber(db: SqlClient): Promise<string> {
  const now = new Date();
  const prefix = `F-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-`;
  const row = await db.get<{ order_number: string }>(
    "SELECT order_number FROM film_orders WHERE order_number LIKE ? ORDER BY order_number DESC LIMIT 1",
    [`${prefix}%`],
  );
  const last = row ? Number(row.order_number.slice(prefix.length)) : 0;
  return `${prefix}${String(Number.isFinite(last) ? last + 1 : 1).padStart(3, "0")}`;
}

function productionBulkUsageMlOf(quotation: QuotationRecord): string {
  const snapshot = quotation.payload.calculationChecklistSnapshot as { bulkUsageMl?: unknown } | undefined;
  const value = Number(snapshot?.bulkUsageMl ?? 0);
  return Number.isFinite(value) && value > 0 ? String(value) : "0";
}

function mapOrder(row: FilmOrderRow): FilmOrder {
  const { purchase_order_json, ...rest } = row;
  const sampleBulk: SampleBulkTracking = {
    status: row.sample_bulk_status,
    productionBulkUsageMl: row.bulk_usage_reference_ml || "0",
    sampleQuantityMl: row.sample_requested_ml,
    sampleReceivedMl: row.sample_received_ml,
    sampleAdjustedMl: row.sample_adjusted_ml,
    adjustmentCount: Number(row.sample_bulk_adjustment_count || 0),
    recipientName: row.sample_bulk_recipient_name,
    recipientPostalCode: row.sample_bulk_recipient_postal_code,
    recipientAddress: row.sample_bulk_recipient_address,
    requestedAt: row.sample_bulk_requested_at,
    receivedAt: row.sample_bulk_received_at,
    confirmedAt: row.sample_bulk_confirmed_at,
    adjustmentRequestedAt: row.sample_bulk_adjustment_requested_at,
    requestNote: row.sample_bulk_request_note,
    receiveNote: row.sample_bulk_receive_note,
    adjustmentReason: row.sample_bulk_adjustment_reason,
  };
  const customerDesign: CustomerDesignTracking = {
    status: row.customer_design_status,
    requestedAt: row.customer_design_requested_at,
    receivedAt: row.customer_design_received_at,
    confirmedAt: row.customer_design_confirmed_at,
    correctionCount: Number(row.customer_design_correction_count || 0),
    correctionReason: row.customer_design_correction_reason,
    note: "",
  };
  const customerProof: CustomerProofTracking = {
    status: row.customer_proof_status,
    requestedAt: row.customer_proof_requested_at,
    approvedAt: row.customer_proof_approved_at,
    correctionCount: Number(row.customer_proof_correction_count || 0),
    correctionReason: row.customer_proof_correction_reason,
  };
  return {
    ...rest,
    purchaseOrder: parsePurchaseOrder(purchase_order_json),
    sampleBulk,
    customerDesign,
    customerProof,
  };
}

/**
 * 成約（approved）済み見積のうち、発注管理に未反映のものを発注待ちとして登録する。
 * 冪等なので一覧取得のたびに実行してよい。
 */
export async function syncFilmOrdersFromQuotations(actorEmail = "system"): Promise<number> {
  const db = await getDatabase();
  const rows = await db.all<{ id: number }>(`
    SELECT quotations.id
    FROM quotations
    LEFT JOIN film_orders ON film_orders.quotation_id = quotations.id
    WHERE quotations.status = 'approved' AND film_orders.id IS NULL
    ORDER BY quotations.id
  `);
  const { getQuotation } = await import("./quotation-store");
  let created = 0;
  for (const row of rows) {
    const quotation = await getQuotation(row.id);
    if (!quotation) continue;
    const snapshot = purchaseOrderOf(quotation);
    const now = new Date().toISOString();
    const orderNumber = await nextOrderNumber(db);
    await db.run(`
      INSERT INTO film_orders (
        order_number, quotation_id, quotation_number, product_name, customer_name, printing_method, procurement_route, film_composition, order_length_m, web_width_mm, pouch_quantity, supplier_name, supplier_email, seven_contact_email, buyer_domain, status, purchase_order_json, sample_bulk_status, bulk_usage_reference_ml, created_at, updated_at, created_by_email, updated_by_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orderNumber,
      quotation.id,
      quotation.quotationNumber,
      quotation.productName,
      quotation.customerName,
      snapshot?.printingMethod ?? "",
      snapshot?.procurementRoute ?? "",
      snapshot?.filmComposition ?? "",
      snapshot?.orderLengthM ?? "",
      String(snapshot?.webWidthsMm?.[0] ?? snapshot?.webWidthMm ?? ""),
      quotation.quantity,
      "",
      DEFAULT_FILM_PROOF_EMAIL,
      quotation.createdBy.email,
      isSevenChemicalUser(quotation.createdBy.email) ? "727.co.jp" : "kanei-trade.co.jp",
      "pending",
      JSON.stringify(snapshot ?? {}),
      "pending",
      productionBulkUsageMlOf(quotation),
      now,
      now,
      quotation.createdBy.email,
      quotation.createdBy.email,
    ]);
    const inserted = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number = ?", [orderNumber]);
    if (inserted) {
      await db.run(
        "INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)",
        [inserted.id, "created", `成約見積 ${quotation.quotationNumber} から発注 ${orderNumber} を作成`, actorEmail, now],
      );
      created += 1;
    }
  }
  return created;
}

export async function listFilmOrders(actorEmail?: string): Promise<FilmOrderView[]> {
  const db = await getDatabase();
  const rows = await db.all<FilmOrderRow>("SELECT * FROM film_orders ORDER BY created_at DESC, id DESC");
  const visible = rows.filter((row) => {
    const buyerIsSeven = isSevenChemicalUser(row.created_by_email);
    if (buyerIsSeven) return true; // セブン発注はカネイ（供給側）も閲覧する。
    return isKaneiTradeUser(actorEmail); // カネイ発注はカネイのみ。
  });
  const files = await db.all<FilmOrderFileRecord>("SELECT * FROM film_order_files ORDER BY created_at, id");
  const events = await db.all<FilmOrderEventRecord>("SELECT * FROM film_order_events ORDER BY created_at, id");
  return visible.map((row) => ({
    ...mapOrder(row),
    files: files.filter((file) => file.order_id === row.id),
    events: events.filter((event) => event.order_id === row.id),
  }));
}

export async function getFilmOrder(id: number): Promise<FilmOrderView | null> {
  const db = await getDatabase();
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [id]);
  if (!row) return null;
  const files = await db.all<FilmOrderFileRecord>(
    "SELECT * FROM film_order_files WHERE order_id = ? ORDER BY created_at, id",
    [id],
  );
  const events = await db.all<FilmOrderEventRecord>(
    "SELECT * FROM film_order_events WHERE order_id = ? ORDER BY created_at, id",
    [id],
  );
  return { ...mapOrder(row), files, events };
}

function mailBodyBase(order: FilmOrder): string {
  return [
    `発注番号: ${order.order_number}`,
    `見積番号: ${order.quotation_number}`,
    `商品名: ${order.product_name || "-"}`,
    `顧客名: ${order.customer_name || "-"}`,
    `印刷方式: ${order.printing_method || "-"}`,
    `原反幅: ${order.web_width_mm ? `${order.web_width_mm}mm` : "-"}`,
    `発注長: ${order.order_length_m ? `${order.order_length_m}m` : "-"}`,
  ].join("\n");
}

async function addEvent(db: SqlClient, orderId: number, type: string, detail: string, actorEmail: string): Promise<void> {
  await db.run(
    "INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)",
    [orderId, type, detail, actorEmail, new Date().toISOString()],
  );
}

async function addFile(
  db: SqlClient,
  orderId: number,
  category: FilmOrderFileCategory,
  fileName: string,
  url: string,
  note: string,
  actorEmail: string,
  metadata: UploadFileMetadata = {},
): Promise<FilmOrderFileRecord> {
  const count = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM film_order_files WHERE order_id = ? AND category = ?",
    [orderId, category],
  );
  const version = Number(count?.n ?? 0) + 1;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO film_order_files (
       order_id,category,file_name,url,version,note,uploaded_by_email,
       file_size_bytes,content_type,checksum,checksum_algorithm,drive_file_id,
       uploaded_via,client_ip_hash,user_agent,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      orderId, category, fileName, url, version, note, actorEmail,
      metadata.fileSizeBytes ?? null,
      metadata.contentType ?? null,
      metadata.checksum ?? null,
      metadata.checksumAlgorithm ?? null,
      metadata.driveFileId ?? null,
      metadata.uploadedVia ?? "internal",
      metadata.clientIpHash ?? null,
      metadata.userAgent ?? null,
      now,
    ],
  );
  const row = await db.get<FilmOrderFileRecord>(
    "SELECT * FROM film_order_files WHERE order_id = ? AND category = ? ORDER BY id DESC LIMIT 1",
    [orderId, category],
  );
  if (!row) throw new Error("film_order_file_failed");
  return row;
}

function fileLinksSection(files: string[]): string {
  const links = files.filter(Boolean);
  return links.length > 0 ? links.join("\n") : "（URL未登録: Driveフォルダのファイル名で確認してください）";
}

function supplierScopedArtworkLinks(
  order: FilmOrderView,
  token: string,
  origin: string,
): string[] {
  return order.files
    .filter((file) => file.category === "receiving")
    .map((file) => {
      const fileId = file.drive_file_id || file.url.split("/d/")[1]?.split("/")[0] || "";
      const label = file.file_name || fileId || "file";
      if (!fileId) return `${label}: (URL未登録)`;
      return `${label}: ${origin}/api/film-orders/proof-download/${encodeURIComponent(token)}?fileId=${encodeURIComponent(fileId)}`;
    });
}

function proofNoticeText(order: FilmOrder, supplierLinks: string[] = [], uploadUrl = "", localeInput?: MailLocale): string {
  const locale = localeInput ?? supplierLocale(order);
  const proofName = buildFilmOrderFileName(order, "proof", 1);
  const destination = supplierDestinationFor(order);
  if (locale === "ko") {
    return [
      "필름 제작 파트너 담당자님",
      "",
      "항상 원활한 협조를 주셔서 감사합니다. 패키지랩입니다.",
      "",
      "아래 건의 필름 제작과 교정 데이터 제작을 요청드리고자 연락드립니다.",
      "바쁘시겠지만 제작 가능 여부와 납기 전망을 확인해 주시기 바랍니다.",
      "",
      "【案件 정보】",
      localizedMailBody(order, locale),
      "",
      "【입고 데이터】",
      fileLinksSection(supplierLinks),
      "",
      "【제작·교정 요청 사항】",
      "1. 입고된 데이터를 필름 도면에 따라 배치해 주십시오.",
      "2. 색상, 배치, 문자 정보에 누락이 없는지 확인해 주십시오.",
      "3. 교정 데이터는 반드시 아래 업로드 페이지로 제출해 주십시오.",
      "4. 업로드 시 파일명에 발주번호를 반드시 포함해 주십시오.",
      "",
      "【교정 데이터 제출 페이지】",
      uploadUrl,
      "",
      `권장 파일명：${proofName}_v번호`,
      destination.route === "B" ? "조달 구분：Y (국내)" : destination.route === "A" ? "조달 구분：A (디지털 / 한국 수입)" : "",
      "",
      "Google 로그인은 필요하지 않습니다. 관리 통일을 위해 다른 방식의 제출은 받고 있지 않습니다.",
      "진행 제약이나 납기 이슈가 있다면 초기에 알려주시기 바랍니다.",
      "",
      "--",
      "Package Lab",
      "shapepouch@package-lab.com",
    ].filter(Boolean).join("\n");
  }
  return [
    "フィルム製作パートナー ご担当者様",
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    "下記案件のフィルム製作と校正データ作成をお願いしたく、ご連絡いたしました。",
    "お忙しいところ恐れ入りますが、製作可否および納期見込みをご確認いただけますと幸いです。",
    "",
    "【案件情報】",
    localizedMailBody(order, locale),
    "",
    "【入稿データ】",
    fileLinksSection(supplierLinks),
    "",
    "【製作・校正依頼内容】",
    "1. 上記入稿データをフィルム図面に沿って配置してください。",
    "2. 色味・配置・文字情報に欠落がないかをご確認ください。",
    "3. 校正データは必ず下記アップロードページから返却してください。",
    "4. アップロード時はファイル名に発注番号を必ず含めてください。",
    "",
    "【校正データ返却ページ】",
    uploadUrl,
    "",
    `推奨ファイル名：${proofName}_v番号`,
    destination.route === "B" ? "調達区分：Y調達（国内）" : destination.route === "A" ? "調達区分：A（digital / 韓国輸入）" : "",
    "",
    "Googleログインは不要です。その他の手段での返却は管理上一律受付できませんので、あらかじめご了承ください。",
    "ご確認のうえ、進行上の制約がある場合はお早めにお知らせください。",
    "",
    "--",
    "パッケージラボ",
    "shapepouch@package-lab.com",
  ].filter(Boolean).join("\n");
}

async function sendReceivingNotice(
  order: FilmOrderView,
  aiFileName: string,
  aiFileUrl: string,
  pdfFileName: string | null,
  pdfFileUrl: string,
  uploadUrl: string,
  artworkToken?: string,
  actionOrigin?: string,
): Promise<MailSendResult[]> {
  const supplierLinks = supplierScopedArtworkLinks(order, artworkToken ?? "", actionOrigin ?? "https://seven-calcul.vercel.app");
  const designMail = await sendMail({
    to: filmDesignNotificationTo(),
    subject: `【入稿登録】${order.order_number} ${order.product_name}`,
    text: [
      "フィルム製作用の入稿データが登録されました。下記内容をご確認のうえ、校正データ作成をご手配ください。",
      "",
      "【案件情報】",
      mailBodyBase(order),
      "",
      "【入稿データ】",
      `AI（必須）：${aiFileName}${aiFileUrl ? `\n${aiFileUrl}` : ""}`,
      pdfFileName ? `PDF（参考）：${pdfFileName}${pdfFileUrl ? `\n${pdfFileUrl}` : ""}` : "PDF（参考）：なし",
      "",
      "【格納場所】",
      `入稿データフォルダ：${FILM_RECEIVING_FOLDER_URL}`,
      `校正データ返却先：${FILM_PROOF_FOLDER_URL}`,
      "",
      "【依頼事項】",
      "1. 入稿AIの図面配置・色分解・文字アウトライン状況をご確認ください。",
      "2. 製作可否と想定納期を確認のうえ、校正データをご返却ください。",
      "3. 入稿内容に製造上の懸念がある場合は、進行前にその旨をご連絡ください。",
    ].join("\n"),
  });
  const destination = supplierDestinationFor(order);
  const mails: MailSendResult[] = [designMail];
  if (destination.to) {
    mails.push(await sendMail({
      to: destination.to,
      subject: proofRequestSubject(order, supplierLocale(order)),
      text: proofNoticeText(order, supplierLinks, uploadUrl),
    }));
  }
  return mails;
}

async function sendProofNoticeMail(order: FilmOrderView, uploadUrl: string, proofToken: string, origin: string): Promise<MailSendResult> {
  const destination = supplierDestinationFor(order);
  const supplierLinks = supplierScopedArtworkLinks(order, proofToken, origin);
  return sendMail({
    to: destination.to ?? filmDesignNotificationTo(),
    subject: proofRequestSubject(order, supplierLocale(order)),
    text: proofNoticeText(order, supplierLinks, uploadUrl),
  });
}

async function sendApprovalMail(order: FilmOrder): Promise<MailSendResult[]> {
  const locale = supplierLocale(order);
  const subject = locale === "ko"
    ? `【교정 승인 · 최종 수주 확정】${order.order_number} ${order.product_name || ""}`.trim()
    : `【校正承認・最終受注確定】${order.order_number} ${order.product_name || ""}`.trim();
  const supplierText = locale === "ko"
    ? [
      "항상 원활한 협조를 주셔서 감사합니다. 패키지랩입니다.",
      "",
      "아래 건의 교정 데이터가 고객 및 내부 최종 승인을 통과했습니다. 이에 따라 카네이무역으로서 최종 수주 처리를 확정합니다.",
      "",
      "【案件 정보】",
      localizedMailBody(order, locale),
      "",
      "【이후 진행】",
      "1. 승인된 교정 데이터를 기준으로 제작을 진행해 주십시오.",
      "2. 이후 사양 변경은 재교정 및 재견적이 필요합니다.",
      "3. 제작 일정에 제약이 확인되면 즉시 공유해 주십시오.",
      "",
      "감사합니다.",
    ].join("\n")
    : [
      "いつも大変お世話になっております。パッケージラボでございます。",
      "",
      "下記案件の校正データが顧客および社内最終承認を通過いたしました。つきましては、金井貿易として最終受注処理を確定いたしますので、ご案内申し上げます。",
      "",
      "【案件情報】",
      localizedMailBody(order, locale),
      "",
      "【今後の進行】",
      "1. 承認済み校正データを基準に製作を進行してください。",
      "2. 以降の仕様変更は再校正・再見積が必要となります。",
      "3. 製造上の納期制約が判明した場合は、速やかにご連絡ください。",
      "",
      "ご協力のほど、よろしくお願い申し上げます。",
    ].join("\n");
  const japaneseText = [
    "下記案件の校正データが顧客および社内最終承認を通過いたしました。つきましては、金井貿易として最終受注処理を確定いたしますので、ご案内申し上げます。",
    "",
    "【案件情報】",
    mailBodyBase(order),
    "",
    "【今後の進行】",
    "1. 承認済み校正データを基準に製作を進行してください。",
    "2. 以降の仕様変更は再校正・再見積が必要となります。",
    "3. 製造上の納期制約が判明した場合は、速やかにご連絡ください。",
  ].join("\n");
  const destination = supplierDestinationFor(order);
  const mails: MailSendResult[] = [];
  if (destination.to) mails.push(await sendMail({ to: destination.to, subject, text: supplierText }));
  mails.push(await sendMail({ to: externalTo(order.seven_contact_email), subject, text: japaneseText }));
  mails.push(await sendMail({ to: filmDesignNotificationTo(), subject, text: japaneseText }));
  return mails;
}

async function sendReProofMail(order: FilmOrderView, internalComment: string, supplierMessage: string, uploadUrl: string, proofToken: string, origin: string): Promise<MailSendResult[]> {
  const locale = supplierLocale(order);
  const subject = locale === "ko"
    ? `【재교정 요청】${order.order_number} ${order.product_name || ""}`.trim()
    : `【再校正のお願い】${order.order_number} ${order.product_name || ""}`.trim();
  const supplierText = locale === "ko"
    ? [
      "필름 제작 파트너 담당자님",
      "",
      "항상 원활한 협조를 주셔서 감사합니다. 패키지랩입니다.",
      "",
      "아래 건의 교정 데이터를 품질 확인한 결과, 재교정이 필요했습니다. 번거로우시겠지만 아래 내용으로 대응을 부탁드립니다.",
      "",
      "【案件 정보】",
      localizedMailBody(order, locale),
      "",
      "【재교정 내용】",
      supplierMessage,
      "",
      `재교정 횟수：${order.re_proof_count + 1}회`,
      "",
      "【입고 데이터（재확인용）】",
      fileLinksSection(supplierScopedArtworkLinks(order, proofToken, origin)),
      "",
      "【대응 방법】",
      "수정된 교정 데이터는 반드시 아래 전용 페이지로 제출해 주십시오.",
      uploadUrl,
      "",
      "파일명에 발주번호를 반드시 포함해 주십시오. Google 로그인은 필요하지 않습니다.",
      "재교정 진행 상황이나 기술적 제약이 있다면 초기에 공유해 주시기 바랍니다.",
      "",
      "--",
      "Package Lab",
      "shapepouch@package-lab.com",
    ].join("\n")
    : [
      "株式会社セブン化学 ご担当者様",
      "",
      "いつも大変お世話になっております。パッケージラボでございます。",
      "",
      "下記案件の校正データについて、品質確認の結果、再校正が必要となりました。お手数をおかけいたしますが、下記内容にてご対応をお願い申し上げます。",
      "",
      "【案件情報】",
      localizedMailBody(order, locale),
      "",
      "【再校正内容】",
      supplierMessage,
      "",
      `再校正回数：${order.re_proof_count + 1}回目`,
      "",
      "【入稿データ（再確認用）】",
      fileLinksSection(supplierScopedArtworkLinks(order, proofToken, origin)),
      "",
      "【ご対応方法】",
      "修正後の校正データは、必ず下記専用ページからご返却ください。",
      uploadUrl,
      "",
      "ファイル名には発注番号を必ず含めてください。Googleログインは不要です。",
      "再校正の進捗や技術的制約がある場合は、お早めにご共有いただけますと幸いです。",
      "",
      "--",
      "パッケージラボ",
      "shapepouch@package-lab.com",
    ].join("\n");
  const japaneseText = [
    "下記案件の校正データについて、品質確認の結果、再校正が必要となりました。",
    "",
    "【案件情報】",
    mailBodyBase(order),
    "",
    "【再校正内容】",
    internalComment,
    "",
    `再校正回数：${order.re_proof_count + 1}回目`,
    "",
    "【返却ページ】",
    uploadUrl,
  ].join("\n");
  const destination = supplierDestinationFor(order);
  const mails: MailSendResult[] = [];
  if (destination.to) mails.push(await sendMail({ to: destination.to, subject, text: supplierText }));
  mails.push(await sendMail({ to: filmDesignNotificationTo(), subject, text: japaneseText }));
  return mails;
}

async function sendProofReceivedMail(
  order: FilmOrder,
  fileName: string,
  fileUrl: string,
  pdfFileName?: string,
  pdfFileUrl?: string,
): Promise<MailSendResult[]> {
  const subject = `【校正データ受領・ご確認のお願い】${order.order_number} ${order.product_name}`;
  const text = [
    "下記案件の校正データがフィルムメーカーより登録されました。",
    "顧客レビュー前の一次確認として、内容をご確認くださいますようお願いいたします。",
    "",
    "【案件情報】",
    mailBodyBase(order),
    "",
    "【校正データ】",
    `AI（必須）：${fileName}`,
    fileUrl ? `AI URL：${fileUrl}` : "AI URL：未登録",
    pdfFileName ? `PDF（任意）：${pdfFileName}` : "PDF（任意）：なし",
    pdfFileName && pdfFileUrl ? `PDF URL：${pdfFileUrl}` : null,
    "",
    "【確認ポイント】",
    "1. 図面配置・仕上がりサイズ・色分解内容",
    "2. ロゴ・商品名・法令表記の正確性",
    "3. 顧客確認前に修正が必要な技術的課題の有無",
    "",
    "問題がない場合は、顧客レビュー依頼へ進めてください。",
  ].join("\n");
  return [await sendMail({ to: externalTo(order.seven_contact_email), subject, text })];
}

async function sendPurchaseOrderMail(
  order: FilmOrder,
  origin: string,
  etaUrl: string,
  purchaseOrderUrl: string,
): Promise<MailSendResult[]> {
  const destination = supplierDestinationFor(order);
  if (!destination.to) throw new Error("supplier_destination_missing");
  const locale = supplierLocale(order);
  const subject = locale === "ko"
    ? `【필름 발주 요청】${order.order_number} ${order.product_name || ""}`.trim()
    : `【フィルム発注のご依頼】${order.order_number} ${order.product_name || ""}`.trim();
  const supplierText = locale === "ko"
    ? [
      "항상 원활한 협조를 주셔서 감사합니다. 패키지랩입니다.",
      "",
      "아래와 같이 필름 제작을 발주드립니다. 발주 내용을 확인하신 후 납기 전망 등록을 부탁드립니다.",
      "",
      "【발주 내용】",
      localizedMailBody(order, locale),
      "",
      "【요청 사항】",
      "1. 접수 가능 여부 및 제작 사양 확인",
      "2. 대략적인 납기 전망 등록",
      "3. 제작 제약이나 대안이 필요한 경우 조기 공유",
      "",
      "【납기 전망 등록 페이지】",
      etaUrl,
      "",
      "【발주서 열람·인쇄 페이지】",
      purchaseOrderUrl,
      "",
      "바쁘신 와중에도 협조해 주셔서 감사합니다.",
    ].join("\n")
    : [
      "いつも大変お世話になっております。パッケージラボでございます。",
      "",
      "下記のとおりフィルム製作をご発注申し上げます。発注内容をご確認のうえ、納期見込みのご登録をお願いいたします。",
      "",
      "【発注内容】",
      localizedMailBody(order, locale),
      "",
      "【ご依頼事項】",
      "1. 受領可能内容・製作仕様のご確認",
      "2. おおよその納期見込みのご登録",
      "3. 製造上の制約や代替案が必要な場合は早期ご連絡",
      "",
      "【納期見込み登録ページ】",
      etaUrl,
      "",
      "【発注書閲覧・印刷ページ】",
      purchaseOrderUrl,
      "",
      "お忙しいところ恐れ入りますが、何卒よろしくお願い申し上げます。",
    ].join("\n");
  const japaneseText = [
    `${order.order_number} の発注書をメーカーへ送信しました。`,
    "",
    "メーカーからの納期見込みは下記フォームに反映されます。",
    etaUrl,
  ].join("\n");
  const mails = [await sendMail({ to: destination.to, subject, text: supplierText })];
  mails.push(await sendMail({
    to: externalTo(order.seven_contact_email),
    subject: `【発注送信完了】${order.order_number} ${order.product_name}`,
    text: japaneseText,
  }));
  return mails;
}

function etaSecret(): string {
  return process.env.FILM_ETA_SECRET ?? process.env.AUTH_SECRET ?? "pouch-eta-dev-secret";
}

function signEta(orderId: number, expiresAt: number): string {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha256", etaSecret()).update(`${orderId}.${expiresAt}`).digest("base64url");
}

export function buildEtaToken(orderId: number, ttlDays = 14): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  const signature = signEta(orderId, expiresAt);
  return { token: `${orderId}.${expiresAt}.${signature}`, expiresAt };
}

export function verifyEtaToken(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const orderId = Number(parts[0]);
  const expiresAt = Number(parts[1]);
  const signature = parts[2];
  if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Date.now()) return null;
  const expected = signEta(orderId, expiresAt);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !require("node:crypto").timingSafeEqual(a, b)) return null;
  return orderId;
}

function buildStableSupplierProofToken(orderId: number, expiresAtMs: number): string {
  const nonce = "stable-v1";
  return `${orderId}.supplier_proof.${expiresAtMs}.${nonce}.${signExternalToken(orderId, "supplier_proof", expiresAtMs, nonce)}`;
}

async function ensureProofUploadToken(db: SqlClient, orderId: number, options: { rotate?: boolean } = {}): Promise<string> {
  const active = await db.get<ExternalTokenRow>(`
    SELECT * FROM film_order_external_tokens
    WHERE film_order_id = ? AND purpose = 'supplier_proof' AND revoked_at IS NULL
    ORDER BY id DESC LIMIT 1
  `, [orderId]);
  const now = Date.now();
  const expiresAtMs = active ? new Date(active.expires_at).getTime() : 0;
  if (!options.rotate && active && expiresAtMs > now + 24 * 60 * 60 * 1000) {
    const candidate = buildStableSupplierProofToken(orderId, expiresAtMs);
    if (safeEqualStrings(sha256(candidate), active.token_hash)) return candidate;
  }

  const nextExpiresAtMs = now + 30 * 24 * 60 * 60 * 1000;
  const token = buildStableSupplierProofToken(orderId, nextExpiresAtMs);
  const nowIso = new Date(now).toISOString();
  const nextIso = new Date(nextExpiresAtMs).toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE film_order_external_tokens
      SET revoked_at = ?, updated_at = ?
      WHERE film_order_id = ? AND purpose = 'supplier_proof' AND revoked_at IS NULL
    `, [nowIso, nowIso, orderId]);
    await tx.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?)
    `, [orderId, "supplier_proof", sha256(token), nextIso, "system", nowIso, nextIso]);
  });
  await addEvent(db, orderId, "token", "外部トークンを発行/更新: supplier_proof", "system");
  return token;
}

export async function getRegisteredFilmOrderFile(fileId: string): Promise<{
  orderId: number;
  category: string;
  fileName: string;
  url: string;
} | null> {
  const db = await getDatabase();
  const row = await db.get<{ order_id: number; category: string; file_name: string; url: string }>(`
    SELECT order_id, category, file_name, url
    FROM film_order_files
    WHERE drive_file_id = ? OR url LIKE ?
    ORDER BY id DESC
    LIMIT 1
  `, [fileId, `%${fileId}%`]);
  if (!row) return null;
  return {
    orderId: Number(row.order_id),
    category: row.category,
    fileName: row.file_name,
    url: row.url,
  };
}

export async function getFilmOrderForProofUpload(token: string): Promise<FilmOrderView | null> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "supplier_proof");
  if (!resolved) throw new Error("invalid_proof_token");
  await markExternalTokenUse(db, resolved.token);
  return getFilmOrder(resolved.orderId);
}

export async function recordSupplierProofDownload(params: {
  request: { headers: { get(name: string): string | null } };
  token: string;
  fileId: string;
  order: FilmOrderView;
}): Promise<boolean> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "supplier_proof");
  if (!resolved) return false;
  const allowed = params.order.files.some((file) =>
    file.category === "receiving"
    && file.url.includes(`/d/${params.fileId}/`)
  );
  await markExternalTokenUse(db, resolved.token, params.request);
  await addEvent(
    db,
    resolved.orderId,
    "token_access",
    `supplier_proof download ${allowed ? "allowed" : "denied"}: ${params.fileId}`,
    "external:supplier_proof",
  );
  return allowed;
}

export async function updateEtaFromToken(
  token: string,
  etaDate: string,
  note: string,
): Promise<FilmOrderView | null> {
  const orderId = verifyEtaToken(token);
  if (orderId == null) throw new Error("invalid_eta_token");
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(etaDate) ? etaDate : null;
  if (!date) throw new Error("invalid_eta_date");
  const db = await getDatabase();
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ? AND eta_token = ?", [orderId, token]);
  if (!row) throw new Error("invalid_eta_token");
  const now = new Date().toISOString();
  await db.run(
    "UPDATE film_orders SET eta_date = ?, eta_note = ?, eta_updated_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
    [date, note.slice(0, 1000), now, now, "supplier", orderId],
  );
  await addEvent(db, orderId, "eta", `納期見込み入力: ${date}${note ? ` / ${note}` : ""}`, "supplier");
  const updated = await getFilmOrder(orderId);
  if (updated) {
    const destination = supplierDestinationFor(updated);
    const locale = supplierLocale(updated);
    const subject = locale === "ko"
      ? `【납기 전망 등록 완료】${updated.order_number} ${updated.product_name || ""}`.trim()
      : `【納期見込み】${updated.order_number} ${updated.product_name || ""}`.trim();
    const supplierText = locale === "ko"
      ? [
        "납기 전망 등록이 완료되었습니다.",
        "",
        `발주번호：${updated.order_number}`,
        `품목：${updated.product_name || "-"}`,
        `등록된 납기 전망：${date}`,
        note ? `메모：${note}` : "",
      ].filter(Boolean).join("\n")
      : [
        `${updated.order_number} の納期見込みが入力されました: ${date}`,
        note ? `メモ: ${note}` : "",
        "",
        mailBodyBase(updated),
      ].filter(Boolean).join("\n");
    const japaneseText = [
      `${updated.order_number} の納期見込みが入力されました: ${date}`,
      note ? `メモ: ${note}` : "",
      "",
      mailBodyBase(updated),
    ].filter(Boolean).join("\n");
    const mails: MailSendResult[] = [];
    if (destination.to) mails.push(await sendMail({ to: destination.to, subject, text: supplierText }));
    mails.push(await sendMail({ to: externalTo(updated.seven_contact_email), subject, text: japaneseText }));
    await logMailEvents(db, orderId, mails, "納期見込み通知", "supplier");
  }
  return updated;
}

export async function getFilmOrderForEta(token: string): Promise<FilmOrderView | null> {
  const orderId = verifyEtaToken(token);
  if (orderId == null) throw new Error("invalid_eta_token");
  const db = await getDatabase();
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ? AND eta_token = ?", [orderId, token]);
  return row ? getFilmOrder(orderId) : null;
}

export async function getFilmOrderForSupplierPurchaseOrder(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "supplier_po");
  if (!resolved) throw new Error("invalid_supplier_po_token");
  await markExternalTokenUse(db, resolved.token, request);
  const order = await getFilmOrder(resolved.orderId);
  if (!order || order.status !== "final_approved" || !order.po_sent_at) {
    throw new Error("invalid_supplier_po_token");
  }
  await addEvent(
    db,
    order.id,
    "token_access",
    "supplier_po purchase-order page viewed",
    "external:supplier_po",
  );
  const refreshed = await getFilmOrder(order.id);
  if (!refreshed) throw new Error("invalid_supplier_po_token");
  return refreshed;
}

function validFileUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 2048 || !/^https?:\/\//i.test(trimmed)) throw new Error("invalid_file_url");
  return trimmed;
}

function validFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.includes("/") || trimmed.includes("\\")) return null;
  return trimmed;
}

function trimParam(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

type MailLocale = "ko" | "ja";

const HANGUL = /[가-힯]/u;

function assertKoreanSupplierMessage(message: string): void {
  if (!message || !HANGUL.test(message)) throw new Error("korean_supplier_message_required");
}

function assertJapaneseSupplierMessage(message: string): void {
  if (!message) throw new Error("japanese_supplier_message_required");
}

function assertJapaneseCustomerMessage(message: string): void {
  if (!message) throw new Error("japanese_customer_message_required");
}

function supplierLocale(order: FilmOrder): MailLocale {
  return order.procurement_route === "Y" ? "ja" : "ko";
}

function printingMethodText(order: FilmOrder, locale: MailLocale): string {
  if (order.printing_method === "gravure") return locale === "ko" ? "그라비아 인쇄" : "グラビア印刷";
  if (order.printing_method === "digital") return locale === "ko" ? "디지털 인쇄" : "デジタル印刷";
  return "-";
}

function localizedMailBody(order: FilmOrder, locale: MailLocale): string {
  if (locale === "ko") {
    return [
      `발주번호：${order.order_number}`,
      `견적번호：${order.quotation_number}`,
      `품목：${order.product_name || "-"}`,
      `고객명：${order.customer_name || "-"}`,
      `인쇄 방식：${printingMethodText(order, locale)}`,
      `원단 폭：${order.web_width_mm ? `${order.web_width_mm}mm` : "-"}`,
      `발주 길이：${order.order_length_m ? `${Number(order.order_length_m).toLocaleString("ja-JP")}m` : "-"}`,
    ].join("\n");
  }
  return mailBodyBase(order);
}

function proofRequestSubject(order: FilmOrder, locale: MailLocale): string {
  return locale === "ko"
    ? `【교정 데이터 제출 요청】${order.order_number} ${order.product_name || ""}`.trim()
    : `【校正データ返却のお願い】${order.order_number} ${order.product_name || ""}`.trim();
}

async function customerDestinationFor(order: FilmOrder): Promise<{ to: string | null; name: string; contact: string }> {
  const { getQuotation } = await import("./quotation-store");
  const quotation = await getQuotation(order.quotation_id);
  const email = typeof quotation?.payload.customerEmail === "string" ? quotation.payload.customerEmail.trim() : "";
  return {
    to: email ? externalTo(email) : null,
    name: quotation?.customerName || order.customer_name,
    contact: quotation?.customerContact || "",
  };
}

function sampleBulkMailBase(order: FilmOrder): string[] {
  return [
    `発注番号：${order.order_number}`,
    `見積番号：${order.quotation_number}`,
    `品名：${order.product_name || "-"}`,
    `数量：${order.pouch_quantity ? `${Number(order.pouch_quantity).toLocaleString("ja-JP")}枚` : "-"}`,
  ];
}

async function sendSampleBulkRequestMail(order: FilmOrder): Promise<MailSendResult> {
  const destination = await customerDestinationFor(order);
  if (!destination.to) throw new Error("customer_email_required");
  const greeting = destination.contact ? `${destination.name}\n${destination.contact} 様` : `${destination.name} 御中`;
  const subject = `【バルクサンプルご送付のお願い】${order.order_number} ${order.product_name || ""}`.trim();
  const text = [
    greeting,
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    "パウチ製作および充填検証を進めるにあたり、検証用のサンプルバルクをご支給くださいますようお願い申し上げます。",
    "",
    "【案件情報】",
    ...sampleBulkMailBase(order),
    "",
    "【サンプル支給量】",
    `${Number(order.sampleBulk.sampleQuantityMl || 0).toLocaleString("ja-JP")}ml`,
    Number(order.sampleBulk.productionBulkUsageMl || 0) > 0
      ? `参考（本生産想定バルク量）：${Number(order.sampleBulk.productionBulkUsageMl).toLocaleString("ja-JP")}ml`
      : "",
    order.sampleBulk.requestNote ? `備考：${order.sampleBulk.requestNote}` : "",
    "",
    "【ご確認いただきたい項目】",
    "1. 対象ロット・品質規格との整合",
    "2. 液性・粘度・容器状態に異常がないか",
    "3. 送付時の保管条件および危険区分の有無",
    "",
    "【送付先】",
    order.sampleBulk.recipientName,
    `${order.sampleBulk.recipientPostalCode} ${order.sampleBulk.recipientAddress}`,
    "TEL 072-971-0726",
    "",
    "サンプル到着後、責任技術者が内容と数量を確認いたします。確認結果によっては、追加のご連絡を差し上げる場合がございます。",
    "お手数ですが、ご対応のほどよろしくお願い申し上げます。",
    "",
    "--",
    "パッケージラボ",
    "shapepouch@package-lab.com",
  ].filter(Boolean).join("\n");
  return sendMail({ to: destination.to, subject, text });
}

async function sendSampleBulkAdjustmentMail(order: FilmOrder): Promise<MailSendResult> {
  const destination = await customerDestinationFor(order);
  if (!destination.to) throw new Error("customer_email_required");
  const greeting = destination.contact ? `${destination.name}\n${destination.contact} 様` : `${destination.name} 御中`;
  const subject = `【バルク量変更のお願い】${order.order_number} ${order.product_name || ""}`.trim();
  const text = [
    greeting,
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    "ご支給いただいたサンプルバルクを確認いたしましたところ、充填仕様の都合によりサンプル量の調整が必要となりました。",
    "下記の通りご対応いただけますと幸いです。",
    "",
    "【案件情報】",
    ...sampleBulkMailBase(order),
    "",
    "【確認結果と変更希望サンプル量】",
    `現在のサンプル支給量：${Number(order.sampleBulk.sampleReceivedMl || 0).toLocaleString("ja-JP")}ml`,
    `ご支給希望サンプル量：${Number(order.sampleBulk.sampleAdjustedMl || 0).toLocaleString("ja-JP")}ml`,
    `変更理由：${order.sampleBulk.adjustmentReason || "-"}`,
    "",
    "【送付先】",
    order.sampleBulk.recipientName,
    `${order.sampleBulk.recipientPostalCode} ${order.sampleBulk.recipientAddress}`,
    "TEL 072-971-0726",
    "",
    "ご不明点がございましたら、お気軽にお問い合わせください。",
    "今後とも何卒よろしくお願い申し上げます。",
    "",
    "--",
    "パッケージラボ",
    "shapepouch@package-lab.com",
  ].join("\n");
  return sendMail({ to: destination.to, subject, text });
}

async function sendCustomerDesignRequestMail(order: FilmOrderView, uploadUrl: string): Promise<MailSendResult> {
  const destination = await customerDestinationFor(order);
  if (!destination.to) throw new Error("customer_email_required");
  const greeting = destination.contact ? `${destination.name}\n${destination.contact} 様` : `${destination.name} 御中`;
  const subject = `【デザイン原稿ご入稿のお願い】${order.order_number} ${order.product_name || ""}`.trim();
  const text = [
    greeting,
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    "このたびは、パウチデザイン製作のご依頼を賜り誠にありがとうございます。",
    "より高品質な仕上がりを実現するため、下記専用ページより印刷用デザイン原稿（AIデータ）をご入稿くださいますようお願い申し上げます。",
    "",
    "【案件情報】",
    ...sampleBulkMailBase(order),
    "",
    "【ご入稿いただくデータ】",
    "必須：AIデータ（編集可能なレイヤー構成のもの）",
    "推奨：確認用PDF（見た目・配置のご確認用）",
    "",
    "【ご入稿ページ】",
    uploadUrl,
    "",
    "【技術上のご確認事項】",
    "1. トンボ・塗り足し（出来上がりサイズ外側3mm）をご確認ください。",
    "2. 文字はアウトライン化してください。",
    "3. リンク画像は埋め込みいただくか、ZIP形式でご入稿ください。",
    "4. 特殊色・明白・白抜きの有無をご確認ください。",
    "",
    `ファイルサイズの上限は1ファイルあたり${Math.floor(customerDesignMaxBytes() / 1024 / 1024)}MBです。`,
    "入稿いただいた原稿は、担当デザイナーが製作適性を確認したうえで進行いたします。必要に応じて修正のご相談をさせていただきます。",
    "",
    "ご不明な点がございましたら、お気軽にお問い合わせください。",
    "今後とも何卒よろしくお願い申し上げます。",
    "",
    "--",
    "パッケージラボ デザイン制作チーム",
    "shapepouch@package-lab.com",
  ].join("\n");
  return sendMail({ to: destination.to, subject, text });
}

async function sendCustomerDesignCorrectionMail(order: FilmOrderView, reason: string, uploadUrl: string): Promise<MailSendResult> {
  const destination = await customerDestinationFor(order);
  if (!destination.to) throw new Error("customer_email_required");
  const greeting = destination.contact ? `${destination.name}\n${destination.contact} 様` : `${destination.name} 御中`;
  const subject = `【デザイン原稿修正のお願い】${order.order_number} ${order.product_name || ""}`.trim();
  const text = [
    greeting,
    "",
    "いつも大変お世話になっております。パッケージラボ デザイン制作チームでございます。",
    "",
    "ご入稿いただいたデザイン原稿を確認いたしました。印刷品質と製造適性を担保するため、下記の修正をご検討いただけますと幸いです。",
    "",
    "【案件情報】",
    ...sampleBulkMailBase(order),
    "",
    "【確認結果と修正内容】",
    reason,
    "",
    "【再入稿データ】",
    "必須：修正後のAIデータ",
    "推奨：修正後の確認用PDF",
    "",
    "【再入稿ページ】",
    uploadUrl,
    "",
    "なお、修正の程度によっては校正時間が変動する場合がございます。あらかじめご了承ください。",
    "内容のご説明が必要な場合は、担当より個別にご連絡いたします。",
    "",
    "お手数をおかけいたしますが、何卒よろしくお願い申し上げます。",
    "",
    "--",
    "パッケージラボ デザイン制作チーム",
    "shapepouch@package-lab.com",
  ].join("\n");
  return sendMail({ to: destination.to, subject, text });
}

async function sendCustomerProofReviewMail(
  order: FilmOrderView,
  proof: FilmOrderFileRecord,
  reviewUrl: string,
): Promise<MailSendResult> {
  const destination = await customerDestinationFor(order);
  if (!destination.to) throw new Error("customer_email_required");
  const greeting = destination.contact ? `${destination.name}\n${destination.contact} 様` : `${destination.name} 御中`;
  const subject = `【校正ご確認のお願い】${order.order_number} ${order.product_name || ""}`.trim();
  const text = [
    greeting,
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    "お見積書にてご依頼いただいたパウチデザインの校正データが完成いたしましたので、下記専用ページにてご確認をお願い申し上げます。",
    "",
    "【案件情報】",
    ...sampleBulkMailBase(order),
    "",
    "【校正データ】",
    `バージョン：v${proof.version}`,
    `ファイル名：${proof.file_name}`,
    "",
    "【ご確認ページ】",
    reviewUrl,
    "",
    "【ご確認いただきたい項目】",
    "1. ロゴ・商品名・表記に誤字・脱字がないか",
    "2. 色味・配置・仕上がりサイズがご意図と一致しているか",
    "3. 規格・法令に関わる注意書きや必要表記が過不足なく含まれているか",
    "",
    "ページ内の「承認する」ボタンを押された時点で、校正内容に同意したものとさせていただきます。",
    "修正をご希望の場合は、修正箇所をご入力ください。担当者が内容を確認後、再度校正をご提案いたします。",
    "",
    "ご不明な点がございましたら、お気軽にお問い合わせください。",
    "今後とも何卒よろしくお願い申し上げます。",
    "",
    "--",
    "パッケージラボ",
    "shapepouch@package-lab.com",
  ].join("\n");
  return sendMail({ to: destination.to, subject, text });
}

async function sendCustomerProofDecisionMail(order: FilmOrderView): Promise<MailSendResult> {
  const destination = await customerDestinationFor(order);
  if (!destination.to) throw new Error("customer_email_required");
  const statusText = order.customerProof.status === "approved" ? "ご承認" : "修正ご依頼";
  const subject = `【校正${statusText}受付完了】${order.order_number} ${order.product_name || ""}`.trim();
  const text = [
    destination.contact ? `${destination.contact} 様` : destination.name,
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    `校正データに関する${statusText}を承りましたので、下記のとおり受付内容をご案内いたします。`,
    "",
    "【受付内容】",
    `見積番号：${order.quotation_number}`,
    `発注番号：${order.order_number}`,
    `品名：${order.product_name || "-"}`,
    `受付日時：${new Date().toLocaleString("ja-JP")}`,
    order.customerProof.status === "correction_requested" ? `修正内容：${order.customerProof.correctionReason}` : "",
    "",
    order.customerProof.status === "approved"
      ? "ご承認内容をもとに製造手配を進めさせていただきます。製造過程で技術的に確認が必要な事項が生じた場合は、改めてご連絡いたします。"
      : "ご指摘内容を制作チームで確認し、修正方針および再校正のご案内をさせていただきます。",
    "",
    "その他ご不明な点がございましたら、お気軽にお問い合わせください。",
    "今後とも何卒よろしくお願い申し上げます。",
    "",
    "--",
    "パッケージラボ",
    "shapepouch@package-lab.com",
  ].join("\n");
  return sendMail({ to: destination.to, subject, text });
}

async function logMailEvents(
  db: SqlClient,
  orderId: number,
  mails: MailSendResult[],
  label: string,
  actorEmail: string,
): Promise<void> {
  for (const mail of mails) {
    const suffix = mail.dryRun ? " (dry-run)" : mail.error ? ` (error: ${mail.error})` : "";
    await addEvent(db, orderId, "email", `${label} → ${mail.to}${suffix}`, actorEmail);
  }
}

export async function runFilmOrderAction(
  id: number,
  action: FilmOrderAction,
  params: {
    fileName?: unknown;
    fileUrl?: unknown;
    aiFileName?: unknown;
    aiFileUrl?: unknown;
    pdfFileName?: unknown;
    pdfFileUrl?: unknown;
    note?: unknown;
    comment?: unknown;
    supplierName?: unknown;
    supplierEmail?: unknown;
    origin?: unknown;
    sampleQuantityMl?: unknown;
    receivedMl?: unknown;
    adjustedMl?: unknown;
    reason?: unknown;
    supplierMessage?: unknown;
    customerMessage?: unknown;
    approverName?: unknown;
    evidence?: unknown;
  },
  actorEmail: string,
): Promise<{ order: FilmOrderView; mails?: MailSendResult[] }> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const origin = trimParam(params.origin, 200) || "https://seven-calcul.vercel.app";
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [id]);
  if (!row) throw new Error("film_order_not_found");
  const order = mapOrder(row);

  if (action === "set-supplier") {
    const supplierName = trimParam(params.supplierName, 200);
    const supplierEmail = trimParam(params.supplierEmail, 254);
    if (supplierEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplierEmail)) throw new Error("invalid_supplier_email");
    const resolvedEmail = supplierEmail || DEFAULT_FILM_PROOF_EMAIL;
    await db.run(
      "UPDATE film_orders SET supplier_name = ?, supplier_email = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [supplierName, resolvedEmail, now, actorEmail, id],
    );
    await addEvent(db, id, "supplier", `仕入先を更新: ${supplierName || "-"} / ${resolvedEmail}`, actorEmail);
  } else if (action === "mark-ordered") {
    if (order.status !== "pending") throw new Error("invalid_status_transition");
    await db.run(
      "UPDATE film_orders SET status = 'ordered', ordered_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, now, actorEmail, id],
    );
    await addEvent(db, id, "status", "成約 → 発注書送信済み（セブン化学からメール送信）", actorEmail);
  } else if (action === "register-receiving") {
    if (order.status !== "ordered") throw new Error("invalid_status_transition");
    if (!["confirmed","not_required","legacy_exempt"].includes(order.customerDesign.status)) {
      throw new Error("customer_design_confirmation_required");
    }
    // フィルム製作用データの入稿。AI は必須、PDF は任意。
    const aiFileName = validFileName(params.aiFileName);
    if (!aiFileName || !/\.ai$/iu.test(aiFileName)) throw new Error("invalid_ai_file");
    const pdfFileNameRaw = validFileName(params.pdfFileName);
    if (pdfFileNameRaw && !/\.pdf$/iu.test(pdfFileNameRaw)) throw new Error("invalid_pdf_file");
    const aiFileUrl = validFileUrl(params.aiFileUrl);
    if (!aiFileUrl) throw new Error("invalid_ai_file_url");
    const pdfFileUrl = validFileUrl(params.pdfFileUrl);
    if (pdfFileNameRaw && !pdfFileUrl) throw new Error("invalid_pdf_file_url");
    await addFile(db, id, "receiving", aiFileName, aiFileUrl, trimParam(params.note, 1000), actorEmail);
    if (pdfFileNameRaw) {
      await addFile(db, id, "receiving", pdfFileNameRaw, pdfFileUrl, trimParam(params.note, 1000), actorEmail);
    }
    await db.run(
      "UPDATE film_orders SET status = 'receiving_registered', receiving_registered_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, now, actorEmail, id],
    );
    await addEvent(db, id, "file", `入稿データ登録: ${aiFileName}${pdfFileNameRaw ? ` / ${pdfFileNameRaw}` : ""}`, actorEmail);
    await addEvent(db, id, "status", "発注書送信済み → 入稿済み", actorEmail);
    const refreshed = await getFilmOrder(id);
    const proofToken = await ensureProofUploadToken(db, id);
    const uploadUrl = `${origin}/film-orders/upload/${proofToken}`;
    const mails = refreshed
      ? await sendReceivingNotice(refreshed, aiFileName, aiFileUrl, pdfFileNameRaw ?? null, pdfFileUrl, uploadUrl, proofToken, origin)
      : [];
    await logMailEvents(db, id, mails, "入稿通知メール", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "send-proof-notice") {
    if (order.status !== "receiving_registered") throw new Error("invalid_status_transition");
    const proofToken = await ensureProofUploadToken(db, id);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? [await sendProofNoticeMail(refreshed, `${origin}/film-orders/upload/${proofToken}`, proofToken, origin)] : [];
    await logMailEvents(db, id, mails, "校正アップロード案内", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "rotate-supplier-proof-token") {
    if (order.status !== "receiving_registered" && order.status !== "re_proof_requested") {
      throw new Error("invalid_status_transition");
    }
    const proofToken = await ensureProofUploadToken(db, id, { rotate: true });
    const uploadUrl = `${origin}/film-orders/upload/${proofToken}`;
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? [await sendProofNoticeMail(refreshed, uploadUrl, proofToken, origin)] : [];
    await logMailEvents(db, id, mails, "校正アップロード案内（強制再発行）", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "register-proof") {
    if (order.status !== "receiving_registered" && order.status !== "re_proof_requested") throw new Error("invalid_status_transition");
    const aiFileName = params.aiFileName ? validFileName(params.aiFileName) : validFileName(params.fileName);
    if (!aiFileName || !aiFileName.toLowerCase().endsWith(".ai")) throw new Error("invalid_ai_file");
    const fileUrl = params.aiFileName ? validFileUrl(params.aiFileUrl ?? "") : validFileUrl(params.fileUrl);
    const pdfFileName = params.pdfFileName ? validFileName(params.pdfFileName) : "";
    if (params.pdfFileName && (!pdfFileName || !pdfFileName.toLowerCase().endsWith(".pdf"))) throw new Error("invalid_pdf_file");
    const pdfFileUrl = params.pdfFileName ? validFileUrl(params.pdfFileUrl ?? "") : "";
    if (params.pdfFileName && !pdfFileUrl) throw new Error("invalid_pdf_file");
    const file = await addFile(db, id, "proof", aiFileName, fileUrl, trimParam(params.note, 1000), actorEmail);
    const pdfFile = pdfFileName
      ? await addFile(db, id, "proof", pdfFileName, pdfFileUrl, trimParam(params.note, 1000), actorEmail)
      : null;
    await db.run(
      "UPDATE film_orders SET status = 'proof_registered', proof_registered_at = ?, customer_proof_status = 'pending', updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, now, actorEmail, id],
    );
    await addEvent(
      db,
      id,
      "file",
      `校正データ登録: ${aiFileName} (v${file.version})${pdfFileName ? ` / ${pdfFileName} (v${pdfFile?.version})` : ""}`,
      actorEmail,
    );
    await addEvent(db, id, "status", `${order.status} → 校正待ち`, actorEmail);
    {
      const refreshed = await getFilmOrder(id);
      const mails = refreshed ? await sendProofReceivedMail(refreshed, aiFileName, fileUrl, pdfFileName || undefined, pdfFileUrl || undefined) : [];
      await logMailEvents(db, id, mails, "校正受領通知", actorEmail);
    }
  } else if (action === "approve") {
    if (order.status !== "proof_registered") throw new Error("invalid_status_transition");
    if (!["approved","legacy_exempt"].includes(order.customerProof.status)) {
      throw new Error("customer_proof_approval_required");
    }
    const fileName = validFileName(params.fileName);
    if (fileName) {
      await addFile(db, id, "final", fileName, validFileUrl(params.fileUrl), trimParam(params.note, 1000), actorEmail);
      await addEvent(db, id, "file", `最終承認データ登録: ${fileName}`, actorEmail);
    }
    await db.run(
      "UPDATE film_orders SET status = 'final_approved', final_approved_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, now, actorEmail, id],
    );
    await addEvent(db, id, "status", "校正待ち → 最終承認済み", actorEmail);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? await sendApprovalMail(refreshed) : [];
    await logMailEvents(db, id, mails, "承認通知メール", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "request-re-proof") {
    if (order.status !== "proof_registered") throw new Error("invalid_status_transition");
    const comment = trimParam(params.comment, 2000);
    if (!comment) throw new Error("re_proof_comment_required");
    const supplierMessage = trimParam(params.supplierMessage, 2000);
    if (supplierLocale(order) === "ko") assertKoreanSupplierMessage(supplierMessage);
    else assertJapaneseSupplierMessage(supplierMessage);
    await db.run(
      "UPDATE film_orders SET status = 're_proof_requested', re_proof_count = ?, re_proof_requested_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [order.re_proof_count + 1, now, now, actorEmail, id],
    );
    await addEvent(db, id, "status", `校正待ち → 再校正依頼中: ${comment}`, actorEmail);
    const refreshed = await getFilmOrder(id);
    const proofToken = await ensureProofUploadToken(db, id);
    const mails = refreshed
      ? await sendReProofMail(refreshed, comment, supplierMessage, `${origin}/film-orders/upload/${proofToken}`, proofToken, origin)
      : [];
    await logMailEvents(db, id, mails, "再校正依頼メール", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "send-po") {
    if (order.status !== "final_approved") throw new Error("invalid_status_transition");
    const { token, expiresAt } = buildEtaToken(id);
    const etaUrl = `${origin}/film-orders/eta/${token}`;
    await db.run(
      "UPDATE film_orders SET po_sent_at = ?, eta_token = ?, eta_expires_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, token, new Date(expiresAt).toISOString(), now, actorEmail, id],
    );
    await addEvent(db, id, "status", "最終承認済み → メーカー発注書送信済み", actorEmail);
    const refreshed = await getFilmOrder(id);
    const destination = refreshed ? supplierDestinationFor(refreshed) : null;
    const purchaseOrderToken = refreshed && destination?.to
      ? await issueExternalToken(db, id, "supplier_po", actorEmail, {
        audienceEmail: destination.to,
        ttlDays: 90,
      })
      : null;
    const purchaseOrderUrl = purchaseOrderToken
      ? `${origin}/film-orders/purchase-order/${encodeURIComponent(purchaseOrderToken.token)}`
      : "";
    const mails = refreshed
      ? await sendPurchaseOrderMail(refreshed, origin, etaUrl, purchaseOrderUrl)
      : [];
    await logMailEvents(db, id, mails, "発注書送信", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "request-sample-bulk") {
    if (order.sampleBulk.status !== "pending") throw new Error("invalid_status_transition");
    const sampleQuantityMl = trimParam(params.sampleQuantityMl, 40);
    if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(sampleQuantityMl) || Number(sampleQuantityMl) <= 0) {
      throw new Error("sample_bulk_quantity_required");
    }
    const requestNote = trimParam(params.note, 1000);
    await db.run(`
      UPDATE film_orders
      SET sample_bulk_status = 'requested', sample_bulk_requested_at = ?, sample_requested_ml = ?,
          sample_bulk_request_note = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [now, sampleQuantityMl, requestNote, now, actorEmail, id]);
    await addEvent(db, id, "sample_bulk", `サンプルバルク送付依頼を作成: ${sampleQuantityMl}ml`, actorEmail);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? [await sendSampleBulkRequestMail(refreshed)] : [];
    await logMailEvents(db, id, mails, "バルクサンプル依頼", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "register-sample-bulk") {
    if (order.sampleBulk.status !== "requested" && order.sampleBulk.status !== "adjustment_requested") {
      throw new Error("invalid_status_transition");
    }
    const receivedMl = trimParam(params.receivedMl, 40);
    if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(receivedMl) || Number(receivedMl) <= 0) {
      throw new Error("sample_bulk_quantity_required");
    }
    const receiveNote = trimParam(params.note, 1000);
    await db.run(`
      UPDATE film_orders
      SET sample_bulk_status = 'received', sample_received_ml = ?, sample_bulk_received_at = ?,
          sample_bulk_receive_note = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [receivedMl, now, receiveNote, now, actorEmail, id]);
    await addEvent(db, id, "sample_bulk", `バルクサンプルを受領: ${receivedMl}ml`, actorEmail);
  } else if (action === "confirm-sample-bulk") {
    if (order.sampleBulk.status !== "received") throw new Error("invalid_status_transition");
    const expectedMl = order.sampleBulk.sampleAdjustedMl ?? order.sampleBulk.sampleQuantityMl;
    if (Number(order.sampleBulk.sampleReceivedMl) !== Number(expectedMl)) {
      throw new Error("sample_bulk_quantity_mismatch");
    }
    await db.run(`
      UPDATE film_orders
      SET sample_bulk_status = 'confirmed', sample_bulk_confirmed_at = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [now, now, actorEmail, id]);
    await addEvent(db, id, "sample_bulk", `サンプル量を確認: ${order.sampleBulk.sampleReceivedMl ?? "-"}ml`, actorEmail);
  } else if (action === "request-sample-bulk-adjustment") {
    if (order.sampleBulk.status !== "received") throw new Error("invalid_status_transition");
    const adjustedMl = trimParam(params.adjustedMl, 40);
    const customerMessage = trimParam(params.customerMessage, 2000);
    assertJapaneseCustomerMessage(customerMessage);
    const internalReason = trimParam(params.reason, 2000);
    if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(adjustedMl) || Number(adjustedMl) <= 0) {
      throw new Error("sample_bulk_quantity_required");
    }
    await db.run(`
      UPDATE film_orders
      SET sample_bulk_status = 'adjustment_requested', sample_adjusted_ml = ?,
          sample_bulk_adjustment_requested_at = ?, sample_bulk_adjustment_count = ?,
          sample_bulk_adjustment_reason = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [adjustedMl, now, order.sampleBulk.adjustmentCount + 1, customerMessage, now, actorEmail, id]);
    await addEvent(db, id, "sample_bulk", `サンプル量変更を依頼: ${order.sampleBulk.sampleReceivedMl ?? "-"}ml → ${adjustedMl}ml / 内部理由: ${internalReason || "-"} / 顧客向け: ${customerMessage}`, actorEmail);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? [await sendSampleBulkAdjustmentMail(refreshed)] : [];
    await logMailEvents(db, id, mails, "バルク量変更依頼", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "request-customer-design-upload") {
    const currentFiles = await getFilmOrder(id);
    const hasAiFile = Boolean(currentFiles?.files.some((file) =>
      file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai")
    ));
    const canRequest = order.customerDesign.status === "pending"
      || (order.customerDesign.status === "received" && !hasAiFile);
    if (!["pending","ordered"].includes(order.status) || !canRequest) {
      throw new Error("invalid_status_transition");
    }
    const { getQuotation } = await import("./quotation-store");
    const quotation = await getQuotation(order.quotation_id);
    const audienceEmail = typeof quotation?.payload.customerEmail === "string" ? quotation.payload.customerEmail.trim() : "";
    if (!audienceEmail) throw new Error("customer_email_required");
    const issued = await issueExternalToken(db, id, "customer_design", actorEmail, { audienceEmail });
    await db.run(`
      UPDATE film_orders
      SET customer_design_status = 'requested', customer_design_requested_at = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [now, now, actorEmail, id]);
    await addEvent(db, id, "customer_design", `顧客デザインアップロード依頼を作成`, actorEmail);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? [await sendCustomerDesignRequestMail(refreshed, `${origin}/film-orders/design-upload/${issued.token}`)] : [];
    await logMailEvents(db, id, mails, "顧客デザイン依頼", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "confirm-customer-design") {
    if (order.customerDesign.status !== "received") throw new Error("invalid_status_transition");
    const current = await getFilmOrder(id);
    if (!current?.files.some((file) => file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai"))) {
      throw new Error("customer_design_file_required");
    }
    await db.run(`
      UPDATE film_orders
      SET customer_design_status = 'confirmed', customer_design_confirmed_at = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [now, now, actorEmail, id]);
    await addEvent(db, id, "customer_design", "顧客デザインを確定", actorEmail);
  } else if (action === "request-customer-design-correction") {
    if (order.customerDesign.status !== "received") throw new Error("invalid_status_transition");
    const customerMessage = trimParam(params.customerMessage, 2000);
    assertJapaneseCustomerMessage(customerMessage);
    const internalReason = trimParam(params.reason, 2000);
    const { getQuotation } = await import("./quotation-store");
    const quotation = await getQuotation(order.quotation_id);
    const audienceEmail = typeof quotation?.payload.customerEmail === "string" ? quotation.payload.customerEmail.trim() : "";
    if (!audienceEmail) throw new Error("customer_email_required");
    const issued = await issueExternalToken(db, id, "customer_design", actorEmail, { audienceEmail });
    await db.run(`
      UPDATE film_orders
      SET customer_design_status = 'correction_requested',
          customer_design_correction_count = ?, customer_design_correction_reason = ?,
          updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [order.customerDesign.correctionCount + 1, customerMessage, now, actorEmail, id]);
    await addEvent(db, id, "customer_design", `顧客デザイン修正依頼: 内部理由 ${internalReason || "-"} / 顧客向け ${customerMessage}`, actorEmail);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? [await sendCustomerDesignCorrectionMail(refreshed, customerMessage, `${origin}/film-orders/design-upload/${issued.token}`)] : [];
    await logMailEvents(db, id, mails, "顧客デザイン修正依頼", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "set-customer-design-not-required") {
    if (!["pending","requested","received","correction_requested"].includes(order.customerDesign.status)) {
      throw new Error("invalid_status_transition");
    }
    const reason = trimParam(params.reason, 2000);
    if (!reason) throw new Error("customer_design_not_required_reason_required");
    await db.run(`
      UPDATE film_orders
      SET customer_design_status = 'not_required', customer_design_correction_reason = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [reason, now, actorEmail, id]);
    await addEvent(db, id, "customer_design", `顧客デザイン不要に設定: ${reason}`, actorEmail);
  } else if (action === "send-customer-proof-review") {
    if (order.status !== "proof_registered") throw new Error("invalid_status_transition");
    if (!["pending","requested","correction_requested"].includes(order.customerProof.status)) {
      throw new Error("invalid_status_transition");
    }
    const current = await getFilmOrder(id);
    const proofPdf = current?.files
      .filter((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf"))
      .at(-1);
    if (!proofPdf) throw new Error("customer_proof_pdf_required");
    const latestProof = proofPdf;
    const { getQuotation } = await import("./quotation-store");
    const quotation = await getQuotation(order.quotation_id);
    const audienceEmail = typeof quotation?.payload.customerEmail === "string" ? quotation.payload.customerEmail.trim() : "";
    if (!audienceEmail) throw new Error("customer_email_required");
    const issued = await issueExternalToken(db, id, "customer_proof_review", actorEmail, { audienceEmail });
    await db.run(`
      UPDATE film_orders
      SET customer_proof_status = 'requested', customer_proof_requested_at = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [now, now, actorEmail, id]);
    await addEvent(db, id, "customer_proof", `顧客校正レビュー依頼: v${latestProof.version}`, actorEmail);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed ? [await sendCustomerProofReviewMail(refreshed, latestProof, `${origin}/film-orders/proof-review/${issued.token}`)] : [];
    await logMailEvents(db, id, mails, "顧客校正レビュー依頼", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "record-customer-proof-approval") {
    if (order.status !== "proof_registered") throw new Error("invalid_status_transition");
    if (!["pending","requested"].includes(order.customerProof.status)) throw new Error("invalid_status_transition");
    const approverName = trimParam(params.approverName, 200);
    const evidence = trimParam(params.evidence, 2000);
    if (!approverName || !evidence) throw new Error("customer_proof_evidence_required");
    await db.run(`
      UPDATE film_orders
      SET customer_proof_status = 'approved', customer_proof_approved_at = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [now, now, actorEmail, id]);
    await addEvent(db, id, "customer_proof", `オフライン承認を記録: ${approverName} / ${evidence}`, actorEmail);
  } else if (action === "register-receiving-extra") {
    if (order.status !== "receiving_registered" && order.status !== "proof_registered" && order.status !== "re_proof_requested") {
      throw new Error("invalid_status_transition");
    }
    const fileName = validFileName(params.fileName);
    if (!fileName) throw new Error("invalid_file_name");
    const fileUrl = validFileUrl(params.fileUrl);
    if (!fileUrl) throw new Error("invalid_file_url");
    await addFile(db, id, "receiving", fileName, fileUrl, trimParam(params.note, 1000), actorEmail);
    await addEvent(db, id, "file", `入稿データ追加: ${fileName}`, actorEmail);
  } else if (action === "resend-receiving-notice") {
    if (order.status !== "receiving_registered") throw new Error("invalid_status_transition");
    const refreshed = await getFilmOrder(id);
    const receiving: FilmOrderFileRecord[] = (refreshed?.files ?? []).filter((file) => file.category === "receiving");
    const aiFile = receiving.find((file) => /\.ai$/iu.test(file.file_name)) ?? receiving[0];
    const pdfFile = receiving.find((file) => /\.pdf$/iu.test(file.file_name));
    if (!refreshed || !aiFile) throw new Error("invalid_status_transition");
    const proofToken = await ensureProofUploadToken(db, id);
    const mails = await sendReceivingNotice(refreshed, aiFile.file_name, aiFile.url, pdfFile?.file_name ?? null, pdfFile?.url ?? "", `${origin}/film-orders/upload/${proofToken}`, proofToken, origin);
    await logMailEvents(db, id, mails, "入稿通知メール（再送）", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else {
    throw new Error("unknown_action");
  }

  const result = await getFilmOrder(id);
  if (!result) throw new Error("film_order_update_failed");
  return { order: result };
}

export async function filmOrderExistsForQuotation(quotationId: number): Promise<boolean> {
  const db = await getDatabase();
  const row = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE quotation_id = ?", [quotationId]);
  return Boolean(row);
}

export async function getFilmOrderForCustomerProofReview(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "customer_proof_review");
  if (!resolved) throw new Error("invalid_customer_proof_token");
  await markExternalTokenUse(db, resolved.token, request);
  const order = await getFilmOrder(resolved.orderId);
  if (
    !order
    || !["proof_registered","re_proof_requested"].includes(order.status)
    || !["requested","approved","correction_requested"].includes(order.customerProof.status)
  ) throw new Error("invalid_customer_proof_token");
  return order;
}

export async function decideCustomerProofReview(params: {
  token: string;
  decision: "approve" | "correction";
  reason?: string;
  request?: { headers: { get(name: string): string | null } };
}): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "customer_proof_review");
  if (!resolved) throw new Error("invalid_customer_proof_token");
  const now = new Date().toISOString();
  const ipHash = params.request ? externalClientIpHash(params.request) : null;

  if (params.decision === "approve") {
    const result = await db.run(`
      UPDATE film_orders
      SET customer_proof_status = 'approved', customer_proof_approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'proof_registered' AND customer_proof_status = 'requested'
    `, [now, now, resolved.orderId]);
    if (Number(result.changes) !== 1) throw new Error("invalid_customer_proof_decision");
    await addEvent(db, resolved.orderId, "customer_proof", `顧客が校正を承認 (${now})`, "customer");
    if (ipHash) await addEvent(db, resolved.orderId, "audit", `顧客承認IPハッシュ: ${ipHash}`, "customer");
  } else {
    const reason = params.reason?.trim().slice(0, 2000) || "";
    if (!reason) throw new Error("customer_proof_correction_reason_required");
    const result = await db.run(`
      UPDATE film_orders
      SET customer_proof_status = 'correction_requested',
          customer_proof_correction_count = customer_proof_correction_count + 1,
          customer_proof_correction_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'proof_registered' AND customer_proof_status = 'requested'
    `, [reason, now, resolved.orderId]);
    if (Number(result.changes) !== 1) throw new Error("invalid_customer_proof_decision");
    await addEvent(db, resolved.orderId, "customer_proof", `顧客修正依頼: ${reason}`, "customer");
  }
  await markExternalTokenUse(db, resolved.token, params.request);
  let order = await getFilmOrder(resolved.orderId);
  if (!order) throw new Error("invalid_customer_proof_token");
  const mails = [await sendCustomerProofDecisionMail(order)];
  await logMailEvents(db, resolved.orderId, mails, "顧客校正判定受付", "customer");
  order = await getFilmOrder(resolved.orderId);
  if (!order) throw new Error("invalid_customer_proof_token");
  return order;
}

export async function getFilmOrderForCustomerDesign(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "customer_design");
  if (!resolved) throw new Error("invalid_customer_design_token");
  await markExternalTokenUse(db, resolved.token, request);
  const order = await getFilmOrder(resolved.orderId);
  if (!order || !["requested","received","correction_requested"].includes(order.customerDesign.status)) {
    throw new Error("invalid_customer_design_token");
  }
  return order;
}

export function nextCustomerDesignFileName(
  order: FilmOrderView,
  originalFileName: string,
): string {
  const version = order.files.filter((file) => file.category === "customer_design").length + 1;
  const normalized = validFileName(originalFileName);
  if (!normalized) throw new Error("invalid_file_name");
  const dot = normalized.lastIndexOf(".");
  const extension = dot > -1 ? normalized.slice(dot).toLowerCase() : "";
  const base = (dot > -1 ? normalized.slice(0, dot) : normalized)
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "design";
  return `${order.order_number}_design_v${version}_${base}${extension}`;
}

export async function registerCustomerDesignFromUploadToken(params: {
  token: string;
  fileName: string;
  fileUrl: string;
  uploader?: string;
  note?: string;
  metadata?: UploadFileMetadata;
}): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "customer_design");
  if (!resolved) throw new Error("invalid_customer_design_token");
  const orderId = resolved.orderId;
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [orderId]);
  if (!row) throw new Error("film_order_not_found");
  const order = mapOrder(row);
  const stored = await getFilmOrder(orderId);
  const hasAiFile = Boolean(stored?.files.some((file) => file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai")));
  assertCustomerDesignUploadPolicy(order, params.fileName, undefined, hasAiFile);
  const fileName = validFileName(params.fileName);
  if (!fileName) throw new Error("invalid_file_name");
  const fileUrl = validFileUrl(params.fileUrl);
  const actor = params.uploader?.slice(0, 200) || "customer";
  const file = await addFile(
    db,
    orderId,
    "customer_design",
    fileName,
    fileUrl,
    params.note?.slice(0, 1000) ?? "",
    actor,
    { ...params.metadata, uploadedVia: params.metadata?.uploadedVia ?? "customer_design" },
  );
  const now = new Date().toISOString();
  await db.run(`
    UPDATE film_orders
    SET customer_design_status = 'received', customer_design_received_at = ?, updated_at = ?, updated_by_email = ?
    WHERE id = ? AND customer_design_status IN ('requested','correction_requested')
  `, [now, now, actor, orderId]);
  await addEvent(db, orderId, "customer_design", `顧客デザイン入稿: ${fileName} (v${file.version})`, actor);
  const refreshed = await getFilmOrder(orderId);
  if (refreshed) {
    const mails = [
      await sendMail({
        to: externalTo(refreshed.seven_contact_email),
        subject: `【顧客デザイン入稿】${refreshed.order_number} ${refreshed.product_name || ""}`.trim(),
        text: [
          "顧客よりデザイン原稿が入稿されました。下記内容をご確認ください。",
          "",
          "【案件情報】",
          mailBodyBase(refreshed),
          "",
          "【入稿データ】",
          `ファイル名：${fileName}`,
          `バージョン：v${file.version}`,
          params.note ? `顧客メモ：${params.note}` : "",
          "",
          "【確認ポイント】",
          "1. AIデータが製作可能なレイヤー・アウトライン構成か",
          "2. トンボ・塗り足し・仕上がりサイズが適切か",
          "3. 顧客修正依頼事項が反映されているか",
        ].filter(Boolean).join("\n"),
      }),
    ];
    await logMailEvents(db, orderId, mails, "顧客デザイン受領", actor);
  }
  const result = await getFilmOrder(orderId);
  if (!result) throw new Error("film_order_update_failed");
  return result;
}

export async function registerProofFromUploadToken(params: {
  token: string;
  fileName: string;
  fileUrl: string;
  pdfFileName?: string;
  pdfFileUrl?: string;
  uploader?: string;
  note?: string;
  metadata?: UploadFileMetadata;
  pdfMetadata?: UploadFileMetadata;
}): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "supplier_proof");
  if (!resolved) throw new Error("invalid_proof_token");
  const orderId = resolved.orderId;
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [orderId]);
  if (!row) throw new Error("film_order_not_found");
  const order = mapOrder(row);
  assertSupplierProofUploadPolicy(order, params.fileName);
  const fileName = validFileName(params.fileName);
  if (!fileName || !fileName.toLowerCase().endsWith(".ai")) throw new Error("invalid_ai_file");
  const fileUrl = validFileUrl(params.fileUrl);
  const pdfFileName = params.pdfFileName ? validFileName(params.pdfFileName) : "";
  if (params.pdfFileName && (!pdfFileName || !pdfFileName.toLowerCase().endsWith(".pdf"))) {
    throw new Error("invalid_pdf_file");
  }
  const pdfFileUrl = params.pdfFileName ? validFileUrl(params.pdfFileUrl ?? "") : "";
  if (params.pdfFileName && !pdfFileUrl) throw new Error("invalid_pdf_file");
  const actor = params.uploader?.slice(0, 200) || "supplier";
  const file = await addFile(
    db,
    orderId,
    "proof",
    fileName,
    fileUrl,
    params.note?.slice(0, 1000) ?? "",
    actor,
    {
      ...params.metadata,
      uploadedVia: params.metadata?.uploadedVia ?? "supplier_proof",
    },
  );
  const pdfFile = pdfFileName
    ? await addFile(
      db,
      orderId,
      "proof",
      pdfFileName,
      pdfFileUrl,
      params.note?.slice(0, 1000) ?? "",
      actor,
      {
        ...params.pdfMetadata,
        uploadedVia: params.pdfMetadata?.uploadedVia ?? "supplier_proof",
      },
    )
    : null;
  await markExternalTokenUse(db, resolved.token);
  const now = new Date().toISOString();
  await db.run(
    "UPDATE film_orders SET status = 'proof_registered', proof_registered_at = ?, customer_proof_status = 'pending', updated_at = ?, updated_by_email = ? WHERE id = ?",
    [now, now, actor, orderId],
  );
  await addEvent(
    db,
    orderId,
    "file",
    `校正データ登録（メーカーアップロード）: ${fileName} (v${file.version})${pdfFileName ? ` / ${pdfFileName} (v${pdfFile?.version})` : ""}`,
    actor,
  );
  await addEvent(db, orderId, "status", `${order.status} → 校正待ち`, actor);
  const refreshed = await getFilmOrder(orderId);
  if (refreshed) {
    const mails = await sendProofReceivedMail(refreshed, fileName, fileUrl, pdfFileName || undefined, pdfFileUrl || undefined);
    await logMailEvents(db, orderId, mails, "校正受領通知", actor);
  }
  const result = await getFilmOrder(orderId);
  if (!result) throw new Error("film_order_update_failed");
  return result;
}
