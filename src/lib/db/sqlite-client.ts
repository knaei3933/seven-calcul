import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqlClient, SqlExecutionResult } from "./types";

export class SqliteClient implements SqlClient {
  readonly dialect = "sqlite" as const;
  private database: DatabaseSync | null = null;
  private opening: Promise<DatabaseSync> | null = null;
  private transactionDepth = 0;
  private transactionLock: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async open(): Promise<DatabaseSync> {
    if (this.database) return this.database;
    this.opening ??= (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const database = new DatabaseSync(this.path);
      this.database = database;
      return database;
    })();
    return this.opening;
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const database = await this.open();
    return database.prepare(sql).all(...(params as never[])) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const database = await this.open();
    return (database.prepare(sql).get(...(params as never[])) ?? undefined) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<SqlExecutionResult> {
    const database = await this.open();
    const result = database.prepare(sql).run(...(params as never[]));
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
    };
  }

  async exec(sql: string): Promise<void> {
    const database = await this.open();
    database.exec(sql);
  }

  async transaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T> {
    // 既に実行中のトランザクション内から呼ばれた場合は、同じトランザクションを再利用する。
    if (this.transactionDepth > 0) return operation(this);
    // 単一接続では同時に1トランザクションだけ実行できる。
    // キューで直列化し、並行更新が互いのトランザクションを壊さないようにする。
    const run = async (): Promise<T> => {
      const database = await this.open();
      this.transactionDepth += 1;
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = await operation(this);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    };
    const next = this.transactionLock.then(run, run);
    this.transactionLock = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = null;
    this.opening = null;
  }
}
