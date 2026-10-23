export const PORTAL_QUOTE_PROJECTION_ALLOWLIST = Object.freeze([
  "publicId",
  "quotationNumber",
  "issueDate",
  "validUntil",
  "customerName",
  "customerContact",
  "productName",
  "sizeSummary",
  "quantity",
  "displayedUnitPrice",
  "displayedSubtotal",
  "displayedTax",
  "displayedGrandTotal",
  "deliveryDate",
  "paymentTerms",
  "notes",
  "createdAt",
  "pdfAvailability",
  "lines",
  "availability",
] as const);

export type PortalQuoteAvailability = "active" | "expired";

export interface PortalQuoteSourceRow {
  publicId: string;
  quotationNumber: string;
  issueDate: string;
  validUntil: string;
  customerName: string;
  customerContact: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  pricePerPiece: string;
  subtotal: string;
  tax: string;
  grandTotal: string;
  deliveryDate: string;
  paymentTerms: string;
  notes: string;
  createdAt: string;
}

export interface PortalQuoteProjection {
  publicId: string;
  quotationNumber: string;
  issueDate: string;
  validUntil: string;
  customerName: string;
  customerContact: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  displayedUnitPrice: string;
  displayedSubtotal: string;
  displayedTax: string;
  displayedGrandTotal: string;
  deliveryDate: string;
  paymentTerms: string;
  notes: string;
  createdAt: string;
  pdfAvailability: "unavailable";
  lines: readonly unknown[];
  availability: PortalQuoteAvailability;
}

export function tokyoDateString(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

export function portalQuoteAvailability(validUntil: string, now: Date): PortalQuoteAvailability {
  return tokyoDateString(now) > validUntil ? "expired" : "active";
}

export function projectPortalQuote(
  row: PortalQuoteSourceRow,
  now: Date,
): PortalQuoteProjection {
  const projection: PortalQuoteProjection = {
    publicId: row.publicId,
    quotationNumber: row.quotationNumber,
    issueDate: row.issueDate,
    validUntil: row.validUntil,
    customerName: row.customerName,
    customerContact: row.customerContact,
    productName: row.productName,
    sizeSummary: row.sizeSummary,
    quantity: row.quantity,
    displayedUnitPrice: row.pricePerPiece,
    displayedSubtotal: row.subtotal,
    displayedTax: row.tax,
    displayedGrandTotal: row.grandTotal,
    deliveryDate: row.deliveryDate,
    paymentTerms: row.paymentTerms,
    notes: row.notes,
    createdAt: row.createdAt,
    pdfAvailability: "unavailable",
    lines: Object.freeze([]),
    availability: portalQuoteAvailability(row.validUntil, now),
  };
  const allowed = new Set<string>(PORTAL_QUOTE_PROJECTION_ALLOWLIST);
  if (Object.keys(projection).some((key) => !allowed.has(key))) {
    throw new Error("portal_quote_projection_invalid");
  }
  return projection;
}
