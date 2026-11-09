import type { SqlClient } from "./db";
import type { QuotationOwnerDomain } from "./quotation-shared";

/** The production owner assigned to every quotation that does not already exist. */
export const NEW_QUOTATION_OWNER_DOMAIN = "kanei" as const;

export class StaleLegacyQuotationNumberError extends Error {
  constructor() {
    super("stale_legacy_quotation_number");
    this.name = "StaleLegacyQuotationNumberError";
  }
}

export class QuotationNumberAllocationConflictError extends Error {
  constructor() {
    super("number_allocation_conflict");
    this.name = "QuotationNumberAllocationConflictError";
  }
}

export class NewQuotationOwnerPolicyError extends Error {
  constructor() {
    super("new_quotation_owner_policy_violation");
    this.name = "NewQuotationOwnerPolicyError";
  }
}

/** Allocation uses the JST calendar month at the moment the number is issued. */
export function jstQuotationMonth(allocationTime: Date = new Date()): string {
  return allocationTime.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" })
    .slice(0, 7)
    .replace("-", "");
}

export function newQuotationNumberPreparationPrefix(
  allocationTime: Date = new Date(),
): string {
  return `KT-${jstQuotationMonth(allocationTime)}-`;
}

function companyPrefixFor(ownerDomain: "seven" | "kanei"): string {
  return ownerDomain === "kanei" ? "KT" : "S7";
}

export function quotationOwnerPrefixMatches(
  ownerDomain: Exclude<QuotationOwnerDomain, "unresolved">,
  quotationNumber: string,
): boolean {
  return quotationNumber.startsWith(`${companyPrefixFor(ownerDomain)}-`);
}

/**
 * Generate the next number while holding the fixed owner/month transaction lock.
 * PostgreSQL uses a transaction-scoped advisory lock; SQLite transactions are
 * already serialized by BEGIN IMMEDIATE on the shared database connection.
 */
export async function allocateQuotationNumberInTransaction(
  tx: SqlClient,
  ownerDomain: "seven" | "kanei" = NEW_QUOTATION_OWNER_DOMAIN,
  allocationTime: Date = new Date(),
): Promise<string> {
  if (ownerDomain !== NEW_QUOTATION_OWNER_DOMAIN) throw new NewQuotationOwnerPolicyError();

  const month = jstQuotationMonth(allocationTime);
  const companyPrefix = companyPrefixFor(ownerDomain);
  const prefix = `${companyPrefix}-${month}-`;
  const lockKey = `quotation_number:${ownerDomain}:${month}`;
  if (tx.dialect === "postgres") {
    await tx.run("SELECT pg_advisory_xact_lock(hashtext($1::text)::bigint)", [lockKey]);
  }

  const rows = await tx.all<{ quotation_number: string }>(
    "SELECT quotation_number FROM quotations WHERE quotation_number LIKE ?",
    [`${prefix}%`],
  );
  const usedSuffixes = new Set(rows.map((row) => {
    const match = new RegExp(`^${companyPrefix}-\\d{6}-(\\d+)$`).exec(row.quotation_number);
    return match ? Number(match[1]) : 0;
  }).filter((suffix) => suffix > 0));

  let suffix = 1;
  while (usedSuffixes.has(suffix)) suffix += 1;
  return `${prefix}${String(suffix).padStart(3, "0")}`;
}
