import { createHash, randomUUID } from "node:crypto";
import { getSqlClient, type SqlClient } from "./db";
import { GRAVURE_MASTER_CALCULATION_VERSION } from "./constants";
import { canonicalize } from "./canonical-json";
import { D, Decimal } from "./decimal";
import { defaultGravureRollParameters, GRAVURE_ROLL_DEFAULTS_KRW, type GravureRollParameters } from "./gravure-roll";
import { defaultGravureYSupplierRows } from "./sasche-gravure";
import { calculatePouchCost, type CalculationInput, type CostResult } from "./calculation";
import type { CostParameters } from "./types";

export const GRAVURE_RESOLVER_VERSION = "gravure-pricing-master-v1";
export const GRAVURE_SNAPSHOT_CALCULATION_VERSION = GRAVURE_MASTER_CALCULATION_VERSION;
export const OPEN_EFFECTIVE_TO = "9999-12-31";
export const GRAVURE_SCHEMA_VERSION = 1;
export const GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR = "gravure_snapshot_issuance_disabled";

export type GravureMasterActor = string;

export interface GravureYMasterRow {
  id: number;
  webWidthMm: number;
  laneCount: number;
  printTierM: number;
  approxOutputLengthM: string;
  supplierUnitPriceYenPerM: string;
  plateBaseYenPerColor: string;
  sellerMarkup: string;
  memo: string;
  effectiveFrom: string;
  effectiveTo: string;
  updatedBy: string;
  updatedAt: string;
  supersededById: number | null;
  supersededAt: string | null;
}

export interface GravureYMasterInput {
  webWidthMm: number;
  laneCount: number;
  printTierM: number;
  approxOutputLengthM: string;
  supplierUnitPriceYenPerM: string;
  plateBaseYenPerColor: string;
  sellerMarkup: string;
  memo?: string;
  effectiveFrom: string;
  effectiveTo?: string;
}

export const GRAVURE_K_SOURCE_FIELDS = [
  "petPriceKrwPerKg",
  "alPriceKrwPerKg",
  "lldpePriceKrwPerKg",
  "printingPriceKrwPerM",
  "laminationPriceKrwPerMWithAl",
  "laminationPriceKrwPerMWithoutAl",
  "newCopperPlatePriceKrw",
  "copperPlateWidthExtraMm",
  "copperPlateMinimumDiameterMm",
  "krwPer100Yen",
  "deliverablePatternLengthM",
  "productionPatternLengthM",
  "overseasShippingUnitM",
  "overseasShippingPerTripYen",
  "manufacturerMarginRate",
  "customsRate",
  "smallWidthThresholdMm",
  "smallWidthOrderPatternLengthM",
  "smallWidthProductionPatternLengthM",
  "smallWidthManufacturerUnitPriceKrwPerM",
] as const;

export type GravureKSourceField = typeof GRAVURE_K_SOURCE_FIELDS[number];
export type GravureKSource = Record<GravureKSourceField, string>;

const K_SOURCE_COLUMNS: Array<[GravureKSourceField, string]> = GRAVURE_K_SOURCE_FIELDS.map((field) => [field, field]);

export interface GravureKMasterRow {
  id: number;
  source: GravureKSource;
  derived: GravureRollParameters;
  memo: string;
  effectiveFrom: string;
  effectiveTo: string;
  updatedBy: string;
  updatedAt: string;
  supersededById: number | null;
  supersededAt: string | null;
}

export type GravureKMasterInput = Pick<GravureKMasterRow, "source" | "effectiveFrom"> & {
  memo?: string;
  effectiveTo?: string;
};

export function validateGravureKMasterInput(value: unknown): GravureKMasterInput {
  if (!value || typeof value !== "object") throw new GravureValidationError("invalid_gravure_k_parameters");
  const input = value as Record<string, unknown>;
  const range = dateRange(input.effectiveFrom as string, input.effectiveTo as string | undefined);
  return {
    source: normalizeKSource(input.source),
    memo: typeof input.memo === "string" ? input.memo.slice(0, 1000) : "",
    ...range,
  };
}

export interface GravureResolvedMasters {
  asOf: string;
  yRows: GravureYMasterRow[];
  kSet: GravureKMasterRow | null;
  fallbackVersions: {
    y: "supplier-matrix-2026-10";
    k: "gravure-roll-defaults-2026-10";
  };
}

export interface GravureSnapshot {
  id: string;
  resolverVersion: string;
  asOf: string;
  digitalValues: CostParameters["filmUnitPrices"];
  yRows: GravureYMasterRow[];
  kSource: GravureKSource;
  kDerived: GravureRollParameters;
  fallbackVersions: GravureResolvedMasters["fallbackVersions"];
  fullAugmentedCalculationRequest: CalculationInput;
  fullCalculationResult: CostResult;
  calculationResultSha256: string;
  canonicalPublicProjection: CanonicalPublicProjection;
  publicProjectionSha256: string;
  createdBy: string;
  createdAt: string;
  snapshotSha256: string;
}

export type SnapshotPublicMetadata = {
  id: string;
  sha256: string;
  resolverVersion: string;
  asOf: string;
  view: "redacted";
};

export type CanonicalPublicProjection = {
  pricingSnapshot: SnapshotPublicMetadata;
  calculationVersion: string;
  printingMethod: string;
  quantity: string;
  connectedChambers: number;
  fillingMethod: string;
  size: { widthMm: string; lengthMm: string };
  selectedCandidateId: string;
  resultHash: string;
  candidates: Array<{
    id: string;
    route: string;
    printingMethod: string;
    detailLabel?: string;
    materialText?: string;
    colorText?: string;
    compositionText?: string;
    pouchSpecText?: string;
    patternText?: string;
    adjustedQuantity: string;
    capacityQuantity: string;
    adjustedSkuQuantities: string[];
    requiredLengthM: string;
    orderLengthM: string;
    effectiveLengthM: string;
    filmTotalYen: string;
    filmCostPerPieceYen: string;
    allInCostPerPieceYen?: string;
  }>;
};

export type ReturnedPublicProjection = CanonicalPublicProjection & { publicProjectionHash: string };

export interface GravureMasterAuditEntry {
  id: number;
  tableName: "gravure_y_supplier_prices" | "gravure_k_parameter_sets";
  rowId: number;
  action: string;
  actor: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export type GravureSnapshotAuditRecord = Pick<
  GravureSnapshot,
  | "id"
  | "resolverVersion"
  | "asOf"
  | "digitalValues"
  | "yRows"
  | "kSource"
  | "kDerived"
  | "fallbackVersions"
  | "calculationResultSha256"
  | "canonicalPublicProjection"
  | "publicProjectionSha256"
  | "createdBy"
  | "createdAt"
  | "snapshotSha256"
>;

function kColumnDefinitions(): string {
  return K_SOURCE_COLUMNS.map(([field]) => `    ${field} TEXT NOT NULL`).join(",\n");
}

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gravure_y_supplier_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    web_width_mm INTEGER NOT NULL,
    lane_count INTEGER NOT NULL,
    print_tier_m INTEGER NOT NULL,
    approx_output_length_m TEXT NOT NULL,
    supplier_unit_price_yen_per_m TEXT NOT NULL,
    plate_base_yen_per_color TEXT NOT NULL,
    seller_markup TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    effective_from TEXT NOT NULL,
    effective_to TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_by_id INTEGER,
    superseded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gravure_y_lookup ON gravure_y_supplier_prices(web_width_mm, lane_count, print_tier_m, effective_from, effective_to);
  CREATE TABLE IF NOT EXISTS gravure_k_parameter_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_json TEXT NOT NULL,
    ${kColumnDefinitions()},
    derived_json TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    effective_from TEXT NOT NULL,
    effective_to TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_by_id INTEGER,
    superseded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gravure_k_lookup ON gravure_k_parameter_sets(effective_from, effective_to);
  CREATE TABLE IF NOT EXISTS gravure_master_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calculation_master_snapshots (
    id TEXT PRIMARY KEY,
    resolver_version TEXT NOT NULL,
    as_of TEXT NOT NULL,
    digital_values_json TEXT NOT NULL,
    y_rows_json TEXT NOT NULL,
    k_source_json TEXT NOT NULL,
    k_derived_json TEXT NOT NULL,
    fallback_versions_json TEXT NOT NULL,
    full_request_json TEXT NOT NULL,
    full_result_json TEXT NOT NULL,
    calculation_result_sha256 TEXT NOT NULL,
    public_projection_json TEXT NOT NULL,
    public_projection_sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gravure_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gravure_y_supplier_prices (
    id SERIAL PRIMARY KEY,
    web_width_mm INTEGER NOT NULL,
    lane_count INTEGER NOT NULL,
    print_tier_m INTEGER NOT NULL,
    approx_output_length_m TEXT NOT NULL,
    supplier_unit_price_yen_per_m TEXT NOT NULL,
    plate_base_yen_per_color TEXT NOT NULL,
    seller_markup TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    effective_from TEXT NOT NULL,
    effective_to TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_by_id INTEGER,
    superseded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gravure_y_lookup ON gravure_y_supplier_prices(web_width_mm, lane_count, print_tier_m, effective_from, effective_to);
  CREATE TABLE IF NOT EXISTS gravure_k_parameter_sets (
    id SERIAL PRIMARY KEY,
    source_json TEXT NOT NULL,
    ${kColumnDefinitions()},
    derived_json TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    effective_from TEXT NOT NULL,
    effective_to TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    superseded_by_id INTEGER,
    superseded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gravure_k_lookup ON gravure_k_parameter_sets(effective_from, effective_to);
  CREATE TABLE IF NOT EXISTS gravure_master_audit (
    id SERIAL PRIMARY KEY,
    table_name TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS calculation_master_snapshots (
    id TEXT PRIMARY KEY,
    resolver_version TEXT NOT NULL,
    as_of TEXT NOT NULL,
    digital_values_json TEXT NOT NULL,
    y_rows_json TEXT NOT NULL,
    k_source_json TEXT NOT NULL,
    k_derived_json TEXT NOT NULL,
    fallback_versions_json TEXT NOT NULL,
    full_request_json TEXT NOT NULL,
    full_result_json TEXT NOT NULL,
    calculation_result_sha256 TEXT NOT NULL,
    public_projection_json TEXT NOT NULL,
    public_projection_sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gravure_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

const ALLOWED_Y_DIMENSIONS = new Set([
  "356:1:2000", "356:1:4000", "356:2:2000", "356:2:4000",
  "476:1:2000", "476:1:4000", "476:2:2000", "476:2:4000",
  "556:1:2000", "556:1:4000", "620:1:2000", "620:1:4000",
]);

let schemaReady: Promise<SqlClient> | null = null;

function durablePostgresUrl(): string | null {
  const value = (process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "").trim();
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:" ? value : null;
  } catch {
    return null;
  }
}

export function assertDurableGravureDatabase(): void {
  const isProductionRuntime = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  if (isProductionRuntime && !durablePostgresUrl()) {
    throw new GravureDurableDatabaseRequiredError();
  }
}

export class GravureInfrastructureError extends Error {}

export class GravureDurableDatabaseRequiredError extends GravureInfrastructureError {
  constructor() {
    super("durable_database_required");
  }
}

async function getDatabase(): Promise<SqlClient> {
  assertDurableGravureDatabase();
  schemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
    await applyGravureMigrations(db);
    return db;
  })().catch((error) => {
    // A transient first-request failure must not poison this process forever.
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function normalizeGravureStoreError(error: unknown): unknown {
  if (error instanceof GravureValidationError || error instanceof GravureInfrastructureError) return error;
  // Transport messages can include SQL and bound values. Keep only a stable
  // internal category plus a correlation digest; never log the raw message.
  const rawMessage = error instanceof Error ? error.message : String(error);
  const diagnosticRef = createHash("sha256")
    .update(`${error instanceof Error ? error.name : typeof error}:${rawMessage}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  console.error("[gravure_price_store] infrastructure_failure", JSON.stringify({
    category: "gravure_master_unavailable",
    diagnosticRef,
    errorName: error instanceof Error ? error.name : typeof error,
  }));
  return new GravureInfrastructureError("gravure_master_unavailable");
}

async function withGravureDatabase<T>(operation: (db: SqlClient) => Promise<T>): Promise<T> {
  try {
    return await operation(await getDatabase());
  } catch (error) {
    throw normalizeGravureStoreError(error);
  }
}

async function applyGravureMigrations(db: SqlClient): Promise<void> {
  const existing = await db.get<{ version: number }>("SELECT version FROM gravure_schema_migrations WHERE version = ?", [GRAVURE_SCHEMA_VERSION]);
  if (existing) return;
  for (const [field] of K_SOURCE_COLUMNS) {
    try {
      await db.run(`ALTER TABLE gravure_k_parameter_sets ADD COLUMN ${field} TEXT`, []);
    } catch (error) {
      if (!/duplicate column|already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  const legacyRows = await db.all<{ id: number; source_json: string }>("SELECT id, source_json FROM gravure_k_parameter_sets");
  for (const legacyRow of legacyRows) {
    let source: unknown;
    try {
      source = JSON.parse(legacyRow.source_json);
    } catch {
      throw new GravureInfrastructureError("gravure_k_migration_source_invalid");
    }
    const normalized = normalizeKSource(source);
    const fields = K_SOURCE_COLUMNS.map(([field]) => `${field} = ?`).join(", ");
    await db.run(
      `UPDATE gravure_k_parameter_sets SET ${fields} WHERE id = ?`,
      [...K_SOURCE_COLUMNS.map(([field]) => normalized[field]), legacyRow.id],
    );
  }
  await db.run(
    `INSERT INTO gravure_schema_migrations (version,applied_at) VALUES (?,?)
     ON CONFLICT(version) DO NOTHING`,
    [GRAVURE_SCHEMA_VERSION, new Date().toISOString()],
  );
}

export async function getGravureMigrationVersion(): Promise<number | null> {
  return withGravureDatabase(async (db) => {
    const row = await db.get<{ version: number }>("SELECT MAX(version) AS version FROM gravure_schema_migrations");
    return row?.version == null ? null : Number(row.version);
  });
}

export function isGravureSnapshotIssuanceEnabled(): boolean {
  const value = (process.env.GRAVURE_SNAPSHOT_ISSUANCE_ENABLED ?? "true").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(value);
}

export function tokyoDate(date = new Date()): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

function decimal(value: unknown, field: string, options: { positive?: boolean; minimum?: string; scale?: number } = {}): string {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw new GravureValidationError(`invalid_${field}`);
  const normalized = D(value);
  if (options.positive && !normalized.gt(0)) throw new GravureValidationError(`invalid_${field}`);
  if (options.minimum && normalized.lt(D(options.minimum))) throw new GravureValidationError(`invalid_${field}`);
  const scale = (value.split(".")[1] ?? "").length;
  if (options.scale != null && scale > options.scale) throw new GravureValidationError(`invalid_${field}`);
  return normalized.toString();
}

function dateOnly(value: unknown, field = "effective_date"): string {
  const matches = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  const parsed = matches ? new Date(`${value}T00:00:00Z`) : null;
  if (!matches || !parsed
    || parsed.getUTCFullYear() !== Number(matches[1])
    || parsed.getUTCMonth() + 1 !== Number(matches[2])
    || parsed.getUTCDate() !== Number(matches[3])) {
    throw new GravureValidationError(`invalid_${field}`);
  }
  return value as string;
}

function dateRange(from: string, to?: string): { effectiveFrom: string; effectiveTo: string } {
  const effectiveFrom = dateOnly(from);
  const effectiveTo = to && to !== "" ? dateOnly(to) : OPEN_EFFECTIVE_TO;
  if (effectiveTo < effectiveFrom) throw new GravureValidationError("invalid_effective_range");
  return { effectiveFrom, effectiveTo };
}

function previousDayUtc(from: string): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

const Y_INTEGER_FIELDS = [
  ["webWidthMm", "web_width_mm"],
  ["laneCount", "lane_count"],
  ["printTierM", "print_tier_m"],
] as const;

export function validateGravureYMasterInput(value: unknown): GravureYMasterInput {
  if (!value || typeof value !== "object") throw new GravureValidationError("invalid_gravure_y_price");
  const input = value as Record<string, unknown>;
  const dimensions = Y_INTEGER_FIELDS.map(([field, name]) => {
    const parsed = input[field];
    if (!Number.isInteger(parsed) || (parsed as number) <= 0) throw new GravureValidationError(`invalid_${name}`);
    return parsed as number;
  });
  if (!ALLOWED_Y_DIMENSIONS.has(dimensions.join(":"))) throw new GravureValidationError("unsupported_y_dimension");
  const range = dateRange(input.effectiveFrom as string, input.effectiveTo as string | undefined);
  return {
    webWidthMm: dimensions[0],
    laneCount: dimensions[1],
    printTierM: dimensions[2],
    approxOutputLengthM: decimal(input.approxOutputLengthM, "approx_output_length_m", { positive: true, scale: 3 }),
    supplierUnitPriceYenPerM: decimal(input.supplierUnitPriceYenPerM, "supplier_unit_price_yen_per_m", { positive: true, scale: 3 }),
    plateBaseYenPerColor: decimal(input.plateBaseYenPerColor, "plate_base_yen_per_color", { scale: 2 }),
    sellerMarkup: decimal(input.sellerMarkup, "seller_markup", { minimum: "1", scale: 6 }),
    memo: typeof input.memo === "string" ? input.memo.slice(0, 1000) : "",
    ...range,
  };
}

interface YDbRow {
  id: number; web_width_mm: number; lane_count: number; print_tier_m: number;
  approx_output_length_m: string; supplier_unit_price_yen_per_m: string;
  plate_base_yen_per_color: string; seller_markup: string; memo: string;
  effective_from: string; effective_to: string; updated_by: string; updated_at: string;
  superseded_by_id: number | null; superseded_at: string | null;
}

function mapYRow(row: YDbRow): GravureYMasterRow {
  return {
    id: Number(row.id), webWidthMm: row.web_width_mm, laneCount: row.lane_count, printTierM: row.print_tier_m,
    approxOutputLengthM: row.approx_output_length_m, supplierUnitPriceYenPerM: row.supplier_unit_price_yen_per_m,
    plateBaseYenPerColor: row.plate_base_yen_per_color, sellerMarkup: row.seller_markup, memo: row.memo,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to, updatedBy: row.updated_by, updatedAt: row.updated_at,
    supersededById: row.superseded_by_id == null ? null : Number(row.superseded_by_id),
    supersededAt: row.superseded_at,
  };
}

export function fallbackGravureYMasterRows(asOf: string): GravureYMasterRow[] {
  const now = new Date(0).toISOString();
  return defaultGravureYSupplierRows().map((row, index) => ({
    ...row,
    id: -(index + 1),
    effectiveFrom: asOf,
    effectiveTo: asOf,
    memo: "code fallback",
    updatedBy: "system",
    updatedAt: now,
    supersededById: null,
    supersededAt: null,
  }));
}

export async function listGravureYMasterRows(): Promise<GravureYMasterRow[]> {
  return withGravureDatabase(async (db) => {
    const rows = await db.all<YDbRow>("SELECT * FROM gravure_y_supplier_prices ORDER BY effective_from DESC, id DESC");
    return rows.map(mapYRow);
  });
}

async function insertGravureYMasterRow(tx: SqlClient, input: GravureYMasterInput, actor: GravureMasterActor): Promise<GravureYMasterRow> {
  if (tx.dialect === "postgres") {
    await tx.run("SELECT pg_advisory_xact_lock(hashtext(?))", [`gravure-y:${input.webWidthMm}:${input.laneCount}:${input.printTierM}`]);
  }
  const overlapping = await tx.get<YDbRow>(
    `SELECT * FROM gravure_y_supplier_prices
     WHERE web_width_mm = ? AND lane_count = ? AND print_tier_m = ?
       AND effective_from <= ? AND effective_to >= ? LIMIT 1`,
    [input.webWidthMm, input.laneCount, input.printTierM, input.effectiveTo, input.effectiveFrom],
  );
  if (overlapping) throw new GravureOverlapError("gravure_y_overlap");
  await tx.run(
    `INSERT INTO gravure_y_supplier_prices
     (web_width_mm,lane_count,print_tier_m,approx_output_length_m,supplier_unit_price_yen_per_m,
      plate_base_yen_per_color,seller_markup,memo,effective_from,effective_to,updated_by,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [input.webWidthMm, input.laneCount, input.printTierM, input.approxOutputLengthM, input.supplierUnitPriceYenPerM,
      input.plateBaseYenPerColor, input.sellerMarkup, input.memo ?? "", input.effectiveFrom, input.effectiveTo, actor, new Date().toISOString()],
  );
  const inserted = await tx.get<YDbRow>("SELECT * FROM gravure_y_supplier_prices ORDER BY id DESC LIMIT 1");
  if (!inserted) throw new GravureValidationError("gravure_y_insert_failed");
  const row = mapYRow(inserted);
  await appendAudit(tx, "gravure_y_supplier_prices", row.id, "create", actor, null, row);
  return row;
}

export async function createGravureYMasterRow(input: GravureYMasterInput, actor: GravureMasterActor): Promise<GravureYMasterRow> {
  return withGravureDatabase((db) => db.transaction((tx) => insertGravureYMasterRow(tx, input, actor)));
}

export async function supersedeGravureYMasterRow(
  id: number,
  input: GravureYMasterInput,
  actor: GravureMasterActor,
): Promise<GravureYMasterRow> {
  return withGravureDatabase((db) => db.transaction(async (tx) => {
    const old = await tx.get<YDbRow>("SELECT * FROM gravure_y_supplier_prices WHERE id = ?", [id]);
    if (!old) throw new GravureValidationError("gravure_y_not_found");
    if (old.superseded_by_id != null) throw new GravureValidationError("already_superseded");
    if (input.effectiveFrom <= old.effective_from) throw new GravureValidationError("supersede_date_not_later");
    const previousTo = previousDayUtc(input.effectiveFrom);
    const closed = await tx.run(
      `UPDATE gravure_y_supplier_prices SET effective_to = ?, superseded_at = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND superseded_by_id IS NULL`,
      [previousTo, new Date().toISOString(), actor, new Date().toISOString(), id],
    );
    if (closed.changes !== 1) throw new GravureValidationError("already_superseded");
    const replacement = await insertGravureYMasterRow(tx, input, actor);
    const superseded = await tx.run(
      "UPDATE gravure_y_supplier_prices SET superseded_by_id = ? WHERE id = ? AND superseded_by_id IS NULL",
      [replacement.id, id],
    );
    if (superseded.changes !== 1) throw new GravureValidationError("already_superseded");
    await appendAudit(tx, "gravure_y_supplier_prices", id, "supersede", actor, mapYRow(old), replacement);
    return replacement;
  }));
}

function normalizeKSource(value: unknown): GravureKSource {
  if (!value || typeof value !== "object") throw new GravureValidationError("invalid_gravure_k_parameters");
  const input = value as Record<string, unknown>;
  const unknownFields = Object.keys(input).filter((field) => !GRAVURE_K_SOURCE_FIELDS.includes(field as GravureKSourceField));
  if (unknownFields.length > 0) throw new GravureValidationError("unknown_k_source_field");
  const result = {} as GravureKSource;
  const positiveFields = new Set(GRAVURE_K_SOURCE_FIELDS.filter((field) => !["manufacturerMarginRate", "customsRate"].includes(field)));
  for (const field of GRAVURE_K_SOURCE_FIELDS) {
    result[field] = decimal(input[field], field, {
      positive: positiveFields.has(field),
      minimum: field === "manufacturerMarginRate" || field === "customsRate" ? "0" : undefined,
      scale: 6,
    });
  }
  if (D(result.krwPer100Yen).lte(0)) throw new GravureValidationError("invalid_krwPer100Yen");
  return result;
}

export function deriveGravureKParameters(source: GravureKSource): GravureRollParameters {
  const convert = (value: string) => D(value).times(100).div(source.krwPer100Yen).toString();
  return {
    petUnitPriceYenPerKg: convert(source.petPriceKrwPerKg),
    alUnitPriceYenPerKg: convert(source.alPriceKrwPerKg),
    lldpeUnitPriceYenPerKg: convert(source.lldpePriceKrwPerKg),
    printingUnitPriceYenPerM: convert(source.printingPriceKrwPerM),
    laminationUnitPriceYenPerMWithAl: convert(source.laminationPriceKrwPerMWithAl),
    laminationUnitPriceYenPerMWithoutAl: convert(source.laminationPriceKrwPerMWithoutAl),
    newCopperPlateUnitPriceYen: convert(source.newCopperPlatePriceKrw),
    copperPlateWidthExtraMm: source.copperPlateWidthExtraMm,
    copperPlateMinimumDiameterMm: source.copperPlateMinimumDiameterMm,
    deliverablePatternLengthM: source.deliverablePatternLengthM,
    productionPatternLengthM: source.productionPatternLengthM,
    overseasShippingUnitM: source.overseasShippingUnitM,
    overseasShippingPerTripYen: source.overseasShippingPerTripYen,
    manufacturerMarginRate: source.manufacturerMarginRate,
    customsRate: source.customsRate,
    smallWidthThresholdMm: source.smallWidthThresholdMm,
    smallWidthOrderPatternLengthM: source.smallWidthOrderPatternLengthM,
    smallWidthProductionPatternLengthM: source.smallWidthProductionPatternLengthM,
    smallWidthManufacturerUnitPriceKRWPerM: source.smallWidthManufacturerUnitPriceKrwPerM,
    krwPer100Yen: source.krwPer100Yen,
  };
}

export function defaultGravureKSource(): GravureKSource {
  return {
    petPriceKrwPerKg: GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg.PET,
    alPriceKrwPerKg: GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg.AL,
    lldpePriceKrwPerKg: GRAVURE_ROLL_DEFAULTS_KRW.materialUnitPricesPerKg.LLDPE,
    printingPriceKrwPerM: GRAVURE_ROLL_DEFAULTS_KRW.printingUnitPricePerM,
    laminationPriceKrwPerMWithAl: GRAVURE_ROLL_DEFAULTS_KRW.laminationUnitPricePerMWithAl,
    laminationPriceKrwPerMWithoutAl: GRAVURE_ROLL_DEFAULTS_KRW.laminationUnitPricePerMWithoutAl,
    newCopperPlatePriceKrw: GRAVURE_ROLL_DEFAULTS_KRW.newCopperPlateUnitPrice,
    copperPlateWidthExtraMm: GRAVURE_ROLL_DEFAULTS_KRW.copperPlateWidthExtraMm,
    copperPlateMinimumDiameterMm: GRAVURE_ROLL_DEFAULTS_KRW.copperPlateMinimumDiameterMm,
    krwPer100Yen: GRAVURE_ROLL_DEFAULTS_KRW.krwPer100Yen,
    deliverablePatternLengthM: GRAVURE_ROLL_DEFAULTS_KRW.deliverablePatternLengthM,
    productionPatternLengthM: GRAVURE_ROLL_DEFAULTS_KRW.productionPatternLengthM,
    overseasShippingUnitM: GRAVURE_ROLL_DEFAULTS_KRW.overseasShippingUnitM,
    overseasShippingPerTripYen: GRAVURE_ROLL_DEFAULTS_KRW.overseasShippingPerTripYen,
    manufacturerMarginRate: GRAVURE_ROLL_DEFAULTS_KRW.manufacturerMarginRate,
    customsRate: GRAVURE_ROLL_DEFAULTS_KRW.customsRate,
    smallWidthThresholdMm: GRAVURE_ROLL_DEFAULTS_KRW.smallWidthThresholdMm,
    smallWidthOrderPatternLengthM: GRAVURE_ROLL_DEFAULTS_KRW.smallWidthOrderPatternLengthM,
    smallWidthProductionPatternLengthM: GRAVURE_ROLL_DEFAULTS_KRW.smallWidthProductionPatternLengthM,
    smallWidthManufacturerUnitPriceKrwPerM: GRAVURE_ROLL_DEFAULTS_KRW.smallWidthManufacturerUnitPriceKRWPerM,
  };
}

export function fallbackGravureKMaster(asOf: string): GravureKMasterRow {
  const source = defaultGravureKSource();
  return {
    id: 0, source, derived: defaultGravureRollParameters(), memo: "code fallback",
    effectiveFrom: asOf, effectiveTo: asOf, updatedBy: "system", updatedAt: new Date(0).toISOString(),
    supersededById: null, supersededAt: null,
  };
}

type KDbRow = {
  id: number;
  derived_json: string;
  memo: string;
  effective_from: string;
  effective_to: string;
  updated_by: string;
  updated_at: string;
  superseded_by_id: number | null;
  superseded_at: string | null;
} & Record<GravureKSourceField, string>;

function mapKRow(row: KDbRow): GravureKMasterRow {
  // The normalized columns are authoritative. source_json exists only as a
  // legacy migration artifact and is intentionally never read here.
  const source = Object.fromEntries(
    GRAVURE_K_SOURCE_FIELDS.map((field) => [field, row[field]]),
  ) as GravureKSource;
  return {
    id: Number(row.id), source, derived: JSON.parse(row.derived_json), memo: row.memo,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to, updatedBy: row.updated_by, updatedAt: row.updated_at,
    supersededById: row.superseded_by_id == null ? null : Number(row.superseded_by_id), supersededAt: row.superseded_at,
  };
}

export async function listGravureKMasterRows(): Promise<GravureKMasterRow[]> {
  return withGravureDatabase(async (db) => {
    const rows = await db.all<KDbRow>("SELECT * FROM gravure_k_parameter_sets ORDER BY effective_from DESC, id DESC");
    return rows.map(mapKRow);
  });
}

export async function listGravureMasterAudit(limit = 200): Promise<GravureMasterAuditEntry[]> {
  return withGravureDatabase(async (db) => {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 200, 1), 500);
    const rows = await db.all<{
      id: number; table_name: GravureMasterAuditEntry["tableName"]; row_id: number; action: string;
      actor: string; before_json: string | null; after_json: string | null; created_at: string;
    }>("SELECT * FROM gravure_master_audit ORDER BY id DESC LIMIT ?", [safeLimit]);
    return rows.map((row) => ({
      id: row.id,
      tableName: row.table_name,
      rowId: row.row_id,
      action: row.action,
      actor: row.actor,
      before: row.before_json == null ? null : JSON.parse(row.before_json),
      after: row.after_json == null ? null : JSON.parse(row.after_json),
      createdAt: row.created_at,
    }));
  });
}

export async function listGravureSnapshotAuditRecords(limit = 50): Promise<GravureSnapshotAuditRecord[]> {
  return withGravureDatabase(async (db) => {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
    const rows = await db.all<SnapshotDbRow>(
      `SELECT id,resolver_version,as_of,digital_values_json,y_rows_json,k_source_json,k_derived_json,
              fallback_versions_json,full_request_json,full_result_json,calculation_result_sha256,
              public_projection_json,public_projection_sha256,created_by,created_at,snapshot_sha256
       FROM calculation_master_snapshots ORDER BY created_at DESC, id DESC LIMIT ?`,
      [safeLimit],
    );
    return rows.map((row) => {
      const snapshot = mapSnapshot(row);
      return {
        id: snapshot.id,
        resolverVersion: snapshot.resolverVersion,
        asOf: snapshot.asOf,
        digitalValues: snapshot.digitalValues,
        yRows: snapshot.yRows,
        kSource: snapshot.kSource,
        kDerived: snapshot.kDerived,
        fallbackVersions: snapshot.fallbackVersions,
        calculationResultSha256: snapshot.calculationResultSha256,
        canonicalPublicProjection: snapshot.canonicalPublicProjection,
        publicProjectionSha256: snapshot.publicProjectionSha256,
        createdBy: snapshot.createdBy,
        createdAt: snapshot.createdAt,
        snapshotSha256: snapshot.snapshotSha256,
      };
    });
  });
}

async function insertGravureKMasterRow(tx: SqlClient, input: GravureKMasterInput, actor: GravureMasterActor): Promise<GravureKMasterRow> {
  if (tx.dialect === "postgres") await tx.run("SELECT pg_advisory_xact_lock(hashtext(?))", ["gravure-k-active"]);
  const overlapping = await tx.get<KDbRow>(
    "SELECT * FROM gravure_k_parameter_sets WHERE effective_from <= ? AND effective_to >= ? LIMIT 1",
    [input.effectiveTo || OPEN_EFFECTIVE_TO, input.effectiveFrom],
  );
  if (overlapping) throw new GravureOverlapError("gravure_k_overlap");
  const source = normalizeKSource(input.source);
  const derived = deriveGravureKParameters(source);
  const sourceValues = K_SOURCE_COLUMNS.map(([field]) => source[field]);
  await tx.run(
    `INSERT INTO gravure_k_parameter_sets
     (source_json,${K_SOURCE_COLUMNS.map(([field]) => field).join(",")},derived_json,memo,effective_from,effective_to,updated_by,updated_at)
     VALUES (${Array.from({ length: K_SOURCE_COLUMNS.length + 2 }, () => "?").join(",")},?,?,?,?,?)`,
    [JSON.stringify(source), ...sourceValues, JSON.stringify(derived), input.memo ?? "", input.effectiveFrom, input.effectiveTo || OPEN_EFFECTIVE_TO, actor, new Date().toISOString()],
  );
  const inserted = await tx.get<KDbRow>("SELECT * FROM gravure_k_parameter_sets ORDER BY id DESC LIMIT 1");
  if (!inserted) throw new GravureValidationError("gravure_k_insert_failed");
  const row = mapKRow(inserted);
  await appendAudit(tx, "gravure_k_parameter_sets", row.id, "create", actor, null, row);
  return row;
}

export async function createGravureKMasterRow(input: GravureKMasterInput, actor: GravureMasterActor): Promise<GravureKMasterRow> {
  return withGravureDatabase((db) => db.transaction((tx) => insertGravureKMasterRow(tx, input, actor)));
}

export async function supersedeGravureKMasterRow(id: number, input: GravureKMasterInput, actor: GravureMasterActor): Promise<GravureKMasterRow> {
  return withGravureDatabase((db) => db.transaction(async (tx) => {
    const old = await tx.get<KDbRow>("SELECT * FROM gravure_k_parameter_sets WHERE id = ?", [id]);
    if (!old) throw new GravureValidationError("gravure_k_not_found");
    if (old.superseded_by_id != null) throw new GravureValidationError("already_superseded");
    if (input.effectiveFrom <= old.effective_from) throw new GravureValidationError("supersede_date_not_later");
    const previousTo = previousDayUtc(input.effectiveFrom);
    const closed = await tx.run(
      `UPDATE gravure_k_parameter_sets SET effective_to = ?, superseded_at = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND superseded_by_id IS NULL`,
      [previousTo, new Date().toISOString(), actor, new Date().toISOString(), id],
    );
    if (closed.changes !== 1) throw new GravureValidationError("already_superseded");
    const replacement = await insertGravureKMasterRow(tx, input, actor);
    const superseded = await tx.run(
      "UPDATE gravure_k_parameter_sets SET superseded_by_id = ? WHERE id = ? AND superseded_by_id IS NULL",
      [replacement.id, id],
    );
    if (superseded.changes !== 1) throw new GravureValidationError("already_superseded");
    await appendAudit(tx, "gravure_k_parameter_sets", id, "supersede", actor, mapKRow(old), replacement);
    return replacement;
  }));
}

async function appendAudit(
  db: SqlClient,
  tableName: GravureMasterAuditEntry["tableName"],
  rowId: number,
  action: string,
  actor: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await db.run(
    "INSERT INTO gravure_master_audit (table_name,row_id,action,actor,before_json,after_json,created_at) VALUES (?,?,?,?,?,?,?)",
    [tableName, rowId, action, actor, before == null ? null : JSON.stringify(before), JSON.stringify(after), new Date().toISOString()],
  );
}

export async function resolveGravureMasters(asOf = tokyoDate()): Promise<GravureResolvedMasters> {
  return withGravureDatabase(async (db) => {
    const [yRows, kRow] = await Promise.all([
      db.all<YDbRow>(
        `SELECT * FROM gravure_y_supplier_prices
         WHERE superseded_by_id IS NULL AND effective_from <= ? AND effective_to >= ?
         ORDER BY effective_from DESC, id DESC`,
        [asOf, asOf],
      ),
      db.get<KDbRow>(
        "SELECT * FROM gravure_k_parameter_sets WHERE effective_from <= ? AND effective_to >= ? ORDER BY effective_from DESC, id DESC LIMIT 1",
        [asOf, asOf],
      ),
    ]);
    const activeByDimension = new Map<string, GravureYMasterRow>();
    for (const raw of yRows) {
      const row = mapYRow(raw);
      const key = [row.webWidthMm, row.laneCount, row.printTierM].join(":");
      if (!activeByDimension.has(key)) activeByDimension.set(key, row);
    }
    const effective = fallbackGravureYMasterRows(asOf);
    for (const row of activeByDimension.values()) {
      effective.splice(effective.findIndex((fallback) => (
        fallback.webWidthMm === row.webWidthMm
        && fallback.laneCount === row.laneCount
        && fallback.printTierM === row.printTierM
      )), 1, row);
    }
    return {
      asOf,
      yRows: effective,
      kSet: kRow ? mapKRow(kRow) : null,
      fallbackVersions: { y: "supplier-matrix-2026-10", k: "gravure-roll-defaults-2026-10" },
    };
  });
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function buildPublicProjection(
  result: CostResult,
  request: CalculationInput,
  metadata: SnapshotPublicMetadata,
): CanonicalPublicProjection {
  const candidates = result.recommendationCandidates ?? [];
  return {
    pricingSnapshot: metadata,
    calculationVersion: GRAVURE_SNAPSHOT_CALCULATION_VERSION,
    printingMethod: result.printingMethod,
    quantity: result.quantity,
    connectedChambers: result.connectedChambers,
    fillingMethod: result.fillingMethod,
    size: {
      widthMm: String(request.spec.customWidthMm ?? "0"),
      lengthMm: String(request.spec.customLengthMm ?? "0"),
    },
    selectedCandidateId: result.selectedCandidateId ?? "",
    resultHash: result.audit.resultJsonSha256,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      route: candidate.route,
      printingMethod: candidate.printingMethod,
      detailLabel: candidate.detailLabel,
      materialText: candidate.materialText,
      colorText: candidate.colorText,
      compositionText: candidate.compositionText,
      pouchSpecText: candidate.pouchSpecText,
      patternText: candidate.patternText,
      adjustedQuantity: candidate.adjustedQuantity,
      capacityQuantity: candidate.capacityQuantity,
      adjustedSkuQuantities: [...candidate.adjustedSkuQuantities],
      requiredLengthM: candidate.requiredLengthM,
      orderLengthM: candidate.orderLengthM,
      effectiveLengthM: candidate.effectiveLengthM,
      filmTotalYen: candidate.filmTotalYen,
      filmCostPerPieceYen: candidate.filmCostPerPieceYen,
      allInCostPerPieceYen: candidate.allInCostPerPieceYen,
    })),
  };
}

export async function saveGravureSnapshot(input: {
  asOf: string;
  digitalValues: CostParameters["filmUnitPrices"];
  resolved: GravureResolvedMasters;
  request: CalculationInput;
  result: CostResult;
  createdBy: string;
}): Promise<GravureSnapshot> {
  return withGravureDatabase(async (db) => {
    const kSource = input.resolved.kSet?.source ?? defaultGravureKSource();
    const kDerived = input.resolved.kSet?.derived ?? defaultGravureRollParameters();
    const createdAt = new Date().toISOString();
    const metadata: SnapshotPublicMetadata = {
      id: randomUUID(), sha256: "", resolverVersion: GRAVURE_RESOLVER_VERSION, asOf: input.asOf, view: "redacted",
    };
    // Bind the immutable snapshot reference into the stored calculation result.
    // The result hash intentionally excludes audit metadata, so this binding does
    // not alter the monetary result hash.
    input.result.audit.pricingSnapshot = {
      id: metadata.id,
      sha256: "",
      publicProjectionSha256: "",
    };
    const publicProjection = buildPublicProjection(input.result, input.request, metadata);
    const publicHash = sha256Canonical(publicProjection);
    const envelope = {
      id: metadata.id,
      resolverVersion: metadata.resolverVersion,
      asOf: input.asOf,
      digitalValues: input.digitalValues,
      yRows: input.resolved.yRows,
      kSource,
      kDerived,
      fallbackVersions: input.resolved.fallbackVersions,
      fullAugmentedCalculationRequest: input.request,
      fullCalculationResult: input.result,
      calculationResultSha256: input.result.audit.resultJsonSha256,
      canonicalPublicProjection: structuredClone(publicProjection),
      publicProjectionSha256: publicHash,
      createdBy: input.createdBy,
      createdAt,
    };
    let snapshotHash = sha256Canonical(envelope);
    metadata.sha256 = snapshotHash;
    const finalProjection = buildPublicProjection(input.result, input.request, metadata);
    const finalPublicHash = sha256Canonical(finalProjection);
    envelope.canonicalPublicProjection = finalProjection;
    envelope.publicProjectionSha256 = finalPublicHash;
    const snapshot: GravureSnapshot = {
      ...envelope,
      fullAugmentedCalculationRequest: input.request,
      fullCalculationResult: input.result,
      snapshotSha256: snapshotHash,
    };
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO calculation_master_snapshots
         (id,resolver_version,as_of,digital_values_json,y_rows_json,k_source_json,k_derived_json,fallback_versions_json,
          full_request_json,full_result_json,calculation_result_sha256,public_projection_json,public_projection_sha256,
          created_by,created_at,snapshot_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [snapshot.id, snapshot.resolverVersion, snapshot.asOf, JSON.stringify(snapshot.digitalValues), JSON.stringify(snapshot.yRows),
          JSON.stringify(snapshot.kSource), JSON.stringify(snapshot.kDerived), JSON.stringify(snapshot.fallbackVersions),
          JSON.stringify(snapshot.fullAugmentedCalculationRequest), JSON.stringify(snapshot.fullCalculationResult),
          snapshot.calculationResultSha256, JSON.stringify(snapshot.canonicalPublicProjection), snapshot.publicProjectionSha256,
          snapshot.createdBy, snapshot.createdAt, snapshot.snapshotSha256],
      );
    });
    return snapshot;
  });
}

interface SnapshotDbRow {
  id: string; resolver_version: string; as_of: string; digital_values_json: string; y_rows_json: string;
  k_source_json: string; k_derived_json: string; fallback_versions_json: string; full_request_json: string;
  full_result_json: string; calculation_result_sha256: string; public_projection_json: string;
  public_projection_sha256: string; created_by: string; created_at: string; snapshot_sha256: string;
}

function mapSnapshot(row: SnapshotDbRow): GravureSnapshot {
  const parsed = {
    id: row.id,
    resolverVersion: row.resolver_version,
    asOf: row.as_of,
    digitalValues: JSON.parse(row.digital_values_json),
    yRows: JSON.parse(row.y_rows_json),
    kSource: JSON.parse(row.k_source_json),
    kDerived: JSON.parse(row.k_derived_json),
    fallbackVersions: JSON.parse(row.fallback_versions_json),
    fullAugmentedCalculationRequest: JSON.parse(row.full_request_json),
    fullCalculationResult: JSON.parse(row.full_result_json),
    calculationResultSha256: row.calculation_result_sha256,
    canonicalPublicProjection: JSON.parse(row.public_projection_json),
    publicProjectionSha256: row.public_projection_sha256,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  return { ...parsed, snapshotSha256: row.snapshot_sha256 };
}

export async function getGravureSnapshot(id: string): Promise<GravureSnapshot | null> {
  return withGravureDatabase(async (db) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const row = await db.get<SnapshotDbRow>("SELECT * FROM calculation_master_snapshots WHERE id = ?", [id]);
    return row ? mapSnapshot(row) : null;
  });
}

export function verifyGravureSnapshot(snapshot: GravureSnapshot): void {
  const { snapshotSha256: _ignored, ...envelope } = snapshot;
  void _ignored;
  const hashInput = {
    ...envelope,
    publicProjectionSha256: sha256Canonical({
      ...envelope.canonicalPublicProjection,
      pricingSnapshot: {
        ...envelope.canonicalPublicProjection.pricingSnapshot,
        sha256: "",
      },
    }),
    canonicalPublicProjection: {
      ...envelope.canonicalPublicProjection,
      pricingSnapshot: {
        ...envelope.canonicalPublicProjection.pricingSnapshot,
        sha256: "",
      },
    },
  };
  if (snapshot.snapshotSha256 !== sha256Canonical(hashInput)) {
    throw new GravureSnapshotInvalidError("pricing_snapshot_hash_invalid");
  }
}

export async function verifyGravureSnapshotIssuance(input: {
  snapshotId?: unknown;
  snapshotSha256?: unknown;
  publicProjection?: unknown;
}): Promise<{ snapshot: GravureSnapshot; result: CostResult }> {
  const value = input.publicProjection;
  if (!value || typeof value !== "object") throw new GravureSnapshotInvalidError("pricing_projection_invalid");
  const submitted = value as ReturnedPublicProjection;
  if (typeof submitted.publicProjectionHash !== "string"
    || !/^[0-9a-f]{64}$/i.test(submitted.publicProjectionHash)) {
    throw new GravureSnapshotInvalidError("pricing_projection_hash_invalid");
  }
  if (submitted.publicProjectionHash === input.snapshotSha256) throw new GravureSnapshotInvalidError("pricing_projection_hash_invalid");
  const snapshot = await getGravureSnapshot(String(input.snapshotId ?? ""));
  if (!snapshot || snapshot.snapshotSha256 !== input.snapshotSha256) throw new GravureSnapshotInvalidError("pricing_snapshot_not_found");
  verifyGravureSnapshot(snapshot);
  if (submitted.publicProjectionHash !== snapshot.publicProjectionSha256) {
    throw new GravureSnapshotInvalidError("pricing_projection_hash_invalid");
  }
  const { publicProjectionHash: _hash, ...submittedCanonical } = submitted;
  void _hash;
  const stripAuditReference = (value: CostResult) => {
    const { pricingSnapshot: _pricingSnapshot, ...audit } = value.audit;
    void _pricingSnapshot;
    return { ...value, audit };
  };
  if (canonicalize(submittedCanonical) !== canonicalize(snapshot.canonicalPublicProjection)
    || sha256Canonical(submittedCanonical) !== snapshot.publicProjectionSha256) {
    throw new GravureSnapshotInvalidError("pricing_projection_mismatch");
  }
  const recalculated = calculatePouchCost(snapshot.fullAugmentedCalculationRequest);
  const storedComparableResult = stripAuditReference(snapshot.fullCalculationResult);
  const recalculatedComparableResult = stripAuditReference(recalculated);
  if (snapshot.fullCalculationResult.audit.resultJsonSha256 !== snapshot.calculationResultSha256
    || snapshot.fullCalculationResult.audit.calculationVersion !== GRAVURE_SNAPSHOT_CALCULATION_VERSION) {
    throw new GravureSnapshotInvalidError("pricing_snapshot_invalid");
  }
  if (recalculated.audit.resultJsonSha256 !== snapshot.calculationResultSha256
    || canonicalize(recalculatedComparableResult) !== canonicalize(storedComparableResult)) {
    throw new GravureSnapshotInvalidError("pricing_snapshot_recalculation_invalid");
  }
  return { snapshot, result: recalculated };
}

export class GravureValidationError extends Error {}
export class GravureOverlapError extends GravureValidationError {}
export class GravureSnapshotInvalidError extends GravureValidationError {}
