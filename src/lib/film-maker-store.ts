import { getDatabaseForFilmMakerStore } from "./film-orders";
import type { SqlClient } from "./db";
import { isUniqueViolation } from "./db";
import {
  classifyLegacySupplier,
  isInternalLegacySupplier,
  listLegacyOrderReconciliations,
  reconcileLegacySuppliers,
  type LegacyOrderReconciliation,
} from "./film-maker-reconciliation";

export type FilmMakerLanguage = "ja" | "ko";
export type FilmMakerPrintMethod = "gravure" | "digital";
export type FilmMakerProcurementRoute = "K" | "Y";
export type FilmMakerSupplierResolution =
  | "legacy_unresolved"
  | "master_selected"
  | "legacy_exempt";

export interface FilmMakerInput {
  makerCode: string;
  companyName: string;
  contactName?: string;
  email: string;
  language: FilmMakerLanguage;
  printMethod: FilmMakerPrintMethod;
  procurementRoute: FilmMakerProcurementRoute;
  isActive?: boolean;
  note?: string;
}

export interface FilmMakerRecord {
  id: number;
  makerCode: string;
  companyName: string;
  contactName: string;
  email: string;
  language: FilmMakerLanguage;
  printMethod: FilmMakerPrintMethod;
  procurementRoute: FilmMakerProcurementRoute;
  isActive: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
  createdByEmail: string;
  updatedByEmail: string;
}

/** 選択UIに連絡先を含めない。連絡先付き全件取得は Kanei admin API のみが呼ぶ。 */
export interface FilmMakerSelection {
  id: number;
  makerCode: string;
  companyName: string;
  language: FilmMakerLanguage;
}

export interface FilmMakerSnapshot extends FilmMakerRecord {
  selectedAt: string;
  selectedByEmail: string;
}

export interface FilmOrderMakerResolution {
  resolution: FilmMakerSupplierResolution;
  makerId: number | null;
  snapshot: FilmMakerSnapshot | null;
}

interface FilmMakerRow {
  id: number;
  maker_code: string;
  company_name: string;
  contact_name: string;
  email: string;
  language: FilmMakerLanguage;
  print_method: FilmMakerPrintMethod;
  procurement_route: FilmMakerProcurementRoute;
  is_active: number | boolean;
  note: string;
  created_at: string;
  updated_at: string;
  created_by_email: string;
  updated_by_email: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAKER_CODE_PATTERN = /^[A-Z0-9](?:[A-Z0-9_-]{1,38}[A-Z0-9])?$/u;

function requiredText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`invalid_film_maker_${label}`);
  if (normalized.length > maxLength) throw new Error(`invalid_film_maker_${label}`);
  return normalized;
}

function booleanParam(db: SqlClient, value: boolean): number | boolean {
  return db.dialect === "postgres" ? value : value ? 1 : 0;
}

function optionalText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length > maxLength) throw new Error(`invalid_film_maker_${label}`);
  return normalized;
}

export function isInternalFilmMakerCandidate(input: Pick<FilmMakerInput, "email" | "companyName">): boolean {
  return isInternalLegacySupplier(input);
}

export function validateFilmMakerInput(value: FilmMakerInput): Required<FilmMakerInput> {
  const makerCode = requiredText(value.makerCode, "maker_code", 40).toUpperCase();
  if (!MAKER_CODE_PATTERN.test(makerCode)) throw new Error("invalid_film_maker_maker_code");
  const companyName = requiredText(value.companyName, "company_name", 200);
  const contactName = optionalText(value.contactName, "contact_name", 200);
  const email = requiredText(value.email, "email", 254);
  if (!EMAIL_PATTERN.test(email) || email.includes("..")) throw new Error("invalid_film_maker_email");
  if (isInternalFilmMakerCandidate({ email, companyName })) throw new Error("internal_film_maker_rejected");
  if (value.language !== "ja" && value.language !== "ko") throw new Error("invalid_film_maker_language");
  if (value.printMethod !== "gravure" && value.printMethod !== "digital") throw new Error("invalid_film_maker_print_method");
  if (value.procurementRoute !== "K" && value.procurementRoute !== "Y") throw new Error("invalid_film_maker_procurement_route");
  return {
    makerCode,
    companyName,
    contactName,
    email,
    language: value.language,
    printMethod: value.printMethod,
    procurementRoute: value.procurementRoute,
    isActive: value.isActive !== false,
    note: optionalText(value.note, "note", 2000),
  };
}

function mapFilmMaker(row: FilmMakerRow): FilmMakerRecord {
  return {
    id: Number(row.id),
    makerCode: row.maker_code,
    companyName: row.company_name,
    contactName: row.contact_name,
    email: row.email,
    language: row.language,
    printMethod: row.print_method,
    procurementRoute: row.procurement_route,
    isActive: Boolean(row.is_active),
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByEmail: row.created_by_email,
    updatedByEmail: row.updated_by_email,
  };
}

export async function createFilmMaker(input: FilmMakerInput, actorEmail: string): Promise<FilmMakerRecord> {
  const valid = validateFilmMakerInput(input);
  const db = await getDatabaseForFilmMakerStore();
  const now = new Date().toISOString();
  try {
    await db.run(`
      INSERT INTO film_makers (
        maker_code, company_name, contact_name, email, language, print_method,
        procurement_route, is_active, note, created_at, updated_at,
        created_by_email, updated_by_email
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      valid.makerCode,
      valid.companyName,
      valid.contactName,
      valid.email,
      valid.language,
      valid.printMethod,
      valid.procurementRoute,
      booleanParam(db, valid.isActive),
      valid.note,
      now,
      now,
      actorEmail,
      actorEmail,
    ]);
    const created = await getFilmMakerByCode(valid.makerCode, db);
    if (!created) throw new Error("film_maker_create_failed");
    return created;
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("duplicate_film_maker_code");
    throw error;
  }
}

export async function updateFilmMaker(
  id: number,
  input: FilmMakerInput,
  actorEmail: string,
): Promise<FilmMakerRecord | null> {
  const valid = validateFilmMakerInput(input);
  const db = await getDatabaseForFilmMakerStore();
  const now = new Date().toISOString();
  try {
    const result = await db.run(`
      UPDATE film_makers SET
        maker_code=?, company_name=?, contact_name=?, email=?, language=?, print_method=?,
        procurement_route=?, is_active=?, note=?, updated_at=?, updated_by_email=?
      WHERE id=?
    `, [
      valid.makerCode,
      valid.companyName,
      valid.contactName,
      valid.email,
      valid.language,
      valid.printMethod,
      valid.procurementRoute,
      booleanParam(db, valid.isActive),
      valid.note,
      now,
      actorEmail,
      id,
    ]);
    if (result.changes === 0) return null;
    return await getFilmMaker(id, db);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("duplicate_film_maker_code");
    throw error;
  }
}

export async function deactivateFilmMaker(id: number, actorEmail: string): Promise<FilmMakerRecord | null> {
  const db = await getDatabaseForFilmMakerStore();
  const result = await db.run(
    "UPDATE film_makers SET is_active=FALSE, updated_at=?, updated_by_email=? WHERE id=?",
    [new Date().toISOString(), actorEmail, id],
  );
  return result.changes ? await getFilmMaker(id, db) : null;
}

export async function getFilmMaker(id: number, client?: SqlClient): Promise<FilmMakerRecord | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const db = client ?? await getDatabaseForFilmMakerStore();
  const row = await db.get<FilmMakerRow>("SELECT * FROM film_makers WHERE id=?", [id]);
  return row ? mapFilmMaker(row) : null;
}

async function getFilmMakerByCode(makerCode: string, client?: SqlClient): Promise<FilmMakerRecord | null> {
  const db = client ?? await getDatabaseForFilmMakerStore();
  const row = await db.get<FilmMakerRow>("SELECT * FROM film_makers WHERE maker_code=?", [makerCode]);
  return row ? mapFilmMaker(row) : null;
}

export async function listFilmMakers(includeInactive = true): Promise<FilmMakerRecord[]> {
  const db = await getDatabaseForFilmMakerStore();
  const rows = await db.all<FilmMakerRow>(
    includeInactive
      ? "SELECT * FROM film_makers ORDER BY company_name, maker_code"
      : "SELECT * FROM film_makers WHERE is_active=TRUE ORDER BY company_name, maker_code",
  );
  return rows.map(mapFilmMaker);
}

export async function listActiveFilmMakerSelections(
  procurementRoute: string,
  printMethod: string,
): Promise<FilmMakerSelection[]> {
  const normalizedRoute = String(procurementRoute).toUpperCase();
  const normalizedPrintMethod = String(printMethod).toLowerCase();
  if (normalizedRoute !== "K" && normalizedRoute !== "Y") throw new Error("invalid_film_maker_procurement_route");
  if (normalizedPrintMethod !== "gravure" && normalizedPrintMethod !== "digital") throw new Error("invalid_film_maker_print_method");
  const db = await getDatabaseForFilmMakerStore();
  const rows = await db.all<FilmMakerRow>(
    "SELECT * FROM film_makers WHERE procurement_route=? AND print_method=? AND is_active=TRUE ORDER BY company_name, maker_code",
    [normalizedRoute, normalizedPrintMethod],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    makerCode: row.maker_code,
    companyName: row.company_name,
    language: row.language,
  }));
}

export function filmMakerSnapshotOf(record: FilmMakerRecord, selectedAt: string, selectedByEmail: string): FilmMakerSnapshot {
  const snapshot: FilmMakerSnapshot = {
    ...record,
    selectedAt,
    selectedByEmail,
  };
  return Object.freeze(snapshot);
}

function parseSnapshot(value: string | null): FilmMakerSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as FilmMakerSnapshot;
    if (typeof parsed?.id !== "number" || typeof parsed?.email !== "string") return null;
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}

export async function selectFilmMakerForOrder(
  orderId: number,
  makerId: number,
  actorEmail: string,
): Promise<{ resolution: FilmMakerSupplierResolution; snapshot: FilmMakerSnapshot }> {
  if (!Number.isInteger(orderId) || orderId <= 0) throw new Error("invalid_film_order_id");
  if (!Number.isInteger(makerId) || makerId <= 0) throw new Error("invalid_film_maker_id");
  const db = await getDatabaseForFilmMakerStore();
  const optimisticOrder = await db.get<{
    film_maker_id: number | null;
    supplier_resolution: FilmMakerSupplierResolution;
    updated_at: string;
  }>(
    "SELECT film_maker_id,supplier_resolution,updated_at FROM film_orders WHERE id=?",
    [orderId],
  );
  if (!optimisticOrder) throw new Error("film_order_not_found");
  return db.transaction(async (tx) => {
    const makerRow = await tx.get<FilmMakerRow>(
      `SELECT * FROM film_makers WHERE id=?${tx.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      [makerId],
    );
    if (!makerRow || !Number(makerRow.is_active)) throw new Error("film_maker_not_found");
    const maker = mapFilmMaker(makerRow);
    const order = await tx.get<{
      id: number;
      procurement_route: string;
      printing_method: string;
      film_maker_id: number | null;
      supplier_resolution: FilmMakerSupplierResolution;
      updated_at: string;
    }>(
      `SELECT id,procurement_route,printing_method,film_maker_id,supplier_resolution,updated_at
       FROM film_orders WHERE id=?${tx.dialect === "postgres" ? " FOR UPDATE" : ""}`,
      [orderId],
    );
    if (!order) throw new Error("film_order_not_found");
    if (order.procurement_route !== maker.procurementRoute) throw new Error("film_maker_route_mismatch");
    if (order.printing_method !== maker.printMethod) throw new Error("film_maker_print_method_mismatch");
    const now = new Date().toISOString();
    const snapshot = filmMakerSnapshotOf(maker, now, actorEmail);
    const affected = await tx.run(`
      UPDATE film_orders SET
        film_maker_id=?, film_maker_snapshot_json=?, supplier_resolution='master_selected',
        updated_at=?, updated_by_email=?
      WHERE id=? AND film_maker_id IS NOT DISTINCT FROM ? AND supplier_resolution=? AND updated_at=?
    `, [maker.id, JSON.stringify(snapshot), now, actorEmail, orderId, optimisticOrder.film_maker_id, optimisticOrder.supplier_resolution, optimisticOrder.updated_at]);
    if (Number(affected.changes) !== 1) throw new Error("film_maker_selection_conflict");
    await tx.run(
      "INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)",
      [orderId, "film_maker", `フィルムメーカー選択: ${maker.makerCode}`, actorEmail, now],
    );
    return { resolution: "master_selected" as const, snapshot };
  });
}

export async function filmOrderMakerResolution(orderId: number): Promise<FilmOrderMakerResolution> {
  const db = await getDatabaseForFilmMakerStore();
  const row = await db.get<{
    film_maker_id: number | null;
    film_maker_snapshot_json: string | null;
    supplier_resolution: FilmMakerSupplierResolution;
  }>(
    "SELECT film_maker_id, film_maker_snapshot_json, supplier_resolution FROM film_orders WHERE id=?",
    [orderId],
  );
  if (!row) throw new Error("film_order_not_found");
  return {
    resolution: row.supplier_resolution,
    makerId: row.film_maker_id == null ? null : Number(row.film_maker_id),
    snapshot: parseSnapshot(row.film_maker_snapshot_json),
  };
}

export async function listLegacyReconciliations(): Promise<LegacyOrderReconciliation[]> {
  const db = await getDatabaseForFilmMakerStore();
  return listLegacyOrderReconciliations(db);
}

export async function backfillLegacySupplierSuggestions(
  orderIds?: readonly number[],
): Promise<{ scanned: number; suggested: number }> {
  const db = await getDatabaseForFilmMakerStore();
  return reconcileLegacySuppliers(db, orderIds);
}

export async function exemptLegacyOrder(
  orderId: number,
  reason: string,
  expectedClassification: LegacyOrderReconciliation["classification"],
  actorEmail: string,
): Promise<{ resolution: FilmMakerSupplierResolution }> {
  if (!Number.isInteger(orderId) || orderId <= 0) throw new Error("invalid_film_order_id");
  const normalizedReason = reason.trim();
  if (!normalizedReason || normalizedReason.length > 1000) throw new Error("legacy_exempt_reason_required");
  if (actorEmail.trim() === "") throw new Error("film_maker_admin_required");

  const db = await getDatabaseForFilmMakerStore();
  return db.transaction(async (tx) => {
    const order = await tx.get<{
      id: number;
      supplier_name: string;
      supplier_email: string;
      procurement_route: string;
      printing_method: string;
      supplier_resolution: FilmMakerSupplierResolution;
    }>(
      "SELECT id,supplier_name,supplier_email,procurement_route,printing_method,supplier_resolution FROM film_orders WHERE id=?",
      [orderId],
    );
    if (!order) throw new Error("film_order_not_found");
    if (order.supplier_resolution !== "legacy_unresolved") throw new Error("film_order_resolution_conflict");
    const makers = await tx.all<{
      id: number;
      maker_code: string;
      company_name: string;
      email: string;
      language: FilmMakerLanguage;
      print_method: FilmMakerPrintMethod;
      procurement_route: FilmMakerProcurementRoute;
    }>(
      "SELECT id,maker_code,company_name,email,language,print_method,procurement_route FROM film_makers WHERE is_active=TRUE",
    );
    const classification = classifyLegacySupplier(order, makers).classification;
    if (classification !== expectedClassification) throw new Error("legacy_classification_conflict");

    const now = new Date().toISOString();
    // supplier_name/supplier_email are historical evidence and are deliberately not changed.
    await tx.run(`
      UPDATE film_orders
      SET supplier_resolution='legacy_exempt', updated_at=?, updated_by_email=?
      WHERE id=? AND supplier_resolution='legacy_unresolved'
    `, [now, actorEmail, orderId]);
    await tx.run(
      "INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)",
      [orderId, "legacy_supplier_reconciliation", `レガシー除外（${classification}）: ${normalizedReason}`, actorEmail, now],
    );
    return { resolution: "legacy_exempt" as const };
  });
}
