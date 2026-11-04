import type { SqlClient } from "./db";
import type { FilmMakerLanguage, FilmMakerPrintMethod, FilmMakerProcurementRoute } from "./film-maker-store";

export type LegacySupplierClassification =
  | "internal"
  | "ambiguous"
  | "external_exact"
  | "external_no_match";

export interface LegacySupplierSuggestion {
  makerId: number;
  makerCode: string;
  companyName: string;
  email: string;
  language: FilmMakerLanguage;
  printMethod: FilmMakerPrintMethod;
  procurementRoute: FilmMakerProcurementRoute;
  matchedByEmail: string;
  confidence: "exact";
  rule: "normalized_email_route_print";
}

export interface LegacyOrderReconciliation {
  orderId: number;
  orderNumber: string;
  productName: string;
  customerName: string;
  supplierName: string;
  supplierEmail: string;
  procurementRoute: string;
  printMethod: string;
  resolution: "legacy_unresolved";
  classification: LegacySupplierClassification;
  suggestedMaker: LegacySupplierSuggestion | null;
}

interface LegacyOrderRow {
  id: number;
  order_number: string;
  product_name: string;
  customer_name: string;
  supplier_name: string;
  supplier_email: string;
  procurement_route: string;
  printing_method: string;
  legacy_supplier_match_json: string | null;
}

interface FilmMakerMatchRow {
  id: number;
  maker_code: string;
  company_name: string;
  email: string;
  language: FilmMakerLanguage;
  print_method: FilmMakerPrintMethod;
  procurement_route: FilmMakerProcurementRoute;
}

const INTERNAL_EMAIL_DOMAINS = [
  "package-lab.com",
  "727.co.jp",
  "kanei-trade.co.jp",
] as const;

const INTERNAL_COMPANY_TERMS = [
  "package lab",
  "パッケージラボ",
  "パッケージ・ラボ",
  "seven chemical",
  "セブン化学",
  "セブンケミカル",
  "株式会社セブン化学",
  "kanei trade",
  "カネイ",
  "金井貿易",
  "株式会社金井貿易",
] as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function normalizeLegacyEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedInternalText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function isInternalLegacySupplier(input: { email: string; companyName: string }): boolean {
  const email = normalizeLegacyEmail(input.email);
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (
    email.includes("@")
    && INTERNAL_EMAIL_DOMAINS.some((internal) => domain === internal || domain.endsWith(`.${internal}`))
  ) {
    return true;
  }
  const company = normalizedInternalText(input.companyName);
  return company.length > 0 && INTERNAL_COMPANY_TERMS.some((term) => company.includes(normalizedInternalText(term)));
}

function suggestionOf(
  order: Pick<LegacyOrderRow, "supplier_email" | "procurement_route" | "printing_method">,
  maker: FilmMakerMatchRow,
): LegacySupplierSuggestion {
  return {
    makerId: Number(maker.id),
    makerCode: maker.maker_code,
    companyName: maker.company_name,
    email: maker.email,
    language: maker.language,
    printMethod: maker.print_method,
    procurementRoute: maker.procurement_route,
    matchedByEmail: normalizeLegacyEmail(order.supplier_email),
    confidence: "exact",
    rule: "normalized_email_route_print",
  };
}

/**
 * A suggestion is intentionally not an assignment. Internal suppliers, missing/invalid
 * identity fields, unknown route/print data, and duplicate master candidates stay unresolved.
 */
export function classifyLegacySupplier(
  order: Pick<LegacyOrderRow, "supplier_name" | "supplier_email" | "procurement_route" | "printing_method">,
  activeMakers: readonly FilmMakerMatchRow[],
): {
  classification: LegacySupplierClassification;
  suggestedMaker: LegacySupplierSuggestion | null;
} {
  const route = order.procurement_route.trim().toUpperCase();
  const printMethod = order.printing_method.trim().toLowerCase();
  const normalizedEmail = normalizeLegacyEmail(order.supplier_email);
  const supplierName = order.supplier_name.trim();
  const validEmail = normalizedEmail.length > 0
    && EMAIL_PATTERN.test(normalizedEmail)
    && !normalizedEmail.includes("..");

  if (isInternalLegacySupplier({ email: order.supplier_email, companyName: supplierName })) {
    return { classification: "internal", suggestedMaker: null };
  }
  if (!validEmail || !supplierName || !["K", "Y"].includes(route) || !["gravure", "digital"].includes(printMethod)) {
    return { classification: "ambiguous", suggestedMaker: null };
  }

  const matches = activeMakers.filter((maker) => (
    maker.procurement_route === route
    && maker.print_method === printMethod
    && normalizeLegacyEmail(maker.email) === normalizedEmail
  ));
  if (matches.length === 0) return { classification: "external_no_match", suggestedMaker: null };
  if (matches.length > 1) return { classification: "ambiguous", suggestedMaker: null };
  return { classification: "external_exact", suggestedMaker: suggestionOf(order, matches[0]) };
}

export async function reconcileLegacySuppliers(
  db: SqlClient,
  orderIds?: readonly number[],
): Promise<{ scanned: number; suggested: number }> {
  const where = orderIds?.length
    ? `WHERE supplier_resolution='legacy_unresolved' AND id IN (${orderIds.map(() => "?").join(",")})`
    : "WHERE supplier_resolution='legacy_unresolved'";
  const orders = await db.all<LegacyOrderRow>(`
    SELECT id,order_number,product_name,customer_name,supplier_name,supplier_email,
           procurement_route,printing_method,legacy_supplier_match_json
    FROM film_orders
    ${where}
    ORDER BY id
  `, orderIds ? [...orderIds] : []);
  const makers = await db.all<FilmMakerMatchRow>(`
    SELECT id,maker_code,company_name,email,language,print_method,procurement_route
    FROM film_makers
    WHERE is_active=TRUE
    ORDER BY id
  `);
  let suggested = 0;
  for (const order of orders) {
    const { suggestedMaker } = classifyLegacySupplier(order, makers);
    // Clear stale suggestions when master data changes; never overwrite an explicit resolution.
    await db.run(
      "UPDATE film_orders SET legacy_supplier_match_json=? WHERE id=? AND supplier_resolution='legacy_unresolved'",
      [suggestedMaker ? JSON.stringify(suggestedMaker) : null, order.id],
    );
    if (suggestedMaker) suggested += 1;
  }
  return { scanned: orders.length, suggested };
}

export async function listLegacyOrderReconciliations(db: SqlClient): Promise<LegacyOrderReconciliation[]> {
  const orders = await db.all<LegacyOrderRow>(`
    SELECT id,order_number,product_name,customer_name,supplier_name,supplier_email,
           procurement_route,printing_method,legacy_supplier_match_json
    FROM film_orders
    WHERE supplier_resolution='legacy_unresolved'
    ORDER BY created_at, id
  `);
  const makers = await db.all<FilmMakerMatchRow>(`
    SELECT id,maker_code,company_name,email,language,print_method,procurement_route
    FROM film_makers
    WHERE is_active=TRUE
    ORDER BY id
  `);
  return orders.map((row) => ({
    orderId: Number(row.id),
    orderNumber: row.order_number,
    productName: row.product_name,
    customerName: row.customer_name,
    supplierName: row.supplier_name,
    supplierEmail: row.supplier_email,
    procurementRoute: row.procurement_route,
    printMethod: row.printing_method,
    resolution: "legacy_unresolved" as const,
    // Live listing rechecks active master data so a deactivated/edited master is never
    // presented as selectable after the migration-time stored suggestion changes.
    ...classifyLegacySupplier(row, makers),
  }));
}
