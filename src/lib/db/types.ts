export type SqlDialect = "sqlite" | "postgres";

export interface SqlExecutionResult {
  changes: number;
  lastInsertRowid: number | null;
}

export interface SqlClient {
  readonly dialect: SqlDialect;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<SqlExecutionResult>;
  /** パラメータを持たない複数文 SQL（主にDDL）を実行する。 */
  exec(sql: string): Promise<void>;
  transaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
