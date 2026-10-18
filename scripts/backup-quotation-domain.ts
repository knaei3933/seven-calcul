#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Client as PgClient } from "pg";
const execFileAsync = promisify(execFile);
const DOMAIN_TABLES = [
  { name: "quotations", order: ["id"], dependency: "root" },
  {
    name: "quotation_checklists",
    order: ["quotation_id", "audience"],
    dependency: "quotations.quotation_id",
  },
  { name: "film_orders", order: ["id"], dependency: "quotations.quotation_id" },
  {
    name: "film_order_files",
    order: ["id"],
    dependency: "film_orders.order_id",
  },
  {
    name: "film_order_events",
    order: ["id"],
    dependency: "film_orders.order_id",
  },
] as const;
type SqliteBackupFunction = typeof sqliteBackup;

type DomainTable = (typeof DOMAIN_TABLES)[number];
type SqlDialect = "sqlite" | "postgres";
type BackupRow = Record<string, unknown>;

interface BackupSourceClient {
  readonly dialect: SqlDialect;
  all<T = BackupRow>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = BackupRow>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

export interface BackupTargetProof {
  requestedTarget: "local" | "production" | "postgres-test";
  resolvedTarget: "sqlite-local" | "postgresql-production" | "postgresql-test";
  engine: "SQLite" | "PostgreSQL";
  engineVersion: string;
  host: string;
  port: string | number | null;
  databaseName: string;
  schema: string | null;
  serverResolvedHost?: string | null;
  databaseFile?: {
    path: string;
    fileName: string;
    byteSize: number;
    inode: number | null;
    mode: number | null;
    modifiedAtUtc: string;
    logicalByteSize: number;
    pageSize: number;
    pageCount: number;
    schemaVersion: number;
    userVersion: number;
    applicationId: number;
    consistentSnapshotSha256: string;
  };
}

interface EncodedRecord {
  table: string;
  columns: string[];
  values: unknown[];
}

export interface TableExportResult {
  name: string;
  file: string;
  columns: Array<{ name: string; dataType: string | null }>;
  binaryColumns: string[];
  sourceRowCount: number;
  exportedRowCount: number;
  recordCount: number;
  dataByteCount: number;
  dataSha256: string;
  recordSha256: string[];
  binaryFieldStats: Array<{
    column: string;
    valueCount: number;
    byteCount: number;
  }>;
  verified: true;
}

export interface BackupResult {
  outputDirectory: string;
  manifestPath: string;
  manifestSha256: string;
  startedAtUtc: string;
  completedAtUtc: string;
  targetProof: BackupTargetProof;
  tables: TableExportResult[];
  totals: {
    tableCount: number;
    sourceRowCount: number;
    exportedRowCount: number;
    binaryValueCount: number;
    binaryByteCount: number;
    dataByteCount: number;
  };
  safety: {
    destructiveOperations: "none";
    productionRequiredExplicitTargetAndConfirmations: boolean;
    productionConfirmed: boolean;
  };
  scope: {
    rootTable: "quotations";
    tables: Array<{ name: string; dependency: string }>;
    retainedOutsideScope: string[];
  };
}

type PostgresConnectionInfo = ParsedDatabaseTarget;

interface BackupOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  sqlite?: {
    backup: typeof sqliteBackup;
    DatabaseSync: typeof DatabaseSync;
  };
  postgres?: {
    Client: typeof PgClient;
  };
  now?: () => Date;
}

class BackupError extends Error {}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier))
    throw new BackupError("invalid_database_identifier");
  return `"${identifier}"`;
}

function orderClause(table: DomainTable): string {
  return table.order.map((column) => quoteIdentifier(column)).join(", ");
}

function isBinary(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || Buffer.isBuffer(value);
}

function encodeValue(value: unknown): unknown {
  if (value === null) return null;
  if (isBinary(value)) {
    return {
      __pouchBinary: "v1",
      encoding: "base64",
      base64: Buffer.from(value).toString("base64"),
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  return value;
}

function sha256Hex(...chunks: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

function utcIsoTime(date: Date): string {
  return date.toISOString();
}

function fileTimestamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(":", "")
    .replace(/\.[0-9]{3}Z$/, "Z");
}

function localDatabasePath(
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  return resolve(cwd, env.POUCH_QUOTATION_DB || join(".data", "quotations.db"));
}

export class ProductionTargetError extends Error {}

export interface ParsedProductionTarget {
  connectionString: string;
  host: string;
  port: string;
  databaseName: string;
  sslMode: "require" | "verify-full";
  channelBindingRequired: boolean;
}

interface ParsedDatabaseTarget extends Omit<ParsedProductionTarget, "sslMode"> {
  schema: string | null;
  sslMode: "require" | "verify-full" | "disable";
}

const DISALLOWED_DATABASE_NAME = /(test|testing|dev|development|staging|local|sqlite)/i;

function reject(message: string): never {
  throw new ProductionTargetError(message);
}

export function parseProductionTarget(
  env: Record<string, string | undefined>,
): ParsedProductionTarget {
  const configured = [
    ["DATABASE_URL", env.DATABASE_URL] as const,
    ["POSTGRES_URL", env.POSTGRES_URL] as const,
  ].filter(([, value]) => Boolean(value?.trim()));
  if (configured.length === 0) {
    reject("production_postgresql_url_not_configured");
  }
  if (configured.length > 1) {
    reject("postgresql_urls_are_ambiguous");
  }
  const connectionString = configured[0][1]!.trim();
  if (/[,@\s]/.test(connectionString.replace(/^[^@]*@/, ""))) {
    reject("postgresql_url_is_ambiguous");
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    reject("postgresql_url_is_ambiguous");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    reject("postgresql_protocol_required");
  }
  if (!url.username || !url.password) {
    reject("postgresql_url_credentials_incomplete");
  }
  if (
    url.username.includes("%") ||
    url.password.includes("%") ||
    connectionString.split("@").length !== 2 ||
    url.hash
  ) {
    reject("postgresql_url_is_ambiguous");
  }

  const host = url.hostname;
  if (
    !host ||
    host.includes("%") ||
    host.includes(",") ||
    host.includes("@") ||
    host.includes(" ") ||
    host.includes(":")
  ) {
    reject("postgresql_url_is_ambiguous");
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    !host.includes(".") ||
    !host.endsWith(".neon.tech") ||
    host.length === ".neon.tech".length
  ) {
    reject("production_host_is_not_allowed");
  }

  if (!/^[0-9]+$/.test(url.port || "5432")) {
    reject("postgresql_url_is_ambiguous");
  }
  const port = url.port || "5432";
  if (port === "0" || Number(port) > 65535) {
    reject("postgresql_url_is_ambiguous");
  }

  const encodedDatabase = url.pathname.replace(/^\/(.*)$/u, "$1");
  if (
    !encodedDatabase ||
    encodedDatabase.includes("/") ||
    encodedDatabase.includes("%") ||
    encodedDatabase.includes("?") ||
    url.pathname !== `/${encodedDatabase}`
  ) {
    reject("postgresql_url_is_ambiguous");
  }
  const databaseName = encodedDatabase;
  if (DISALLOWED_DATABASE_NAME.test(databaseName)) {
    reject("production_database_name_is_not_allowed");
  }

  const queryKeys = [...url.searchParams.keys()];
  const allowedKeys = new Set(["sslmode", "channel_binding"]);
  if (queryKeys.some((key) => !allowedKeys.has(key))) {
    reject("postgresql_url_query_is_ambiguous");
  }
  if (
    ["sslmode", "channel_binding"].some(
      (key) => url.searchParams.getAll(key).length > 1,
    )
  ) {
    reject("postgresql_url_query_is_ambiguous");
  }
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode !== "require" && sslMode !== "verify-full") {
    reject("production_ssl_is_required");
  }
  const channelBinding = url.searchParams.get("channel_binding");
  if (channelBinding && channelBinding !== "require") {
    reject("postgresql_url_query_is_ambiguous");
  }

  return {
    connectionString,
    host,
    port,
    databaseName,
    sslMode,
    channelBindingRequired: channelBinding === "require",
  };
}

export function productionClientOptions(
  target: ParsedProductionTarget,
): {
  connectionString: string;
  ssl: { rejectUnauthorized: true };
} {
  return {
    connectionString: target.connectionString,
    ssl: { rejectUnauthorized: true },
  };
}

function parsePostgresTestTarget(
  env: Record<string, string | undefined>,
  args: Record<string, string | boolean>,
): ParsedDatabaseTarget {
  const configured = env.POUCH_TEST_POSTGRESQL_URL?.trim();
  if (!configured) reject("test_postgresql_url_not_configured");
  if (env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim()) {
    reject("test_postgresql_environment_is_ambiguous");
  }

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    reject("postgresql_url_is_ambiguous");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    reject("postgresql_protocol_required");
  }
  if (!url.username || !url.password) {
    reject("postgresql_url_credentials_incomplete");
  }
  const host = url.hostname;
  const isLocalHost =
    host === "localhost" || host === "::1" || /^127\.[0-9.]+$/.test(host);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  const databaseIsTestOnly = /(^|_)(test|testing)($|_)/i.test(databaseName);
  if (!isLocalHost || !databaseName || !databaseIsTestOnly || url.hash) {
    reject("test_postgresql_target_is_not_allowed");
  }
  if (![...url.searchParams.keys()].every((key) => key === "options")) {
    reject("postgresql_url_query_is_ambiguous");
  }
  const option = url.searchParams.get("options");
  const schema =
    /^-c search_path=([A-Za-z_][A-Za-z0-9_]*)$/.exec(option ?? "")?.[1];
  if (!schema) reject("test_postgresql_schema_is_not_isolated");
  const confirmedHost = args["confirm-host"] ?? args.confirmHost;
  const confirmedDatabase = args["confirm-database"] ?? args.confirmDatabase;
  const confirmedSchema = args["confirm-schema"];
  if (
    confirmedHost !== host ||
    confirmedDatabase !== databaseName ||
    confirmedSchema !== schema
  ) {
    reject("test_postgresql_confirmation_mismatch");
  }

  return {
    connectionString: configured,
    host,
    port: url.port || "5432",
    databaseName,
    schema,
    sslMode: "disable",
    channelBindingRequired: false,
  };
}

function parseDatabaseTarget(
  target: "production" | "postgres-test",
  env: Record<string, string | undefined>,
  args: Record<string, string | boolean>,
): ParsedDatabaseTarget {
  return target === "production"
    ? { ...parseProductionTarget(env), schema: null }
    : parsePostgresTestTarget(env, args);
}

function databaseClientOptions(target: ParsedDatabaseTarget): {
  connectionString: string;
  ssl?: { rejectUnauthorized: true };
} {
  return target.sslMode === "disable"
    ? { connectionString: target.connectionString }
    : {
        connectionString: target.connectionString,
        ssl: { rejectUnauthorized: true },
      };
}

function expectedProductionFlags(args: {
  confirmHost?: string;
  confirmDatabase?: string;
  confirmReadOnlyBackup?: boolean;
}): void {
  if (!args.confirmReadOnlyBackup)
    throw new BackupError(
      "production_requires_confirm_production_read_only_backup",
    );
  if (!args.confirmHost)
    throw new BackupError("production_requires_confirm_host");
  if (!args.confirmDatabase)
    throw new BackupError("production_requires_confirm_database");
}

async function ensureOutputIsNotTrackable(
  outputDirectory: string,
  cwd: string,
): Promise<void> {
  let repositoryRoot: string;
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd },
    );
    repositoryRoot = resolve(result.stdout.trim());
  } catch {
    throw new BackupError("backup_output_cannot_be_safety_checked_without_git");
  }
  if (
    !outputDirectory.startsWith(
      `${repositoryRoot}${outputDirectory === repositoryRoot ? "" : "/"}`,
    )
  )
    return;
  const relative =
    outputDirectory === repositoryRoot
      ? "."
      : outputDirectory.slice(repositoryRoot.length + 1);
  try {
    await execFileAsync("git", ["check-ignore", "--", relative], {
      cwd: repositoryRoot,
    });
  } catch {
    throw new BackupError("backup_output_inside_repository_is_not_gitignored");
  }
}

async function sourceFileIdentity(path: string): Promise<{
  byteSize: number;
  inode: number | null;
  mode: number | null;
  modifiedAtUtc: string;
}> {
  const info = await stat(path);
  return {
    byteSize: info.size,
    inode: Number.isSafeInteger(info.ino) ? info.ino : null,
    mode: info.mode,
    modifiedAtUtc: new Date(info.mtimeMs).toISOString(),
  };
}

async function targetProofForSqlite(
  sourcePath: string,
  snapshotPath: string,
  sqliteBackup: SqliteBackupFunction,
): Promise<BackupTargetProof> {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await sqliteBackup(source, snapshotPath);
  } finally {
    source.close();
  }
  const database = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const getNumber = (pragma: string): number => {
      const row = database.prepare(`PRAGMA ${pragma}`).get() as
        Record<string, number | bigint | string> | undefined;
      return Number(row?.[pragma] ?? 0);
    };
    const pageSize = await getNumber("page_size");
    const pageCount = await getNumber("page_count");
    const schemaVersion = await getNumber("schema_version");
    const userVersion = await getNumber("user_version");
    const applicationId = await getNumber("application_id");
    const fileIdentity = await sourceFileIdentity(sourcePath);
    const snapshotBytes = await readFile(snapshotPath);
    return {
      requestedTarget: "local",
      resolvedTarget: "sqlite-local",
      engine: "SQLite",
      engineVersion: `SQLite ${(database.prepare("SELECT sqlite_version() AS version").get() as { version?: string } | undefined)?.version ?? "unknown"}`,
      host: "local-file",
      port: null,
      databaseName: sourcePath,
      schema: "main",
      databaseFile: {
        path: sourcePath,
        fileName: sourcePath.slice(sourcePath.lastIndexOf("/") + 1),
        ...fileIdentity,
        logicalByteSize: pageSize * pageCount,
        pageSize,
        pageCount,
        schemaVersion,
        userVersion,
        applicationId,
        consistentSnapshotSha256: sha256Hex(snapshotBytes),
      },
    };
  } finally {
    database.close();
  }
}

class SqliteSnapshotClient implements BackupSourceClient {
  readonly dialect = "sqlite" as const;
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.database = database;
  }

  all<T = BackupRow>(sql: string): Promise<T[]> {
    return Promise.resolve(this.database.prepare(sql).all() as T[]);
  }

  get<T = BackupRow>(sql: string): Promise<T | undefined> {
    return Promise.resolve(this.database.prepare(sql).get() as T | undefined);
  }
}

async function openLocalSource(
  options: BackupOptions,
  sourcePath: string,
  snapshotPath: string,
): Promise<{
  client: BackupSourceClient;
  proof: BackupTargetProof;
  close: () => Promise<void>;
}> {
  const sqlite = options.sqlite ?? { backup: sqliteBackup, DatabaseSync };
  try {
    await stat(sourcePath);
  } catch {
    throw new BackupError(`local_sqlite_file_not_found:${sourcePath}`);
  }
  const proof = await targetProofForSqlite(
    sourcePath,
    snapshotPath,
    sqlite.backup,
  );
  const database = new sqlite.DatabaseSync(snapshotPath, { readOnly: true });
  database.exec("PRAGMA foreign_keys = ON");
  return {
    client: new SqliteSnapshotClient(database),
    proof,
    close: async () => database.close(),
  };
}

function wrapPgClient(client: PgClient): BackupSourceClient {
  return {
    dialect: "postgres",
    async all<T = BackupRow>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const result = await client.query(sql, params);
      return result.rows as T[];
    },
    async get<T = BackupRow>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T | undefined> {
      const result = await client.query(sql, params);
      return result.rows[0] as T | undefined;
    },
  };
}

async function tableColumns(
  client: BackupSourceClient,
  tableName: string,
): Promise<Array<{ name: string; dataType: string | null }>> {
  if (client.dialect === "sqlite") {
    const rows = await client.all<{ name: string; type: string }>(
      `PRAGMA table_info(${quoteIdentifier(tableName)})`,
    );
    if (!rows.length)
      throw new BackupError(
        `required_quotation_domain_table_missing:${tableName}`,
      );
    return rows.map((row) => ({ name: row.name, dataType: row.type || null }));
  }
  const rows = await client.all<{ column_name: string; data_type: string }>(
    `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1
    ORDER BY ordinal_position
  `,
    [tableName],
  );
  if (!rows.length)
    throw new BackupError(
      `required_quotation_domain_table_missing:${tableName}`,
    );
  return rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
  }));
}

async function sourceRowCount(
  client: BackupSourceClient,
  tableName: string,
): Promise<number> {
  const row =
    client.dialect === "sqlite"
      ? await client.get<{ count: number }>(
          `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`,
        )
      : await client.get<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(tableName)}`,
        );
  const count = Number(row?.count);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new BackupError(`invalid_row_count:${tableName}`);
  return count;
}

function encodeRecords(
  tableName: string,
  columns: string[],
  rows: BackupRow[],
): {
  records: EncodedRecord[];
  binaryColumns: string[];
  binaryStats: Map<
    string,
    { column: string; valueCount: number; byteCount: number }
  >;
} {
  const binaryColumns = new Set<string>();
  const binaryStats = new Map<
    string,
    { column: string; valueCount: number; byteCount: number }
  >();
  const records = rows.map((row) => {
    if (!row || typeof row !== "object")
      throw new BackupError(`invalid_row:${tableName}`);
    const values = columns.map((column) => {
      const value = row[column];
      if (isBinary(value)) {
        binaryColumns.add(column);
        const current = binaryStats.get(column) ?? {
          column,
          valueCount: 0,
          byteCount: 0,
        };
        current.valueCount += 1;
        current.byteCount += value.byteLength;
        binaryStats.set(column, current);
      }
      return encodeValue(value);
    });
    return { table: tableName, columns, values };
  });
  return {
    records,
    binaryColumns: columns.filter((column) => binaryColumns.has(column)),
    binaryStats,
  };
}

async function writeTableArtifact(
  path: string,
  records: EncodedRecord[],
): Promise<{
  dataSha256: string;
  dataByteCount: number;
  recordSha256: string[];
}> {
  const lines = records.map((record) => `${JSON.stringify(record)}\n`);
  const data = Buffer.from(lines.join(""), "utf8");
  await writeFile(path, data, { flag: "wx", mode: 0o600 });
  return {
    dataSha256: sha256Hex(data),
    dataByteCount: data.byteLength,
    recordSha256: lines.map((line) => sha256Hex(Buffer.from(line, "utf8"))),
  };
}

export async function verifyTableArtifact(input: {
  client: BackupSourceClient;
  tableName: string;
  path: string;
  columns: string[];
  expectedRecords: EncodedRecord[];
  expectedDataSha256: string;
  expectedRecordSha256: string[];
}): Promise<void> {
  const sourceCount = await sourceRowCount(input.client, input.tableName);
  const bytes = await readFile(input.path);
  const aggregateHash = createHash("sha256");
  aggregateHash.update(bytes);
  const actualAggregate = aggregateHash.digest("hex");
  if (actualAggregate !== input.expectedDataSha256) {
    throw new BackupError(`verification_failed_checksum:${input.tableName}`);
  }

  const actualLines =
    bytes.byteLength === 0
      ? []
      : Buffer.from(bytes).toString("utf8").split("\n").slice(0, -1);
  if (
    actualLines.length !== input.expectedRecords.length ||
    sourceCount !== input.expectedRecords.length
  ) {
    throw new BackupError(`verification_failed_row_count:${input.tableName}`);
  }
  const actualRecordChecksums = actualLines.map((line) =>
    sha256Hex(Buffer.from(`${line}\n`, "utf8")),
  );
  for (const [index, expectedRecord] of input.expectedRecords.entries()) {
    if (actualRecordChecksums[index] !== input.expectedRecordSha256[index]) {
      throw new BackupError(
        `verification_failed_record_checksum:${input.tableName}:${index}`,
      );
    }
    const actualRecord = JSON.parse(actualLines[index]) as EncodedRecord;
    if (
      actualRecord.table !== input.tableName ||
      JSON.stringify(actualRecord.columns) !== JSON.stringify(input.columns) ||
      actualRecord.values.length !== input.columns.length
    ) {
      throw new BackupError(
        `verification_failed_record_shape:${input.tableName}:${index}`,
      );
    }
    for (const [valueIndex, value] of actualRecord.values.entries()) {
      const expectedValue = expectedRecord.values[valueIndex];
      if (value && typeof value === "object" && "__pouchBinary" in value) {
        const envelope = value as {
          __pouchBinary?: string;
          encoding?: string;
          base64?: string;
        };
        if (
          envelope.__pouchBinary !== "v1" ||
          envelope.encoding !== "base64" ||
          typeof envelope.base64 !== "string"
        ) {
          throw new BackupError(
            `verification_failed_binary_envelope:${input.tableName}:${index}`,
          );
        }
        const actualBytes = Buffer.from(envelope.base64, "base64");
        const expectedEnvelope = expectedValue as { base64?: unknown };
        if (
          !expectedEnvelope ||
          typeof expectedEnvelope !== "object" ||
          typeof expectedEnvelope.base64 !== "string"
        ) {
          throw new BackupError(
            `verification_failed_binary_source:${input.tableName}:${index}`,
          );
        }
        const expectedBytes = Buffer.from(expectedEnvelope.base64, "base64");
        if (Buffer.compare(actualBytes, expectedBytes) !== 0) {
          throw new BackupError(
            `verification_failed_binary_bytes:${input.tableName}:${index}`,
          );
        }
      } else if (JSON.stringify(value) !== JSON.stringify(expectedValue)) {
        throw new BackupError(
          `verification_failed_value:${input.tableName}:${index}:${valueIndex}`,
        );
      }
    }
  }
}

export interface VerifiedBackupManifest {
  manifest: BackupResult;
  manifestSha256: string;
  sourceCounts: Record<string, number>;
  binaryValueCount: number;
  binaryByteCount: number;
}

export async function verifyBackupManifest(input: {
  manifestPath: string;
  expectedTarget: BackupTargetProof;
  expectedTables: readonly string[];
}): Promise<VerifiedBackupManifest> {
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(input.manifestPath);
  } catch {
    throw new BackupError(
      `backup_manifest_not_found:${input.manifestPath}`,
    );
  }
  const manifestSha256 = sha256Hex(manifestBytes);
  const sidecarPath = `${input.manifestPath.slice(0, -".json".length)}.sha256`;
  const sidecarBytes = await readFile(sidecarPath, "utf8").catch(() => {
    throw new BackupError("backup_manifest_checksum_sidecar_not_found");
  });
  if (sidecarBytes !== `${manifestSha256}  manifest.json\n`) {
    throw new BackupError("backup_manifest_checksum_mismatch");
  }

  let manifest: BackupResult;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as BackupResult;
  } catch {
    throw new BackupError("backup_manifest_invalid_json");
  }

  const proof = manifest.targetProof;
  const expectedProof = input.expectedTarget;
  if (
    proof.requestedTarget !== expectedProof.requestedTarget ||
    proof.resolvedTarget !== expectedProof.resolvedTarget ||
    proof.engine !== expectedProof.engine ||
    proof.host !== expectedProof.host ||
    proof.port !== expectedProof.port ||
    proof.databaseName !== expectedProof.databaseName ||
    proof.engineVersion !== expectedProof.engineVersion ||
    proof.serverResolvedHost !== expectedProof.serverResolvedHost ||
    proof.schema !== expectedProof.schema
  ) {
    throw new BackupError("backup_manifest_target_identity_mismatch");
  }
  if (manifest.safety?.destructiveOperations !== "none") {
    throw new BackupError("backup_manifest_destructive_operations_mismatch");
  }
  if (manifest.scope?.rootTable !== "quotations") {
    throw new BackupError("backup_manifest_root_mismatch");
  }
  const manifestTables = manifest.tables.map((table) => table.name);
  if (
    JSON.stringify([...manifestTables].sort()) !==
    JSON.stringify([...input.expectedTables].sort())
  ) {
    throw new BackupError("backup_manifest_domain_table_mismatch");
  }

  const directory = dirname(input.manifestPath);
  const sourceCounts: Record<string, number> = {};
  const totals = {
    sourceRowCount: 0,
    exportedRowCount: 0,
    binaryValueCount: 0,
    binaryByteCount: 0,
    dataByteCount: 0,
  };
  for (const table of manifest.tables) {
    const expectedFile = `${table.name}.jsonl`;
    if (table.file !== expectedFile || table.verified !== true) {
      throw new BackupError(
        `backup_artifact_metadata_invalid:${table.name}`,
      );
    }
    const tablePath = join(directory, expectedFile);
    if (tablePath !== resolve(directory, expectedFile)) {
      throw new BackupError(`backup_artifact_path_invalid:${table.name}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(tablePath);
    } catch {
      throw new BackupError(`backup_artifact_not_found:${table.name}`);
    }
    if (sha256Hex(bytes) !== table.dataSha256) {
      throw new BackupError(
        `backup_artifact_checksum_mismatch:${table.name}`,
      );
    }
    const lines =
      bytes.byteLength === 0
        ? []
        : bytes.toString("utf8").split("\n").slice(0, -1);
    if (
      lines.length !== table.sourceRowCount ||
      table.exportedRowCount !== table.sourceRowCount ||
      table.recordCount !== table.sourceRowCount ||
      lines.length !== table.recordSha256.length
    ) {
      throw new BackupError(
        `backup_artifact_row_count_mismatch:${table.name}`,
      );
    }

    let binaryValueCount = 0;
    let binaryByteCount = 0;
    const binaryByColumn = new Map(
      table.binaryFieldStats.map((stats) => [stats.column, stats]),
    );
    for (const [index, line] of lines.entries()) {
      if (
        sha256Hex(Buffer.from(`${line}\n`, "utf8")) !==
        table.recordSha256[index]
      ) {
        throw new BackupError(
          `backup_artifact_record_checksum_mismatch:${table.name}:${index}`,
        );
      }
      let record: { table?: string; columns?: string[]; values?: unknown[] };
      try {
        record = JSON.parse(line);
      } catch {
        throw new BackupError(
          `backup_artifact_record_invalid_json:${table.name}:${index}`,
        );
      }
      if (
        record.table !== table.name ||
        JSON.stringify(record.columns ?? []) !==
          JSON.stringify(table.columns.map((column) => column.name)) ||
        record.values?.length !== table.columns.length
      ) {
        throw new BackupError(
          `backup_artifact_record_shape_mismatch:${table.name}:${index}`,
        );
      }
      for (const [columnIndex, value] of (record.values ?? []).entries()) {
        const envelope = value as
          | { __pouchBinary?: unknown; encoding?: unknown; base64?: unknown }
          | null;
        if (!envelope || typeof envelope !== "object" || !("__pouchBinary" in envelope)) continue;
        if (
          envelope.__pouchBinary !== "v1" ||
          envelope.encoding !== "base64" ||
          typeof envelope.base64 !== "string"
        ) {
          throw new BackupError(
            `backup_artifact_binary_envelope_invalid:${table.name}:${index}`,
          );
        }
        const decoded = Buffer.from(envelope.base64, "base64");
        const columnName = table.columns[columnIndex]?.name ?? "";
        const stats = binaryByColumn.get(columnName);
        if (!stats) {
          throw new BackupError(
            `backup_artifact_binary_column_undeclared:${table.name}:${columnName}`,
          );
        }
        binaryValueCount += 1;
        binaryByteCount += decoded.byteLength;
      }
    }
    const actualBinaryStats = {
      valueCount: binaryValueCount,
      byteCount: binaryByteCount,
    };
    const expectedBinaryStats = [...binaryByColumn.values()].reduce(
      (accumulator, stats) => ({
        valueCount: accumulator.valueCount + stats.valueCount,
        byteCount: accumulator.byteCount + stats.byteCount,
      }),
      { valueCount: 0, byteCount: 0 },
    );
    if (
      actualBinaryStats.valueCount !== expectedBinaryStats.valueCount ||
      actualBinaryStats.byteCount !== expectedBinaryStats.byteCount
    ) {
      throw new BackupError(
        `backup_artifact_binary_byte_count_mismatch:${table.name}`,
      );
    }

    sourceCounts[table.name] = table.sourceRowCount;
    totals.sourceRowCount += table.sourceRowCount;
    totals.exportedRowCount += table.exportedRowCount;
    totals.binaryValueCount += binaryValueCount;
    totals.binaryByteCount += binaryByteCount;
    totals.dataByteCount += bytes.byteLength;
  }
  if (
    manifest.totals.sourceRowCount !== totals.sourceRowCount ||
    manifest.totals.exportedRowCount !== totals.exportedRowCount ||
    manifest.totals.binaryValueCount !== totals.binaryValueCount ||
    manifest.totals.binaryByteCount !== totals.binaryByteCount ||
    manifest.totals.dataByteCount !== totals.dataByteCount
  ) {
    throw new BackupError("backup_manifest_total_mismatch");
  }
  if (dirname(input.manifestPath) !== manifest.outputDirectory) {
    throw new BackupError("backup_manifest_directory_mismatch");
  }
  return {
    manifest,
    manifestSha256,
    sourceCounts,
    binaryValueCount: totals.binaryValueCount,
    binaryByteCount: totals.binaryByteCount,
  };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--"))
      throw new BackupError(`unknown_argument:${arg ?? ""}`);
    const key = arg.slice(2);
    if (key in parsed) throw new BackupError(`duplicate_argument:${key}`);
    if (key === "target") {
      parsed.target = argv[++index];
      continue;
    }
    if (key === "output-dir") {
      parsed.outputDir = argv[++index];
      continue;
    }
    if (key === "confirm-host") {
      parsed.confirmHost = argv[++index];
      continue;
    }
    if (key === "confirm-database") {
      parsed.confirmDatabase = argv[++index];
      continue;
    }
    if (key === "confirm-schema") {
      parsed["confirm-schema"] = argv[++index];
      continue;
    }
    if (key === "confirm-production-read-only-backup") {
      parsed.confirmProductionReadOnlyBackup = true;
      continue;
    }
    throw new BackupError(`unknown_argument:${arg}`);
  }
  return parsed;
}

interface OpenedSource {
  client: BackupSourceClient;
  proof: BackupTargetProof;
  close: () => Promise<void>;
}

async function exportDomain(input: {
  client: BackupSourceClient;
  proof: BackupTargetProof;
  outputDirectory: string;
  started: Date;
  requestedTarget: "local" | "production" | "postgres-test";
}): Promise<BackupResult> {
  const { client, proof, outputDirectory, started, requestedTarget } = input;
  const existingTables =
    client.dialect === "sqlite"
      ? new Set(
          (
            await client.all<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `)
          ).map((row) => row.name),
        )
      : new Set(
          (
            await client.all<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()
      `)
          ).map((row) => row.table_name),
        );
  for (const table of DOMAIN_TABLES) {
    if (!existingTables.has(table.name)) {
      throw new BackupError(
        `required_quotation_domain_table_missing:${table.name}`,
      );
    }
  }

  const tables: TableExportResult[] = [];
  for (const table of DOMAIN_TABLES) {
    const columns = await tableColumns(client, table.name);
    const columnNames = columns.map((column) => column.name);
    for (const orderColumn of table.order) {
      if (!columnNames.includes(orderColumn)) {
        throw new BackupError(
          `required_order_column_missing:${table.name}:${orderColumn}`,
        );
      }
    }
    const beforeCount = await sourceRowCount(client, table.name);
    const rows = await client.all<BackupRow>(
      `SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY ${orderClause(table)} ASC`,
    );
    const afterCount = await sourceRowCount(client, table.name);
    if (beforeCount !== afterCount || rows.length !== afterCount) {
      throw new BackupError(`source_snapshot_changed:${table.name}`);
    }
    const encoded = encodeRecords(table.name, columnNames, rows);
    const fileName = `${table.name}.jsonl`;
    const filePath = join(outputDirectory, fileName);
    const written = await writeTableArtifact(filePath, encoded.records);
    await verifyTableArtifact({
      client,
      tableName: table.name,
      path: filePath,
      columns: columnNames,
      expectedRecords: encoded.records,
      expectedDataSha256: written.dataSha256,
      expectedRecordSha256: written.recordSha256,
    });
    tables.push({
      name: table.name,
      file: fileName,
      columns,
      binaryColumns: encoded.binaryColumns,
      sourceRowCount: afterCount,
      exportedRowCount: encoded.records.length,
      recordCount: encoded.records.length,
      dataByteCount: written.dataByteCount,
      dataSha256: written.dataSha256,
      recordSha256: written.recordSha256,
      binaryFieldStats: [...encoded.binaryStats.values()],
      verified: true,
    });
  }

  const completed = new Date();
  const totals = tables.reduce(
    (accumulator, table) => ({
      tableCount: accumulator.tableCount + 1,
      sourceRowCount: accumulator.sourceRowCount + table.sourceRowCount,
      exportedRowCount: accumulator.exportedRowCount + table.exportedRowCount,
      binaryValueCount:
        accumulator.binaryValueCount +
        table.binaryFieldStats.reduce(
          (sum, field) => sum + field.valueCount,
          0,
        ),
      binaryByteCount:
        accumulator.binaryByteCount +
        table.binaryFieldStats.reduce((sum, field) => sum + field.byteCount, 0),
      dataByteCount: accumulator.dataByteCount + table.dataByteCount,
    }),
    {
      tableCount: 0,
      sourceRowCount: 0,
      exportedRowCount: 0,
      binaryValueCount: 0,
      binaryByteCount: 0,
      dataByteCount: 0,
    },
  );
  const result: BackupResult = {
    outputDirectory,
    manifestPath: join(outputDirectory, "manifest.json"),
    manifestSha256: "",
    startedAtUtc: utcIsoTime(started),
    completedAtUtc: utcIsoTime(completed),
    targetProof: proof,
    tables,
    totals,
    safety: {
      destructiveOperations: "none",
      productionRequiredExplicitTargetAndConfirmations: true,
      productionConfirmed: requestedTarget === "production",
    },
    scope: {
      rootTable: "quotations",
      tables: DOMAIN_TABLES.map(({ name, dependency }) => ({
        name,
        dependency,
      })),
      retainedOutsideScope: [
        "customers",
        "film_prices",
        "gravure_y_supplier_prices",
        "gravure_k_parameter_sets",
        "gravure_master_audit",
        "calculation_master_snapshots",
        "users",
        "sessions",
      ],
    },
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  await writeFile(result.manifestPath, manifestBytes, {
    flag: "wx",
    mode: 0o600,
  });
  result.manifestSha256 = sha256Hex(manifestBytes);
  await writeFile(
    join(outputDirectory, "manifest.sha256"),
    `${result.manifestSha256}  manifest.json\n`,
    { flag: "wx", mode: 0o600 },
  );
  return result;
}

export async function runBackup(
  options: BackupOptions = {},
): Promise<BackupResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const args = parseArgs(options.args ?? []);
  const started = (options.now ?? (() => new Date()))();
  const requestedTarget =
    args.target === undefined
      ? env.DATABASE_URL || env.POSTGRES_URL
        ? undefined
        : "local"
      : args.target;
  if (!requestedTarget)
    throw new BackupError(
      "target_required_when_postgresql_environment_is_configured",
    );
  if (
    requestedTarget !== "local" &&
    requestedTarget !== "production" &&
    requestedTarget !== "postgres-test"
  ) {
    throw new BackupError("target_must_be_local_production_or_postgres_test");
  }

  const outputDirectory = resolve(
    cwd,
    typeof args.outputDir === "string" && args.outputDir
      ? args.outputDir
      : join(".omx", "backups", "quotation-domain", fileTimestamp(started)),
  );
  await ensureOutputIsNotTrackable(outputDirectory, cwd);

  const databaseTarget =
    requestedTarget === "production" || requestedTarget === "postgres-test"
      ? parseDatabaseTarget(requestedTarget, env, args)
      : null;
  if (requestedTarget === "local" && (env.DATABASE_URL || env.POSTGRES_URL)) {
    throw new BackupError(
      "local_target_conflicts_with_configured_postgresql_environment",
    );
  }
  if (requestedTarget === "production") {
    expectedProductionFlags({
      confirmHost:
        typeof args.confirmHost === "string" ? args.confirmHost : undefined,
      confirmDatabase:
        typeof args.confirmDatabase === "string"
          ? args.confirmDatabase
          : undefined,
      confirmReadOnlyBackup: args.confirmProductionReadOnlyBackup === true,
    });
    if (args.confirmHost !== databaseTarget?.host)
      throw new BackupError("production_host_confirmation_mismatch");
    if (args.confirmDatabase !== databaseTarget?.databaseName)
      throw new BackupError("production_database_confirmation_mismatch");
  }

  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const snapshotPath = join(outputDirectory, ".consistent-source.tmp.sqlite");
  let source: OpenedSource | null = null;
  const temporaryFiles = [
    snapshotPath,
    `${snapshotPath}-wal`,
    `${snapshotPath}-shm`,
    `${snapshotPath}-journal`,
  ];
  try {
    if (requestedTarget === "local") {
      source = await openLocalSource(
        options,
        localDatabasePath(env, cwd),
        snapshotPath,
      );
      return await exportDomain({
        client: source.client,
        proof: source.proof,
        outputDirectory,
        started,
        requestedTarget,
      });
    }

    if (options.postgres && databaseTarget) {
      source = await openInjectedProductionSource(
        options,
        requestedTarget,
        databaseTarget,
      );
      return await exportDomain({
        client: source.client,
        proof: source.proof,
        outputDirectory,
        started,
        requestedTarget,
      });
    }

    return await withProductionSource(
      options,
      requestedTarget,
      databaseTarget!,
      async (client, proof) =>
        exportDomain({
          client,
          proof,
          outputDirectory,
          started,
          requestedTarget,
        }),
    );
  } finally {
    await source?.close();
    await Promise.all(temporaryFiles.map((path) => rm(path, { force: true })));
  }
}

async function openInjectedProductionSource(
  options: BackupOptions,
  requestedTarget: "production" | "postgres-test",
  target: PostgresConnectionInfo,
): Promise<OpenedSource> {
  const Client = options.postgres?.Client;
  if (!Client) throw new BackupError("injected_postgres_client_missing");
  const client = new Client(databaseClientOptions(target));
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transactionOpen = true;
    const info = await client.query<{
      database_name: string;
      schema_name: string;
      server_version: string;
      server_address: string | null;
      server_port: string | number | null;
    }>(`
      SELECT current_database() AS database_name, current_schema() AS schema_name,
             version() AS server_version, inet_server_addr()::text AS server_address,
             inet_server_port()::text AS server_port
    `);
    const row = info.rows[0];
    if (!row || row.database_name !== target.databaseName) {
      throw new BackupError("resolved_postgres_database_does_not_match_url");
    }
    return {
      client: wrapPgClient(client),
      proof: {
        requestedTarget,
        resolvedTarget:
          requestedTarget === "postgres-test"
            ? "postgresql-test"
            : "postgresql-production",
        engine: "PostgreSQL",
        engineVersion: row.server_version,
        host: target.host,
        port: target.port,
        databaseName: row.database_name,
        schema: row.schema_name,
        serverResolvedHost: row.server_address,
      },
      close: async () => {
        if (transactionOpen) await client.query("ROLLBACK");
        await client.end();
      },
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    await client.end();
    throw error;
  }
}

async function withProductionSource<T>(
  options: BackupOptions,
  requestedTarget: "production" | "postgres-test",
  target: PostgresConnectionInfo,
  operation: (
    client: BackupSourceClient,
    proof: BackupTargetProof,
  ) => Promise<T>,
): Promise<T> {
  const { Client } = options.postgres ?? (await import("pg"));
  const client = new Client(databaseClientOptions(target));
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    transactionOpen = true;
    const info = await client.query<{
      database_name: string;
      schema_name: string;
      server_version: string;
      server_address: string | null;
      server_port: string | number | null;
    }>(`
      SELECT current_database() AS database_name, current_schema() AS schema_name,
             version() AS server_version, inet_server_addr()::text AS server_address,
             inet_server_port()::text AS server_port
    `);
    const row = info.rows[0];
    if (!row || row.database_name !== target.databaseName) {
      throw new BackupError("resolved_postgres_database_does_not_match_url");
    }
    const proof: BackupTargetProof = {
      requestedTarget,
      resolvedTarget:
        requestedTarget === "postgres-test"
          ? "postgresql-test"
          : "postgresql-production",
      engine: "PostgreSQL",
      engineVersion: row.server_version,
      host: target.host,
      port: target.port,
      databaseName: row.database_name,
      schema: row.schema_name,
      serverResolvedHost: row.server_address,
    };
    return await operation(wrapPgClient(client), proof);
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    await client.end();
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const result = await runBackup({ args: argv });
    const summary = {
      backup: result.outputDirectory,
      manifest: result.manifestPath,
      manifestSha256: result.manifestSha256,
      target: result.targetProof.resolvedTarget,
      databaseName: result.targetProof.databaseName,
      tables: result.totals.tableCount,
      rows: result.totals.exportedRowCount,
      verified: result.tables.every((table) => table.verified),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof BackupError ? error.message : "backup_failed";
    const detail =
      error instanceof Error && error.stack ? `\n${error.stack}` : "";
    process.stderr.write(`${code}${detail}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await main();
}
