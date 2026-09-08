import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { quotationStatuses, type QuotationStatus } from "./quotation-shared";
import { QUOTATION_RESTORE_KEY } from "./quotation-shared";
import { D } from "./decimal";
import type { QuotationRecord, QuotationRecordInput, ChecklistAudience } from "./quotation-shared";
import { buildChecklistItems, type CalculationChecklistSnapshot, type ChecklistAudience as ChecklistAudienceValue, type ChecklistRecord } from "./calculation-checklist";

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
}

const databasePath = process.env.POUCH_QUOTATION_DB
  ?? (process.env.VERCEL === "1" ? "/tmp/pouch-quotations.db" : resolve(process.cwd(), ".data/quotations.db"));
let database: DatabaseSync | null = null;

async function getDatabase(): Promise<DatabaseSync> {
  if (database) return database;
  await mkdir(dirname(databasePath), { recursive: true });
  database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
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
      updated_at TEXT NOT NULL
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
  `);
  return database;
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
  };
}

export async function saveQuotation(value: QuotationRecordInput): Promise<QuotationRecord> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(value.payload);
  db.prepare(`
    INSERT INTO quotations (
      quotation_number,status,issue_date,valid_until,customer_name,customer_contact,product_name,size_summary,
      quantity,filling_cost_per_piece,film_cost_per_piece,film_meter_price,film_order_length_m,target_margin,
      tax_rate_percent,price_per_piece,subtotal,tax,grand_total,delivery_date,payment_terms,notes,
      calculation_version,result_hash,payload_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      payload_json=excluded.payload_json, updated_at=excluded.updated_at
  `).run(
    value.quotationNumber, value.status, value.issueDate, value.validUntil, value.customerName, value.customerContact,
    value.productName, value.sizeSummary, value.quantity, value.fillingCostPerPiece, value.filmCostPerPiece,
    value.filmMeterPrice, value.filmOrderLengthM, value.targetMargin, value.taxRatePercent, value.pricePerPiece,
    value.subtotal, value.tax, value.grandTotal, value.deliveryDate, value.paymentTerms, value.notes,
    value.calculationVersion, value.resultHash, payloadJson, now, now,
  );
  const saved = db.prepare("SELECT * FROM quotations WHERE quotation_number = ?").get(value.quotationNumber) as DatabaseRow | undefined;
  if (!saved) throw new Error("quotation_save_failed");
  return mapRow(saved);
}

export async function listQuotations({ q = "", status = "all", limit = 100 }: { q?: string; status?: string; limit?: number } = {}): Promise<QuotationRecord[]> {
  const db = await getDatabase();
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Number(limit) : 100, 1), 500);
  const search = `%${q.trim()}%`;
  const statusFilter = quotationStatuses.find((item) => item === status);
  const rows = statusFilter
    ? db.prepare(`
        SELECT * FROM quotations
        WHERE status = ? AND (quotation_number LIKE ? OR customer_name LIKE ? OR customer_contact LIKE ? OR product_name LIKE ?)
        ORDER BY updated_at DESC, id DESC LIMIT ?
      `).all(statusFilter, search, search, search, search, safeLimit) as unknown as DatabaseRow[]
    : db.prepare(`
        SELECT * FROM quotations
        WHERE quotation_number LIKE ? OR customer_name LIKE ? OR customer_contact LIKE ? OR product_name LIKE ?
        ORDER BY updated_at DESC, id DESC LIMIT ?
      `).all(search, search, search, search, safeLimit) as unknown as DatabaseRow[];
  return rows.map(mapRow);
}

export async function getQuotation(id: number): Promise<QuotationRecord | null> {
  const db = await getDatabase();
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare("SELECT * FROM quotations WHERE id = ?").get(id) as DatabaseRow | undefined;
  return row ? mapRow(row) : null;
}

export async function getQuotationByNumber(quotationNumber: string): Promise<QuotationRecord | null> {
  const db = await getDatabase();
  const code = quotationNumber.trim();
  if (!code) return null;
  const row = db.prepare("SELECT * FROM quotations WHERE quotation_number = ?").get(code) as DatabaseRow | undefined;
  return row ? mapRow(row) : null;
}

export async function updateQuotationStatus(id: number, status: QuotationStatus): Promise<QuotationRecord | null> {
  const db = await getDatabase();
  if (!Number.isInteger(id) || id <= 0 || !quotationStatuses.includes(status)) return null;
  const result = db.prepare("UPDATE quotations SET status = ?, updated_at = ? WHERE id = ?").run(status, new Date().toISOString(), id);
  if (Number(result.changes) === 0) return null;
  return getQuotation(id);
}

export async function deleteQuotation(id: number): Promise<boolean> {
  const db = await getDatabase();
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = db.prepare("DELETE FROM quotations WHERE id = ?").run(id);
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
    snapshot: JSON.parse(row.snapshot_json) as CalculationChecklistSnapshot,
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
  const existing = db.prepare("SELECT COUNT(*) n FROM quotation_checklists WHERE quotation_id = ?").get(record.id) as { n: number };
  if (existing.n > 0) {
    const rows = db.prepare("SELECT * FROM quotation_checklists WHERE quotation_id = ? ORDER BY audience").all(record.id) as unknown as ChecklistRow[];
    return rows.map(mapChecklistRow);
  }

  const itemTemplates = buildChecklistItems(snapshot);
  const audiences: ChecklistAudienceValue[] = ["CUSTOMER", "INTERNAL_QA"];
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO quotation_checklists (
      quotation_id,audience,checklist_version,status,snapshot_json,items_json,checked_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
  `);
  for (const audience of audiences) {
    insert.run(
      record.id,
      audience,
      snapshot.checklistVersion,
      "in_progress",
      JSON.stringify(snapshot),
      JSON.stringify(itemTemplates),
      audience === "CUSTOMER" ? record.customerName || "고객" : "카네이무역 내부 QA",
      now,
      now,
    );
  }
  const rows = db.prepare("SELECT * FROM quotation_checklists WHERE quotation_id = ? ORDER BY audience").all(record.id) as unknown as ChecklistRow[];
  return rows.map(mapChecklistRow);
}

export async function getChecklistsForQuotation(quotationId: number): Promise<ChecklistRecord[]> {
  const db = await getDatabase();
  if (!Number.isInteger(quotationId) || quotationId <= 0) return [];
  const rows = db.prepare("SELECT * FROM quotation_checklists WHERE quotation_id = ? ORDER BY audience").all(quotationId) as unknown as ChecklistRow[];
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
  const row = db.prepare("SELECT * FROM quotation_checklists WHERE quotation_id = ? AND audience = ?").get(quotationId, audience) as ChecklistRow | undefined;
  if (!row) return null;
  const items = JSON.parse(row.items_json) as import("./calculation-checklist").ChecklistItem[];
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return null;
  item.accepted = accepted;
  item.checkedAt = accepted ? new Date().toISOString() : null;
  item.checkedBy = accepted ? checkedBy || null : null;
  const progress = calculateChecklistProgress(items);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE quotation_checklists
    SET items_json = ?, status = ?, checked_by = ?, updated_at = ?
    WHERE quotation_id = ? AND audience = ?
  `).run(
    JSON.stringify(items),
    progress.status,
    progress.status === "completed" ? checkedBy : "",
    now,
    quotationId,
    audience,
  );
  const updated = db.prepare("SELECT * FROM quotation_checklists WHERE quotation_id = ? AND audience = ?").get(quotationId, audience) as ChecklistRow | undefined;
  return updated ? mapChecklistRow(updated) : null;
}
