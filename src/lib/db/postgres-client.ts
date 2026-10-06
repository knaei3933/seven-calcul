import type { Pool, PoolClient } from "pg";
import { translateSqlToPostgres } from "./sql-translation";
import type { SqlClient, SqlExecutionResult } from "./types";

interface PoolOptions {
  connectionString?: string;
  ssl?: boolean | { rejectUnauthorized?: boolean };
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
}

function isLocalAddress(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function poolOptions(connectionString: string): PoolOptions {
  const local = isLocalAddress(connectionString);
  const sslDisabled = /sslmode=disable/i.test(connectionString);
  const sslRequested = /sslmode=(require|verify-ca|verify-full)/i.test(connectionString);
  return {
    connectionString,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 12_000,
    allowExitOnIdle: true,
    ssl: sslDisabled || local ? undefined : { rejectUnauthorized: false },
    ...(sslRequested && local ? { ssl: { rejectUnauthorized: false } } : {}),
  };
}

export class PostgresClient implements SqlClient {
  readonly dialect = "postgres" as const;
  private constructor(private readonly pool: Pool) {}

  static async connect(connectionString: string): Promise<PostgresClient> {
    const { Pool } = await import("pg");
    const pool = new Pool(poolOptions(connectionString));
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
