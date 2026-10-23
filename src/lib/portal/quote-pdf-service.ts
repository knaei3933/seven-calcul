import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import {
  authenticatePortalSession,
  incrementPortalRateLimit,
  PortalIdentityError,
  type PublicPortalUser,
} from "@/lib/portal/identity-store";
import { projectPortalQuote, type PortalQuoteProjection } from "@/lib/portal/quote-projection";
import {
  generatePortalQuotePdf,
  PortalQuotePdfGenerationError,
} from "@/lib/portal/quote-pdf-generator";
import { PortalServiceAuthenticationError, requirePortalServiceToken } from "@/lib/portal/service-auth";
import {
  getQuotationPdf,
  QuotationPdfIntegrityError,
  saveQuotationPdf,
} from "@/lib/quotation-store";

export type PortalPdfOwnerDomain = "kanei";

const GENERATION_RATE_LIMIT = 10;
const PUBLIC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class PortalPdfSessionError extends Error {
  constructor() {
    super("portal_session_required");
    this.name = "PortalPdfSessionError";
  }
}

class PortalPdfRateLimitError extends Error {
  constructor() {
    super("rate_limited");
    this.name = "PortalPdfRateLimitError";
  }
}

class PortalPdfConflictError extends Error {
  constructor() {
    super("canonical_pdf_already_exists");
    this.name = "PortalPdfConflictError";
  }
}

interface PortalPdfSourceRow {
  public_id: string;
  quotation_id: number;
  quotation_number: string;
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
  delivery_date: string;
  payment_terms: string;
  notes: string;
  created_at: string;
}

export interface PortalPdfApiDependencies {
  now?: () => Date;
  authenticateSession?: typeof authenticatePortalSession;
  incrementRateLimit?: typeof incrementPortalRateLimit;
  resolveQuote?: typeof resolveOwnPortalQuoteForPdf;
  generatePdf?: typeof generatePortalQuotePdf;
  savePdf?: typeof saveQuotationPdf;
  getPdf?: typeof getQuotationPdf;
  fontBytes?: Uint8Array | ArrayBuffer;
}

interface AuthenticatedCaller {
  user: PublicPortalUser;
  ownerDomain: PortalPdfOwnerDomain;
}

interface ResolvedPortalQuote {
  internalQuotationId: number;
  projection: PortalQuoteProjection;
}

async function resolveOwnPortalQuoteForPdf(input: {
  portalUserId: number;
  ownerDomain: PortalPdfOwnerDomain;
  customerCode: string;
  publicId: string;
  now: Date;
}): Promise<ResolvedPortalQuote | null> {
  const [{ getDatabaseForTest }, { getSqlClient }] = await Promise.all([
    import("@/lib/quotation-store"),
    import("@/lib/db"),
  ]);
  void getSqlClient;
  const db = await getDatabaseForTest();
  const row = await db.get<PortalPdfSourceRow>(`
    SELECT portal_quote_mappings.public_id,
           portal_quote_mappings.quotation_id,
           quotations.quotation_number,
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
           quotations.delivery_date,
           quotations.payment_terms,
           quotations.notes,
           portal_quote_mappings.created_at
    FROM portal_quote_mappings
      INNER JOIN quotations ON quotations.id = portal_quote_mappings.quotation_id
    WHERE portal_quote_mappings.public_id = ?
      AND portal_quote_mappings.portal_user_id = ?
      AND portal_quote_mappings.owner_domain = ?
      AND portal_quote_mappings.customer_code = ?
      AND portal_quote_mappings.source = 'customer_portal'
  `, [input.publicId, input.portalUserId, input.ownerDomain, input.customerCode]);
  if (!row) return null;
  if (
    !PUBLIC_ID_PATTERN.test(row.public_id)
    || !Number.isInteger(row.quotation_id)
    || Number(row.quotation_id) <= 0
  ) throw new Error("portal_quote_mapping_invalid");
  return {
    internalQuotationId: Number(row.quotation_id),
    projection: projectPortalQuote({
      publicId: row.public_id,
      quotationNumber: row.quotation_number,
      issueDate: row.issue_date,
      validUntil: row.valid_until,
      customerName: row.customer_name,
      customerContact: row.customer_contact,
      productName: row.product_name,
      sizeSummary: row.size_summary,
      quantity: row.quantity,
      pricePerPiece: row.price_per_piece,
      subtotal: row.subtotal,
      tax: row.tax,
      grandTotal: row.grand_total,
      deliveryDate: row.delivery_date,
      paymentTerms: row.payment_terms,
      notes: row.notes,
      createdAt: row.created_at,
    }, input.now),
  };
}

async function readBrandFont(): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "src", "fonts", "NotoSansJP-Variable.ttf"));
}

function sessionToken(request: Request): string | null {
  return request.headers.get("x-portal-session-token")
    ?? request.headers.get("x-portal-session");
}

async function requireOwnPortalCaller(
  request: Request,
  dependencies: PortalPdfApiDependencies,
): Promise<AuthenticatedCaller> {
  requirePortalServiceToken(request.headers.get("authorization"));
  const token = sessionToken(request);
  if (!token) throw new PortalPdfSessionError();
  const authenticateSession = dependencies.authenticateSession ?? authenticatePortalSession;
  let user: PublicPortalUser | null;
  try {
    user = await authenticateSession(token, {
      now: dependencies.now?.() ?? new Date(),
      metadata: {
        ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: request.headers.get("user-agent"),
      },
    });
  } catch (error) {
    if (error instanceof PortalIdentityError) throw new PortalPdfSessionError();
    throw error;
  }
  if (!user || user.ownerDomain !== "kanei" || !user.customerCode || !user.isActive || !user.isVerified) {
    throw new PortalPdfSessionError();
  }
  return { user, ownerDomain: "kanei" };
}

async function enforceGenerationRateLimit(
  dependencies: PortalPdfApiDependencies,
  caller: AuthenticatedCaller,
  now: Date,
): Promise<void> {
  const incrementRateLimit = dependencies.incrementRateLimit ?? incrementPortalRateLimit;
  const result = await incrementRateLimit({
    key: `portal-quote-pdf-generate:${caller.ownerDomain}:${caller.user.id}`,
    limit: GENERATION_RATE_LIMIT,
    windowSeconds: 60,
    now,
  });
  if (result.count > GENERATION_RATE_LIMIT) throw new PortalPdfRateLimitError();
}

function callerScope(caller: AuthenticatedCaller): {
  portalUserId: number;
  ownerDomain: PortalPdfOwnerDomain;
  customerCode: string;
} {
  return {
    portalUserId: caller.user.id,
    ownerDomain: caller.ownerDomain,
    customerCode: caller.user.customerCode,
  };
}

function isPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}

function safeJapaneseDisposition(quotationNumber: string): string {
  const fileName = `${quotationNumber}.pdf`;
  return `attachment; filename="quote.pdf"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function unauthorizedResponse(): NextResponse {
  return NextResponse.json({
    error: "unauthorized",
    message: "認証が必要です。",
  }, { status: 401 });
}

function pdfErrorResponse(error: unknown): NextResponse {
  if (error instanceof PortalServiceAuthenticationError || error instanceof PortalPdfSessionError) {
    return unauthorizedResponse();
  }
  if (error instanceof PortalPdfRateLimitError) {
    return NextResponse.json({
      error: "rate_limited",
      message: "処理回数が多いため、しばらくしてから再度お試しください。",
    }, { status: 429 });
  }
  if (error instanceof PortalPdfConflictError) {
    return NextResponse.json({
      error: "conflict",
      message: "この見積書のPDFは確定済みのため上書きできません。",
    }, { status: 409 });
  }
  void error;
  return NextResponse.json({
    error: "internal_error",
    message: "処理できませんでした。しばらくしてから再度お試しください。",
  }, { status: 500 });
}

export async function generatePortalQuotePdfApi(
  request: Request,
  publicId: string,
  dependencies: PortalPdfApiDependencies = {},
): Promise<NextResponse> {
  try {
    if (!isPublicId(publicId)) {
      return NextResponse.json({
        error: "not_found",
        message: "お見積りが見つかりません。",
      }, { status: 404 });
    }
    const now = dependencies.now?.() ?? new Date();
    const caller = await requireOwnPortalCaller(request, dependencies);
    await enforceGenerationRateLimit(dependencies, caller, now);
    const resolveQuote = dependencies.resolveQuote ?? resolveOwnPortalQuoteForPdf;
    const quote = await resolveQuote({ ...callerScope(caller), publicId, now });
    if (!quote) {
      return NextResponse.json({
        error: "not_found",
        message: "お見積りが見つかりません。",
      }, { status: 404 });
    }
    const generatePdf = dependencies.generatePdf ?? generatePortalQuotePdf;
    const fontBytes = dependencies.fontBytes ?? await readBrandFont();
    const generated = await generatePdf(quote.projection, fontBytes);
    const savePdf = dependencies.savePdf ?? saveQuotationPdf;
    const saved = await savePdf(quote.internalQuotationId, generated, `${quote.projection.quotationNumber}.pdf`);
    if (!saved) throw new PortalPdfConflictError();
    return NextResponse.json({
      saved: true,
      size: generated.byteLength,
      sha256: createHash("sha256").update(generated).digest("hex"),
    }, { status: 201 });
  } catch (error) {
    if (error instanceof PortalQuotePdfGenerationError) return pdfErrorResponse(error);
    return pdfErrorResponse(error);
  }
}

export async function downloadPortalQuotePdfApi(
  request: Request,
  publicId: string,
  dependencies: PortalPdfApiDependencies = {},
): Promise<Response> {
  try {
    if (!isPublicId(publicId)) {
      return NextResponse.json({
        error: "not_found",
        message: "お見積りが見つかりません。",
      }, { status: 404 });
    }
    const now = dependencies.now?.() ?? new Date();
    const caller = await requireOwnPortalCaller(request, dependencies);
    const resolveQuote = dependencies.resolveQuote ?? resolveOwnPortalQuoteForPdf;
    const quote = await resolveQuote({ ...callerScope(caller), publicId, now });
    if (!quote) {
      return NextResponse.json({
        error: "not_found",
        message: "お見積りが見つかりません。",
      }, { status: 404 });
    }
    const getPdf = dependencies.getPdf ?? getQuotationPdf;
    const pdf = await getPdf(quote.internalQuotationId);
    if (!pdf) {
      return NextResponse.json({
        error: "not_found",
        message: "PDFが見つかりません。",
      }, { status: 404 });
    }
    return new Response(new Uint8Array(pdf.data), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdf.data.byteLength),
        "Content-Disposition": safeJapaneseDisposition(quote.projection.quotationNumber),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof QuotationPdfIntegrityError) return pdfErrorResponse(error);
    return pdfErrorResponse(error);
  }
}
