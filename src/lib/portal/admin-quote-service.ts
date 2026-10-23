import { getSqlClient } from "@/lib/db";
import { getCustomer } from "@/lib/customer-store";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import type { AuthenticatedUser } from "@/lib/auth-store";

export const PORTAL_QUOTE_SOURCE_LABEL = "顧客ポータル";
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

export class AdminQuoteAccessError extends Error {
  constructor() {
    super("admin_quote_access_denied");
    this.name = "AdminQuoteAccessError";
  }
}

export class AdminQuoteValidationError extends Error {
  constructor() {
    super("admin_quote_validation_failed");
    this.name = "AdminQuoteValidationError";
  }
}

export function canViewPortalQuotes(user: AuthenticatedUser | null | undefined): boolean {
  return Boolean(
    user
    && user.isActive
    && user.role === "admin"
    && isKaneiTradeUser(user.email),
  );
}

export interface AdminPortalQuote {
  publicId: string;
  quotationId: number;
  quotationNumber: string;
  source: "customer_portal";
  sourceLabel: typeof PORTAL_QUOTE_SOURCE_LABEL;
  customerCode: string;
  customer: {
    code: string;
    name: string;
    contact: string;
    telephone: string;
    email: string;
  } | null;
  issueDate: string;
  validUntil: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  displayedTotals: {
    pricePerPiece: string;
    subtotal: string;
    tax: string;
    grandTotal: string;
  };
  status: string;
  pdfAvailable: boolean;
  mappingCreatedAt: string;
  quotationUpdatedAt: string;
}

export interface AdminPortalQuotePage {
  quotes: AdminPortalQuote[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
}

export interface AdminQuoteQuery {
  search?: string;
  page?: number;
  limit?: number;
}

type AdminQuoteQueryRunner = typeof listAdminPortalQuotes;
type AdminApiUserReader = typeof import("@/lib/api-auth").getSessionUser;

interface AdminQuoteRow {
  public_id: string;
  quotation_id: number;
  quotation_number: string;
  customer_code: string;
  issue_date: string;
  valid_until: string;
  customer_name: string;
  customer_contact: string;
  product_name: string;
  size_summary: string;
  quantity: string;
  price_per_piece: string;
  subtotal: string;
  tax: string;
  grand_total: string;
  status: string;
  pdf_available: number | boolean;
  mapping_created_at: string;
  quotation_updated_at: string;
}

export async function initializePortalQuoteMappingSchema(): Promise<void> {
  const { initializePortalQuoteMappingSchema: initializeStoreSchema } =
    await import("@/lib/portal/quote-calculation-store");
  await initializeStoreSchema();
}

function escapedSearchTerm(search: string): string {
  return `%${search.trim().replace(/[!%_]/g, (character) => `!${character}`)}%`;
}

function paginationOf(page: number, limit: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

async function customerFor(
  ownerDomain: "kanei",
  customerCode: string,
  readCustomer: typeof getCustomer,
): Promise<AdminPortalQuote["customer"]> {
  const customer = await readCustomer(ownerDomain, customerCode);
  if (!customer) return null;
  return {
    code: customer.customerCode,
    name: customer.customerName,
    contact: customer.customerContact,
    telephone: customer.customerTelephone,
    email: customer.customerEmail,
  };
}

function toAdminQuote(row: AdminQuoteRow, customer: AdminPortalQuote["customer"]): AdminPortalQuote {
  return {
    publicId: row.public_id,
    quotationId: Number(row.quotation_id),
    quotationNumber: row.quotation_number,
    source: "customer_portal",
    sourceLabel: PORTAL_QUOTE_SOURCE_LABEL,
    customerCode: row.customer_code,
    customer,
    issueDate: row.issue_date,
    validUntil: row.valid_until,
    productName: row.product_name,
    sizeSummary: row.size_summary,
    quantity: row.quantity,
    displayedTotals: {
      pricePerPiece: row.price_per_piece,
      subtotal: row.subtotal,
      tax: row.tax,
      grandTotal: row.grand_total,
    },
    status: row.status,
    pdfAvailable: Boolean(row.pdf_available),
    mappingCreatedAt: row.mapping_created_at,
    quotationUpdatedAt: row.quotation_updated_at,
  };
}

export async function listAdminPortalQuotes(
  query: AdminQuoteQuery = {},
  dependencies: { readCustomer?: typeof getCustomer } = {},
): Promise<AdminPortalQuotePage> {
  const search = query.search?.trim() ?? "";
  const page = query.page ?? 1;
  const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(page) || page < 1 || page > Number.MAX_SAFE_INTEGER) {
    throw new AdminQuoteValidationError();
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new AdminQuoteValidationError();
  }
  const db = await getSqlClient("quotations");
  await initializePortalQuoteMappingSchema();
  const where = "WHERE portal_quote_mappings.source = 'customer_portal'";
  const whereArguments: Array<string> = [];
  if (search) {
    const term = escapedSearchTerm(search);
    whereArguments.push(term, term, term);
  }
  const searchCondition = search
    ? `
      AND (
        quotations.quotation_number LIKE ? ESCAPE '!'
        OR quotations.customer_name LIKE ? ESCAPE '!'
        OR portal_quote_mappings.customer_code LIKE ? ESCAPE '!'
      )`
    : "";
  const totalRow = await db.get<{ total: number }>(`
    SELECT COUNT(*) AS total
    FROM portal_quote_mappings
      INNER JOIN quotations ON quotations.id = portal_quote_mappings.quotation_id
    ${where}${searchCondition}
  `, whereArguments);
  const total = Number(totalRow?.total ?? 0);
  const offset = (page - 1) * limit;
  const rows = await db.all<AdminQuoteRow>(`
    SELECT portal_quote_mappings.public_id,
           portal_quote_mappings.quotation_id,
           quotations.quotation_number,
           portal_quote_mappings.customer_code,
           quotations.issue_date,
           quotations.valid_until,
           quotations.customer_name,
           quotations.customer_contact,
           quotations.product_name,
           quotations.size_summary,
           quotations.quantity,
           quotations.price_per_piece,
           quotations.subtotal,
           quotations.tax,
           quotations.grand_total,
           quotations.status,
           (quotations.pdf_data IS NOT NULL) AS pdf_available,
           portal_quote_mappings.created_at AS mapping_created_at,
           quotations.updated_at AS quotation_updated_at
    FROM portal_quote_mappings
      INNER JOIN quotations ON quotations.id = portal_quote_mappings.quotation_id
    ${where}${searchCondition}
    ORDER BY portal_quote_mappings.created_at DESC, portal_quote_mappings.public_id DESC
    LIMIT ? OFFSET ?
  `, [...whereArguments, limit, offset]);
  const readCustomer = dependencies.readCustomer ?? getCustomer;
  const quotes = await Promise.all(rows.map(async (row) => toAdminQuote(
    row,
    await customerFor("kanei", row.customer_code, readCustomer),
  )));
  return { quotes, pagination: paginationOf(page, limit, total) };
}

export function requirePortalQuoteAdmin(
  user: AuthenticatedUser | null | undefined,
): AuthenticatedUser {
  if (!user || !canViewPortalQuotes(user)) throw new AdminQuoteAccessError();
  return user;
}

export interface AdminQuoteApiDependencies {
  getSessionUser?: AdminApiUserReader;
  listQuotes?: AdminQuoteQueryRunner;
  readCustomer?: typeof getCustomer;
}
