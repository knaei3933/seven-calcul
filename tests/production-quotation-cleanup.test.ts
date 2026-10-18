import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Client as PgClient, QueryResult } from "pg";
import { runBackup } from "../scripts/backup-quotation-domain";
import {
  runProductionAuthorization,
  runProductionCleanup,
  signAuthorizationEvidence,
  type AuthorizationEvidence,
} from "../scripts/production-cleanup-quotation-domain";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pouch-production-cleanup-"));
const databaseUrl =
  "postgres://backup-user:backup-password@prod-pooler.example.neon.tech:5432/prod_database?sslmode=require";

const primaryKeys: Record<string, string[]> = {
  quotations: ["id"],
  quotation_checklists: ["quotation_id", "audience"],
  film_orders: ["id"],
  film_order_files: ["id"],
  film_order_events: ["id"],
  users: ["id"],
  customers: ["customer_code"],
  sessions: ["token"],
};

const tableNames = Object.keys(primaryKeys).sort();
const domainTables = [
  "film_order_events",
  "film_order_files",
  "film_orders",
  "quotation_checklists",
  "quotations",
];

function initialRows(): Record<string, Record<string, unknown>[]> {
  return {
    quotations: [{
      id: 1,
      quotation_number: "B-001",
      pdf_data: Buffer.from([0, 70, 0, 68, 255]),
      created_by: 7,
    }],
    quotation_checklists: [{
      quotation_id: 1,
      audience: "CUSTOMER",
      snapshot_json: "{}",
    }],
    film_orders: [{ id: 10, quotation_id: 1, order_number: "F-001" }],
    film_order_files: [{ id: 20, order_id: 10, file_name: "proof.pdf" }],
    film_order_events: [{ id: 30, order_id: 10, detail: "uploaded" }],
    users: [{ id: 7, email: "keeper@example.test" }],
    customers: [{ customer_code: "C-001", customer_name: "Keep" }],
    sessions: [{ token: "session-token", user_id: 7 }],
  };
}

const columnShapes: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries(initialRows()).map(([table, rows]) => [table, rows[0]!]),
);

function withPrimaryKey(
  rows: Record<string, unknown>[],
  primaryKey: string,
): Record<string, unknown>[] {
  return rows.map((row) => ({ [primaryKey]: row[primaryKey], ...row }));
}

interface FakeClientOptions {
  queries: string[];
  rows?: Record<string, Record<string, unknown>[]>;
  transactionOpen?: { value: boolean };
  extraForeignKey?: { child: string; parent: string };
  schemaName?: string;
  onQuery?: (sql: string, rows: Map<string, Record<string, unknown>[]>) => void;
  failDeleteTable?: string;
}

class FakeProductionClient {
  readonly rows: Map<string, Record<string, unknown>[]>;
  connectCount = 0;
  endCount = 0;
  locks: string[] = [];
  commits = 0;
  private readonly initial: Record<string, Record<string, unknown>[]>;

  constructor(private readonly options: FakeClientOptions) {
    this.initial = options.rows ?? initialRows();
    this.rows = new Map(
      Object.entries(this.initial).map(([table, values]) => [
        table,
        values.map((value) => ({ ...value })),
      ]),
    );
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.options.queries.push(sql);
    this.options.onQuery?.(sql, this.rows);
    const empty = { rows: [] } as unknown as QueryResult<T>;
    if (sql.startsWith("BEGIN ")) {
      this.options.transactionOpen!.value = true;
      return empty;
    }
    if (sql === "COMMIT") {
      this.commits += 1;
      this.options.transactionOpen!.value = false;
      return empty;
    }
    if (sql === "ROLLBACK") {
      this.options.transactionOpen!.value = false;
      this.rows.clear();
      for (const [table, rows] of Object.entries(this.initial)) {
        this.rows.set(table, rows.map((row) => ({ ...row })));
      }
      return empty;
    }
    if (sql.includes("current_database()")) {
        return {
          rows: [{
            database_name: "prod_database",
            schema_name: this.options.schemaName ?? "public",
          server_version: "PostgreSQL 16.2",
          server_address: "192.0.2.10",
          server_port: "5432",
        }],
      } as unknown as QueryResult<T>;
    }
    if (sql.includes("information_schema.tables")) {
      return {
        rows: tableNames
          .filter((table) => this.rows.has(table))
          .map((table_name) => ({ table_name })),
      } as unknown as QueryResult<T>;
    }
    if (sql.includes("information_schema.columns")) {
      if (/table_name\s*=\s*"/.test(sql)) {
        throw new Error("invalid_postgres_metadata_literal");
      }
      const table = values[0];
      if (typeof table !== "string") {
        throw new Error("unbound_postgres_metadata_parameter");
      }
      return {
        rows: Object.keys(columnShapes[table] ?? {}).map((column_name) => ({
          column_name,
          data_type: "text",
        })),
      } as unknown as QueryResult<T>;
    }
    if (sql.includes("information_schema.table_constraints")) {
      const table = values[0] as string;
      return {
        rows: (primaryKeys[table] ?? []).map((column_name) => ({ column_name })),
      } as unknown as QueryResult<T>;
    }
    if (sql.includes("FROM pg_constraint")) {
      const edges = [
        { child_table: "quotation_checklists", parent_table: "quotations", parent_schema: "public" },
        { child_table: "film_orders", parent_table: "quotations", parent_schema: "public" },
        { child_table: "film_order_files", parent_table: "film_orders", parent_schema: "public" },
        { child_table: "film_order_events", parent_table: "film_orders", parent_schema: "public" },
        { child_table: "quotations", parent_table: "users", parent_schema: "public" },
      ];
      if (this.options.extraForeignKey) edges.push({
        child_table: this.options.extraForeignKey.child,
        parent_table: this.options.extraForeignKey.parent,
        parent_schema: "public",
      });
      return { rows: edges } as unknown as QueryResult<T>;
    }
    if (sql.startsWith("LOCK TABLE ")) {
      this.locks.push(sql);
      return empty;
    }
    if (sql.includes("COUNT(*)")) {
      const table = /FROM\s+"([^"]+)"/.exec(sql)?.[1] ?? "";
      return {
        rows: [{ count: String(this.rows.get(table)?.length ?? 0) }],
      } as unknown as QueryResult<T>;
    }
    if (/^SELECT\s+\*/s.test(sql)) {
      const table = /FROM\s+"([^"]+)"/.exec(sql)?.[1] ?? "";
      const primaryKey = primaryKeys[table]?.[0] ?? "id";
      const all = (this.rows.get(table) ?? []).map(
        (row) => withPrimaryKey([row], primaryKey)[0]!,
      );
      const limit = Number(values[0] ?? all.length);
      const offset = Number(values[1] ?? 0);
      return { rows: all.slice(offset, offset + limit) } as unknown as QueryResult<T>;
    }
    if (sql.startsWith("DELETE FROM")) {
      const table = /FROM\s+"([^"]+)"/.exec(sql)?.[1] ?? "";
      if (table === this.options.failDeleteTable) {
        throw new Error("foreign_key_violation");
      }
      const deleted = this.rows.get(table)?.length ?? 0;
      this.rows.set(table, []);
      return { rowCount: deleted } as unknown as QueryResult<T>;
    }
    return empty;
  }

  async end(): Promise<void> {
    this.endCount += 1;
  }
}

function factory(client: FakeProductionClient): typeof PgClient {
  return function ClientFactory() {
    return client;
  } as unknown as typeof PgClient;
}

function productionArgs(phase: "1" | "2"): string[] {
  return [
    "--phase",
    phase,
    "--target",
    "production",
    "--confirm-host",
    "prod-pooler.example.neon.tech",
    "--confirm-database",
    "prod_database",
    "--confirm-schema",
    "public",
    "--confirm-domain-tables",
    domainTables.join(","),
  ];
}

async function createAuthorization() {
  const outputDirectory = join(temporaryRoot, `run-${Math.random().toString(36).slice(2)}`);
  const authQueries: string[] = [];
  const authClient = new FakeProductionClient({
    queries: authQueries,
    transactionOpen: { value: false },
  });
  const authorization = await runProductionAuthorization({
    args: [
      ...productionArgs("1"),
      "--confirm-production-read-only-backup",
      "--output-dir",
      outputDirectory,
    ],
    env: { DATABASE_URL: databaseUrl },
    postgres: { Client: factory(authClient) },
  });
  const challenge = (await readFile(authorization.challengePath, "utf8")).trim();
  const evidence = JSON.parse(
    await readFile(authorization.authorizationPath, "utf8"),
  ) as AuthorizationEvidence;
  return {
    outputDirectory,
    backup: authorization.backup,
    authorization,
    challenge,
    evidence,
    authQueries,
  };
}

function phase2Args(input: Awaited<ReturnType<typeof createAuthorization>>): string[] {
  return [
    ...productionArgs("2"),
    "--confirm-production-deletion",
    "--backup-manifest",
    input.backup.manifestPath,
    "--authorization-file",
    input.authorization.authorizationPath,
    "--challenge",
    input.challenge,
  ];
}

function phase2FileArgs(input: Awaited<ReturnType<typeof createAuthorization>>): string[] {
  return [
    ...productionArgs("2"),
    "--confirm-production-deletion",
    "--backup-manifest",
    input.backup.manifestPath,
    "--authorization-file",
    input.authorization.authorizationPath,
    "--challenge-file",
    input.authorization.challengePath,
  ];
}

async function rewriteAuthorization(
  input: Awaited<ReturnType<typeof createAuthorization>>,
  mutate: (evidence: AuthorizationEvidence) => void,
): Promise<void> {
  const evidence = JSON.parse(
    await readFile(input.authorization.authorizationPath, "utf8"),
  ) as AuthorizationEvidence;
  mutate(evidence);
  evidence.authorization.evidenceHmacSha256 = signAuthorizationEvidence(
    evidence,
    input.challenge,
  );
  await writeFile(
    input.authorization.authorizationPath,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  await writeFile(
    `${input.backup.manifestPath.slice(0, -".json".length)}.sha256`,
    `${createHash("sha256").update(await readFile(input.backup.manifestPath)).digest("hex")}  manifest.json\n`,
  );
}

afterAll(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("two-phase production quotation cleanup gate", () => {
  it("creates a verified phase-1 backup, evidence, and bounded challenge", async () => {
    const input = await createAuthorization();
    expect(input.backup.totals).toMatchObject({
      sourceRowCount: 5,
      binaryValueCount: 1,
      binaryByteCount: 5,
    });
    expect(input.authorization.outcome).toBe("authorization_created");
    expect(input.evidence.target).toMatchObject({
      requestedTarget: "production",
      host: "prod-pooler.example.neon.tech",
      databaseName: "prod_database",
      schema: "public",
      engineVersion: "PostgreSQL 16.2",
      serverResolvedHost: "192.0.2.10",
    });
    expect(input.evidence.manifest.sha256).toBe(input.backup.manifestSha256);
    expect(input.evidence.manifest.sourceCounts).toEqual({
      film_order_events: 1,
      film_order_files: 1,
      film_orders: 1,
      quotation_checklists: 1,
      quotations: 1,
    });
    expect(input.evidence.manifest.binaryValueCount).toBe(1);
    expect(input.evidence.manifest.binaryByteCount).toBe(5);
    expect(input.evidence.retainedTables.map((table) => table.name)).toEqual([
      "customers",
      "sessions",
      "users",
    ]);
    expect(input.evidence.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(input.evidence.tool.version).not.toBe("");
    expect(Date.parse(input.evidence.expiresAtUtc)).toBeGreaterThan(
      Date.parse(input.evidence.createdAtUtc),
    );
    expect(await readFile(input.authorization.challengePath, "utf8")).toMatch(
      /^[0-9a-f]{64}\n$/,
    );
    const evidenceText = await readFile(input.authorization.authorizationPath, "utf8");
    expect(evidenceText).not.toContain("backup-user");
    expect(evidenceText).not.toContain("backup-password");
    expect(input.authQueries.some((sql) => sql.startsWith("DELETE"))).toBe(false);
  }, 20_000);

  it("refuses phase 2 for missing, mismatched, expired, or tampered authorization before connecting", async () => {
    const input = await createAuthorization();
    const forbidden = new FakeProductionClient({
      queries: [],
      transactionOpen: { value: false },
    });
    const badChallengeArgs = [
      ...phase2Args(input).slice(0, -2),
      "--challenge",
      "0".repeat(64),
    ];
    await expect(
      runProductionCleanup({
        args: badChallengeArgs,
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(forbidden) },
      }),
    ).rejects.toThrow("production_cleanup_challenge_mismatch");
    expect(forbidden.connectCount).toBe(0);

    await expect(
      runProductionCleanup({
        args: phase2Args(input),
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(forbidden) },
        now: () => new Date(Date.parse(input.evidence.expiresAtUtc) + 1),
      }),
    ).rejects.toThrow("authorization_expired_or_not_yet_valid");

    const evidencePath = input.authorization.authorizationPath;
    const original = await readFile(evidencePath);
    const evidence = JSON.parse(original.toString()) as AuthorizationEvidence;
    evidence.manifest.sha256 = "1".repeat(64);
    await writeFile(evidencePath, JSON.stringify(evidence));
    await expect(
      runProductionCleanup({
        args: phase2Args(input),
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(forbidden) },
      }),
    ).rejects.toThrow("authorization_evidence_tampered");
    await writeFile(evidencePath, original);
    expect(forbidden.connectCount).toBe(0);
  }, 20_000);

  it("binds operator schema confirmation to authorization and live target schema", async () => {
    const input = await createAuthorization();
    const wrongConfirmation = phase2Args(input);
    wrongConfirmation[wrongConfirmation.indexOf("--confirm-schema") + 1] = "private";
    const forbidden = new FakeProductionClient({
      queries: [],
      transactionOpen: { value: false },
    });
    await expect(
      runProductionCleanup({
        args: wrongConfirmation,
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(forbidden) },
      }),
    ).rejects.toThrow("authorization_schema_confirmation_mismatch");
    expect(forbidden.connectCount).toBe(0);

    const queries: string[] = [];
    const transactionOpen = { value: false };
    const changedLiveSchema = new FakeProductionClient({
      queries,
      transactionOpen,
      schemaName: "private",
    });
    await expect(
      runProductionCleanup({
        args: phase2Args(input),
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(changedLiveSchema) },
      }),
    ).rejects.toThrow("resolved_production_schema_mismatch");
    expect(queries.some((sql) => sql.startsWith("LOCK TABLE "))).toBe(false);
    expect(queries.some((sql) => sql.startsWith("DELETE FROM"))).toBe(false);
    expect(queries.at(-1)).toBe("ROLLBACK");
  }, 20_000);

  it("revalidates target, manifest, counts, binary totals, retained identity, and commits behind ACCESS EXCLUSIVE", async () => {
    const input = await createAuthorization();
    const queries: string[] = [];
    const transactionOpen = { value: false };
    const client = new FakeProductionClient({ queries, transactionOpen });
    const result = await runProductionCleanup({
      args: phase2FileArgs(input),
      env: { DATABASE_URL: databaseUrl },
      postgres: { Client: factory(client) },
    });
    expect(result.outcome).toBe("deleted");
    expect(result.postCommitVerification).toBe("not_performed");
    expect(result.deletion.isolationLevel).toBe("read-committed");
    expect(result.deletion.writeFence).toBe("access-exclusive");
    expect(client.locks).toEqual([
      'LOCK TABLE "film_order_events", "film_order_files", "film_orders", "quotation_checklists", "quotations" IN ACCESS EXCLUSIVE MODE',
    ]);
    expect(queries.indexOf("COMMIT")).toBeGreaterThan(
      queries.findIndex((sql) => sql.startsWith("LOCK TABLE")),
    );
    expect(queries.filter((sql) => sql.startsWith("DELETE FROM"))).toEqual([
      'DELETE FROM "film_order_events"',
      'DELETE FROM "film_order_files"',
      'DELETE FROM "film_orders"',
      'DELETE FROM "quotation_checklists"',
      'DELETE FROM "quotations"',
    ]);
    expect(client.rows.get("quotations")).toEqual([]);
    expect(client.rows.get("users")?.length).toBe(1);
    expect(result.retainedTables.every((table) => table.unchanged)).toBe(true);
    expect(transactionOpen.value).toBe(false);
  }, 20_000);

  it("rejects and rolls back a concurrent post-challenge insert", async () => {
    const input = await createAuthorization();
    const queries: string[] = [];
    const transactionOpen = { value: false };
    const client = new FakeProductionClient({
      queries,
      transactionOpen,
      onQuery(sql, rows) {
        if (sql.startsWith("LOCK TABLE ")) {
          rows.get("quotations")!.push({
            id: 2,
            quotation_number: "CONCURRENT",
            pdf_data: Buffer.from([1]),
            created_by: 7,
          });
        }
      },
    });
    await expect(
      runProductionCleanup({
        args: phase2Args(input),
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(client) },
      }),
    ).rejects.toThrow("target_backup_row_count_mismatch:quotations");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries.filter((sql) => sql === "ROLLBACK").length).toBe(1);
    expect(queries.some((sql) => sql.startsWith("DELETE FROM"))).toBe(false);
  }, 20_000);

  it("rolls back when a foreign-key constraint rejects deletion", async () => {
    const input = await createAuthorization();
    const queries: string[] = [];
    const transactionOpen = { value: false };
    const client = new FakeProductionClient({
      queries,
      transactionOpen,
      failDeleteTable: "quotations",
    });
    await expect(
      runProductionCleanup({
        args: phase2Args(input),
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(client) },
      }),
    ).rejects.toThrow("foreign_key_violation");
    expect(transactionOpen.value).toBe(false);
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(client.rows.get("quotations")?.length).toBe(1);
    expect(client.rows.get("film_order_events")?.length).toBe(1);
  }, 20_000);

  it("returns non-failed committed warning semantics when opt-in post-commit verification fails", async () => {
    const input = await createAuthorization();
    const queries: string[] = [];
    const transactionOpen = { value: false };
    let committed = false;
    const client = new FakeProductionClient({
      queries,
      transactionOpen,
      onQuery(sql) {
        if (sql === "COMMIT") committed = true;
      },
    });
    const originalCount = client.query.bind(client);
    client.query = async function patchedQuery(sql: string, values: unknown[] = []) {
      if (committed && sql.includes("COUNT(*)")) throw new Error("connection_lost_after_commit");
      return originalCount(sql, values);
    } as typeof client.query;
    const result = await runProductionCleanup({
      args: phase2Args(input),
      env: { DATABASE_URL: databaseUrl },
      postgres: { Client: factory(client) },
      verifyAfterCommit: true,
    });
    expect(result.outcome).toBe("committed_with_post_commit_warning");
    expect(result.postCommitVerification).toBe("warning");
    expect(result.postCommitWarning).toBe("connection_lost_after_commit");
    expect(client.commits).toBe(1);
  }, 20_000);

  it("revalidates binary totals from the manifest and refuses a mismatch before deletion", async () => {
    const input = await createAuthorization();
    const manifest = JSON.parse(await readFile(input.backup.manifestPath, "utf8")) as {
      totals: { binaryValueCount: number };
    };
    manifest.totals.binaryValueCount = 2;
    await writeFile(input.backup.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rewriteAuthorization(input, () => undefined);
    const client = new FakeProductionClient({
      queries: [],
      transactionOpen: { value: false },
    });
    await expect(
      runProductionCleanup({
        args: phase2Args(input),
        env: { DATABASE_URL: databaseUrl },
        postgres: { Client: factory(client) },
      }),
    ).rejects.toThrow("backup_manifest_total_mismatch");
    expect(client.connectCount).toBe(1);
    expect(client.rows.get("quotations")?.length).toBe(1);
  }, 20_000);

  it("applies cleanup transport rules to production backup targets", async () => {
    class ForbiddenClient {
      async connect(): Promise<void> {
        throw new Error("must_not_connect");
      }
    }
    const invalidUrls = [
      "postgres://u:p@localhost:5432/prod?sslmode=require",
      "postgres://u:p@10.0.0.1:5432/prod?sslmode=require",
      "postgres://u:p@prod.neon.tech.evil.test:5432/prod?sslmode=require",
      "postgres://u:p@prod-pooler.example.neon.tech:5432/prod?sslmode=prefer",
      "postgres://u:p@prod-pooler.example.neon.tech:5432/prod?application_name=x&sslmode=require",
      "postgres://u:p@prod-pooler.example.neon.tech:5432/test_database?sslmode=require",
    ];
    for (const url of invalidUrls) {
      await expect(
        runBackup({
          args: [
            "--target",
            "production",
            "--confirm-production-read-only-backup",
            "--confirm-host",
            new URL(url).hostname,
            "--confirm-database",
            new URL(url).pathname.slice(1),
            "--output-dir",
            join(temporaryRoot, "forbidden"),
          ],
          env: { DATABASE_URL: url },
          postgres: { Client: ForbiddenClient as unknown as typeof PgClient },
        }),
      ).rejects.toThrow();
    }
  });
});
