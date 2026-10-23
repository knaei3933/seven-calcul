import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { calculatePouchCost, getSizeMaster, type CalculationInput } from "@/lib/calculation";
import { canonicalize } from "@/lib/canonical-json";
import { GRAVURE_MASTER_CALCULATION_VERSION, defaultParameters, sizeMaster } from "@/lib/constants";
import type { SizeKey } from "@/lib/types";
import { QuotationValidationError } from "@/lib/digital-film";
import { resolveFilmUnitPrices } from "@/lib/film-price-store";
import {
  GravureDurableDatabaseRequiredError,
  GravureInfrastructureError,
  GravureValidationError,
  GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR,
  isGravureSnapshotIssuanceEnabled,
  resolveGravureMasters,
  saveGravureSnapshot,
  tokyoDate,
  type GravureSnapshot,
} from "@/lib/gravure-price-store";
import { defaultGravureRollParameters } from "@/lib/gravure-roll";
import {
  PORTAL_SERVICE_ACTOR_EMAIL,
  authenticatePortalSession,
  getPortalServiceActorId,
  incrementPortalRateLimit,
} from "@/lib/portal/identity-store";
import { PortalServiceAuthenticationError, requirePortalServiceToken } from "@/lib/portal/service-auth";
import {
  createPortalQuoteWithMapping,
  findPortalQuoteMapping,
  PortalQuoteIdempotencyConflictError,
  type PortalQuoteOwnerDomain,
} from "@/lib/portal/quote-calculation-store";
import { portalQuoteAvailability } from "@/lib/portal/quote-projection";
import { calculateAutomaticQuotation } from "@/lib/quotation-pricing";

export interface PortalQuoteDependencies {
  now?: () => Date;
  clientFingerprint?: string;
  calculate?: typeof calculatePouchCost;
  resolveFilmPrices?: typeof resolveFilmUnitPrices;
}

const TOP_LEVEL_ALLOWLIST = Object.freeze([
  "idempotencyKey",
  "productName",
  "sizeKey",
  "customWidthMm",
  "customLengthMm",
  "fillMlPerChamber",
  "connectedChambers",
  "fillingMethod",
  "fillingLanes",
  "printingMethod",
  "quantity",
  "skus",
  "deliveryDate",
  "notes",
] as const);

const SKU_ALLOWLIST = Object.freeze([
  "name",
  "quantity",
  "fillMlPerChamber",
  "colorCount",
] as const);

const PRICING_AUTHORITY_FIELDS = Object.freeze(new Set([
  "parameters",
  "parameters.filmUnitPrices",
  "bulkUnitPrice",
  "gravureYRows",
  "ySupplierRows",
  "pricingSnapshot",
  "publicProjectionHash",
  "pricingSnapshotSha256",
  "fullAugmentedCalculationRequest",
]));

const SIZE_KEYS = new Set(Object.keys(sizeMaster) as SizeKey[]);
const MAX_QUOTE_CALCULATIONS_PER_HOUR = 10;
const DEFAULT_TARGET_MARGIN = "0.4";

class PortalQuoteValidationError extends Error {
  readonly fieldErrors: Record<string, string>;
  constructor(fieldErrors: Record<string, string>) {
    super("validation_failed");
    this.name = "PortalQuoteValidationError";
    this.fieldErrors = fieldErrors;
  }
}

class PortalPricingAuthorityError extends Error {
  constructor() {
    super("pricing_authority_rejected");
    this.name = "PortalPricingAuthorityError";
  }
}

class PortalSessionDeniedError extends Error {
  constructor() {
    super("portal_session_required");
    this.name = "PortalSessionDeniedError";
  }
}

class PortalQuoteRateLimitError extends Error {
  constructor() {
    super("rate_limited");
    this.name = "PortalQuoteRateLimitError";
  }
}

function rejectPricingAuthority(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectPricingAuthority(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (
      PRICING_AUTHORITY_FIELDS.has(key)
      || (path === "parameters" && key === "filmUnitPrices")
      || PRICING_AUTHORITY_FIELDS.has(childPath)
    ) throw new PortalPricingAuthorityError();
    rejectPricingAuthority(child, childPath);
  }
}

function strictObject(
  value: unknown,
  label: string,
  allowlist: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortalQuoteValidationError({ [label]: "入力形式が正しくありません。" });
  }
  const object = value as Record<string, unknown>;
  const unknownField = Object.keys(object).find((key) => !allowlist.includes(key));
  if (unknownField !== undefined) {
    throw new PortalQuoteValidationError({ _request: "許可されていない入力項目が含まれています。" });
  }
  return object;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  if (!(key in body) || body[key] === undefined) return undefined;
  if (typeof body[key] !== "string") {
    throw new PortalQuoteValidationError({ [key]: "文字列で入力してください。" });
  }
  const value = body[key].trim();
  if (value.length < 1 || value.length > maxLength) {
    throw new PortalQuoteValidationError({ [key]: "入力値の長さが正しくありません。" });
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = optionalString(body, key, maxLength);
  if (value === undefined) throw new PortalQuoteValidationError({ [key]: "この項目は必須です。" });
  return value;
}

function decimalString(
  body: Record<string, unknown>,
  key: string,
  optional = false,
): string | undefined {
  if (!(key in body) || body[key] === undefined) {
    if (optional) return undefined;
    throw new PortalQuoteValidationError({ [key]: "この項目は必須です。" });
  }
  if (typeof body[key] !== "string" || !/^\d+(?:\.\d+)?$/.test(body[key])) {
    throw new PortalQuoteValidationError({ [key]: "0以上の数値を文字列で入力してください。" });
  }
  return body[key];
}

function positiveInteger(
  body: Record<string, unknown>,
  key: string,
  maximum: number,
  optional = false,
): number | undefined {
  if (!(key in body) || body[key] === undefined) {
    if (optional) return undefined;
    throw new PortalQuoteValidationError({ [key]: "この項目は必須です。" });
  }
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new PortalQuoteValidationError({ [key]: `1から${maximum}の整数で入力してください。` });
  }
  return value;
}

interface PortalQuoteBusinessInput {
  idempotencyKey: string;
  productName: string;
  sizeKey: SizeKey;
  customWidthMm?: string;
  customLengthMm?: string;
  fillMlPerChamber: string;
  connectedChambers: 1 | 2 | 3 | 4;
  fillingMethod: "hopper" | "pressure";
  fillingLanes: number;
  printingMethod: "digital" | "gravure";
  quantity: string;
  skus?: Array<{
    name: string;
    quantity: string;
    fillMlPerChamber: string;
    colorCount: number;
  }>;
  deliveryDate?: string;
  notes?: string;
}

function validatePortalQuoteBody(input: unknown): PortalQuoteBusinessInput {
  const body = strictObject(input, "_request", TOP_LEVEL_ALLOWLIST);
  const idempotencyKey = requiredString(body, "idempotencyKey", 200);
  const sizeKeyText = requiredString(body, "sizeKey", 100);
  if (!SIZE_KEYS.has(sizeKeyText as SizeKey)) {
    throw new PortalQuoteValidationError({ sizeKey: "サイズを選択してください。" });
  }
  const customWidthMm = decimalString(body, "customWidthMm", true);
  const customLengthMm = decimalString(body, "customLengthMm", true);
  if ((customWidthMm === undefined) !== (customLengthMm === undefined)) {
    throw new PortalQuoteValidationError({
      customWidthMm: "カスタムサイズは幅と長さの両方を入力してください。",
    });
  }
  const fillingMethod = requiredString(body, "fillingMethod", 20);
  if (fillingMethod !== "hopper" && fillingMethod !== "pressure") {
    throw new PortalQuoteValidationError({ fillingMethod: "充填方式を選択してください。" });
  }
  const printingMethod = requiredString(body, "printingMethod", 20);
  if (printingMethod !== "digital" && printingMethod !== "gravure") {
    throw new PortalQuoteValidationError({ printingMethod: "印刷方式を選択してください。" });
  }

  const skusValue = body.skus;
  let skus: PortalQuoteBusinessInput["skus"];
  if (skusValue !== undefined) {
    if (!Array.isArray(skusValue) || skusValue.length < 1 || skusValue.length > 20) {
      throw new PortalQuoteValidationError({ skus: "SKUは1から20件で入力してください。" });
    }
    skus = skusValue.map((entry, index) => {
      const sku = strictObject(entry, `skus[${index}]`, SKU_ALLOWLIST);
      const quantity = decimalString(sku, "quantity");
      const fill = decimalString(sku, "fillMlPerChamber");
      const colorCount = positiveInteger(sku, "colorCount", 20);
      return {
        name: requiredString(sku, "name", 200),
        quantity: quantity!,
        fillMlPerChamber: fill!,
        colorCount: colorCount!,
      };
    });
  }

  const quantity = decimalString(body, "quantity");
  const quantityValue = Number(quantity);
  if (!Number.isInteger(quantityValue) || quantityValue < 1 || quantityValue > 5_000_000) {
    throw new PortalQuoteValidationError({
      quantity: "数量は1から5,000,000の整数で入力してください。",
    });
  }
  if (skus) {
    const skuTotal = skus.reduce((total, sku) => total + Number(sku.quantity), 0);
    if (!Number.isInteger(skuTotal) || skuTotal !== quantityValue) {
      throw new PortalQuoteValidationError({
        skus: "各SKU数量の合計は数量と一致させてください。",
      });
    }
  }

  const connectedChambers = positiveInteger(body, "connectedChambers", 4);
  const fillingLanes = positiveInteger(body, "fillingLanes", 8);
  return {
    idempotencyKey,
    productName: requiredString(body, "productName", 200),
    sizeKey: sizeKeyText as SizeKey,
    customWidthMm,
    customLengthMm,
    fillMlPerChamber: decimalString(body, "fillMlPerChamber")!,
    connectedChambers: connectedChambers as 1 | 2 | 3 | 4,
    fillingMethod,
    fillingLanes: fillingLanes!,
    printingMethod,
    quantity: quantity!,
    skus,
    deliveryDate: optionalString(body, "deliveryDate", 200),
    notes: optionalString(body, "notes", 2000),
  };
}

function buildCalculationInput(input: PortalQuoteBusinessInput): CalculationInput {
  const skus = input.skus ?? [{
    name: input.productName,
    quantity: input.quantity,
    fillMlPerChamber: input.fillMlPerChamber,
    colorCount: 1,
  }];
  const weightedFillTotal = skus.reduce(
    (total, sku) => total + Number(sku.fillMlPerChamber) * Number(sku.quantity),
    0,
  );
  const skuQuantityTotal = skus.reduce((total, sku) => total + Number(sku.quantity), 0);
  const representativeFill = skuQuantityTotal > 0
    ? weightedFillTotal / skuQuantityTotal
    : Number(input.fillMlPerChamber);
  return {
    spec: {
      sizeKey: input.sizeKey,
      customWidthMm: input.customWidthMm ?? sizeMaster[input.sizeKey].widthMm,
      customLengthMm: input.customLengthMm ?? sizeMaster[input.sizeKey].lengthMm,
      fillMlPerChamber: representativeFill.toString(),
      connectedChambers: input.connectedChambers,
      fillingMethod: input.fillingMethod,
      fillingLanes: input.fillingLanes,
      isCustom: input.customWidthMm !== undefined,
      colorCount: Math.max(...skus.map((sku) => sku.colorCount)),
      // The portal DTO deliberately has no bulk purchase-price authority.
      bulkUnitPrice: "0",
      skuCount: skus.length,
      skuQuantities: skus.map((sku) => sku.quantity),
      skuNames: skus.map((sku) => sku.name),
      skuFillMlPerChamber: skus.map((sku) => sku.fillMlPerChamber),
      skuColorCounts: skus.map((sku) => sku.colorCount.toString()),
    },
    quantity: input.quantity,
    printingMethod: input.printingMethod,
  };
}

function japaneseDate(date: Date, addDays = 0): string {
  return new Date(date.getTime() + addDays * 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

function fingerprintOf(input: PortalQuoteBusinessInput): string {
  return createHash("sha256").update(canonicalize(input)).digest("hex");
}

function sessionToken(request: Request): string | null {
  return request.headers.get("x-portal-session-token");
}

function clientFingerprint(request: Request, dependencies: PortalQuoteDependencies): string {
  if (dependencies.clientFingerprint !== undefined) {
    return /^[0-9a-f]{64}$/.test(dependencies.clientFingerprint)
      ? dependencies.clientFingerprint
      : "unknown";
  }
  const value = request.headers.get("x-portal-client-fingerprint")?.trim() ?? "";
  return /^[0-9a-f]{64}$/.test(value) ? value : "unknown";
}

function unavailableResponse(): NextResponse {
  return NextResponse.json({
    error: "print_method_unavailable",
    message: "グラビア印刷は現在ポータルからご利用いただけません。デジタル印刷でお試しいただくか、後ほど再度お試しください。",
  }, { status: 503 });
}

export async function calculatePortalQuote(
  request: Request,
  dependencies: PortalQuoteDependencies = {},
): Promise<NextResponse> {
  const now = dependencies.now?.() ?? new Date();
  try {
    requirePortalServiceToken(request.headers.get("authorization"));
    let parsedBody: unknown;
    try {
      parsedBody = await request.json();
    } catch {
      throw new PortalQuoteValidationError({ _request: "リクエストの形式が正しくありません。" });
    }
    rejectPricingAuthority(parsedBody);

    const token = sessionToken(request);
    if (!token) throw new PortalSessionDeniedError();
    const user = await authenticatePortalSession(token, {
      now,
      metadata: {
        ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: request.headers.get("user-agent"),
      },
    });
    if (!user || user.ownerDomain !== "kanei" || !user.customerCode) {
      throw new PortalSessionDeniedError();
    }

    const businessInput = validatePortalQuoteBody(parsedBody);
    const ownerDomain: PortalQuoteOwnerDomain = "kanei";
    const existing = await findPortalQuoteMapping({
      portalUserId: user.id,
      ownerDomain,
      idempotencyKey: businessInput.idempotencyKey,
    });
    if (existing) {
      if (existing.customerCode !== user.customerCode
        || existing.requestFingerprint !== fingerprintOf(businessInput)) {
        throw new PortalQuoteIdempotencyConflictError();
      }
      return NextResponse.json(existing.response);
    }

    const requestedFingerprint = clientFingerprint(request, dependencies);
    for (const key of [
      `portal-quote-calculate:${ownerDomain}:${user.id}`,
      `portal-quote-calculate:client:${requestedFingerprint}`,
    ]) {
      const rate = await incrementPortalRateLimit({
        key,
        limit: MAX_QUOTE_CALCULATIONS_PER_HOUR,
        windowSeconds: 60 * 60,
        now,
      });
      if (rate.count > MAX_QUOTE_CALCULATIONS_PER_HOUR) throw new PortalQuoteRateLimitError();
    }

    const calculationInput = buildCalculationInput(businessInput);
    const asOf = japaneseDate(now);
    const filmUnitPrices = await (dependencies.resolveFilmPrices ?? resolveFilmUnitPrices)(
      asOf,
      defaultParameters.filmUnitPrices,
    );

    let gravureSnapshot: GravureSnapshot | null = null;
    if (businessInput.printingMethod === "gravure") {
      if (!isGravureSnapshotIssuanceEnabled()) {
        throw new Error(GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR);
      }
      // The admin route's durable-production gate is reused verbatim.
      const { assertDurableGravureDatabase } = await import("@/lib/gravure-price-store");
      assertDurableGravureDatabase();
      const resolved = await resolveGravureMasters(tokyoDate(now));
      calculationInput.gravureParameters = resolved.kSet?.derived ?? defaultGravureRollParameters();
      calculationInput.gravureYRows = structuredClone(resolved.yRows);
      calculationInput.parameters = structuredClone({
        ...defaultParameters,
        filmUnitPrices,
      });
      const calculate = dependencies.calculate ?? calculatePouchCost;
      const gravureResult = calculate(calculationInput);
      gravureSnapshot = await saveGravureSnapshot({
        asOf: tokyoDate(now),
        digitalValues: filmUnitPrices,
        resolved,
        request: calculationInput,
        result: gravureResult,
        createdBy: PORTAL_SERVICE_ACTOR_EMAIL,
      });
      if (
        gravureResult.audit.calculationVersion !== GRAVURE_MASTER_CALCULATION_VERSION
        || gravureSnapshot.fullAugmentedCalculationRequest !== calculationInput
      ) throw new Error("portal_quote_snapshot_invalid");
      return await persistPortalQuote({
        businessInput,
        calculationInput,
        result: gravureResult,
        displayed: calculateAutomaticQuotation(gravureResult, DEFAULT_TARGET_MARGIN),
        gravureSnapshot,
        user,
        ownerDomain,
        now,
      });
    }

    const augmentedRequest: CalculationInput = {
      ...calculationInput,
      parameters: structuredClone({ ...defaultParameters, filmUnitPrices }),
    };
    const calculate = dependencies.calculate ?? calculatePouchCost;
    const result = calculate(augmentedRequest);
    return await persistPortalQuote({
      businessInput,
      calculationInput: augmentedRequest,
      result,
      displayed: calculateAutomaticQuotation(result, DEFAULT_TARGET_MARGIN),
      gravureSnapshot: null,
      user,
      ownerDomain,
      now,
    });
  } catch (error) {
    if (error instanceof PortalServiceAuthenticationError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (error instanceof PortalQuoteValidationError) {
      return NextResponse.json({
        error: "validation_failed",
        fieldErrors: error.fieldErrors,
      }, { status: 400 });
    }
    if (error instanceof PortalPricingAuthorityError) {
      return NextResponse.json({
        error: "pricing_authority_rejected",
        fieldErrors: { _request: "価格設定情報は送信できません。" },
      }, { status: 400 });
    }
    if (error instanceof PortalSessionDeniedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (error instanceof PortalQuoteRateLimitError) {
      return NextResponse.json({
        error: "rate_limited",
        message: "お見積りの作成回数が多すぎます。しばらくしてから再度お試しください。",
      }, { status: 429 });
    }
    if (error instanceof PortalQuoteIdempotencyConflictError) {
      return NextResponse.json({
        error: "conflict",
        message: "同じIDで異なる内容のお見積りは作成できません。",
      }, { status: 409 });
    }
    if (
      error instanceof GravureDurableDatabaseRequiredError
      || error instanceof GravureInfrastructureError
      || (error instanceof Error && error.message === GRAVURE_SNAPSHOT_ISSUANCE_DISABLED_ERROR)
    ) return unavailableResponse();
    if (error instanceof GravureValidationError || error instanceof QuotationValidationError) {
      return NextResponse.json({
        error: "validation_failed",
        fieldErrors: { _request: "お見積りの内容を確認してください。" },
      }, { status: 400 });
    }
    return NextResponse.json({
      error: "internal_error",
      message: "処理できませんでした。しばらくしてから再度お試しください。",
    }, { status: 500 });
  }
}

async function persistPortalQuote(input: {
  businessInput: PortalQuoteBusinessInput;
  calculationInput: CalculationInput;
  result: Awaited<ReturnType<typeof calculatePouchCost>>;
  displayed: ReturnType<typeof calculateAutomaticQuotation>;
  gravureSnapshot: GravureSnapshot | null;
  user: Awaited<ReturnType<typeof authenticatePortalSession>> & object;
  ownerDomain: PortalQuoteOwnerDomain;
  now: Date;
}): Promise<NextResponse> {
  const displayed = input.displayed;
  if (!displayed) throw new Error("portal_quote_display_invalid");
  const actorId = await getPortalServiceActorId();
  if (actorId == null) throw new Error("portal_service_actor_invalid");
  const issueDate = japaneseDate(input.now);
  const validUntil = japaneseDate(input.now, 30);
  const size = getSizeMaster(input.calculationInput.spec);
  const sizeSummary = `${size.widthMm}×${size.lengthMm}mm / ${input.calculationInput.spec.connectedChambers}連`;
  const customerSafeResponse = {
    issueDate,
    validUntil,
    customerName: input.user.companyName,
    customerContact: input.user.contactName,
    productName: input.businessInput.productName,
    sizeSummary,
    quantity: input.businessInput.quantity,
    displayedUnitPrice: displayed.display.pricePerPiece,
    displayedSubtotal: displayed.display.subtotal,
    displayedTax: displayed.display.tax,
    displayedGrandTotal: displayed.display.grandTotal,
    deliveryDate: input.businessInput.deliveryDate ?? "別途相談",
    paymentTerms: "月末締め翌月末払い",
    notes: input.businessInput.notes ?? "",
    createdAt: input.now.toISOString(),
    pdfAvailability: "unavailable",
    availability: portalQuoteAvailability(validUntil, input.now),
  };

  const mapping = await createPortalQuoteWithMapping({
    quotation: {
      status: "draft",
      issueDate,
      validUntil,
      customerName: input.user.companyName,
      customerContact: input.user.contactName,
      productName: input.businessInput.productName,
      sizeSummary,
      quantity: input.businessInput.quantity,
      fillingCostPerPiece: input.result.costPerPieceComponents.bulk,
      filmCostPerPiece: input.result.costPerPieceComponents.film,
      filmMeterPrice: input.result.film.unitPrice,
      filmOrderLengthM: input.result.film.orderLengthM,
      targetMargin: DEFAULT_TARGET_MARGIN,
      taxRatePercent: "10",
      pricePerPiece: displayed.display.pricePerPiece,
      subtotal: displayed.display.subtotal,
      tax: displayed.display.tax,
      grandTotal: displayed.display.grandTotal,
      deliveryDate: input.businessInput.deliveryDate ?? "別途相談",
      paymentTerms: "月末締め翌月末払い",
      notes: input.businessInput.notes ?? "",
      calculationVersion: input.result.audit.calculationVersion,
      resultHash: input.result.audit.resultJsonSha256,
      payload: {
        source: "customer_portal",
        calculationRequest: input.calculationInput,
        calculationResult: input.result,
        displayedTotals: displayed,
        ...(input.gravureSnapshot ? {
          gravureSnapshot: {
            id: input.gravureSnapshot.id,
            sha256: input.gravureSnapshot.snapshotSha256,
            asOf: input.gravureSnapshot.asOf,
          },
        } : {}),
      },
    },
    actorId,
    portalUserId: input.user.id,
    ownerDomain: input.ownerDomain,
    customerCode: input.user.customerCode,
    idempotencyKey: input.businessInput.idempotencyKey,
    requestFingerprint: fingerprintOf(input.businessInput),
    buildResponse: (identifiers) => ({
      ...customerSafeResponse,
      publicId: identifiers.publicId,
      quotationNumber: identifiers.quotationNumber,
    }),
  });

  // Always return the exact persisted projection. This prevents a concurrent
  // idempotency winner from mixing its locally captured createdAt with the
  // original request's stored response.
  return NextResponse.json(mapping.response, { status: 201 });
}
