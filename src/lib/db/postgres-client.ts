import type { Pool, PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { translateSqlToPostgres } from "./sql-translation";
import type { SqlClient, SqlExecutionResult } from "./types";

type PostgresSslOptions = {
  rejectUnauthorized: boolean;
  ca?: string;
  cert?: string;
  key?: string;
};

interface PoolOptions {
  connectionString?: string;
  ssl?: boolean | PostgresSslOptions;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
}

const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);
const secureSslModes = new Set(["prefer", "allow", "require", "verify-ca", "verify-full"]);

function isLocalAddress(connectionString: string): boolean {
  const url = new URL(connectionString);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return localHostnames.has(hostname) || hostname.endsWith(".localhost");
}

function requireSingleSearchParameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new Error(`PostgreSQL connection parameter "${name}" must be specified only once.`);
  }
  return values[0] ?? null;
}

export function postgresPoolOptions(connectionString: string): PoolOptions {
  const url = new URL(connectionString);
  const local = isLocalAddress(connectionString);
  const sslMode = requireSingleSearchParameter(url, "sslmode")?.toLowerCase() ?? null;
  const sslParameter = requireSingleSearchParameter(url, "ssl")?.toLowerCase() ?? null;
  const rootCertificatePath = requireSingleSearchParameter(url, "sslrootcert");
  const clientCertificatePath = requireSingleSearchParameter(url, "sslcert");
  const clientKeyPath = requireSingleSearchParameter(url, "sslkey");
  const sslDisabled = sslMode === "disable" || sslParameter === "false" || sslParameter === "0";
  const insecureSslMode = sslMode === "no-verify";
  const sslRequested = sslMode !== null
    ? secureSslModes.has(sslMode)
    : sslParameter === "true" || sslParameter === "1" || rootCertificatePath !== null;

  if (!local && (sslDisabled || insecureSslMode)) {
    throw new Error(
      "TLS must not be disabled for non-local PostgreSQL connections; use a verified SSL mode.",
    );
  }

  if (sslMode !== null && !sslDisabled && !insecureSslMode && !secureSslModes.has(sslMode)) {
    throw new Error(`Unsupported PostgreSQL sslmode "${sslMode}".`);
  }

  let ssl: boolean | PostgresSslOptions | undefined;
  if (sslDisabled) {
    ssl = false;
  } else if (local && !sslRequested) {
    ssl = undefined;
  } else if (local && !rootCertificatePath && !clientCertificatePath && !clientKeyPath) {
    // Local test servers commonly use an untrusted development certificate.
    // This relaxation applies only to loopback/localhost PostgreSQL URLs.
    ssl = { rejectUnauthorized: false };
  } else {
    const verifiedOptions: PostgresSslOptions = { rejectUnauthorized: true };
    if (rootCertificatePath) {
      verifiedOptions.ca = readFileSync(
        /* turbopackIgnore: true */ rootCertificatePath,
        "utf8",
      );
    }
    if (clientCertificatePath) {
      verifiedOptions.cert = readFileSync(
        /* turbopackIgnore: true */ clientCertificatePath,
        "utf8",
      );
    }
    if (clientKeyPath) {
      verifiedOptions.key = readFileSync(
        /* turbopackIgnore: true */ clientKeyPath,
        "utf8",
      );
    }
    ssl = verifiedOptions;
  }

  for (const parameter of ["ssl", "sslcert", "sslkey", "sslmode", "sslrootcert"]) {
    url.searchParams.delete(parameter);
  }

  return {
    connectionString: url.toString(),
    max: 3,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 12_000,
    allowExitOnIdle: true,
    ssl,
  };
}

export class PostgresClient implements SqlClient {
  readonly dialect = "postgres" as const;
  private constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string): Promise<PostgresClient> {
    const { Pool } = await import("pg");
    const pool = new Pool(postgresPoolOptions(connectionString));
    // 接続設定の誤りを起動時点で検知できるように、最初の接続を確認する。
    const client = await pool.connect();
    client.release();
    return new PostgresClient(pool);
  }

  private async query(sql: string, params?: unknown[]) {
    return this.pool.query(translateSqlToPostgres(sql), params ?? []);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query(sql, params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<SqlExecutionResult> {
    const result = await this.query(sql, params);
    return { changes: result.rowCount ?? 0, lastInsertRowid: null };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(translateSqlToPostgres(sql));
  }

  async transaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const transactionClient = new PostgresTransactionClient(client);
    try {
      await client.query("BEGIN");
      const result = await operation(transactionClient);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PostgresTransactionClient implements SqlClient {
  readonly dialect = "postgres" as const;

  constructor(private readonly client: PoolClient) {}

  private async query(sql: string, params?: unknown[]) {
    return this.client.query(translateSqlToPostgres(sql), params ?? []);
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query(sql, params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: unknown[] = []): Promise<SqlExecutionResult> {
    const result = await this.query(sql, params);
    return { changes: result.rowCount ?? 0, lastInsertRowid: null };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(translateSqlToPostgres(sql));
  }

  // トランザクション内では同一クライアントを再利用する。
  async transaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T> {
    return operation(this);
  }

  async close(): Promise<void> {
    // プールのクライアントは PostgresClient.transaction の finally で返却する。
  }
}
