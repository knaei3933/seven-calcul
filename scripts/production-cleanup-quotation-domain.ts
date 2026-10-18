#!/usr/bin/env node
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client as PgClient, QueryResult } from "pg";
import {
  verifyBackupManifest,
  type BackupResult,
  type BackupTargetProof,
  parseProductionTarget,
  productionClientOptions,
} from "./backup-quotation-domain.ts";

const PRODUCTION_DELETION_ORDER = [
  "film_order_events",
  "film_order_files",
  "film_orders",
  "quotation_checklists",
  "quotations",
] as const;

type DomainTable = (typeof PRODUCTION_DELETION_ORDER)[number];

const EXPECTED_FOREIGN_KEYS: Record<DomainTable, string[]> = {
  film_order_events: ["film_orders"],
  film_order_files: ["film_orders"],
  film_orders: ["quotations"],
  quotation_checklists: ["quotations"],
  quotations: ["users"],
};

const EXPECTED_ORDER_COLUMNS: Record<DomainTable, string[]> = {
  film_order_events: ["id"],
  film_order_files: ["id"],
  film_orders: ["id"],
  quotation_checklists: ["quotation_id", "audience"],
  quotations: ["id"],
};

const AUTHORIZATION_ALGORITHM = "pouch-production-cleanup-challenge-v1";
const DEFAULT_AUTHORIZATION_TTL_SECONDS = 900;
const STREAM_PAGE_SIZE = 500;

export interface TableIdentity {
  name: string;
  rowCount: number;
  identitySha256: string;
}

export interface AuthorizationEvidence {
  algorithm: string;
  tool: { name: string; version: string };
  phase: 1;
  nonce: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  target: BackupTargetProof;
  manifest: {
    path: string;
    sha256: string;
    tables: DomainTable[];
    sourceCounts: Record<DomainTable, number>;
    binaryValueCount: number;
    binaryByteCount: number;
    verified: true;
  };
  foreignKeyGraph: Record<string, string[]>;
  foreignKeyGraphVerified: true;
  retainedTables: TableIdentity[];
  authorization: {
    challengeTokenSha256: string;
    evidenceHmacSha256: string;
  };
}

export interface ProductionAuthorizationResult {
  outcome: "authorization_created";
  backup: BackupResult;
  authorizationPath: string;
  challengePath: string;
  expiresAtUtc: string;
}

export interface ProductionCleanupResult {
  outcome: "deleted" | "committed_with_post_commit_warning";
  target: BackupTargetProof;
  backup: {
    manifestPath: string;
    manifestSha256: string;
    sourceCounts: Record<DomainTable, number>;
    binaryValueCount: number;
    binaryByteCount: number;
    verified: true;
  };
  sourceBackupMatch: {
    columnIdentityVerified: true;
    rowCountVerified: true;
    recordValueVerified: true;
    foreignKeyGraphVerified: true;
  };
  deletion: {
    order: DomainTable[];
    deletedRowCount: Record<DomainTable, number>;
    transaction: "committed";
    isolationLevel: "read-committed";
    writeFence: "access-exclusive";
    domainRowsAfterDelete: 0;
  };
  domainTables: Array<{ name: DomainTable; before: number; after: 0 }>;
  retainedTables: Array<{
    name: string;
    before: TableIdentity;
    afterDelete: TableIdentity;
    unchanged: true;
  }>;
  postCommitVerification: "not_performed" | "verified" | "warning";
  postCommitWarning?: string;
}

interface ProductionCleanupOptions {
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  postgres?: { Client: typeof PgClient };
  now?: () => Date;
  verifyAfterCommit?: boolean;
}

interface PgLikeClient {
  connect(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  end(): Promise<void>;
}

interface ValidatedProductionTargetProof extends BackupTargetProof {
  schema: string;
}

class ProductionCleanupError extends Error {}
class CommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("production_cleanup_commit_outcome_unknown");
    this.cause = cause;
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new ProductionCleanupError("invalid_database_identifier");
  }
  return `"${identifier}"`;
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function constantTimeHexEquals(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function parseArgs(argv: string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {};
  const valueKeys = new Set([
    "phase",
    "target",
    "confirm-host",
    "confirm-database",
    "confirm-schema",
    "backup-manifest",
    "confirm-domain-tables",
    "output-dir",
    "authorization-file",
    "challenge",
    "challenge-file",
    "authorization-ttl-seconds",
  ]);
  const booleanKeys = new Set([
    "confirm-production-deletion",
    "confirm-production-read-only-backup",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) {
      throw new ProductionCleanupError(`unknown_argument:${argument ?? ""}`);
    }
    const key = argument.slice(2);
    if (key in parsed) throw new ProductionCleanupError(`duplicate_argument:${key}`);
    if (valueKeys.has(key)) {
      const value = argv[++index];
      if (!value?.trim()) throw new ProductionCleanupError(`missing_value:${key}`);
      parsed[key] = value;
    } else if (booleanKeys.has(key)) {
      parsed[key] = true;
    } else {
      throw new ProductionCleanupError(`unknown_argument:${argument}`);
    }
  }
  if (parsed["confirm-production-deletion"] === true) {
    parsed.confirmProductionDeletion = true;
  }
  if (parsed["confirm-production-read-only-backup"] === true) {
    parsed.confirmProductionReadOnlyBackup = true;
  }
  return parsed;
}

function requireString(parsed: Record<string, string | true>, key: string): string {
  const value = parsed[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ProductionCleanupError(`missing_required_argument:${key}`);
  }
  return value;
}

function requireProductionTarget(parsed: Record<string, string | true>): void {
  if (parsed.target !== "production") {
    throw new ProductionCleanupError("target_must_be_production");
  }
}

function requireSchema(parsed: Record<string, string | true>): string {
  const schema = requireString(parsed, "confirm-schema");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new ProductionCleanupError("invalid_database_identifier");
  }
  return schema;
}

function confirmTarget(
  parsed: Record<string, string | true>,
  target: ReturnType<typeof parseProductionTarget>,
): void {
  if (requireString(parsed, "confirm-host") !== target.host) {
    throw new ProductionCleanupError("production_host_confirmation_mismatch");
  }
  if (requireString(parsed, "confirm-database") !== target.databaseName) {
    throw new ProductionCleanupError("production_database_confirmation_mismatch");
  }
}

function requireDomainTableConfirmation(
  parsed: Record<string, string | true>,
): void {
  const confirmedTables = requireString(parsed, "confirm-domain-tables")
    .split(",")
    .map((table) => table.trim());
  if (JSON.stringify(confirmedTables) !== JSON.stringify(PRODUCTION_DELETION_ORDER)) {
    throw new ProductionCleanupError("domain_table_confirmation_mismatch");
  }
}

function manifestPath(cwd: string, value: string): string {
  const path = resolve(cwd, value);
  if (!isAbsolute(path) || path.slice(path.lastIndexOf("/") + 1) !== "manifest.json") {
    throw new ProductionCleanupError("backup_manifest_file_name_mismatch");
  }
  return path;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === undefined) return JSON.stringify(null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value instanceof Uint8Array) {
    return JSON.stringify(["__pouchBinary", Buffer.from(value).toString("base64")]);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
    return `{${entries.join(",")}}`;
  }
  throw new ProductionCleanupError("unsupported_authorization_value");
}

function encodeBackupValue(value: unknown): unknown {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
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

async function toolVersion(cwd: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

async function queryColumns(
  client: PgLikeClient,
  tableName: string,
): Promise<Array<{ name: string; dataType: string }>> {
  const rows = await client.query<{ column_name: string; data_type: string }>(
    `
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = $1
    ORDER BY ordinal_position
  `,
    [tableName],
  );
  return rows.rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
  }));
}

async function queryTableRowCount(
  client: PgLikeClient,
  tableName: string,
): Promise<number> {
  const row = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(tableName)}`,
  );
  const count = Number(row.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ProductionCleanupError(`invalid_row_count:${tableName}`);
  }
  return count;
}

async function queryPrimaryKeys(
  client: PgLikeClient,
  tableName: string,
): Promise<string[]> {
  const rows = await client.query<{ column_name: string }>(
    `
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = $1
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `,
    [tableName],
  );
  return rows.rows.map((row) => row.column_name);
}

async function* streamRows(
  client: PgLikeClient,
  tableName: string,
  orderColumns: string[],
): AsyncGenerator<Record<string, unknown>> {
  const order = orderColumns.map(quoteIdentifier).join(", ");
  for (let offset = 0; ; offset += STREAM_PAGE_SIZE) {
    const result = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY ${order} ASC LIMIT $1 OFFSET $2`,
      [STREAM_PAGE_SIZE, offset],
    );
    for (const row of result.rows) yield row;
    if (result.rows.length < STREAM_PAGE_SIZE) return;
  }
}

async function tableIdentity(
  client: PgLikeClient,
  tableName: string,
): Promise<TableIdentity> {
  const columns = await queryColumns(client, tableName);
  if (!columns.length) {
    throw new ProductionCleanupError(`required_table_missing:${tableName}`);
  }
  const primaryKeys = await queryPrimaryKeys(client, tableName);
  const order = primaryKeys.length ? primaryKeys : columns.map((column) => column.name);
  const rowCount = await queryTableRowCount(client, tableName);
  const hash = createHash("sha256");
  hash.update(
    `table\0${tableName}\0columns\0${columns.map((column) => column.name).join("\0")}\0count\0${rowCount}\0`,
  );
  let streamedCount = 0;
  for await (const row of streamRows(client, tableName, order)) {
    streamedCount += 1;
    hash.update("row\0");
    for (const column of columns) {
      hash.update(`${column.name}\0${canonicalJson(encodeBackupValue(row[column.name]))}\0`);
    }
  }
  if (streamedCount !== rowCount) {
    throw new ProductionCleanupError(`table_snapshot_changed:${tableName}`);
  }
  return { name: tableName, rowCount, identitySha256: hash.digest("hex") };
}

async function compareDomainRowsToBackup(input: {
  client: PgLikeClient;
  manifestPath: string;
  manifest: {
    tables: Array<{
      name: string;
      columns: Array<{ name: string; dataType: string | null }>;
    }>;
  };
}): Promise<void> {
  for (const table of input.manifest.tables) {
    const columns = await queryColumns(input.client, table.name);
    if (
      JSON.stringify(columns) !==
      JSON.stringify(
        table.columns.map((column) => ({
          name: column.name,
          dataType: column.dataType,
        })),
      )
    ) {
      throw new ProductionCleanupError(`target_backup_column_identity_mismatch:${table.name}`);
    }
    const artifactBytes = await readFile(
      join(dirname(input.manifestPath), `${table.name}.jsonl`),
    );
    const artifactLines =
      artifactBytes.byteLength === 0
        ? []
        : artifactBytes.toString("utf8").split("\n").slice(0, -1);
    const rowCount = await queryTableRowCount(input.client, table.name);
    if (artifactLines.length !== rowCount) {
      throw new ProductionCleanupError(`target_backup_row_count_mismatch:${table.name}`);
    }
    let rowIndex = 0;
    for await (const row of streamRows(
      input.client,
      table.name,
      EXPECTED_ORDER_COLUMNS[table.name as DomainTable],
    )) {
      if (rowIndex >= artifactLines.length) {
        throw new ProductionCleanupError(`target_snapshot_changed:${table.name}`);
      }
      const values = columns.map((column) => encodeBackupValue(row[column.name]));
      let backupRecord: { columns?: string[]; values?: unknown[] };
      try {
        backupRecord = JSON.parse(artifactLines[rowIndex]!) as typeof backupRecord;
      } catch {
        throw new ProductionCleanupError(`backup_artifact_record_invalid_json:${table.name}`);
      }
      if (
        canonicalJson({ columns: columns.map((column) => column.name), values }) !==
        canonicalJson({ columns: backupRecord.columns, values: backupRecord.values })
      ) {
        throw new ProductionCleanupError(
          `target_backup_record_mismatch:${table.name}:${rowIndex}`,
        );
      }
      rowIndex += 1;
    }
    if (rowIndex !== artifactLines.length || rowIndex !== rowCount) {
      throw new ProductionCleanupError(`target_snapshot_changed:${table.name}`);
    }
  }
}

async function foreignKeyGraph(
  client: PgLikeClient,
  schemaName: string,
): Promise<Record<string, string[]>> {
  const rows = await client.query<{
    child_table: string;
    parent_table: string;
    parent_schema: string;
  }>(`
    SELECT child.relname AS child_table,
           parent.relname AS parent_table,
           parent_namespace.nspname AS parent_schema
    FROM pg_constraint constraint_definition
    JOIN pg_class child ON child.oid = constraint_definition.conrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = constraint_definition.confrelid
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    WHERE constraint_definition.contype = 'f'
      AND child_namespace.nspname = current_schema()
    ORDER BY child.relname, constraint_definition.oid
  `);
  const graph: Record<string, string[]> = {};
  for (const row of rows.rows) {
    if (row.parent_schema !== schemaName) {
      throw new ProductionCleanupError(`cross_schema_quotation_domain_dependency:${row.child_table}`);
    }
    graph[row.child_table] ??= [];
    if (!graph[row.child_table]!.includes(row.parent_table)) {
      graph[row.child_table]!.push(row.parent_table);
    }
  }
  return graph;
}

function verifyForeignKeyGraph(graph: Record<string, string[]>): void {
  const domain = new Set<string>(PRODUCTION_DELETION_ORDER);
  for (const table of PRODUCTION_DELETION_ORDER) {
    const actualParents = [...(graph[table] ?? [])].sort();
    const expectedParents = [...EXPECTED_FOREIGN_KEYS[table]].sort();
    if (JSON.stringify(actualParents) !== JSON.stringify(expectedParents)) {
      throw new ProductionCleanupError(`unexpected_quotation_domain_foreign_keys:${table}`);
    }
  }
  const allTables = new Set(Object.keys(graph));
  for (const table of PRODUCTION_DELETION_ORDER) allTables.add(table);
  for (const child of Object.keys(graph)) {
    if (domain.has(child)) continue;
    const visited = new Set<string>();
    const stack = [...graph[child]!];
    while (stack.length) {
      const parent = stack.pop()!;
      if (visited.has(parent)) continue;
      visited.add(parent);
      if (domain.has(parent)) {
        throw new ProductionCleanupError(`undeclared_quotation_domain_dependent_table:${child}`);
      }
      stack.push(...(graph[parent] ?? []));
    }
  }
}

function identitiesMatch(before: TableIdentity[], after: TableIdentity[]): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new ProductionCleanupError("retained_table_identity_changed");
  }
}

async function targetProof(
  client: PgLikeClient,
): Promise<ValidatedProductionTargetProof & {
  row: {
    database_name: string;
    schema_name: string;
    server_version: string;
    server_address: string | null;
  };
}> {
  const result = await client.query<{
    database_name: string;
    schema_name: string;
    server_version: string;
    server_address: string | null;
    server_port: string | number | null;
  }>(`
    SELECT current_database() AS database_name,
           current_schema() AS schema_name,
           version() AS server_version,
           inet_server_addr()::text AS server_address,
           inet_server_port()::text AS server_port
  `);
  const row = result.rows[0];
  if (!row) throw new ProductionCleanupError("production_target_proof_missing");
  return {
    requestedTarget: "production",
    resolvedTarget: "postgresql-production",
    engine: "PostgreSQL",
    engineVersion: row.server_version,
    host: "",
    port: "",
    databaseName: row.database_name,
    schema: row.schema_name,
    serverResolvedHost: row.server_address,
    row,
  };
}

async function currentTableNames(client: PgLikeClient): Promise<string[]> {
  const tables = await client.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return tables.rows.map((row) => row.table_name);
}

function retainedNames(tableNames: string[]): string[] {
  return tableNames.filter(
    (table) => !(PRODUCTION_DELETION_ORDER as readonly string[]).includes(table),
  );
}

async function retainedIdentities(
  client: PgLikeClient,
  tableNames: string[],
): Promise<TableIdentity[]> {
  const identities: TableIdentity[] = [];
  for (const table of retainedNames(tableNames)) {
    identities.push(await tableIdentity(client, table));
  }
  return identities;
}

export function signAuthorizationEvidence(
  evidence: AuthorizationEvidence,
  challenge: string,
): string {
  const { authorization: _authentication, ...unsigned } = evidence;
  return createHmac("sha256", challenge)
    .update(canonicalJson(unsigned))
    .digest("hex");
}

function assertNoCredentials(content: string, env: Record<string, string | undefined>): void {
  const url = env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) return;
  try {
    const parsed = new URL(url);
    for (const secret of [parsed.username, parsed.password]) {
      if (secret.length >= 8 && content.includes(secret)) {
        throw new ProductionCleanupError("authorization_contains_credentials");
      }
    }
  } catch (error) {
    if (error instanceof ProductionCleanupError) throw error;
  }
}

async function validateTargetProofMatchesAuthorization(input: {
  client: PgLikeClient;
  target: ReturnType<typeof parseProductionTarget>;
  expectedSchema: string;
  expectedTarget: BackupTargetProof;
}): Promise<ValidatedProductionTargetProof> {
  const proofRow = await targetProof(input.client);
  proofRow.host = input.target.host;
  proofRow.port = input.target.port;
  if (proofRow.databaseName !== input.target.databaseName) {
    throw new ProductionCleanupError("resolved_production_database_mismatch");
  }
  if (proofRow.schema !== input.expectedSchema) {
    throw new ProductionCleanupError("resolved_production_schema_mismatch");
  }
  if (proofRow.host !== input.expectedTarget.host || proofRow.port !== input.expectedTarget.port) {
    throw new ProductionCleanupError("target_identity_authorization_mismatch");
  }
  if (proofRow.engineVersion !== input.expectedTarget.engineVersion) {
    throw new ProductionCleanupError("target_identity_engine_version_mismatch");
  }
  if (proofRow.serverResolvedHost !== input.expectedTarget.serverResolvedHost) {
    throw new ProductionCleanupError("target_identity_resolved_host_mismatch");
  }
  return proofRow;
}

export async function runProductionAuthorization(
  options: ProductionCleanupOptions = {},
): Promise<ProductionAuthorizationResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseArgs(options.args ?? []);
  if (parsed.phase !== "1") throw new ProductionCleanupError("phase_1_required");
  requireProductionTarget(parsed);
  const target = parseProductionTarget(env);
  confirmTarget(parsed, target);
  const schema = requireSchema(parsed);
  requireDomainTableConfirmation(parsed);
    if (!parsed.confirmProductionReadOnlyBackup) {
    throw new ProductionCleanupError("production_requires_confirm_production_read_only_backup");
  }
  const outputDirectory = resolve(cwd, requireString(parsed, "output-dir"));
  const ttlRaw = parsed["authorization-ttl-seconds"];
  const ttlSeconds = ttlRaw === undefined || ttlRaw === true ? DEFAULT_AUTHORIZATION_TTL_SECONDS : Number(ttlRaw);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3600) {
    throw new ProductionCleanupError("invalid_authorization_ttl");
  }

  const backup = await runBackupSafe(options, parsed, outputDirectory);
  if (backup.targetProof.requestedTarget !== "production") {
    throw new ProductionCleanupError("production_backup_target_mismatch");
  }

  const Client = options.postgres?.Client ?? (await import("pg")).Client;
  const client = new Client(productionClientOptions(target)) as unknown as PgLikeClient;
  await client.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const proofRow = await validateTargetProofMatchesAuthorization({
      client,
      target,
      expectedSchema: schema,
      expectedTarget: backup.targetProof,
    });
    const verified = await verifyBackupManifest({
      manifestPath: backup.manifestPath,
      expectedTarget: proofRow,
      expectedTables: PRODUCTION_DELETION_ORDER,
    });
    const verifiedTableNames = await currentTableNames(client);
    if (
      PRODUCTION_DELETION_ORDER.some((table) => !verifiedTableNames.includes(table))
    ) {
      throw new ProductionCleanupError("required_quotation_domain_table_missing");
    }
    const graph = await foreignKeyGraph(client, proofRow.schema);
    verifyForeignKeyGraph(graph);
    await compareDomainRowsToBackup({
      client,
      manifestPath: backup.manifestPath,
      manifest: verified.manifest,
    });
    const domainIdentities: TableIdentity[] = [];
    for (const table of PRODUCTION_DELETION_ORDER) {
      const identity = await tableIdentity(client, table);
      if (identity.rowCount !== verified.sourceCounts[table]) {
        throw new ProductionCleanupError(`target_source_count_mismatch:${table}`);
      }
      domainIdentities.push(identity);
    }
    const retainedTables = await retainedIdentities(client, verifiedTableNames);

    const now = (options.now ?? (() => new Date()))();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const challenge = randomBytes(32).toString("hex");
    const manifestSha256 = verified.manifestSha256;
    const evidence: AuthorizationEvidence = {
      algorithm: AUTHORIZATION_ALGORITHM,
      tool: {
        name: "pouch-clacul-production-cleanup",
        version: await toolVersion(cwd),
      },
      phase: 1,
      nonce: randomBytes(32).toString("hex"),
      createdAtUtc: now.toISOString(),
      expiresAtUtc: expiresAt.toISOString(),
      target: proofRow,
      manifest: {
        path: backup.manifestPath,
        sha256: manifestSha256,
        tables: [...PRODUCTION_DELETION_ORDER],
        sourceCounts: Object.fromEntries(
          PRODUCTION_DELETION_ORDER.map((table) => [table, verified.sourceCounts[table]]),
        ) as Record<DomainTable, number>,
        binaryValueCount: verified.binaryValueCount,
        binaryByteCount: verified.binaryByteCount,
        verified: true,
      },
      foreignKeyGraph: graph,
      foreignKeyGraphVerified: true,
      retainedTables,
      authorization: {
        challengeTokenSha256: sha256Hex(challenge),
        evidenceHmacSha256: "",
      },
    };
    evidence.authorization.evidenceHmacSha256 = signAuthorizationEvidence(
      evidence,
      challenge,
    );
    const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;
    assertNoCredentials(evidenceJson, env);
    const authorizationPath = join(outputDirectory, "authorization.json");
    const challengePath = join(outputDirectory, "authorization.challenge");
    await writeFile(authorizationPath, evidenceJson, { flag: "wx", mode: 0o600 });
    await writeFile(challengePath, `${challenge}\n`, { flag: "wx", mode: 0o600 });
    await client.query("ROLLBACK");
    transactionOpen = false;
    return {
      outcome: "authorization_created",
      backup,
      authorizationPath,
      challengePath,
      expiresAtUtc: evidence.expiresAtUtc,
    };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function runBackupSafe(
  options: ProductionCleanupOptions,
  parsed: Record<string, string | true>,
  outputDirectory: string,
): Promise<BackupResult> {
  const { runBackup } = await import("./backup-quotation-domain.ts");
  return runBackup({
    env: options.env,
    cwd: options.cwd,
    postgres: options.postgres,
    args: [
      "--target",
      "production",
      "--confirm-production-read-only-backup",
      "--confirm-host",
      requireString(parsed, "confirm-host"),
      "--confirm-database",
      requireString(parsed, "confirm-database"),
      "--output-dir",
      outputDirectory,
    ],
  });
}

function isAuthorizationEvidence(value: unknown): value is AuthorizationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Partial<AuthorizationEvidence>;
  return (
    evidence.algorithm === AUTHORIZATION_ALGORITHM &&
    evidence.tool?.name === "pouch-clacul-production-cleanup" &&
    typeof evidence.tool?.version === "string" &&
    evidence.phase === 1 &&
    /^[0-9a-f]{64}$/.test(evidence.nonce ?? "") &&
    typeof evidence.createdAtUtc === "string" &&
    typeof evidence.expiresAtUtc === "string" &&
    Number.isNaN(Date.parse(evidence.createdAtUtc)) === false &&
    Number.isNaN(Date.parse(evidence.expiresAtUtc)) === false &&
    typeof evidence.target === "object" &&
    typeof evidence.target?.schema === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(evidence.target.schema) &&
    typeof evidence.manifest === "object" &&
    typeof evidence.manifest.path === "string" &&
    /^[0-9a-f]{64}$/.test(evidence.manifest.sha256 ?? "") &&
    JSON.stringify(evidence.manifest.tables) === JSON.stringify(PRODUCTION_DELETION_ORDER) &&
    typeof evidence.foreignKeyGraph === "object" &&
    evidence.foreignKeyGraphVerified === true &&
    Array.isArray(evidence.retainedTables) &&
    typeof evidence.authorization === "object" &&
    /^[0-9a-f]{64}$/.test(evidence.authorization.challengeTokenSha256 ?? "") &&
    /^[0-9a-f]{64}$/.test(evidence.authorization.evidenceHmacSha256 ?? "")
  );
}

export async function readValidAuthorization(input: {
  authorizationPath: string;
  challenge: string;
  now?: () => Date;
}): Promise<AuthorizationEvidence> {
  if (!/^[0-9a-f]{64}$/.test(input.challenge)) {
    throw new ProductionCleanupError("production_cleanup_challenge_invalid");
  }
  let evidenceJson: string;
  try {
    evidenceJson = await readFile(input.authorizationPath, "utf8");
  } catch {
    throw new ProductionCleanupError(`authorization_not_found:${input.authorizationPath}`);
  }
  let evidence: AuthorizationEvidence;
  try {
    evidence = JSON.parse(evidenceJson) as AuthorizationEvidence;
  } catch {
    throw new ProductionCleanupError("authorization_invalid_json");
  }
  if (!isAuthorizationEvidence(evidence)) {
    throw new ProductionCleanupError("authorization_shape_invalid");
  }
  if (
    !constantTimeHexEquals(
      sha256Hex(input.challenge),
      evidence.authorization.challengeTokenSha256,
    )
  ) {
    throw new ProductionCleanupError("production_cleanup_challenge_mismatch");
  }
  const expectedHmac = signAuthorizationEvidence(evidence, input.challenge);
  if (
    !constantTimeHexEquals(expectedHmac, evidence.authorization.evidenceHmacSha256)
  ) {
    throw new ProductionCleanupError("authorization_evidence_tampered");
  }
  const now = (input.now ?? (() => new Date()))();
  if (
    now.getTime() < Date.parse(evidence.createdAtUtc) ||
    now.getTime() > Date.parse(evidence.expiresAtUtc)
  ) {
    throw new ProductionCleanupError("authorization_expired_or_not_yet_valid");
  }
  return evidence;
}

async function deletionTransaction(input: {
  client: PgLikeClient;
  target: ReturnType<typeof parseProductionTarget>;
  confirmationSchema: string;
  manifestPath: string;
  authorization: AuthorizationEvidence;
}): Promise<{
  proof: ProductionCleanupResult["target"];
  result: Omit<ProductionCleanupResult, "postCommitVerification" | "postCommitWarning">;
}> {
  const { client } = input;
  await client.connect();
  let transactionOpen = false;
  let commitInitiated = false;
  let committed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    transactionOpen = true;
    const proofRow = await validateTargetProofMatchesAuthorization({
      client,
      target: input.target,
      expectedSchema: input.authorization.target.schema!,
      expectedTarget: input.authorization.target,
    });
    if (proofRow.schema !== input.confirmationSchema) {
      throw new ProductionCleanupError("operator_schema_confirmation_mismatch");
    }
    const verified = await verifyBackupManifest({
      manifestPath: input.manifestPath,
      expectedTarget: proofRow,
      expectedTables: PRODUCTION_DELETION_ORDER,
    });
    if (verified.manifestSha256 !== input.authorization.manifest.sha256) {
      throw new ProductionCleanupError("authorization_manifest_mismatch");
    }
    if (
      PRODUCTION_DELETION_ORDER.some(
        (table) =>
          verified.sourceCounts[table] !==
          input.authorization.manifest.sourceCounts[table],
      ) ||
      verified.binaryValueCount !== input.authorization.manifest.binaryValueCount ||
      verified.binaryByteCount !== input.authorization.manifest.binaryByteCount
    ) {
      throw new ProductionCleanupError("authorization_backup_totals_mismatch");
    }

    const tableNames = await currentTableNames(client);
    if (PRODUCTION_DELETION_ORDER.some((table) => !tableNames.includes(table))) {
      throw new ProductionCleanupError("required_quotation_domain_table_missing");
    }
    const lockTables = PRODUCTION_DELETION_ORDER.map(quoteIdentifier).join(", ");
    await client.query(`LOCK TABLE ${lockTables} IN ACCESS EXCLUSIVE MODE`);
    verifyForeignKeyGraph(await foreignKeyGraph(client, proofRow.schema));

    await compareDomainRowsToBackup({
      client,
      manifestPath: input.manifestPath,
      manifest: verified.manifest,
    });
    const beforeDomain: TableIdentity[] = [];
    for (const table of PRODUCTION_DELETION_ORDER) {
      const identity = await tableIdentity(client, table);
      if (identity.rowCount !== verified.sourceCounts[table]) {
        throw new ProductionCleanupError(`target_source_count_mismatch:${table}`);
      }
      beforeDomain.push(identity);
    }
    const beforeRetained = await retainedIdentities(client, tableNames);
    identitiesMatch(input.authorization.retainedTables, beforeRetained);

    const deleted = {} as Record<DomainTable, number>;
    for (const table of PRODUCTION_DELETION_ORDER) {
      const result = await client.query(`DELETE FROM ${quoteIdentifier(table)}`);
      deleted[table] = Number(result.rowCount ?? -1);
      if (deleted[table] < 0) {
        throw new ProductionCleanupError(`invalid_delete_row_count:${table}`);
      }
      if (deleted[table] !== verified.sourceCounts[table]) {
        throw new ProductionCleanupError(`delete_row_count_mismatch:${table}`);
      }
    }
    const afterDeleteRetained = await retainedIdentities(client, tableNames);
    identitiesMatch(beforeRetained, afterDeleteRetained);
    for (const table of PRODUCTION_DELETION_ORDER) {
      if ((await queryTableRowCount(client, table)) !== 0) {
        throw new ProductionCleanupError(`quotation_domain_not_empty:${table}`);
      }
    }

    try {
      await client.query("COMMIT");
      commitInitiated = true;
      transactionOpen = false;
      committed = true;
    } catch (error) {
      transactionOpen = false;
      commitInitiated = true;
      throw new CommitOutcomeUnknownError(error);
    }

    const proof: ProductionCleanupResult["target"] = {
      ...proofRow,
      host: input.target.host,
      port: input.target.port,
    };
    const result: Omit<ProductionCleanupResult, "postCommitVerification" | "postCommitWarning"> = {
      outcome: "deleted",
      target: proof,
      backup: {
        manifestPath: input.manifestPath,
        manifestSha256: verified.manifestSha256,
        sourceCounts: input.authorization.manifest.sourceCounts,
        binaryValueCount: verified.binaryValueCount,
        binaryByteCount: verified.binaryByteCount,
        verified: true,
      },
      sourceBackupMatch: {
        columnIdentityVerified: true,
        rowCountVerified: true,
        recordValueVerified: true,
        foreignKeyGraphVerified: true,
      },
      deletion: {
        order: [...PRODUCTION_DELETION_ORDER],
        deletedRowCount: deleted,
        transaction: "committed",
        isolationLevel: "read-committed",
        writeFence: "access-exclusive",
        domainRowsAfterDelete: 0,
      },
      domainTables: beforeDomain.map((before) => ({
        name: before.name as DomainTable,
        before: before.rowCount,
        after: 0 as const,
      })),
      retainedTables: beforeRetained.map((before) => ({
        name: before.name,
        before,
        afterDelete: afterDeleteRetained.find((identity) => identity.name === before.name)!,
        unchanged: true as const,
      })),
    };
    return { proof, result };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    if (commitInitiated && !committed && error instanceof CommitOutcomeUnknownError) {
      throw error.cause;
    }
    throw error;
  }
}

async function verifyAfterCommit(input: {
  client: PgLikeClient;
  tableNames: string[];
  beforeRetained: TableIdentity[];
  afterDeleteRetained: TableIdentity[];
  domainTables: readonly DomainTable[];
}): Promise<void> {
  const afterCommit = await retainedIdentities(input.client, input.tableNames);
  identitiesMatch(input.afterDeleteRetained, afterCommit);
  for (const table of input.domainTables) {
    if ((await queryTableRowCount(input.client, table)) !== 0) {
      throw new ProductionCleanupError(`quotation_domain_not_empty_after_commit:${table}`);
    }
  }
}

export async function runProductionCleanup(
  options: ProductionCleanupOptions = {},
): Promise<ProductionCleanupResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseArgs(options.args ?? []);
  const phase = requireString(parsed, "phase");
  if (phase !== "2") throw new ProductionCleanupError("phase_2_required");
  requireProductionTarget(parsed);
  requireFlagForDeletion(parsed);
  const target = parseProductionTarget(env);
  confirmTarget(parsed, target);
  const confirmationSchema = requireSchema(parsed);
  requireDomainTableConfirmation(parsed);
  const manifestPathValue = manifestPath(cwd, requireString(parsed, "backup-manifest"));
  const authorizationPath = resolve(cwd, requireString(parsed, "authorization-file"));
  const challengeArg = parsed.challenge;
  const challengeFileArg = parsed["challenge-file"];
  if (
    (challengeArg === undefined) === (challengeFileArg === undefined)
  ) {
    throw new ProductionCleanupError("exactly_one_challenge_source_required");
  }
  const challenge =
    typeof challengeArg === "string"
      ? challengeArg
      : (await readFile(resolve(cwd, requireString(parsed, "challenge-file")), "utf8")).trim();
  const authorization = await readValidAuthorization({
    authorizationPath,
    challenge,
    now: options.now,
  });
  if (resolve(authorization.manifest.path) !== manifestPathValue) {
    throw new ProductionCleanupError("authorization_manifest_path_mismatch");
  }
  if (
    authorization.target.requestedTarget !== "production" ||
    authorization.target.host !== target.host ||
    authorization.target.port !== target.port ||
    authorization.target.databaseName !== target.databaseName
  ) {
    throw new ProductionCleanupError("authorization_target_mismatch");
  }
  if (authorization.target.schema !== confirmationSchema) {
    throw new ProductionCleanupError("authorization_schema_confirmation_mismatch");
  }

  const Client = options.postgres?.Client ?? (await import("pg")).Client;
  const client = new Client(productionClientOptions(target)) as unknown as PgLikeClient;
  try {
    const deletion = await deletionTransaction({
      client,
      target,
      confirmationSchema,
      manifestPath: manifestPathValue,
      authorization,
    });
    if (options.verifyAfterCommit === true) {
      try {
        await verifyAfterCommit({
          client,
          tableNames: [
            ...PRODUCTION_DELETION_ORDER,
            ...authorization.retainedTables.map((table) => table.name),
          ],
          beforeRetained: authorization.retainedTables,
          afterDeleteRetained: deletion.result.retainedTables.map((table) => table.afterDelete),
          domainTables: PRODUCTION_DELETION_ORDER,
        });
        return {
          ...deletion.result,
          postCommitVerification: "verified",
        };
      } catch (error) {
        return {
          ...deletion.result,
          outcome: "committed_with_post_commit_warning",
          postCommitVerification: "warning",
          postCommitWarning: error instanceof Error ? error.message : "post_commit_verification_failed",
        };
      }
    }
    return {
      ...deletion.result,
      postCommitVerification: "not_performed",
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function requireFlagForDeletion(parsed: Record<string, string | true>): void {
  if (parsed.confirmProductionDeletion !== true) {
    throw new ProductionCleanupError("requires_confirm_production_deletion");
  }
}

export async function main(argv: string[]): Promise<void> {
  try {
    if (argv[0] === "--phase" && argv[1] === "1") {
      const result = await runProductionAuthorization({ args: argv });
      process.stdout.write(
        `${JSON.stringify(
          {
            outcome: result.outcome,
            backup: result.backup.manifestPath,
            manifestSha256: result.backup.manifestSha256,
            authorization: result.authorizationPath,
            challenge: result.challengePath,
            expiresAtUtc: result.expiresAtUtc,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    const result = await runProductionCleanup({ args: argv });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.outcome === "committed_with_post_commit_warning") process.exitCode = 3;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stderr.write(`quotation_production_cleanup_failed:${message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}
