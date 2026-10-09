import { D } from "./decimal";
import { getSqlClient, type SqlClient } from "./db";
import type { CostParameters } from "./types";

export interface FilmPriceRow {
  id: number;
  band: "lte570" | "571to740";
  tier: "500" | "1000" | "1500";
  unitPriceYenPerM: string;
  effectiveFrom: string;
  effectiveTo: string;
  memo: string;
  updatedBy: string;
  updatedAt: string;
}

export interface FilmPriceInput {
  band: string;
  tier: string;
  unitPriceYenPerM: string;
  effectiveFrom: string;
  effectiveTo?: string;
  memo?: string;
}

let schemaReady: Promise<SqlClient> | null = null;

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS film_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    band TEXT NOT NULL CHECK (band IN ('lte570','571to740')),
    tier TEXT NOT NULL CHECK (tier IN ('500','1000','1500')),
    unit_price_yen_per_m TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    effective_to TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_film_prices_lookup ON film_prices(band, tier, effective_from);
`;

const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS film_prices (
    id SERIAL PRIMARY KEY,
    band TEXT NOT NULL CHECK (band IN ('lte570','571to740')),
    tier TEXT NOT NULL CHECK (tier IN ('500','1000','1500')),
    unit_price_yen_per_m TEXT NOT NULL,
    effective_from TEXT NOT NULL,
    effective_to TEXT NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_film_prices_lookup ON film_prices(band, tier, effective_from);
`;

async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : SQLITE_SCHEMA);
    return db;
  })();
  return schemaReady;
}

interface FilmPriceDbRow {
  id: number;
  band: string;
  tier: string;
  unit_price_yen_per_m: string;
  effective_from: string;
  effective_to: string;
  memo: string;
  updated_by: string;
  updated_at: string;
}

function mapRow(row: FilmPriceDbRow): FilmPriceRow {
  return {
    id: row.id,
    band: row.band as FilmPriceRow["band"],
    tier: row.tier as FilmPriceRow["tier"],
    unitPriceYenPerM: row.unit_price_yen_per_m,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    memo: row.memo,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export async function listFilmPrices(): Promise<FilmPriceRow[]> {
  const db = await getDatabase();
  const rows = await db.all<FilmPriceDbRow>(
    "SELECT * FROM film_prices ORDER BY effective_from DESC, band, tier",
  );
  return rows.map(mapRow);
}

export function validateFilmPriceInput(value: unknown): FilmPriceInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const band = input.band;
  const tier = input.tier;
  const unitPrice = input.unitPriceYenPerM;
  const effectiveFrom = input.effectiveFrom;
  const effectiveTo = input.effectiveTo;
  if (band !== "lte570" && band !== "571to740") return null;
  if (tier !== "500" && tier !== "1000" && tier !== "1500") return null;
  if (typeof unitPrice !== "string" || !/^\d+(?:\.\d+)?$/.test(unitPrice)) return null;
  if (typeof effectiveFrom !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(effectiveFrom)) return null;
  if (effectiveTo !== undefined && (typeof effectiveTo !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(effectiveTo))) return null;
  return {
    band,
    tier,
    unitPriceYenPerM: unitPrice,
    effectiveFrom,
    effectiveTo: typeof effectiveTo === "string" ? effectiveTo : "",
    memo: typeof input.memo === "string" ? input.memo : "",
  };
}

function defaultEffectiveTo(from: string): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export async function upsertFilmPrice(
  input: FilmPriceInput,
  updatedBy: string,
): Promise<FilmPriceRow> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const effectiveTo = input.effectiveTo || defaultEffectiveTo(input.effectiveFrom);

  // 同一band+tierで重複する期間を閉じる（最新行のみ有効にする）.
  await db.run(
    `UPDATE film_prices SET effective_to = ?, updated_at = ?, updated_by = ?
     WHERE band = ? AND tier = ? AND effective_to >= ? AND effective_from <= ?`,
    [input.effectiveFrom, now, updatedBy, input.band, input.tier, input.effectiveFrom, input.effectiveFrom],
  );

  const result = await db.run(
    `INSERT INTO film_prices (band, tier, unit_price_yen_per_m, effective_from, effective_to, memo, updated_by, updated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [input.band, input.tier, input.unitPriceYenPerM, input.effectiveFrom, effectiveTo, input.memo, updatedBy, now, now],
  );
  const row = await db.get<FilmPriceDbRow>("SELECT * FROM film_prices WHERE id = ?", [result.lastInsertRowid]);
  return mapRow(row!);
}

export async function resolveFilmUnitPrices(
  asOf: string,
  fallback: CostParameters["filmUnitPrices"],
): Promise<CostParameters["filmUnitPrices"]> {
  const db = await getDatabase();
  const rows = await db.all<FilmPriceDbRow>(
    "SELECT * FROM film_prices WHERE effective_from <= ? AND effective_to >= ? ORDER BY effective_from DESC",
    [asOf, asOf],
  );
  const result: CostParameters["filmUnitPrices"] = {
    lte570: { ...fallback.lte570 },
    "571to740": { ...fallback["571to740"] },
  };
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = mapRow(raw);
    const key = `${row.band}:${row.tier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result[row.band][row.tier] = row.unitPriceYenPerM;
  }
  return result;
}
