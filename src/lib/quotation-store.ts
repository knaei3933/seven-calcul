import type { SqlClient } from "./db";
import { getSqlClient } from "./db";
import { quotationStatuses, type QuotationStatus } from "./quotation-shared";
import { QUOTATION_RESTORE_KEY } from "./quotation-shared";
import { D } from "./decimal";
import { ensureAdministratorSeed, type UserRole } from "./auth-store";
import type { QuotationRecord, QuotationRecordInput, ChecklistAudience } from "./quotation-shared";
import {
  buildChecklistItems,
  buildLegacyChecklistItems,
  CHECKLIST_VERSION,
  LEGACY_CHECKLIST_VERSION,
  type CalculationChecklistSnapshot,
  type ChecklistAudience as ChecklistAudienceValue,
  type ChecklistRecord,
} from "./calculation-checklist";

export { QUOTATION_RESTORE_KEY, quotationStatuses };
export type { QuotationRecord, QuotationRecordInput, QuotationStatus };

interface DatabaseRow {
  id: number;
  quotation_number: string;
  status: string;
  issue_date: string;
  valid_until: string;
  customer_name: string;
  customer_contact: string;
  product_name: string;
  size_summary: string;
  quantity: string;
  filling_cost_per_piece: string;
  film_cost_per_piece: string;
  film_meter_price: string;
  film_order_length_m: string;
  target_margin: string;
  tax_rate_percent: string;
  price_per_piece: string;
  subtotal: string;
  tax: string;
  grand_total: string;
  delivery_date: string;
  payment_terms: string;
  notes: string;
  calculation_version: string;
  result_hash: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  updated_by: number | null;
  creator_name: string | null;
  creator_email: string | null;
  updater_name: string | null;
  updater_email: string | null;
}

let schemaReady: Promise<SqlClient> | null = null;

export class QuotationOwnershipConflictError extends Error {
  constructor() {
    super("quotation_ownership_conflict");
    this.name = "QuotationOwnershipConflictError";
  }
}

async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    // users テーブルと環境変数管理者のFK参照を先に保証する。
    const administratorId = await ensureAdministratorSeed();
    const db = await getSqlClient("quotations");
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
    await migrateOwnershipColumns(db, administratorId);
    // 社名表記を「金井貿易株式会社」へ統一する（旧default・既存DB値を含む）。
    await db.exec(CHECKLIST_COMPANY_NAME_NORMALIZATION);
    return db;
  })();
  return schemaReady;
}

const CHECKLIST_COMPANY_NAME_NORMALIZATION = `
    UPDATE quotation_checklists
    SET
      checked_by = CASE checked_by
        WHEN '카네이무역 내부 QA' THEN '金井貿易株式会社 内部QA'
        WHEN '金井貿易 社内QA' THEN '金井貿易株式会社 社内QA'
        ELSE checked_by
      END,
      items_json = replace(
        replace(items_json, '金井貿易 社内QA', '金井貿易株式会社 社内QA'),
        '카네이무역 내부 QA',
        '金井貿易株式会社 内部QA'
      )
    WHERE checked_by IN ('카네이무역 내부 QA', '金井貿易 社内QA')
       OR items_json LIKE '%카네이무역%'
       OR items_json LIKE '%金井貿易%'
`;

const SQLITE_SCHEMA = `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('draft','sent','approved','rejected','expired')),
      issue_date TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_contact TEXT NOT NULL,
      product_name TEXT NOT NULL,
      size_summary TEXT NOT NULL,
      quantity TEXT NOT NULL,
      filling_cost_per_piece TEXT NOT NULL,
      film_cost_per_piece TEXT NOT NULL,
      film_meter_price TEXT NOT NULL,
      film_order_length_m TEXT NOT NULL,
      target_margin TEXT NOT NULL,
      tax_rate_percent TEXT NOT NULL,
      price_per_piece TEXT NOT NULL,
      subtotal TEXT NOT NULL,
      tax TEXT NOT NULL,
      grand_total TEXT NOT NULL,
      delivery_date TEXT NOT NULL,
      payment_terms TEXT NOT NULL,
      notes TEXT NOT NULL,
      calculation_version TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_quotations_updated_at ON quotations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_name);
    CREATE TABLE IF NOT EXISTS quotation_checklists (
      quotation_id INTEGER NOT NULL,
      audience TEXT NOT NULL CHECK(audience IN ('CUSTOMER','INTERNAL_QA')),
      checklist_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress','completed')),
      snapshot_json TEXT NOT NULL,
      items_json TEXT NOT NULL,
      checked_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (quotation_id, audience),
      FOREIGN KEY (quotation_id) REFERENCES quotations(id)
    );
`;

const POSTGRES_SCHEMA = `
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      quotation_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('draft','sent','approved','rejected','expired')),
      issue_date TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_contact TEXT NOT NULL,
      product_name TEXT NOT NULL,
      size_summary TEXT NOT NULL,
      quantity TEXT NOT NULL,
      filling_cost_per_piece TEXT NOT NULL,
      film_cost_per_piece TEXT NOT NULL,
      film_meter_price TEXT NOT NULL,
      film_order_length_m TEXT NOT NULL,
      target_margin TEXT NOT NULL,
      tax_rate_percent TEXT NOT NULL,
      price_per_piece TEXT NOT NULL,
      subtotal TEXT NOT NULL,
      tax TEXT NOT NULL,
      grand_total TEXT NOT NULL,
      delivery_date TEXT NOT NULL,
      payment_terms TEXT NOT NULL,
      notes TEXT NOT NULL,
      calculation_version TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_quotations_updated_at ON quotations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_name);
    CREATE TABLE IF NOT EXISTS quotation_checklists (
      quotation_id INTEGER NOT NULL,
      audience TEXT NOT NULL CHECK(audience IN ('CUSTOMER','INTERNAL_QA')),
      checklist_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('in_progress','completed')),
      snapshot_json TEXT NOT NULL,
      items_json TEXT NOT NULL,
      checked_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (quotation_id, audience),
      FOREIGN KEY (quotation_id) REFERENCES quotations(id)
    );
`;

async function migrateOwnershipColumns(db: SqlClient, administratorId: number): Promise<void> {
  if (db.dialect === "sqlite") {
    const columns = await db.all<{ name: string }>("PRAGMA table_info(quotations)");
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("created_by")) {
      await db.exec("ALTER TABLE quotations ADD COLUMN created_by INTEGER REFERENCES users(id)");
    }
    if (!columnNames.has("updated_by")) {
      await db.exec("ALTER TABLE quotations ADD COLUMN updated_by INTEGER REFERENCES users(id)");
    }
  }
  await db.run("UPDATE quotations SET created_by = ? WHERE created_by IS NULL", [administratorId]);
}

function isNonNegativeNumber(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function validateQuotationInput(value: unknown): QuotationRecordInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const numericFields = [
    "quantity", "fillingCostPerPiece", "filmCostPerPiece", "filmMeterPrice", "filmOrderLengthM",
    "targetMargin", "taxRatePercent", "pricePerPiece", "subtotal", "tax", "grandTotal",
  ] as const;
  if (!text(input.quotationNumber).trim() || !text(input.issueDate).trim()) return null;
  if (numericFields.some((field) => !isNonNegativeNumber(input[field]))) return null;
  const status = quotationStatuses.find((item) => item === input.status);
  if (!status || typeof input.payload !== "object" || input.payload === null) return null;

  return {
    quotationNumber: text(input.quotationNumber),
    status,
    issueDate: text(input.issueDate),
    validUntil: text(input.validUntil),
    customerName: text(input.customerName),
    customerContact: text(input.customerContact),
    productName: text(input.productName),
    sizeSummary: text(input.sizeSummary),
    quantity: text(input.quantity),
    fillingCostPerPiece: text(input.fillingCostPerPiece),
    filmCostPerPiece: text(input.filmCostPerPiece),
    filmMeterPrice: text(input.filmMeterPrice),
    filmOrderLengthM: text(input.filmOrderLengthM),
    targetMargin: text(input.targetMargin),
    taxRatePercent: text(input.taxRatePercent),
    pricePerPiece: text(input.pricePerPiece),
    subtotal: text(input.subtotal),
    tax: text(input.tax),
    grandTotal: text(input.grandTotal),
    deliveryDate: text(input.deliveryDate),
    paymentTerms: text(input.paymentTerms),
    notes: text(input.notes),
    calculationVersion: text(input.calculationVersion, "manual-entry"),
    resultHash: text(input.resultHash),
    payload: input.payload as Record<string, unknown>,
  };
}

function mapRow(row: DatabaseRow): QuotationRecord {
  const updatedById = row.updated_by == null ? null : Number(row.updated_by);
  return {
    id: Number(row.id),
    quotationNumber: row.quotation_number,
    status: row.status as QuotationStatus,
    issueDate: row.issue_date,
    validUntil: row.valid_until,
    customerName: row.customer_name,
    customerContact: row.customer_contact,
    productName: row.product_name,
    sizeSummary: row.size_summary,
    quantity: row.quantity,
    fillingCostPerPiece: row.filling_cost_per_piece,
    filmCostPerPiece: row.film_cost_per_piece,
    filmMeterPrice: row.film_meter_price,
    filmOrderLengthM: row.film_order_length_m,
    targetMargin: row.target_margin,
    taxRatePercent: row.tax_rate_percent,
    pricePerPiece: row.price_per_piece,
    subtotal: row.subtotal,
    tax: row.tax,
    grandTotal: row.grand_total,
    deliveryDate: row.delivery_date,
    paymentTerms: row.payment_terms,
    notes: row.notes,
    calculationVersion: row.calculation_version,
    resultHash: row.result_hash,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: {
      id: Number(row.created_by),
      email: row.creator_email ?? "",
      name: row.creator_name ?? "",
    },
    updatedBy: updatedById == null ? null : {
      id: updatedById,
      email: row.updater_email ?? "",
      name: row.updater_name ?? "",
    },
  };
}

export async function saveQuotation(
  value: QuotationRecordInput,
  actorId: number,
  actorRole: UserRole = "user",
): Promise<QuotationRecord> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(value.payload);
  await db.run(`
    INSERT INTO quotations (
      quotation_number,status,issue_date,valid_until,customer_name,customer_contact,product_name,size_summary,
      quantity,filling_cost_per_piece,film_cost_per_piece,film_meter_price,film_order_length_m,target_margin,
      tax_rate_percent,price_per_piece,subtotal,tax,grand_total,delivery_date,payment_terms,notes,
      calculation_version,result_hash,payload_json,created_at,updated_at,created_by,updated_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(quotation_number) DO UPDATE SET
      status=excluded.status, issue_date=excluded.issue_date, valid_until=excluded.valid_until,
      customer_name=excluded.customer_name, customer_contact=excluded.customer_contact,
      product_name=excluded.product_name, size_summary=excluded.size_summary, quantity=excluded.quantity,
      filling_cost_per_piece=excluded.filling_cost_per_piece, film_cost_per_piece=excluded.film_cost_per_piece,
      film_meter_price=excluded.film_meter_price, film_order_length_m=excluded.film_order_length_m,
      target_margin=excluded.target_margin, tax_rate_percent=excluded.tax_rate_percent,
      price_per_piece=excluded.price_per_piece, subtotal=excluded.subtotal, tax=excluded.tax,
      grand_total=excluded.grand_total, delivery_date=excluded.delivery_date, payment_terms=excluded.payment_terms,
      notes=excluded.notes, calculation_version=excluded.calculation_version, result_hash=excluded.result_hash,
      payload_json=excluded.payload_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by
      WHERE quotations.created_by = excluded.updated_by OR ? = 'admin'
  `, [
    value.quotationNumber, value.status, value.issueDate, value.validUntil, value.customerName, value.customerContact,
    value.productName, value.sizeSummary, value.quantity, value.fillingCostPerPiece, value.filmCostPerPiece,
    value.filmMeterPrice, value.filmOrderLengthM, value.targetMargin, value.taxRatePercent, value.pricePerPiece,
    value.subtotal, value.tax, value.grandTotal, value.deliveryDate, value.paymentTerms, value.notes,
    value.calculationVersion, value.resultHash, payloadJson, now, now, actorId, actorId, actorRole,
  ]);
  const saved = await selectRecordByNumber(db, value.quotationNumber);
  if (!saved) throw new Error("quotation_save_failed");
  const record = mapRow(saved);
  if (actorRole !== "admin" && record.createdBy.id !== actorId) {
    throw new QuotationOwnershipConflictError();
  }
  return record;
}

export async function getDatabaseForTest(): Promise<SqlClient> {
  return getDatabase();
}

export async function listQuotations({
  q = "",
  status = "all",
  limit = 100,
  creatorId,
}: { q?: string; status?: string; limit?: number; creatorId?: number } = {}): Promise<QuotationRecord[]> {
  const db = await getDatabase();
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Number(limit) : 100, 1), 500);
  const search = `%${q.trim()}%`;
  const statusFilter = quotationStatuses.find((item) => item === status);
  const ownershipFilter = Number.isInteger(creatorId) && creatorId! > 0 ? " AND quotations.created_by = ?" : "";
  const ownershipArguments: Array<string | number | null> = ownershipFilter ? [creatorId ?? 0] : [];
  const baseSelect = `
        SELECT quotations.*, creator.name AS creator_name, creator.email AS creator_email,
               updater.name AS updater_name, updater.email AS updater_email
        FROM quotations
        JOIN users AS creator ON creator.id = quotations.created_by
        LEFT JOIN users AS updater ON updater.id = quotations.updated_by
  `;
  const rows = statusFilter
    ? await db.all<DatabaseRow>(`
        ${baseSelect}
        WHERE status = ?${ownershipFilter} AND (quotation_number LIKE ? OR customer_name LIKE ? OR customer_contact LIKE ? OR product_name LIKE ?)
        ORDER BY updated_at DESC, id DESC LIMIT ?
      `, [statusFilter, ...ownershipArguments, search, search, search, search, safeLimit])
    : await db.all<DatabaseRow>(`
        ${baseSelect}
        WHERE (quotation_number LIKE ? OR customer_name LIKE ? OR customer_contact LIKE ? OR product_name LIKE ?)${ownershipFilter}
        ORDER BY updated_at DESC, id DESC LIMIT ?
      `, [search, search, search, search, ...ownershipArguments, safeLimit]);
  return rows.map(mapRow);
}

export async function getQuotation(id: number): Promise<QuotationRecord | null> {
  const db = await getDatabase();
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await selectRecordById(db, id);
  return row ? mapRow(row) : null;
}

export async function getQuotationByNumber(quotationNumber: string): Promise<QuotationRecord | null> {
  const db = await getDatabase();
  const code = quotationNumber.trim();
  if (!code) return null;
  const row = await selectRecordByNumber(db, code);
  return row ? mapRow(row) : null;
}

export async function updateQuotationStatus(id: number, status: QuotationStatus, actorId: number): Promise<QuotationRecord | null> {
  const db = await getDatabase();
  if (!Number.isInteger(id) || id <= 0 || !quotationStatuses.includes(status)) return null;
  const result = await db.run(
    "UPDATE quotations SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    [status, actorId, new Date().toISOString(), id],
  );
  if (Number(result.changes) === 0) return null;
  return getQuotation(id);
}

async function selectRecordById(db: SqlClient, id: number): Promise<DatabaseRow | undefined> {
  return db.get<DatabaseRow>(`
    SELECT quotations.*, creator.name AS creator_name, creator.email AS creator_email,
           updater.name AS updater_name, updater.email AS updater_email
    FROM quotations
    JOIN users AS creator ON creator.id = quotations.created_by
    LEFT JOIN users AS updater ON updater.id = quotations.updated_by
    WHERE quotations.id = ?
  `, [id]);
}

async function selectRecordByNumber(db: SqlClient, quotationNumber: string): Promise<DatabaseRow | undefined> {
  if (!quotationNumber.trim()) return undefined;
  return db.get<DatabaseRow>(`
    SELECT quotations.*, creator.name AS creator_name, creator.email AS creator_email,
           updater.name AS updater_name, updater.email AS updater_email
    FROM quotations
    JOIN users AS creator ON creator.id = quotations.created_by
    LEFT JOIN users AS updater ON updater.id = quotations.updated_by
    WHERE quotations.quotation_number = ?
  `, [quotationNumber]);
}

export async function deleteQuotation(id: number): Promise<boolean> {
  const db = await getDatabase();
  if (!Number.isInteger(id) || id <= 0) return false;
  // 견적 삭제 시 체크리스트 행이 외래키 제약으로 남아 있으면 삭제가 실패한다. 먼저 정리한다.
  await db.run("DELETE FROM quotation_checklists WHERE quotation_id = ?", [id]);
  const result = await db.run("DELETE FROM quotations WHERE id = ?", [id]);
  return Number(result.changes) > 0;
}

interface ChecklistRow {
  quotation_id: number;
  audience: ChecklistAudienceValue;
  checklist_version: string;
  status: string;
  snapshot_json: string;
  items_json: string;
  checked_by: string;
  created_at: string;
  updated_at: string;
}

function mapChecklistRow(row: ChecklistRow): ChecklistRecord {
  const items = JSON.parse(row.items_json) as import("./calculation-checklist").ChecklistItem[];
  const accepted = items.filter((item) => item.accepted).length;
  return {
    quotationId: Number(row.quotation_id),
    audience: row.audience,
    checklistVersion: row.checklist_version,
    status: row.status as "in_progress" | "completed",
    snapshot: JSON.parse(row.snapshot_json) as Partial<CalculationChecklistSnapshot>,
    items,
    acceptedCount: accepted,
    totalCount: items.length,
    progressPercent: items.length > 0 ? Number(D(accepted).div(items.length).times(100).toString()) : 0,
    checkedBy: row.checked_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function calculateChecklistProgress(items: import("./calculation-checklist").ChecklistItem[]) {
  const accepted = items.filter((item) => item.accepted).length;
  const total = items.length;
  const percent = total > 0 ? Number(D(accepted).div(total).times(100).toString()) : 0;
  return {
    accepted,
    total,
    percent,
    status: accepted === total ? "completed" : "in_progress",
  };
}

export async function createChecklistsForQuotation(record: QuotationRecord, snapshot: CalculationChecklistSnapshot): Promise<ChecklistRecord[]> {
  const db = await getDatabase();
  const existing = await db.all<{ checklist_version: string; snapshot_json: string }>(
    "SELECT checklist_version,snapshot_json FROM quotation_checklists WHERE quotation_id = ?",
    [record.id],
  );
  if (existing.length > 0) {
    const serializedSnapshot = JSON.stringify(snapshot);
    const unchanged = existing.every((row) =>
      row.checklist_version === CHECKLIST_VERSION && row.snapshot_json === serializedSnapshot
    );
    if (unchanged) {
      const rows = await db.all<ChecklistRow>(
        "SELECT * FROM quotation_checklists WHERE quotation_id = ? ORDER BY audience",
        [record.id],
      );
      return rows.map(mapChecklistRow);
    }
    await db.run("DELETE FROM quotation_checklists WHERE quotation_id = ?", [record.id]);
  }

  const itemTemplates = buildChecklistItems(snapshot);
  const audiences: ChecklistAudienceValue[] = ["CUSTOMER", "INTERNAL_QA"];
  const now = new Date().toISOString();
  const insertSql = `
    INSERT INTO quotation_checklists (
      quotation_id,audience,checklist_version,status,snapshot_json,items_json,checked_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `;
  for (const audience of audiences) {
    await db.run(insertSql, [
      record.id,
      audience,
      snapshot.checklistVersion,
      "in_progress",
      JSON.stringify(snapshot),
      JSON.stringify(itemTemplates),
      audience === "CUSTOMER" ? record.customerName || "顧客" : "金井貿易株式会社 内部QA",
      now,
      now,
    ]);
  }
  const rows = await db.all<ChecklistRow>(
    "SELECT * FROM quotation_checklists WHERE quotation_id = ? ORDER BY audience",
    [record.id],
  );
  return rows.map(mapChecklistRow);
}

export async function createLegacyChecklistsForQuotation(
  record: QuotationRecord,
  printingMethod: "digital" | "gravure",
): Promise<ChecklistRecord[]> {
  const db = await getDatabase();
  const existing = await db.all<{ checklist_version: string }>(
    "SELECT checklist_version FROM quotation_checklists WHERE quotation_id = ?",
    [record.id],
  );
  if (existing.length > 0 && existing.every((row) => row.checklist_version === LEGACY_CHECKLIST_VERSION)) {
    return getChecklistsForQuotation(record.id);
  }
  if (existing.length > 0) {
    await db.run(
      "DELETE FROM quotation_checklists WHERE quotation_id = ? AND checklist_version LIKE 'legacy-%'",
      [record.id],
    );
  }

  const items = buildLegacyChecklistItems(record, printingMethod);
  const audiences: ChecklistAudienceValue[] = ["CUSTOMER", "INTERNAL_QA"];
  const now = new Date().toISOString();
  const insertSql = `
    INSERT INTO quotation_checklists (
      quotation_id,audience,checklist_version,status,snapshot_json,items_json,checked_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `;

  for (const audience of audiences) {
    await db.run(insertSql, [
      record.id,
      audience,
      LEGACY_CHECKLIST_VERSION,
      "in_progress",
      JSON.stringify({ printingMethod }),
      JSON.stringify(items),
      audience === "CUSTOMER" ? record.customerName || "顧客" : "金井貿易株式会社 内部QA",
      now,
      now,
    ]);
  }

  return getChecklistsForQuotation(record.id);
}

export async function getChecklistsForQuotation(quotationId: number): Promise<ChecklistRecord[]> {
  const db = await getDatabase();
  if (!Number.isInteger(quotationId) || quotationId <= 0) return [];
  const rows = await db.all<ChecklistRow>(
    "SELECT * FROM quotation_checklists WHERE quotation_id = ? ORDER BY audience",
    [quotationId],
  );
  return rows.map(mapChecklistRow);
}

export async function updateChecklistItem(
  quotationId: number,
  audience: ChecklistAudienceValue,
  itemId: string,
  accepted: boolean,
  checkedBy: string,
): Promise<ChecklistRecord | null> {
  const db = await getDatabase();
  const row = await db.get<ChecklistRow>(
    "SELECT * FROM quotation_checklists WHERE quotation_id = ? AND audience = ?",
    [quotationId, audience],
  );
  if (!row) return null;
  const items = JSON.parse(row.items_json) as import("./calculation-checklist").ChecklistItem[];
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return null;
  item.accepted = accepted;
  item.checkedAt = accepted ? new Date().toISOString() : null;
  item.checkedBy = accepted ? checkedBy || null : null;
  const progress = calculateChecklistProgress(items);
  const now = new Date().toISOString();
  await db.run(`
    UPDATE quotation_checklists
    SET items_json = ?, status = ?, checked_by = ?, updated_at = ?
    WHERE quotation_id = ? AND audience = ?
  `, [
    JSON.stringify(items),
    progress.status,
    progress.status === "completed" ? checkedBy : "",
    now,
    quotationId,
    audience,
  ]);
  const updated = await db.get<ChecklistRow>(
    "SELECT * FROM quotation_checklists WHERE quotation_id = ? AND audience = ?",
    [quotationId, audience],
  );
  return updated ? mapChecklistRow(updated) : null;
}
