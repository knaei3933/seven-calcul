import { canonicalize } from "@/lib/canonical-json";
import { calculatePouchCost, type CostResult } from "@/lib/calculation";
import { CALCULATION_VERSION } from "@/lib/constants";
import { defaultParameters } from "@/lib/constants";
import { resolveFilmUnitPrices } from "@/lib/film-price-store";
import {
  getGravureSnapshot,
  resolveGravureMasters,
  tokyoDate,
  verifyGravureSnapshot,
  verifyGravureSnapshotIssuance,
} from "@/lib/gravure-price-store";
import { getSqlClient, type SqlClient } from "@/lib/db";
import { hasValidSimulatorProvenance } from "@/app/api/quotations/route";
import type { QuotationRecord } from "@/lib/quotation-shared";

export type InternalApprovalBlockReason =
  | "unauthorized"
  | "forbidden_scope"
  | "approval_disabled"
  | "owner_domain_blocked"
  | "invalid_approval_transition"
  | "stale_calculation"
  | "canonical_pdf_required"
  | "pdf_integrity_failed"
  | "quote_expired"
  | "validation_blocked"
  | "sample_bulk_confirmation_required"
  | "policy_limit_exceeded";

export type InternalApprovalPolicyConfig = {
  enabled: boolean;
  configComplete: boolean;
  maxQuantity: number;
  maxCostJpy: number;
  maxValidityDays: number;
  allowedCustomerCodes: readonly string[];
  allowedPrintClasses: readonly string[];
  acknowledgedWarnings: readonly string[];
  approvedSnapshotAsOf: readonly string[];
  fingerprint: string;
};

type PolicySnapshotReference = {
  id?: unknown;
  sha256?: unknown;
  publicProjection?: unknown;
};

let configSchemaReady: Promise<SqlClient> | null = null;

function envValues(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function optionalNumber(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function dateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function safeConfigFingerprint(input: Omit<InternalApprovalPolicyConfig, "fingerprint">): string {
  return Array.from(new TextEncoder().encode(canonicalize(input)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function internalApprovalConfigFromEnv(): InternalApprovalPolicyConfig {
  const enabled = ["1", "true", "yes", "on"].includes(
    (process.env.AGENT_INTERNAL_APPROVAL_ENABLED ?? "").trim().toLowerCase(),
  );
  const maxQuantity = optionalNumber("AGENT_INTERNAL_APPROVAL_MAX_QUANTITY");
  const maxCostJpy = optionalNumber("AGENT_INTERNAL_APPROVAL_MAX_COST_JPY");
  const maxValidityDays = optionalNumber("AGENT_INTERNAL_APPROVAL_MAX_VALIDITY_DAYS");
  const allowedCustomerCodes = envValues("AGENT_INTERNAL_APPROVAL_ALLOWED_CUSTOMER_CODES");
  const allowedPrintClasses = envValues("AGENT_INTERNAL_APPROVAL_ALLOWED_PRINT_CLASSES");
  const acknowledgedWarnings = envValues("AGENT_INTERNAL_APPROVAL_ACKNOWLEDGED_WARNINGS");
  const approvedSnapshotAsOf = envValues("AGENT_INTERNAL_APPROVAL_APPROVED_SNAPSHOT_AS_OF")
    .filter(dateOnly);
  const values = {
    enabled,
    configComplete: maxQuantity !== null && maxCostJpy !== null && maxValidityDays !== null
      && allowedCustomerCodes.length > 0 && allowedPrintClasses.length > 0,
    maxQuantity: maxQuantity ?? 0,
    maxCostJpy: maxCostJpy ?? 0,
    maxValidityDays: maxValidityDays ?? 0,
    allowedCustomerCodes,
    allowedPrintClasses,
    acknowledgedWarnings,
    approvedSnapshotAsOf,
  };
  return { ...values, fingerprint: safeConfigFingerprint(values) };
}

async function configDatabase(): Promise<SqlClient> {
  configSchemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS agent_internal_approval_config_state (
        singleton TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
    return db;
  })();
  return configSchemaReady;
}

/**
 * Environment remains the deployment authority. This durable observation makes
 * the first request after a non-secret policy fingerprint change auditable.
 */
export async function observeInternalApprovalConfig(
  config: InternalApprovalPolicyConfig,
): Promise<"created" | "changed" | "unchanged"> {
  const db = await configDatabase();
  const now = new Date().toISOString();
  const current = await db.get<{ fingerprint: string }>(
    "SELECT fingerprint FROM agent_internal_approval_config_state WHERE singleton = 'default'",
  );
  if (!current) {
    await db.run(
      "INSERT INTO agent_internal_approval_config_state (singleton,fingerprint,observed_at) VALUES ('default',?,?)",
      [config.fingerprint, now],
    );
    return "created";
  }
  if (current.fingerprint === config.fingerprint) return "unchanged";
  await db.run(
    "UPDATE agent_internal_approval_config_state SET fingerprint=?,observed_at=? WHERE singleton='default'",
    [config.fingerprint, now],
  );
  return "changed";
}

export async function resetInternalApprovalPolicyForTest(): Promise<void> {
  configSchemaReady = null;
}

function payloadBlocks(record: QuotationRecord): string[] {
  const raw = record.payload.validationBlocks;
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
}

async function freshDigitalResult(
  record: QuotationRecord,
): Promise<{ result: CostResult; current: boolean }> {
  const storedRequest = record.payload.calculationRequest;
  if (!storedRequest || typeof storedRequest !== "object") {
    return { result: calculatePouchCost(record.payload.calculationRequest as never), current: false };
  }
  const asOf = new Date().toISOString().slice(0, 10);
  const currentPrices = await resolveFilmUnitPrices(asOf, defaultParameters.filmUnitPrices);
  const request = structuredClone(storedRequest) as Parameters<typeof calculatePouchCost>[0];
  request.parameters = { ...(request.parameters ?? {}), filmUnitPrices: currentPrices };
  const result = calculatePouchCost(request);
  const storedResult = calculatePouchCost(structuredClone(storedRequest) as Parameters<typeof calculatePouchCost>[0]);
  return {
    result,
    current: canonicalize(request.parameters?.filmUnitPrices) === canonicalize(currentPrices)
      && storedResult.audit.resultJsonSha256 === result.audit.resultJsonSha256,
  };
}

async function freshGravureResult(
  record: QuotationRecord,
  config: InternalApprovalPolicyConfig,
): Promise<{ result: CostResult; current: boolean }> {
  const reference = record.payload.pricingSnapshot as PolicySnapshotReference | undefined;
  const snapshot = await getGravureSnapshot(String(reference?.id ?? ""));
  if (!snapshot || snapshot.snapshotSha256 !== reference?.sha256) {
    throw new Error("pricing_snapshot_not_found");
  }
  verifyGravureSnapshot(snapshot);
  const verified = await verifyGravureSnapshotIssuance({
    snapshotId: reference?.id,
    snapshotSha256: reference?.sha256,
    publicProjection: reference?.publicProjection,
  });
  const today = tokyoDate();
  const explicitlyApproved = config.approvedSnapshotAsOf.includes(snapshot.asOf);
  if (!explicitlyApproved && snapshot.asOf !== today) {
    return { result: verified.result, current: false };
  }
  if (explicitlyApproved) return { result: verified.result, current: true };
  const resolved = await resolveGravureMasters(today);
  const current = canonicalize({
    yRows: snapshot.yRows,
    kSource: snapshot.kSource,
    kDerived: snapshot.kDerived,
    fallbackVersions: snapshot.fallbackVersions,
  }) === canonicalize({
    yRows: resolved.yRows,
    kSource: resolved.kSet?.source ?? snapshot.kSource,
    kDerived: resolved.kSet?.derived ?? snapshot.kDerived,
    fallbackVersions: resolved.fallbackVersions,
  });
  return { result: verified.result, current };
}

export type FreshnessEvaluation = {
  result: CostResult;
  fresh: boolean;
  version: boolean;
  provenance: boolean;
  storedHashMatches: boolean;
  authorityCurrent: boolean;
};

export async function evaluateCalculationFreshness(
  record: QuotationRecord,
  config: InternalApprovalPolicyConfig,
): Promise<FreshnessEvaluation> {
  const printClass = String(record.payload.printingMethod ?? "");
  const result = printClass === "gravure"
    ? await freshGravureResult(record, config)
    : await freshDigitalResult(record);
  const version = printClass === "gravure" ? record.calculationVersion === "2026-10.2-gravure-master" : record.calculationVersion === CALCULATION_VERSION;
  const provenance = printClass === "gravure" ? true : hasValidSimulatorProvenance(record);
  const hash = result.result.audit.resultJsonSha256 === record.resultHash;
  return {
    result: result.result,
    fresh: version && provenance && hash && result.current,
    version,
    provenance,
    storedHashMatches: hash,
    authorityCurrent: result.current,
  };
}

function decimal(value: unknown): number | null {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validityDays(record: QuotationRecord): number | null {
  const issue = Date.parse(`${record.issueDate.slice(0, 10)}T00:00:00Z`);
  const valid = Date.parse(`${record.validUntil.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(issue) && Number.isFinite(valid)
    ? Math.round((valid - issue) / 86_400_000)
    : null;
}

function sampleBulkPending(record: QuotationRecord): boolean {
  const confirmation = record.payload.sampleBulkConfirmation as
    | { required?: unknown; status?: unknown }
    | undefined;
  return confirmation?.required === true
    && confirmation.status !== "received"
    && confirmation.status !== "confirmed";
}

export function policyLimitExceeded(
  record: QuotationRecord,
  config: InternalApprovalPolicyConfig,
): boolean {
  const quantity = decimal(record.quantity);
  const cost = decimal(record.grandTotal);
  const validity = validityDays(record);
  const customerCode = String(record.payload.customerCode ?? "");
  const printClass = String(record.payload.printingMethod ?? "");
  return quantity === null || quantity > config.maxQuantity
    || cost === null || cost > config.maxCostJpy
    || validity === null || validity > config.maxValidityDays
    || !config.allowedCustomerCodes.includes(customerCode)
    || !config.allowedPrintClasses.includes(printClass);
}

export function quoteValidityExpired(record: QuotationRecord, todayJapanDate?: string): boolean {
  const valid = record.validUntil.slice(0, 10);
  const today = todayJapanDate ?? new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  return /^\d{4}-\d{2}-\d{2}$/u.test(valid) && valid < today;
}
