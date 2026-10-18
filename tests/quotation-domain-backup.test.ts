import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../scripts/backup-quotation-domain";
import type { Client as PgClient } from "pg";

const testDatabaseUrl = process.env.POUCH_TEST_DATABASE_URL;
const temporaryRoot = await mkdtemp(join(tmpdir(), "pouch-domain-backup-"));
const databasePath = join(temporaryRoot, "quotations.sqlite");
const environment = {
  POUCH_QUOTATION_DB: databasePath,
};
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
  INSERT INTO users VALUES (1, 'backup-test@example.test');
  CREATE TABLE quotations (
    id INTEGER PRIMARY KEY,
    quotation_number TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    pdf_data BLOB,
    pdf_file_name TEXT,
    pdf_uploaded_at TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id)
  );
  CREATE TABLE quotation_checklists (
    quotation_id INTEGER NOT NULL,
    audience TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY (quotation_id, audience)
  );
  CREATE TABLE film_orders (
    id INTEGER PRIMARY KEY,
    quotation_id INTEGER NOT NULL,
    quotation_number TEXT NOT NULL,
    eta_token TEXT
  );
  CREATE TABLE film_order_files (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    url TEXT NOT NULL
  );
  CREATE TABLE film_order_events (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    detail TEXT NOT NULL
  );
  INSERT INTO quotations VALUES
    (1, 'B-001', 'テスト株式会社', '{"n":1}', x'0046004400ff', 'テスト.pdf', '2026-01-01T00:00:00.000Z', 1);
  INSERT INTO quotation_checklists VALUES (1, 'CUSTOMER', '{"items":[1,2]}');
  INSERT INTO film_orders VALUES (10, 1, 'B-001', 'eta-secret-token');
  INSERT INTO film_order_files VALUES (20, 10, 'proof.pdf', 'https://files.example.test/proof.pdf');
  INSERT INTO film_order_events VALUES (30, 10, 'proof uploaded');
`);

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ["scripts/backup-quotation-domain.ts", ...args],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) =>
      resolvePromise({ code: code ?? -1, stdout, stderr }),
    );
  });
}

afterAll(async () => {
  database.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("quotation domain backup", () => {
  it("creates a verified SQLite backup with exact PDF bytes and safe target proof", async () => {
    const output = join(temporaryRoot, "sqlite-backup");
    const result = await runCli(
      ["--target", "local", "--output-dir", output],
      environment,
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);

    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    ) as {
      tables: Array<{
        name: string;
        sourceRowCount: number;
        exportedRowCount: number;
        verified: boolean;
      }>;
      targetProof: { resolvedTarget: string; databaseFile: { path: string } };
      scope: { tables: Array<{ name: string }> };
      safety: { destructiveOperations: string };
    };
    expect(
      Object.fromEntries(
        manifest.tables.map((table) => [table.name, table.sourceRowCount]),
      ),
    ).toEqual({
      quotations: 1,
      quotation_checklists: 1,
      film_orders: 1,
      film_order_files: 1,
      film_order_events: 1,
    });
    expect(
      manifest.tables.every(
        (table) =>
          table.exportedRowCount === table.sourceRowCount && table.verified,
      ),
    ).toBe(true);
    expect(manifest.targetProof.resolvedTarget).toBe("sqlite-local");
    expect(manifest.targetProof.databaseFile.path).toBe(databasePath);
    expect(manifest.scope.tables.map((table) => table.name)).toEqual([
      "quotations",
      "quotation_checklists",
      "film_orders",
      "film_order_files",
      "film_order_events",
    ]);
    expect(manifest.safety.destructiveOperations).toBe("none");

    const quotationLine = (
      await readFile(join(output, "quotations.jsonl"), "utf8")
    ).trimEnd();
    const quotation = JSON.parse(quotationLine) as { values: unknown[] };
    const binaryEnvelope = quotation.values[4] as { base64: string };
    expect(Buffer.from(binaryEnvelope.base64, "base64")).toEqual(
      Buffer.from([0x00, 0x46, 0x00, 0x44, 0x00, 0xff]),
    );
    expect(await readdir(output)).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "manifest.sha256",
        "quotations.jsonl",
        "quotation_checklists.jsonl",
        "film_orders.jsonl",
        "film_order_files.jsonl",
        "film_order_events.jsonl",
      ]),
    );
  });

  it("fails when an exported artifact no longer matches its verified checksum", async () => {
    const directory = join(temporaryRoot, "tampered");
    await mkdir2(directory);
    const record = { table: "film_orders", columns: ["id"], values: [1] };
    const line = `${JSON.stringify(record)}\n`;
    const goodChecksum = createHash("sha256").update(line).digest("hex");
    const path = join(directory, "film_orders.jsonl");
    await writeFile(path, line);
    await writeFile(path, `${line}tampered\n`);
    const { verifyTableArtifact } =
      await import("../scripts/backup-quotation-domain");
    await expect(
      verifyTableArtifact({
        client: {
          dialect: "sqlite" as const,
          all: async () => [],
          get: async <T>() => ({ count: 2 }) as T,
        },
        tableName: "film_orders",
        path,
        columns: ["id"],
        expectedRecords: [record],
        expectedDataSha256: goodChecksum,
        expectedRecordSha256: [goodChecksum],
      }),
    ).rejects.toThrow("verification_failed_checksum:film_orders");
  });

  it("refuses accidental production and requires exact host/database proof", async () => {
    const databaseUrl =
      "postgres://backup-user:backup-password@prod-pooler.example.neon.tech:5432/prod_database?sslmode=require";
    let connected = false;
    class ForbiddenClient {
      async connect(): Promise<void> {
        connected = true;
      }
      async query(): Promise<{ rows: unknown[] }> {
        return { rows: [] };
      }
      async end(): Promise<void> {
        connected = false;
      }
    }
    await expect(
      runBackup({
        args: [],
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: ForbiddenClient as unknown as typeof PgClient },
      }),
    ).rejects.toThrow(
      "target_required_when_postgresql_environment_is_configured",
    );
    expect(connected).toBe(false);

    const base = [
      "--target",
      "production",
      "--confirm-production-read-only-backup",
    ];
    await expect(
      runBackup({
        args: [
          ...base,
          "--confirm-host",
          "prod-pooler.example.neon.tech",
          "--confirm-database",
          "other",
        ],
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: ForbiddenClient as unknown as typeof PgClient },
      }),
    ).rejects.toThrow("production_database_confirmation_mismatch");
    expect(connected).toBe(false);
  });

  it("exports through an injected PostgreSQL production contract without exposing credentials", async () => {
    const databaseUrl =
      "postgres://backup-user:backup-password@prod-pooler.example.neon.tech:5432/prod_database?sslmode=require";
    const queries: string[] = [];
    let transactionOpen = false;
    class FakeClient {
      async connect(): Promise<void> {}
      async query(
        sql: string,
        values: unknown[] = [],
      ): Promise<{ rows: Record<string, unknown>[] }> {
        queries.push(sql);
        if (
          sql === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        ) {
          transactionOpen = true;
          return { rows: [] };
        }
        if (sql === "ROLLBACK") {
          transactionOpen = false;
          return { rows: [] };
        }
        if (sql.includes("current_database()")) {
          return {
            rows: [
              {
                database_name: "prod_database",
                schema_name: "public",
                server_version: "PostgreSQL 16.0",
                server_address: "192.0.2.10",
                server_port: "5432",
              },
            ],
          };
        }
        if (sql.includes("information_schema.tables")) {
          return {
            rows: [
              { table_name: "quotations" },
              { table_name: "quotation_checklists" },
              { table_name: "film_orders" },
              { table_name: "film_order_files" },
              { table_name: "film_order_events" },
            ],
          };
        }
        if (sql.includes("information_schema.columns")) {
          if (/table_name\s*=\s*"/.test(sql)) {
            throw new Error("invalid_postgres_metadata_literal");
          }
          const table = values[0];
          if (typeof table !== "string") {
            throw new Error("unbound_postgres_metadata_parameter");
          }
          const shape: Record<string, Record<string, unknown>> = {
            quotations: {
              id: 1,
              quotation_number: "B-001",
              pdf_data: Buffer.from([0, 255]),
            },
            quotation_checklists: { quotation_id: 1, audience: "CUSTOMER" },
            film_orders: { id: 10, quotation_id: 1 },
            film_order_files: { id: 20, order_id: 10 },
            film_order_events: { id: 30, order_id: 10 },
          };
          return {
            rows: Object.keys(shape[table] ?? {}).map((column_name) => ({
              column_name,
              data_type: "text",
            })),
          };
        }
        if (sql.includes("COUNT(*)")) {
          const table = /FROM\s+"([^"]+)"/.exec(sql)?.[1] ?? "";
          return { rows: [{ count: "1" }] };
        }
        if (sql.startsWith("SELECT *")) {
          const table = /FROM\s+"([^"]+)"/.exec(sql)?.[1] ?? "";
          const shapes: Record<string, Record<string, unknown>> = {
            quotations: {
              id: 1,
              quotation_number: "B-001",
              pdf_data: Buffer.from([0, 255]),
            },
            quotation_checklists: { quotation_id: 1, audience: "CUSTOMER" },
            film_orders: { id: 10, quotation_id: 1 },
            film_order_files: { id: 20, order_id: 10 },
            film_order_events: { id: 30, order_id: 10 },
          };
          return { rows: [shapes[table]] };
        }
        return { rows: [] };
      }
      async end(): Promise<void> {}
    }
    const output = join(temporaryRoot, "mocked-postgres");
    const result = await runBackup({
      args: [
        "--target",
        "production",
        "--confirm-production-read-only-backup",
        "--confirm-host",
        "prod-pooler.example.neon.tech",
        "--confirm-database",
        "prod_database",
        "--output-dir",
        output,
      ],
      env: { DATABASE_URL: databaseUrl },
      postgres: { Client: FakeClient as unknown as typeof PgClient },
    });
    expect(result.targetProof.databaseName).toBe("prod_database");
    expect(result.targetProof.host).toBe("prod-pooler.example.neon.tech");
    expect(result.totals.exportedRowCount).toBe(5);
    expect(transactionOpen).toBe(false);
    expect(
      queries.some((sql) =>
        sql.startsWith(
          "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        ),
      ),
    ).toBe(true);
    const manifestText = await readFile(result.manifestPath, "utf8");
    expect(manifestText).not.toContain(databaseUrl);
    expect(manifestText).not.toContain("backup-password");
    expect(manifestText).not.toContain("backup-user");
  }, 15_000);
});

describe.skipIf(!testDatabaseUrl)(
  "quotation domain backup with local PostgreSQL test database",
  () => {
    it(
      "performs the same transactional export against PostgreSQL",
      { timeout: 120_000 },
      async () => {
        const { Client } = await import("pg");
        const bootstrap = new Client({ connectionString: testDatabaseUrl });
        const schema = `pouch_backup_g005_${Date.now()}`;
        await bootstrap.connect();
        await bootstrap.query(`CREATE SCHEMA "${schema}"`);
        await bootstrap.query(`SET search_path = "${schema}"`);
        await bootstrap.query(`
      CREATE TABLE quotations (id INTEGER PRIMARY KEY, quotation_number TEXT NOT NULL);
      CREATE TABLE quotation_checklists (quotation_id INTEGER PRIMARY KEY, audience TEXT NOT NULL);
      CREATE TABLE film_orders (id INTEGER PRIMARY KEY, quotation_id INTEGER NOT NULL);
      CREATE TABLE film_order_files (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL);
      CREATE TABLE film_order_events (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL);
      INSERT INTO quotations VALUES (1, 'PG-BACKUP-001');
      INSERT INTO quotation_checklists VALUES (1, 'CUSTOMER');
      INSERT INTO film_orders VALUES (2, 1);
      INSERT INTO film_order_files VALUES (3, 2);
      INSERT INTO film_order_events VALUES (4, 2);
    `);
        await bootstrap.end();
        const parsed = new URL(testDatabaseUrl!);
        parsed.searchParams.set("options", `-c search_path=${schema}`);
        const output = join(temporaryRoot, "real-postgres");
        const result = await runBackup({
          args: [
            "--target",
            "postgres-test",
            "--confirm-host",
            parsed.hostname,
            "--confirm-database",
            decodeURIComponent(parsed.pathname.slice(1)),
            "--confirm-schema",
            schema,
            "--output-dir",
            output,
          ],
          env: { POUCH_TEST_POSTGRESQL_URL: parsed.toString() },
          postgres: { Client },
        });
        expect(result.targetProof.schema).toBe(schema);
        expect(result.totals.exportedRowCount).toBe(5);
        const cleanup = new Client({ connectionString: testDatabaseUrl });
        await cleanup.connect();
        await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
        await cleanup.end();
      },
    );
  },
);

async function mkdir2(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}
