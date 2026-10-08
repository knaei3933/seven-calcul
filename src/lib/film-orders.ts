import { getSqlClient, type SqlClient } from "./db";
import { sendMail, type MailSendResult } from "./mailer";
import type { PurchaseOrderSnapshot } from "./purchase-order";
import type { QuotationRecord } from "./quotation-shared";

export function filmDesignNotificationTo(): string {
  return process.env.FILM_DESIGN_TO ?? "design@package-lab.com";
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
  purchase_order_json: string;
  notes: string;
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
  | "send-po";

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
    po_sent_at TEXT,
    eta_token TEXT,
    eta_expires_at TEXT,
    eta_date TEXT,
    eta_note TEXT,
    eta_updated_at TEXT,
    proof_upload_token TEXT,
    proof_upload_expires_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','ordered','receiving_registered','proof_registered','re_proof_requested','final_approved')),
    re_proof_count INTEGER NOT NULL DEFAULT 0,
    ordered_at TEXT,
    receiving_registered_at TEXT,
    proof_registered_at TEXT,
    re_proof_requested_at TEXT,
    final_approved_at TEXT,
    purchase_order_json TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL DEFAULT '',
    updated_by_email TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_film_orders_status ON film_orders(status);
  CREATE INDEX IF NOT EXISTS idx_film_orders_quotation ON film_orders(quotation_id);
  CREATE TABLE IF NOT EXISTS film_order_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('receiving','proof','final')),
    file_name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    uploaded_by_email TEXT NOT NULL DEFAULT '',
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
    ];
    for (const [, sql] of migrations) {
      try {
        await db.exec(sql);
      } catch {
        // 既存カラムの場合は無視する。
      }
    }
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

function mapOrder(row: FilmOrderRow): FilmOrder {
  const { purchase_order_json, ...rest } = row;
  return { ...rest, purchaseOrder: parsePurchaseOrder(purchase_order_json) };
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
        order_number,quotation_id,quotation_number,product_name,customer_name,printing_method,
        procurement_route,film_composition,order_length_m,web_width_mm,pouch_quantity,
        supplier_name,supplier_email,seven_contact_email,status,purchase_order_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'',?,?,'pending',?,?,?)
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
      quotation.createdBy.email,
      JSON.stringify(snapshot ?? {}),
      now,
      now,
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

export async function listFilmOrders(): Promise<FilmOrderView[]> {
  const db = await getDatabase();
  const rows = await db.all<FilmOrderRow>("SELECT * FROM film_orders ORDER BY created_at DESC, id DESC");
  const files = await db.all<FilmOrderFileRecord>("SELECT * FROM film_order_files ORDER BY created_at, id");
  const events = await db.all<FilmOrderEventRecord>("SELECT * FROM film_order_events ORDER BY created_at, id");
  return rows.map((row) => ({
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
): Promise<FilmOrderFileRecord> {
  const count = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM film_order_files WHERE order_id = ? AND category = ?",
    [orderId, category],
  );
  const version = Number(count?.n ?? 0) + 1;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO film_order_files (order_id,category,file_name,url,version,note,uploaded_by_email,created_at) VALUES (?,?,?,?,?,?,?,?)",
    [orderId, category, fileName, url, version, note, actorEmail, now],
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

function proofNoticeText(order: FilmOrder, artworkUrls: string[] = [], uploadUrl = ""): string {
  const proofName = buildFilmOrderFileName(order, "proof", 1);
  const destination = supplierDestinationFor(order);
  return [
    "お世話になっております。",
    `${order.order_number}（${order.product_name || "-"}）のフィルム製作を依頼いたします。`,
    "",
    "【入稿データ】",
    fileLinksSection(artworkUrls),
    "",
    "上記データをフィルム図面に沿って配置し、校正データを作成してください。",
    "校正データは、必ず下記のアップロードページから返却してください（Googleログイン不要・他の手段では受け付けていません）。",
    "",
    `アップロードページ: ${uploadUrl}`,
    `ファイル名の形式: ${proofName}_v番号（発注番号を必ず含めてください）`,
    destination.route === "B" ? "宛先種別: Y調達（国内）" : destination.route === "A" ? "宛先種別: A（digital / 韓国輸入）" : "",
  ].filter(Boolean).join("\n");
}

async function sendReceivingNotice(
  order: FilmOrder,
  aiFileName: string,
  aiFileUrl: string,
  pdfFileName: string | null,
  pdfFileUrl: string,
  uploadUrl: string,
): Promise<MailSendResult[]> {
  const artworkUrls = [aiFileUrl, pdfFileName ? pdfFileUrl : ""];
  const designMail = await sendMail({
    to: filmDesignNotificationTo(),
    subject: `【入稿登録】${order.order_number} ${order.product_name}`,
    text: [
      `${order.order_number}（${order.product_name || "-"}）のフィルム製作データが入稿されました。`,
      "",
      mailBodyBase(order),
      "",
      `AI: ${aiFileName}${aiFileUrl ? `\n${aiFileUrl}` : ""}`,
      pdfFileName ? `PDF: ${pdfFileName}${pdfFileUrl ? `\n${pdfFileUrl}` : ""}` : "PDF: なし",
      "",
      `入稿データフォルダ: ${FILM_RECEIVING_FOLDER_URL}`,
      `校正データ返却先: ${FILM_PROOF_FOLDER_URL}`,
      "",
      "この内容をもとに、フィルムメーカーへ校正データの返却依頼を行ってください。",
    ].join("\n"),
  });
  const destination = supplierDestinationFor(order);
  const mails: MailSendResult[] = [designMail];
  if (destination.to) {
    mails.push(await sendMail({
      to: destination.to,
      subject: `【校正データ返却のお願い】${order.order_number} ${order.product_name}`,
      text: proofNoticeText(order, artworkUrls, uploadUrl),
    }));
  }
  return mails;
}

async function sendProofNoticeMail(order: FilmOrder, uploadUrl: string): Promise<MailSendResult> {
  const destination = supplierDestinationFor(order);
  return sendMail({
    to: destination.to ?? filmDesignNotificationTo(),
    subject: `【校正データ返却のお願い】${order.order_number} ${order.product_name}`,
    text: proofNoticeText(order, [], uploadUrl),
  });
}

async function sendApprovalMail(order: FilmOrder): Promise<MailSendResult[]> {
  const subject = `【校正承認・最終受注】${order.order_number} ${order.product_name}`;
  const text = [
    `${order.order_number}（${order.product_name || "-"}）の校正データが承認され、カネイ貿易の最終受注処理が確定しました。`,
    "",
    mailBodyBase(order),
  ].join("\n");
  const destination = supplierDestinationFor(order);
  const mails: MailSendResult[] = [];
  if (destination.to) mails.push(await sendMail({ to: destination.to, subject, text }));
  mails.push(await sendMail({ to: externalTo(order.seven_contact_email), subject, text }));
  mails.push(await sendMail({ to: filmDesignNotificationTo(), subject, text }));
  return mails;
}

async function sendReProofMail(order: FilmOrder, comment: string, uploadUrl: string): Promise<MailSendResult[]> {
  const subject = `【再校正のお願い】${order.order_number} ${order.product_name}`;
  const text = [
    `${order.order_number}（${order.product_name || "-"}）の校正データについて再校正をお願いいたします。`,
    "",
    mailBodyBase(order),
    "",
    `再校正内容: ${comment}（再校正 ${order.re_proof_count + 1} 回目）`,
    "",
    `返却ページ（必ずここからアップロード・Googleログイン不要）: ${uploadUrl}`,
  ].join("\n");
  const destination = supplierDestinationFor(order);
  const mails: MailSendResult[] = [];
  if (destination.to) mails.push(await sendMail({ to: destination.to, subject, text }));
  mails.push(await sendMail({ to: filmDesignNotificationTo(), subject, text }));
  return mails;
}

async function sendProofReceivedMail(order: FilmOrder, fileName: string, fileUrl: string): Promise<MailSendResult[]> {
  const subject = `【校正データ受領】${order.order_number} ${order.product_name}`;
  const text = [
    `${order.order_number}（${order.product_name || "-"}）の校正データが登録されました。`,
    "セブン化学での確認・承認をお願いします。",
    "",
    mailBodyBase(order),
    "",
    `校正ファイル: ${fileName}`,
    fileUrl ? `ファイルURL: ${fileUrl}` : "（URL未登録）",
  ].join("\n");
  return [await sendMail({ to: externalTo(order.seven_contact_email), subject, text })];
}

async function sendPurchaseOrderMail(order: FilmOrder, origin: string, etaUrl: string): Promise<MailSendResult[]> {
  const destination = supplierDestinationFor(order);
  if (!destination.to) throw new Error("supplier_destination_missing");
  const subject = `【発注】${order.order_number} ${order.product_name}`;
  const text = [
    "お世話になっております。",
    `${order.order_number}（${order.product_name || "-"}）について、下記の内容で発注いたします。`,
    "",
    mailBodyBase(order),
    "",
    "【お願い】おおよその納期見込みを下記フォームからご入力ください。",
    etaUrl,
    "",
    `発注書URL（印刷用）: ${origin}/film-orders`,
  ].join("\n");
  const mails = [await sendMail({ to: destination.to, subject, text })];
  mails.push(await sendMail({
    to: externalTo(order.seven_contact_email),
    subject: `【発注送信】${order.order_number} ${order.product_name}`,
    text: `${order.order_number} の発注書をメーカーへ送信しました。\n納期見込み入力フォーム: ${etaUrl}`,
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

function signProofToken(orderId: number, expiresAt: number): string {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha256", `${etaSecret()}:proof`).update(`${orderId}.${expiresAt}`).digest("base64url");
}

async function ensureProofUploadToken(db: SqlClient, orderId: number): Promise<string> {
  const row = await db.get<{ proof_upload_token: string | null; proof_upload_expires_at: string | null }>(
    "SELECT proof_upload_token, proof_upload_expires_at FROM film_orders WHERE id = ?",
    [orderId],
  );
  const stillValid = row?.proof_upload_token
    && row.proof_upload_expires_at
    && new Date(row.proof_upload_expires_at).getTime() > Date.now() + 24 * 60 * 60 * 1000;
  if (stillValid && row?.proof_upload_token) return row.proof_upload_token;
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const token = `${orderId}.${expiresAt}.${signProofToken(orderId, expiresAt)}`;
  const now = new Date().toISOString();
  await db.run(
    "UPDATE film_orders SET proof_upload_token = ?, proof_upload_expires_at = ?, updated_at = ? WHERE id = ?",
    [token, new Date(expiresAt).toISOString(), now, orderId],
  );
  return token;
}

function verifyProofUploadToken(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const orderId = Number(parts[0]);
  const expiresAt = Number(parts[1]);
  const signature = parts[2];
  if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Date.now()) return null;
  const expected = signProofToken(orderId, expiresAt);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !require("node:crypto").timingSafeEqual(a, b)) return null;
  return orderId;
}

export async function getFilmOrderForProofUpload(token: string): Promise<FilmOrderView | null> {
  const orderId = verifyProofUploadToken(token);
  if (orderId == null) throw new Error("invalid_proof_token");
  const db = await getDatabase();
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ? AND proof_upload_token = ?", [orderId, token]);
  return row ? getFilmOrder(orderId) : null;
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
    const subject = `【納期見込み】${updated.order_number} ${updated.product_name}`;
    const text = [
      `${updated.order_number} の納期見込みが入力されました: ${date}`,
      note ? `メモ: ${note}` : "",
      "",
      mailBodyBase(updated),
    ].filter(Boolean).join("\n");
    const mails: MailSendResult[] = [];
    if (destination.to) mails.push(await sendMail({ to: destination.to, subject, text }));
    mails.push(await sendMail({ to: externalTo(updated.seven_contact_email), subject, text }));
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
    const resolvedEmail = supplierEmail || filmPracticeSupplierEmail();
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
    // フィルム製作用データの入荷。AI は必須、PDF は任意。
    const aiFileName = validFileName(params.aiFileName);
    if (!aiFileName || !/\.ai$/iu.test(aiFileName)) throw new Error("invalid_ai_file");
    const pdfFileNameRaw = validFileName(params.pdfFileName);
    if (pdfFileNameRaw && !/\.pdf$/iu.test(pdfFileNameRaw)) throw new Error("invalid_pdf_file");
    const aiFileUrl = validFileUrl(params.aiFileUrl);
    const pdfFileUrl = validFileUrl(params.pdfFileUrl);
    await addFile(db, id, "receiving", aiFileName, aiFileUrl, trimParam(params.note, 1000), actorEmail);
    if (pdfFileNameRaw) {
      await addFile(db, id, "receiving", pdfFileNameRaw, pdfFileUrl, trimParam(params.note, 1000), actorEmail);
    }
    await db.run(
      "UPDATE film_orders SET status = 'receiving_registered', receiving_registered_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, now, actorEmail, id],
    );
    await addEvent(db, id, "file", `入荷データ登録: ${aiFileName}${pdfFileNameRaw ? ` / ${pdfFileNameRaw}` : ""}`, actorEmail);
    await addEvent(db, id, "status", "発注書送信済み → 入荷データ登録済み", actorEmail);
    const refreshed = await getFilmOrder(id);
    const uploadUrl = `${origin}/film-orders/upload/${await ensureProofUploadToken(db, id)}`;
    const mails = refreshed
      ? await sendReceivingNotice(refreshed, aiFileName, aiFileUrl, pdfFileNameRaw ?? null, pdfFileUrl, uploadUrl)
      : [];
    await logMailEvents(db, id, mails, "入荷通知メール", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "send-proof-notice") {
    if (order.status !== "receiving_registered") throw new Error("invalid_status_transition");
    const mails = [await sendProofNoticeMail(order, `${origin}/film-orders/upload/${await ensureProofUploadToken(db, id)}`)];
    await logMailEvents(db, id, mails, "校正アップロード案内", actorEmail);
    const result = await getFilmOrder(id);
    if (!result) throw new Error("film_order_update_failed");
    return { order: result, mails };
  } else if (action === "register-proof") {
    if (order.status !== "receiving_registered" && order.status !== "re_proof_requested") throw new Error("invalid_status_transition");
    const fileName = validFileName(params.fileName);
    if (!fileName) throw new Error("invalid_file_name");
    const fileUrl = validFileUrl(params.fileUrl);
    const file = await addFile(db, id, "proof", fileName, fileUrl, trimParam(params.note, 1000), actorEmail);
    await db.run(
      "UPDATE film_orders SET status = 'proof_registered', proof_registered_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, now, actorEmail, id],
    );
    await addEvent(db, id, "file", `校正データ登録: ${fileName} (v${file.version})`, actorEmail);
    await addEvent(db, id, "status", `${order.status} → 校正待ち`, actorEmail);
    {
      const refreshed = await getFilmOrder(id);
      const mails = refreshed ? await sendProofReceivedMail(refreshed, fileName, fileUrl) : [];
      await logMailEvents(db, id, mails, "校正受領通知", actorEmail);
    }
  } else if (action === "approve") {
    if (order.status !== "proof_registered") throw new Error("invalid_status_transition");
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
    await db.run(
      "UPDATE film_orders SET status = 're_proof_requested', re_proof_count = ?, re_proof_requested_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [order.re_proof_count + 1, now, now, actorEmail, id],
    );
    await addEvent(db, id, "status", `校正待ち → 再校正依頼中: ${comment}`, actorEmail);
    const refreshed = await getFilmOrder(id);
    const mails = refreshed
      ? await sendReProofMail(refreshed, comment, `${origin}/film-orders/upload/${await ensureProofUploadToken(db, id)}`)
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
    const mails = refreshed ? await sendPurchaseOrderMail(refreshed, origin, etaUrl) : [];
    await logMailEvents(db, id, mails, "発注書送信", actorEmail);
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

export async function registerProofFromUploadToken(params: {
  token: string;
  fileName: string;
  fileUrl: string;
  uploader?: string;
  note?: string;
}): Promise<FilmOrderView> {
  const orderId = verifyProofUploadToken(params.token);
  if (orderId == null) throw new Error("invalid_proof_token");
  const db = await getDatabase();
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ? AND proof_upload_token = ?", [orderId, params.token]);
  if (!row) throw new Error("invalid_proof_token");
  if (row.status !== "receiving_registered" && row.status !== "re_proof_requested") {
    throw new Error("invalid_status_transition");
  }
  const fileName = validFileName(params.fileName);
  if (!fileName || !fileName.includes(row.order_number)) throw new Error("invalid_file_name");
  const fileUrl = validFileUrl(params.fileUrl);
  const order = mapOrder(row);
  const actor = params.uploader?.slice(0, 200) || "supplier";
  const file = await addFile(db, orderId, "proof", fileName, fileUrl, params.note?.slice(0, 1000) ?? "", actor);
  const now = new Date().toISOString();
  await db.run(
    "UPDATE film_orders SET status = 'proof_registered', proof_registered_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
    [now, now, actor, orderId],
  );
  await addEvent(db, orderId, "file", `校正データ登録（メーカーアップロード）: ${fileName} (v${file.version})`, actor);
  await addEvent(db, orderId, "status", `${order.status} → 校正待ち`, actor);
  const refreshed = await getFilmOrder(orderId);
  if (refreshed) {
    const mails = await sendProofReceivedMail(refreshed, fileName, fileUrl);
    await logMailEvents(db, orderId, mails, "校正受領通知", actor);
  }
  const result = await getFilmOrder(orderId);
  if (!result) throw new Error("film_order_update_failed");
  return result;
}
