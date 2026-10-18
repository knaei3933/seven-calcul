#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { ObjectEncodingOptions } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

const DOMAIN_DELETION_ORDER = [
  "film_order_files",
  "film_order_events",
  "film_orders",
  "quotation_checklists",
  "quotations",
] as const;

type DomainTable = (typeof DOMAIN_DELETION_ORDER)[number];
type DatabaseRow = Record<string, unknown>;

interface ManifestTable {
  name: string;
  file: string;
  columns: Array<{ name: string }>;
  sourceRowCount: number;
  exportedRowCount: number;
  recordCount: number;
  dataSha256: string;
  recordSha256: string[];
  verified: boolean;
}

interface CleanupManifest {
  outputDirectory: string;
  manifestPath?: string;
  tables: ManifestTable[];
  totals?: { sourceRowCount?: number; exportedRowCount?: number };
  targetProof: {
    requestedTarget: string;
    resolvedTarget: string;
    engine: string;
    engineVersion: string;
    databaseName: string;
    databaseFile?: {
      path: string;
      inode: number | null;
      consistentSnapshotSha256: string;
    };
  };
  scope?: {
    rootTable?: string;
    tables?: Array<{ name: string }>;
  };
  safety?: { destructiveOperations?: string };
}

interface TableIdentity {
  name: string;
  rowCount: number;
  identitySha256: string;
}

interface ExternalDatabaseIdentity {
  path: string;
  present: boolean;
  byteSize: number | null;
  inode: number | null;
  fileSha256: string | null;
  tables: TableIdentity[];
}

export interface CleanupResult {
  outcome: "deleted" | "committed_with_post_commit_warning";
  target: {
    path: string;
    inode: number | null;
    manifestPath: string;
    manifestSha256: string;
    sourceSnapshotSha256: string;
  };
  backup: {
    manifestPath: string;
    manifestSha256: string;
    sourceCounts: Record<DomainTable, number>;
  };
  deletion: {
    order: DomainTable[];
    deletedRowCount: Record<DomainTable, number>;
    transaction: "committed";
    foreignKeysEnabled: boolean;
    foreignKeyViolations: number;
    integrityCheck: "ok";
  };
  domainTables: Array<{ name: DomainTable; before: number; after: 0 }>;
  retainedTables: Array<{
    name: string;
    before: TableIdentity;
    after: TableIdentity;
    unchanged: true;
  }>;
  retainedDatabases: Array<{
    path: string;
    before: ExternalDatabaseIdentity;
    after: ExternalDatabaseIdentity;
    unchanged: true;
  }>;
  postCommitVerification: "verified" | "warning";
  postCommitWarning?: string;
}

export interface CleanupOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  verifyAfterCommit?: () => Promise<void>;
  onSnapshotCreated?: (evidenceDirectory: string) => void;
}

class QuotationCleanupError extends Error {}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier))
    throw new QuotationCleanupError("invalid_database_identifier");
  return `"${identifier}"`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {};
  const valueKeys = new Set([
    "db",
    "confirm-db",
    "backup-manifest",
    "confirm-domain-tables",
    "target",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new QuotationCleanupError(`unknown_argument:${argument ?? ""}`);
    const key = argument.slice(2);
    if (!(key in parsed)) {
      if (valueKeys.has(key)) {
        const value = argv[++index];
        if (!value) throw new QuotationCleanupError(`missing_value:${key}`);
        parsed[key] = value;
      } else if (
        key === "confirm-local-deletion"
      ) {
        parsed[key] = true;
      } else {
        throw new QuotationCleanupError(`unknown_argument:${argument}`);
      }
    } else {
      throw new QuotationCleanupError(`duplicate_argument:${key}`);
    }
  }
  return parsed;
}

function requireString(parsed: Record<string, string | true>, key: string): string {
  const value = parsed[key];
  if (typeof value !== "string" || !value.trim())
    throw new QuotationCleanupError(`missing_required_argument:${key}`);
  return value;
}

function localDatabasePath(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  return resolve(cwd, env.POUCH_QUOTATION_DB || join(".data", "quotations.db"));
}

function fileStat(path: string) {
  return stat(path);
}

function encodedValue(value: unknown): string {
  if (value === null) return "n:";
  if (typeof value === "bigint") return `i:${value}`;
  if (typeof value === "number")
    return Number.isFinite(value) ? `d:${value}` : `s:${String(value)}`;
  if (typeof value === "string") return `t:${value.length}:${value}`;
  if (value instanceof Uint8Array)
    return `b:${Buffer.from(value).toString("base64")}`;
  return `j:${JSON.stringify(value)}`;
}

function applicationTables(database: DatabaseSync): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  const rows = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as Array<Record<string, unknown>>;
  if (!rows.length) throw new QuotationCleanupError(`required_table_missing:${table}`);
  return rows.map((row) => String(row.name));
}

function tableOrderColumns(database: DatabaseSync, table: string): string[] {
  const rows = database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
    .all() as Array<Record<string, unknown>>;
  const primaryKey = rows
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  return primaryKey.length ? primaryKey : ["rowid"];
}

function tableIdentity(
  database: DatabaseSync,
  table: string,
): TableIdentity {
  const columns = tableColumns(database, table);
  const order = tableOrderColumns(database, table);
  const countRow = database
    .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`)
    .get() as { count: number | bigint };
  const rowCount = Number(countRow.count);
  const rows = database
    .prepare(
      `SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${order.map(quoteIdentifier).join(", ")}`,
    )
    .all() as DatabaseRow[];
  const hash = createHash("sha256");
  hash.update(`table\0${table}\0columns\0${columns.join("\0")}\0count\0${rowCount}\0`);
  for (const row of rows) {
    hash.update("row\0");
    for (const column of columns) {
      hash.update(`${column}\0${encodedValue(row[column])}\0`);
    }
  }
  return { name: table, rowCount, identitySha256: hash.digest("hex") };
}

function foreignKeys(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
    .all()
    .map((row) => String((row as { table: unknown }).table));
}

function assertNoUndeclaredDomainDependents(
  database: DatabaseSync,
  domainTables: ReadonlySet<string>,
): void {
  const tables = applicationTables(database);
  for (const table of tables) {
    for (const required of DOMAIN_DELETION_ORDER) {
      if (!tables.includes(required))
        throw new QuotationCleanupError(`required_quotation_domain_table_missing:${required}`);
    }
  }
  for (const child of tables) {
    if (domainTables.has(child)) continue;
    const visited = new Set<string>();
    const stack = [...foreignKeys(database, child)];
    while (stack.length) {
      const parent = stack.pop()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      if (domainTables.has(parent))
        throw new QuotationCleanupError(`undeclared_quotation_domain_dependent_table:${child}`);
      if (tables.includes(parent)) stack.push(...foreignKeys(database, parent));
    }
  }
}

function externalDatabasePath(targetPath: string): string {
  return resolve(dirname(targetPath), "customers.db");
}

async function externalDatabaseIdentity(
  path: string,
): Promise<ExternalDatabaseIdentity> {
  try {
    const [file, bytes] = await Promise.all([stat(path), readFile(path)]);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        path,
        present: true,
        byteSize: file.size,
        inode: Number.isSafeInteger(file.ino) ? file.ino : null,
        fileSha256: sha256Hex(bytes),
        tables: applicationTables(database).map((table) =>
          tableIdentity(database, table),
        ),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        path,
        present: false,
        byteSize: null,
        inode: null,
        fileSha256: null,
        tables: [],
      };
    }
    throw error;
  }
}

async function createTargetSnapshot(
  targetPath: string,
): Promise<{
  evidenceDirectory: string;
  snapshotPath: string;
  snapshotSha256: string;
  inode: number | null;
  engineVersion: string;
}> {
  const evidenceDirectory = await mkdtemp(
    join(tmpdir(), "quotation-cleanup-proof-"),
    { mode: 0o700 } as unknown as ObjectEncodingOptions,
  );
  await chmod(evidenceDirectory, 0o700);
  const snapshotPath = join(evidenceDirectory, "target.sqlite");
  let source: DatabaseSync;
  try {
    source = new DatabaseSync(targetPath, { readOnly: true });
  } catch (error) {
    await removeTargetSnapshot(evidenceDirectory);
    throw error;
  }
  try {
    try {
      await sqliteBackup(source, snapshotPath);
      await chmod(snapshotPath, 0o600);
    } finally {
      source.close();
    }
    const database = new DatabaseSync(snapshotPath, { readOnly: true });
    let engineVersion: string;
    try {
      engineVersion = `SQLite ${
        (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version
      }`;
    } finally {
      database.close();
    }
    const bytes = await readFile(snapshotPath);
    const file = await stat(targetPath);
    return {
      evidenceDirectory,
      snapshotPath,
      snapshotSha256: sha256Hex(bytes),
      inode: Number.isSafeInteger(file.ino) ? file.ino : null,
      engineVersion,
    };
  } catch (error) {
    await removeTargetSnapshot(evidenceDirectory);
    throw error;
  }
}

async function removeTargetSnapshot(snapshotPath: string): Promise<void> {
  await rm(snapshotPath, { recursive: true, force: true });
}

export async function createTargetSnapshotForTest(targetPath: string) {
  return createTargetSnapshot(targetPath);
}

async function readManifest(manifestPath: string): Promise<{ manifest: CleanupManifest; manifestSha256: string }> {
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch {
    throw new QuotationCleanupError(`backup_manifest_not_found:${manifestPath}`);
  }
  const manifestSha256 = sha256Hex(manifestBytes);
  const sidecarBytes = await readFile(`${manifestPath.slice(0, -".json".length)}.sha256`, "utf8");
  if (sidecarBytes !== `${manifestSha256}  manifest.json\n`)
    throw new QuotationCleanupError("backup_manifest_checksum_mismatch");
  let manifest: CleanupManifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as CleanupManifest;
  } catch {
    throw new QuotationCleanupError("backup_manifest_invalid_json");
  }
  return { manifest, manifestSha256 };
}

async function verifyBackupArtifacts(
  manifest: CleanupManifest,
  manifestPath: string,
): Promise<Record<DomainTable, number>> {
  const directory = dirname(manifestPath);
  if (manifest.targetProof.requestedTarget !== "local")
    throw new QuotationCleanupError("backup_manifest_is_not_local");
  if (manifest.targetProof.resolvedTarget !== "sqlite-local")
    throw new QuotationCleanupError("backup_manifest_is_not_sqlite_local");
  if (manifest.targetProof.engine !== "SQLite")
    throw new QuotationCleanupError("backup_manifest_is_not_sqlite");
  if (manifest.safety?.destructiveOperations !== "none")
    throw new QuotationCleanupError("backup_manifest_destructive_operations_mismatch");
  if (manifest.scope?.rootTable !== "quotations")
    throw new QuotationCleanupError("backup_manifest_root_mismatch");
  const manifestNames = manifest.tables.map((table) => table.name);
  if (JSON.stringify([...manifestNames].sort()) !== JSON.stringify([...DOMAIN_DELETION_ORDER].sort()))
    throw new QuotationCleanupError("backup_manifest_domain_table_mismatch");

  const sourceCounts = {} as Record<DomainTable, number>;
  let totalRows = 0;
  for (const table of manifest.tables) {
    const expectedFile = `${table.name}.jsonl`;
    if (table.file !== expectedFile || !table.verified)
      throw new QuotationCleanupError(`backup_artifact_metadata_invalid:${table.name}`);
    const path = resolve(directory, table.file);
    if (!path.startsWith(`${resolve(directory)}/`) || path !== join(directory, expectedFile))
      throw new QuotationCleanupError(`backup_artifact_path_invalid:${table.name}`);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new QuotationCleanupError(`backup_artifact_not_found:${table.name}`);
    }
    if (sha256Hex(bytes) !== table.dataSha256)
      throw new QuotationCleanupError(`backup_artifact_checksum_mismatch:${table.name}`);
    const lines = bytes.byteLength === 0 ? [] : bytes.toString("utf8").split("\n").slice(0, -1);
    if (
      lines.length !== table.sourceRowCount ||
      table.exportedRowCount !== table.sourceRowCount ||
      table.recordCount !== table.sourceRowCount ||
      lines.length !== table.recordSha256.length
    )
      throw new QuotationCleanupError(`backup_artifact_row_count_mismatch:${table.name}`);
    for (const [index, line] of lines.entries()) {
      const lineWithNewline = `${line}\n`;
      if (sha256Hex(Buffer.from(lineWithNewline, "utf8")) !== table.recordSha256[index])
        throw new QuotationCleanupError(`backup_artifact_record_checksum_mismatch:${table.name}:${index}`);
      const record = JSON.parse(line) as { table?: string; columns?: string[]; values?: unknown[] };
      if (
        record.table !== table.name ||
        JSON.stringify(record.columns ?? []) !== JSON.stringify(table.columns.map((column) => column.name)) ||
        record.values?.length !== table.columns.length
      )
        throw new QuotationCleanupError(`backup_artifact_record_shape_mismatch:${table.name}:${index}`);
    }
    sourceCounts[table.name as DomainTable] = table.sourceRowCount;
    totalRows += table.sourceRowCount;
  }
  if (manifest.totals && (manifest.totals.sourceRowCount !== totalRows || manifest.totals.exportedRowCount !== totalRows))
    throw new QuotationCleanupError("backup_manifest_total_row_count_mismatch");
  return sourceCounts;
}

function assertTargetMatchesManifest(input: {
  manifest: CleanupManifest;
  manifestPath: string;
  targetPath: string;
}): void {
  const proof = input.manifest.targetProof;
  if (proof.databaseName !== input.targetPath || proof.databaseFile?.path !== input.targetPath)
    throw new QuotationCleanupError("target_identity_path_mismatch");
  if (dirname(input.manifestPath) !== input.manifest.outputDirectory)
    throw new QuotationCleanupError("backup_manifest_directory_mismatch");
}

function identitiesMatch(
  before: TableIdentity[],
  after: TableIdentity[],
): void {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new QuotationCleanupError("retained_table_identity_changed");
}

export async function deleteQuotationDomain(
  database: DatabaseSync,
): Promise<Record<DomainTable, number>> {
  const deleted: Partial<Record<DomainTable, number>> = {};
  for (const table of DOMAIN_DELETION_ORDER) {
    const result = database.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
    deleted[table] = Number(result.changes);
  }
  return deleted as Record<DomainTable, number>;
}

async function cleanupDatabase(
  targetPath: string,
  manifest: CleanupManifest,
  sourceCounts: Record<DomainTable, number>,
  options: Pick<CleanupOptions, "onSnapshotCreated" | "verifyAfterCommit"> = {},
): Promise<Omit<CleanupResult, "backup" | "target">> {
  const proof = await createTargetSnapshot(targetPath);
  const expectedSnapshotHash = manifest.targetProof.databaseFile?.consistentSnapshotSha256;
  try {
    options.onSnapshotCreated?.(proof.evidenceDirectory);
    if (!expectedSnapshotHash || proof.snapshotSha256 !== expectedSnapshotHash)
      throw new QuotationCleanupError("target_identity_snapshot_hash_mismatch");
    if (proof.inode !== manifest.targetProof.databaseFile?.inode)
      throw new QuotationCleanupError("target_identity_inode_mismatch");
    if (proof.engineVersion !== manifest.targetProof.engineVersion)
      throw new QuotationCleanupError("target_identity_engine_mismatch");

    const proofDatabase = new DatabaseSync(proof.snapshotPath, { readOnly: true });
    let beforeDomain: Array<TableIdentity>;
    let beforeRetained: Array<TableIdentity>;
    try {
      const tables = applicationTables(proofDatabase);
      for (const table of DOMAIN_DELETION_ORDER) {
        if (!tables.includes(table))
          throw new QuotationCleanupError(`required_quotation_domain_table_missing:${table}`);
      }
      assertNoUndeclaredDomainDependents(proofDatabase, new Set(DOMAIN_DELETION_ORDER));
      const identities = tables.map((table) => tableIdentity(proofDatabase, table));
      beforeDomain = identities.filter((identity) =>
        (DOMAIN_DELETION_ORDER as readonly string[]).includes(identity.name),
      ) as Array<TableIdentity>;
      beforeRetained = identities.filter(
        (identity) => !(DOMAIN_DELETION_ORDER as readonly string[]).includes(identity.name),
      );
      for (const identity of beforeDomain) {
        if (identity.rowCount !== sourceCounts[identity.name as DomainTable])
          throw new QuotationCleanupError(`target_source_count_mismatch:${identity.name}`);
      }
    } finally {
      proofDatabase.close();
    }

    const customerPath = externalDatabasePath(targetPath);
    const customerBefore = await externalDatabaseIdentity(customerPath);
    const database = new DatabaseSync(targetPath);
    let deleted: Record<DomainTable, number>;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("BEGIN IMMEDIATE");
      try {
        const transactionDomain = applicationTables(database)
          .filter((table) => (DOMAIN_DELETION_ORDER as readonly string[]).includes(table))
          .map((table) => tableIdentity(database, table))
          .sort((left, right) => left.name.localeCompare(right.name));
        identitiesMatch(beforeDomain, transactionDomain);
        const transactionRetained = applicationTables(database)
          .filter((table) => !(DOMAIN_DELETION_ORDER as readonly string[]).includes(table))
          .map((table) => tableIdentity(database, table));
        identitiesMatch(beforeRetained, transactionRetained);
        assertNoUndeclaredDomainDependents(database, new Set(DOMAIN_DELETION_ORDER));
        deleted = await deleteQuotationDomain(database);
        const postRetained = applicationTables(database)
          .filter((table) => !(DOMAIN_DELETION_ORDER as readonly string[]).includes(table))
          .map((table) => tableIdentity(database, table));
        identitiesMatch(beforeRetained, postRetained);
        const violations = database.prepare("PRAGMA foreign_key_check").all();
        if (violations.length) throw new QuotationCleanupError("foreign_key_violations_after_deletion");
        const transactionIntegrityCheck = String(
          (database.prepare("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check,
        );
        if (transactionIntegrityCheck !== "ok")
          throw new QuotationCleanupError("database_integrity_check_failed");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }

    const verification = new DatabaseSync(targetPath, { readOnly: true });
    let postRetained: TableIdentity[] = [];
    let postDomain: TableIdentity[] = [];
    let foreignKeyViolations = 0;
    let integrityCheck = "unknown";
    let postCommitWarning: string | undefined;
    let postCommitCustomerAfter = customerBefore;
    try {
      const identities = applicationTables(verification).map((table) =>
        tableIdentity(verification, table),
      );
      postDomain = identities.filter((identity) =>
        (DOMAIN_DELETION_ORDER as readonly string[]).includes(identity.name),
      ) as Array<TableIdentity>;
      postRetained = identities.filter(
        (identity) => !(DOMAIN_DELETION_ORDER as readonly string[]).includes(identity.name),
      );
      foreignKeyViolations = verification.prepare("PRAGMA foreign_key_check").all().length;
      integrityCheck = String(
        (verification.prepare("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check,
      );
      identitiesMatch(beforeRetained, postRetained);
      if (postDomain.some((identity) => identity.rowCount !== 0))
        throw new QuotationCleanupError("quotation_domain_not_empty_after_deletion");
      if (foreignKeyViolations !== 0 || integrityCheck !== "ok")
        throw new QuotationCleanupError("database_integrity_check_failed");
      await options.verifyAfterCommit?.();
      const customerAfter = await externalDatabaseIdentity(customerPath);
      if (JSON.stringify(customerBefore) !== JSON.stringify(customerAfter))
        throw new QuotationCleanupError("retained_database_identity_changed");
      postCommitCustomerAfter = customerAfter;
    } catch (error) {
      postCommitWarning = error instanceof Error ? error.message : "post_commit_verification_failed";
    } finally {
      verification.close();
    }

    const byBefore = new Map(beforeDomain.map((identity) => [identity.name, identity.rowCount]));
    const postCommitSucceeded = postCommitWarning === undefined;
    const customerAfter = postCommitCustomerAfter;
    return {
      outcome: postCommitSucceeded ? "deleted" : "committed_with_post_commit_warning",
      deletion: {
        order: [...DOMAIN_DELETION_ORDER],
        deletedRowCount: deleted,
        transaction: "committed",
        foreignKeysEnabled: true,
        foreignKeyViolations,
        integrityCheck: integrityCheck as "ok",
      },
      domainTables: postDomain.map((identity) => ({
        name: identity.name as DomainTable,
        before: byBefore.get(identity.name) ?? -1,
        after: 0 as const,
      })),
      retainedTables: postCommitSucceeded
        ? beforeRetained.map((before) => {
            const after = postRetained.find((identity) => identity.name === before.name)!;
            return { name: before.name, before, after, unchanged: true as const };
          })
        : [],
      retainedDatabases: postCommitSucceeded
        ? [
            {
              path: customerPath,
              before: customerBefore,
              after: customerAfter,
              unchanged: true as const,
            },
          ]
        : [],
      postCommitVerification: postCommitSucceeded ? "verified" : "warning",
      ...(postCommitWarning ? { postCommitWarning } : {}),
    };
  } finally {
    await removeTargetSnapshot(proof.evidenceDirectory);
  }
}

export async function runCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseArgs(options.args ?? []);
  if (parsed.target !== "local") throw new QuotationCleanupError("target_must_be_local");
  if (parsed["confirm-local-deletion"] !== true)
    throw new QuotationCleanupError("requires_confirm_local_deletion");
  if (env.DATABASE_URL || env.POSTGRES_URL)
    throw new QuotationCleanupError("postgresql_environment_forbidden_for_local_cleanup");

  const requestedPath = resolve(cwd, requireString(parsed, "db"));
  const confirmedPath = resolve(cwd, requireString(parsed, "confirm-db"));
  const expectedPath = localDatabasePath(env, cwd);
  if (!isAbsolute(requestedPath) || requestedPath !== confirmedPath || requestedPath !== expectedPath)
    throw new QuotationCleanupError("local_target_proof_mismatch");
  if (requestedPath.slice(requestedPath.lastIndexOf("/") + 1) !== "quotations.db")
    throw new QuotationCleanupError("local_target_file_name_mismatch");
  await fileStat(requestedPath);

  const manifestPath = resolve(cwd, requireString(parsed, "backup-manifest"));
  if (manifestPath.slice(manifestPath.lastIndexOf("/") + 1) !== "manifest.json")
    throw new QuotationCleanupError("backup_manifest_file_name_mismatch");
  const confirmedTables = requireString(parsed, "confirm-domain-tables")
    .split(",")
    .map((table) => table.trim());
  if (JSON.stringify(confirmedTables) !== JSON.stringify(DOMAIN_DELETION_ORDER))
    throw new QuotationCleanupError("domain_table_confirmation_mismatch");

  const { manifest, manifestSha256 } = await readManifest(manifestPath);
  assertTargetMatchesManifest({ manifest, manifestPath, targetPath: requestedPath });
  if (manifest.targetProof.databaseFile?.path !== requestedPath)
    throw new QuotationCleanupError("target_identity_path_mismatch");
  const sourceCounts = await verifyBackupArtifacts(manifest, manifestPath);
  const cleanup = await cleanupDatabase(requestedPath, manifest, sourceCounts, {
    onSnapshotCreated: options.onSnapshotCreated,
    verifyAfterCommit: options.verifyAfterCommit,
  });
  return {
    ...cleanup,
    backup: {
      manifestPath,
      manifestSha256,
      sourceCounts,
    },
    target: {
      path: requestedPath,
      inode: manifest.targetProof.databaseFile?.inode ?? null,
      manifestPath,
      manifestSha256,
      sourceSnapshotSha256: manifest.targetProof.databaseFile?.consistentSnapshotSha256 ?? "",
    },
  };
}

export async function main(argv: string[], options: CleanupOptions = {}): Promise<void> {
  try {
    const result = await runCleanup({ ...options, args: argv });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.outcome === "committed_with_post_commit_warning") process.exitCode = 3;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`quotation_local_cleanup_failed:${message}\n`);
    process.exitCode = 1;
  }
}

export function isDirectExecution(
  commandPath: string | undefined,
  moduleUrl: string,
): boolean {
  if (typeof commandPath !== "string") return false;
  return resolve(commandPath) === fileURLToPath(moduleUrl);
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  await main(process.argv.slice(2));
}
