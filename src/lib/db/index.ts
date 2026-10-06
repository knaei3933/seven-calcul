import { resolve } from "node:path";
import { PostgresClient } from "./postgres-client";
import { SqliteClient } from "./sqlite-client";
import type { SqlClient } from "./types";

export type { SqlClient, SqlDialect, SqlExecutionResult } from "./types";

/**
 * `quotations`（ユーザー・セッション・見積）と `customers`（顧客マスタ）の2系統。
 * PostgreSQL では同一接続を共有し、SQLite では従来どおり別ファイルを使う。
 */
export type StoreSlot = "quotations" | "customers";

const clients = new Map<StoreSlot, Promise<SqlClient>>();

export function postgresConnectionString(): string | null {
  const value = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function activeDialect(): "sqlite" | "postgres" {
  return postgresConnectionString() ? "postgres" : "sqlite";
}

function sqlitePath(slot: StoreSlot): string {
  if (slot === "customers") {
    return process.env.POUCH_CUSTOMER_DB
      ?? (process.env.VERCEL === "1" ? "/tmp/pouch-customers.db" : resolve(process.cwd(), ".data/customers.db"));
  }
  return process.env.POUCH_QUOTATION_DB
    ?? (process.env.VERCEL === "1" ? "/tmp/pouch-quotations.db" : resolve(process.cwd(), ".data/quotations.db"));
}

async function createClient(slot: StoreSlot): Promise<SqlClient> {
  const connectionString = postgresConnectionString();
  if (connectionString) return PostgresClient.connect(connectionString);

  if (process.env.VERCEL === "1") {
    console.warn(
      "[pouch] DATABASE_URL is not configured. Falling back to ephemeral SQLite; "
      + "quotation history will not be shared between instances or survive deployments.",
    );
  }
  return new SqliteClient(sqlitePath(slot));
}

export function getSqlClient(slot: StoreSlot = "quotations"): Promise<SqlClient> {
  let client = clients.get(slot);
  if (!client) {
    client = createClient(slot);
    clients.set(slot, client);
  }
  return client;
}

export async function resetSqlClientForTest(): Promise<void> {
  const pending = [...clients.values()];
  clients.clear();
  await Promise.allSettled(pending.map((client) => client.then((entry) => entry.close())));
}

export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (code === "23505") return true;
  return /unique constraint/i.test(error.message);
}
