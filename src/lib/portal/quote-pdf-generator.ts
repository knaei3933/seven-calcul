import { PortalQuoteProjection } from "@/lib/portal/quote-projection";
import {
  CanonicalQuotationPdfAssetError,
  buildCanonicalQuotationPdfModel,
  CanonicalQuotationPdf,
  renderCanonicalQuotationPdf,
} from "@/lib/standard-quote-pdf";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
import { DEFAULT_KANEI_QUOTE_PROFILE, type QuoteOwnerProfile } from "@/lib/quote-owner-profiles";

export class PortalQuotePdfGenerationError extends Error {
  constructor() {
    super("portal_quote_pdf_generation_failed");
    this.name = "PortalQuotePdfGenerationError";
  }
}

/**
 * Adapt only the verified server projection and the durable owner profile into
 * the shared canonical model. No portal request body or internal calculation
 * result is passed to the customer-facing renderer.
 */
function portalCanonicalInput(
  quote: PortalQuoteProjection,
  ownerProfile: QuoteOwnerProfile,
): QuotationRecordInput {
  const notes = quote.availability === "expired"
    ? [quote.notes, "有効期限切れ：このお見積りは現在無効です。最新のお見積りをご確認ください。"]
      .filter((value) => value.trim()).join("\n")
    : quote.notes;
  return {
    quotationNumber: quote.quotationNumber,
    status: quote.availability === "expired" ? "expired" : "draft",
    issueDate: quote.issueDate,
    validUntil: quote.validUntil,
    customerName: quote.customerName,
    customerContact: quote.customerContact,
    productName: quote.productName,
    sizeSummary: quote.sizeSummary,
    quantity: quote.quantity,
    fillingCostPerPiece: "0",
    filmCostPerPiece: "0",
    filmMeterPrice: "0",
    filmOrderLengthM: "0",
    targetMargin: "0",
    taxRatePercent: "10",
    pricePerPiece: quote.displayedUnitPrice,
    subtotal: quote.displayedSubtotal,
    tax: quote.displayedTax,
    grandTotal: quote.displayedGrandTotal,
    deliveryDate: quote.deliveryDate,
    paymentTerms: quote.paymentTerms,
    notes,
    calculationVersion: "customer-portal-canonical-v1",
    resultHash: "",
    payload: {
      source: "customer_portal",
      footerContact: {
        companyName: ownerProfile.legalName,
        contactName: quote.customerContact,
        email: ownerProfile.defaultContactEmail,
        telephone: ownerProfile.defaultContactTelephone,
      },
    },
  };
}

export async function generatePortalQuotePdfWithProvenance(
  quote: PortalQuoteProjection,
  _fontBytes: Uint8Array | ArrayBuffer,
  ownerProfile: QuoteOwnerProfile = DEFAULT_KANEI_QUOTE_PROFILE,
): Promise<CanonicalQuotationPdf> {
  try {
    return await renderCanonicalQuotationPdf(
      buildCanonicalQuotationPdfModel(
        portalCanonicalInput(quote, ownerProfile),
        quote.quotationNumber,
        ownerProfile.ownerDomain,
        ownerProfile,
      ),
      ownerProfile.ownerDomain,
    );
  } catch (error) {
    if (error instanceof CanonicalQuotationPdfAssetError) throw error;
    // Ordinary rendering failures remain deliberately coarse for the public
    // portal API; structured asset failures were rethrown above.
    throw new PortalQuotePdfGenerationError();
  }
}

/** Compatibility wrapper for existing portal callers; new service code uses provenance. */
export async function generatePortalQuotePdf(
  quote: PortalQuoteProjection,
  fontBytes: Uint8Array | ArrayBuffer,
  ownerProfile: QuoteOwnerProfile = DEFAULT_KANEI_QUOTE_PROFILE,
): Promise<Buffer> {
  return (await generatePortalQuotePdfWithProvenance(quote, fontBytes, ownerProfile)).bytes;
}
