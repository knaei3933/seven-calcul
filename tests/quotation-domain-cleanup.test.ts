import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runBackup } from "../scripts/backup-quotation-domain";
import {
  createTargetSnapshotForTest,
  deleteQuotationDomain,
  isDirectExecution,
  runCleanup,
  main as runCleanupMain,
} from "../scripts/cleanup-quotation-domain";

const temporaryRoot = await mkdtemp(join(tmpdir(), "pouch-domain-cleanup-"));
const databasePath = join(temporaryRoot, "quotations.db");
const customerPath = join(temporaryRoot, "customers.db");
const environment = { POUCH_QUOTATION_DB: databasePath };

const database = new DatabaseSync(databasePath);
createSchema(database);
seedDatabase(database);

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL
    );
    CREATE TABLE film_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unit_price TEXT NOT NULL
    );
    CREATE TABLE calculation_master_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_number TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id)
    );
    CREATE TABLE quotation_checklists (
      quotation_id INTEGER NOT NULL REFERENCES quotations(id),
      audience TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (quotation_id, audience)
    );
    CREATE TABLE film_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_id INTEGER NOT NULL REFERENCES quotations(id),
      quotation_number TEXT NOT NULL
    );
    CREATE TABLE film_order_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL
    );
    CREATE TABLE film_order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
      detail TEXT NOT NULL
    );
  `);
}

function seedDatabase(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO users VALUES (1, 'keeper@example.test', 'test-password-hash');
    INSERT INTO sessions VALUES (1, 1, 'session-token-hash');
    INSERT INTO film_prices VALUES (1, '100');
    INSERT INTO calculation_master_snapshots VALUES (1, '{"snapshot":"keep"}');
    INSERT INTO quotations VALUES (1, 'B-001', '{"quotation":1}', 1);
    INSERT INTO quotations VALUES (2, 'B-002', '{"quotation":2}', 1);
    INSERT INTO quotation_checklists VALUES (1, 'CUSTOMER', '{"items":[1]}');
    INSERT INTO quotation_checklists VALUES (2, 'INTERNAL_QA', '{"items":[2]}');
    INSERT INTO film_orders VALUES (10, 1, 'B-001');
    INSERT INTO film_orders VALUES (11, 2, 'B-002');
    INSERT INTO film_order_files VALUES (20, 10, 'receiving.pdf');
    INSERT INTO film_order_files VALUES (21, 10, 'proof.pdf');
    INSERT INTO film_order_files VALUES (22, 11, 'final.pdf');
    INSERT INTO film_order_events VALUES (30, 10, 'created');
    INSERT INTO film_order_events VALUES (31, 10, 'ordered');
    INSERT INTO film_order_events VALUES (32, 11, 'created');
    INSERT INTO film_order_events VALUES (33, 11, 'approved');
  `);
}

async function makeVerifiedBackup(
  name: string,
  targetPath: string = databasePath,
): Promise<string> {
  const output = join(temporaryRoot, name);
  const result = await runBackup({
    args: ["--target", "local", "--output-dir", output],
    env: { POUCH_QUOTATION_DB: targetPath },
  });
  expect(result.safety.destructiveOperations).toBe("none");
  return result.manifestPath;
}

function cleanupArgs(manifestPath: string, targetPath: string = databasePath): string[] {
  return [
    "--target",
    "local",
    "--db",
    targetPath,
    "--confirm-db",
    targetPath,
    "--backup-manifest",
    manifestPath,
    "--confirm-domain-tables",
    "film_order_files,film_order_events,film_orders,quotation_checklists,quotations",
    "--confirm-local-deletion",
  ];
}

async function rowCount(path: string, table: string): Promise<number> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    );
  } finally {
    database.close();
  }
}

async function rowCounts(
  path: string,
  tables: string[],
): Promise<Record<string, number>> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(tables.map((table) => [
      table,
      Number(
        (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      ),
    ]));
  } finally {
    database.close();
  }
}

afterAll(async () => {
  database.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("quotation domain local cleanup", () => {
  it("uses exact CLI entry detection and owner-only temporary evidence", async () => {
    const cleanupModulePath = new URL(
      "../scripts/cleanup-quotation-domain.ts",
      import.meta.url,
    ).pathname;
    const cleanupModuleUrl = pathToFileURL(cleanupModulePath).href;
    expect(isDirectExecution(`${cleanupModulePath}-lookalike`, cleanupModuleUrl)).toBe(false);
    expect(isDirectExecution(
      cleanupModulePath,
      cleanupModuleUrl,
    )).toBe(true);
    expect(isDirectExecution(
      join("scripts", "cleanup-quotation-domain.ts"),
      cleanupModuleUrl,
    )).toBe(false);

    const proof = await createTargetSnapshotForTest(databasePath);
    const directoryMode = (await stat(proof.evidenceDirectory)).mode & 0o777;
    const snapshotMode = (await stat(proof.snapshotPath)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(snapshotMode).toBe(0o600);
    expect(directoryMode & 0o077).toBe(0);
    expect(snapshotMode & 0o077).toBe(0);
    await rm(proof.evidenceDirectory, { recursive: true, force: true });
  });

  it("rolls back all deletions when a rollbackable pre-commit check fails and removes evidence", async () => {
    const rollbackRoot = join(temporaryRoot, "rollback-target");
    await mkdir(rollbackRoot);
    const rollbackPath = join(rollbackRoot, "quotations.db");
    const rollback = new DatabaseSync(rollbackPath);
    createSchema(rollback);
    seedDatabase(rollback);
    rollback.exec(`
      CREATE TRIGGER abort_cleanup_before_commit
      BEFORE DELETE ON film_order_events
      BEGIN
        SELECT RAISE(ABORT, 'rollbackable_pre_commit_failure');
      END;
    `);
    rollback.close();
    const manifestPath = await makeVerifiedBackup("rollback-backup", rollbackPath);
    let evidenceDirectory: string | undefined;

    const cleanupOutcome = await runCleanup({
        args: cleanupArgs(manifestPath, rollbackPath),
        env: { POUCH_QUOTATION_DB: rollbackPath },
        onSnapshotCreated: (createdDirectory) => {
          evidenceDirectory = createdDirectory;
        },
    }).then(
      () => "resolved",
      (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
    );
    expect(cleanupOutcome).toBe("rejected:rollbackable_pre_commit_failure");
    expect(await rowCounts(rollbackPath, [
      "quotations",
      "film_orders",
      "film_order_events",
      "users",
    ])).toEqual({
      quotations: 2,
      film_orders: 2,
      film_order_events: 4,
      users: 1,
    });

    await expect(stat(evidenceDirectory!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a committed warning with exit code 3 when only post-commit verification fails", async () => {
    const warningRoot = join(temporaryRoot, "warning-target");
    await mkdir(warningRoot);
    const warningPath = join(warningRoot, "quotations.db");
    const warningDatabase = new DatabaseSync(warningPath);
    createSchema(warningDatabase);
    seedDatabase(warningDatabase);
    warningDatabase.close();
    const manifestPath = await makeVerifiedBackup("post-commit-warning-backup", warningPath);
    const originalExitCode = process.exitCode;
    const stdout = process.stdout.write.bind(process.stdout);
    let output = "";
    process.stdout.write = ((chunk: Uint8Array | string) => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    try {
      await runCleanupMain(
        cleanupArgs(manifestPath, warningPath),
        {
          env: { POUCH_QUOTATION_DB: warningPath },
          verifyAfterCommit: async () => {
            throw new Error("connection_lost_after_commit");
          },
        },
      );
      const result = JSON.parse(output) as {
        outcome: string;
        postCommitVerification: string;
        postCommitWarning: string;
      };
      expect(result.outcome).toBe("committed_with_post_commit_warning");
      expect(result.postCommitVerification).toBe("warning");
      expect(result.postCommitWarning).toBe("connection_lost_after_commit");
      expect(process.exitCode).toBe(3);
      expect(await rowCount(warningPath, "quotations")).toBe(0);
      expect(await rowCount(warningPath, "film_order_events")).toBe(0);
      expect(await rowCount(warningPath, "users")).toBe(1);
    } finally {
      process.stdout.write = stdout;
      process.exitCode = originalExitCode;
    }
  });

  it("deletes grandchildren before parents and keeps quotation ordering exact", async () => {
    const orderingPath = join(temporaryRoot, "ordering.sqlite");
    const ordering = new DatabaseSync(orderingPath);
    try {
      createSchema(ordering);
      ordering.exec(`
        INSERT INTO users VALUES (1, 'order@example.test', 'hash');
        INSERT INTO quotations VALUES (1, 'B-ORDER', '{}', 1);
        INSERT INTO quotation_checklists VALUES (1, 'CUSTOMER', '{}');
        INSERT INTO film_orders VALUES (10, 1, 'B-ORDER');
        INSERT INTO film_order_files VALUES (20, 10, 'file.pdf');
        INSERT INTO film_order_events VALUES (30, 10, 'event');
      `);
      ordering.exec(`
        CREATE TEMP TABLE deletion_order (position INTEGER PRIMARY KEY, table_name TEXT NOT NULL);
        CREATE TEMP TRIGGER notify_files AFTER DELETE ON main.film_order_files
        BEGIN INSERT INTO deletion_order(table_name) VALUES ('film_order_files'); END;
        CREATE TEMP TRIGGER notify_events AFTER DELETE ON main.film_order_events
        BEGIN INSERT INTO deletion_order(table_name) VALUES ('film_order_events'); END;
        CREATE TEMP TRIGGER notify_orders AFTER DELETE ON main.film_orders
        BEGIN INSERT INTO deletion_order(table_name) VALUES ('film_orders'); END;
        CREATE TEMP TRIGGER notify_checklists AFTER DELETE ON main.quotation_checklists
        BEGIN INSERT INTO deletion_order(table_name) VALUES ('quotation_checklists'); END;
        CREATE TEMP TRIGGER notify_quotations AFTER DELETE ON main.quotations
        BEGIN INSERT INTO deletion_order(table_name) VALUES ('quotations'); END;
        BEGIN;
      `);
      await deleteQuotationDomain(ordering);
      const order = ordering
        .prepare("SELECT table_name FROM deletion_order ORDER BY position")
        .all()
        .map((row) => (row as { table_name: string }).table_name);
      expect(order).toEqual([
        "film_order_files",
        "film_order_events",
        "film_orders",
        "quotation_checklists",
        "quotations",
      ]);
      ordering.exec("ROLLBACK");
    } finally {
      ordering.close();
      await rm(orderingPath, { force: true });
    }
  });

  it("refuses without the explicit confirmation and exact target flags", async () => {
    const manifestPath = await makeVerifiedBackup("refused-confirm-backup");
    const args = cleanupArgs(manifestPath).filter((argument) => argument !== "--confirm-local-deletion");
    await expect(runCleanup({ args, env: environment })).rejects.toThrow(
      "requires_confirm_local_deletion",
    );
    const mismatched = cleanupArgs(manifestPath).map((argument) =>
      argument === databasePath && !args.includes(argument) ? argument : argument,
    );
    mismatched[mismatched.indexOf("--db") + 1] = `${databasePath}-not-exact`;
    await expect(runCleanup({ args: mismatched, env: environment })).rejects.toThrow(
      "local_target_proof_mismatch",
    );
  });

  it("refuses a missing or tampered backup manifest", async () => {
    await expect(
      runCleanup({
        args: cleanupArgs(join(temporaryRoot, "missing", "manifest.json")),
        env: environment,
      }),
    ).rejects.toThrow("backup_manifest_not_found");

    const manifestPath = await makeVerifiedBackup("tampered-backup");
    const tablePath = join(manifestPath, "..", "film_order_files.jsonl");
    const original = await readFile(tablePath);
    await writeFile(tablePath, Buffer.concat([original, Buffer.from("{}\n")]));
    await expect(runCleanup({ args: cleanupArgs(manifestPath), env: environment })).rejects.toThrow(
      "backup_artifact_checksum_mismatch:film_order_files",
    );
    await writeFile(tablePath, original);
  });

  it("refuses when the live target identity no longer matches the manifest", async () => {
    const manifestPath = await makeVerifiedBackup("stale-target-backup");
    database.exec(`
      INSERT INTO quotations (id, quotation_number, payload_json, created_by)
      VALUES (99, 'B-AFTER-BACKUP', '{}', 1)
    `);
    await expect(runCleanup({ args: cleanupArgs(manifestPath), env: environment })).rejects.toThrow(
      "target_identity_snapshot_hash_mismatch",
    );
    database.exec("DELETE FROM quotations WHERE id = 99");
  });

  it("refuses an undeclared FK-dependent table outside the confirmed domain", async () => {
    database.exec(`
      CREATE TABLE extra_quotation_children (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quotation_id INTEGER NOT NULL REFERENCES quotations(id)
      );
      INSERT INTO extra_quotation_children VALUES (1, 1);
    `);
    const manifestPath = await makeVerifiedBackup("extra-dependent-backup");
    await expect(runCleanup({ args: cleanupArgs(manifestPath), env: environment })).rejects.toThrow(
      "undeclared_quotation_domain_dependent_table:extra_quotation_children",
    );
    database.exec("DROP TABLE extra_quotation_children");
  });

  it("creates a gated transactional cleanup while preserving retained identity", async () => {
    const customers = new DatabaseSync(customerPath);
    customers.exec(`
      CREATE TABLE customers (
        customer_code TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL
      );
      INSERT INTO customers VALUES ('C-001', 'Customer To Keep');
    `);
    customers.close();

    const manifestPath = await makeVerifiedBackup("successful-cleanup");
    const before = {
      quotation: await rowCount(databasePath, "quotations"),
      checklist: await rowCount(databasePath, "quotation_checklists"),
      filmOrder: await rowCount(databasePath, "film_orders"),
      filmOrderFile: await rowCount(databasePath, "film_order_files"),
      filmOrderEvent: await rowCount(databasePath, "film_order_events"),
      user: await rowCount(databasePath, "users"),
      customer: await rowCount(customerPath, "customers"),
    };
    expect(before).toMatchObject({
      quotation: 2,
      checklist: 2,
      filmOrder: 2,
      filmOrderFile: 3,
      filmOrderEvent: 4,
      user: 1,
      customer: 1,
    });

    const result = await runCleanup({ args: cleanupArgs(manifestPath), env: environment });
    expect(result.outcome).toBe("deleted");
    expect(result.backup.manifestPath).toBe(manifestPath);
    expect(result.backup.sourceCounts).toEqual({
      quotations: 2,
      quotation_checklists: 2,
      film_orders: 2,
      film_order_files: 3,
      film_order_events: 4,
    });
    expect(result.deletion.order).toEqual([
      "film_order_files",
      "film_order_events",
      "film_orders",
      "quotation_checklists",
      "quotations",
    ]);
    expect(result.deletion.deletedRowCount).toEqual({
      film_order_files: 3,
      film_order_events: 4,
      film_orders: 2,
      quotation_checklists: 2,
      quotations: 2,
    });
    expect(result.domainTables.every((table) => table.before > 0 && table.after === 0)).toBe(true);
    expect(result.retainedTables.map((table) => table.name)).toEqual([
      "calculation_master_snapshots",
      "film_prices",
      "sessions",
      "users",
    ]);
    expect(
      result.retainedTables.every(
        (table) =>
          table.unchanged &&
          table.before.rowCount === table.after.rowCount &&
          table.before.identitySha256 === table.after.identitySha256,
      ),
    ).toBe(true);
    expect(result.retainedDatabases[0].unchanged).toBe(true);
    expect(result.retainedDatabases[0].before.tables[0].rowCount).toBe(1);

    expect(await rowCount(databasePath, "quotations")).toBe(0);
    expect(await rowCount(databasePath, "quotation_checklists")).toBe(0);
    expect(await rowCount(databasePath, "film_orders")).toBe(0);
    expect(await rowCount(databasePath, "film_order_files")).toBe(0);
    expect(await rowCount(databasePath, "film_order_events")).toBe(0);
    expect(await rowCount(databasePath, "users")).toBe(1);
    expect(await rowCount(customerPath, "customers")).toBe(1);
  });
});
