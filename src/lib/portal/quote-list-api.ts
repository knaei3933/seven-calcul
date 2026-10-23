import { NextResponse } from "next/server";
import {
  authenticatePortalSession,
  incrementPortalRateLimit,
  type PublicPortalUser,
  PortalIdentityError,
} from "@/lib/portal/identity-store";
import { PortalServiceAuthenticationError, requirePortalServiceToken } from "@/lib/portal/service-auth";
import {
  decodeCursor,
  findOwnPortalQuote,
  listOwnPortalQuotes,
  type PortalQuoteOwnerDomain,
} from "@/lib/portal/quote-queries";

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const LIST_RATE_LIMIT = 60;
const DETAIL_RATE_LIMIT = 240;

class PortalQuoteSessionError extends Error {
  constructor() {
    super("portal_session_required");
    this.name = "PortalQuoteSessionError";
  }
}

class PortalQuoteRateLimitError extends Error {
  constructor() {
    super("rate_limited");
    this.name = "PortalQuoteRateLimitError";
  }
}

class PortalQuoteValidationError extends Error {
  constructor() {
    super("validation_failed");
    this.name = "PortalQuoteValidationError";
  }
}

export interface PortalQuoteApiDependencies {
  now?: () => Date;
  authenticateSession?: typeof authenticatePortalSession;
  incrementRateLimit?: typeof incrementPortalRateLimit;
  listQuotes?: typeof listOwnPortalQuotes;
  findQuote?: typeof findOwnPortalQuote;
}

interface AuthenticatedCaller {
  user: PublicPortalUser;
  ownerDomain: PortalQuoteOwnerDomain;
}

function sessionToken(request: Request): string | null {
  return request.headers.get("x-portal-session-token");
}

async function requireOwnPortalCaller(
  request: Request,
  dependencies: PortalQuoteApiDependencies,
): Promise<AuthenticatedCaller> {
  requirePortalServiceToken(request.headers.get("authorization"));
  const token = sessionToken(request);
  if (!token) throw new PortalQuoteSessionError();
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
    // The identity store intentionally rejects malformed tokens as credentials;
    // callers receive the same opaque result as missing/expired sessions.
    if (error instanceof PortalIdentityError) throw new PortalQuoteSessionError();
    throw error;
  }
  if (!user || user.ownerDomain !== "kanei" || !user.customerCode || !user.isActive || !user.isVerified) {
    throw new PortalQuoteSessionError();
  }
  return { user, ownerDomain: "kanei" };
}

async function enforceRateLimit(
  dependencies: PortalQuoteApiDependencies,
  input: { key: string; limit: number },
  now: Date,
): Promise<void> {
  const incrementRateLimit = dependencies.incrementRateLimit ?? incrementPortalRateLimit;
  const result = await incrementRateLimit({
    key: input.key,
    limit: input.limit,
    windowSeconds: 60,
    now,
  });
  if (result.count > input.limit) throw new PortalQuoteRateLimitError();
}

function callerScope(caller: AuthenticatedCaller): {
  portalUserId: number;
  ownerDomain: PortalQuoteOwnerDomain;
  customerCode: string;
} {
  return {
    portalUserId: caller.user.id,
    ownerDomain: caller.ownerDomain,
    customerCode: caller.user.customerCode,
  };
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_LIST_LIMIT;
  if (!/^[1-9][0-9]*$/.test(value)) throw new PortalQuoteValidationError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
    throw new PortalQuoteValidationError();
  }
  return parsed;
}

export async function listPortalQuotesApi(
  request: Request,
  dependencies: PortalQuoteApiDependencies = {},
): Promise<NextResponse> {
  try {
    const now = dependencies.now?.() ?? new Date();
    const caller = await requireOwnPortalCaller(request, dependencies);
    const url = new URL(request.url);
    const rawCursor = url.searchParams.get("cursor");
    if (url.searchParams.has("cursor") && !rawCursor) throw new PortalQuoteValidationError();
    const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;
    if (rawCursor && !cursor) throw new PortalQuoteValidationError();
    const limit = parseLimit(url.searchParams.get("limit"));
    await enforceRateLimit(dependencies, {
      key: `portal-quote-list:${caller.ownerDomain}:${caller.user.id}`,
      limit: LIST_RATE_LIMIT,
    }, now);
    const listQuotes = dependencies.listQuotes ?? listOwnPortalQuotes;
    const page = await listQuotes({ ...callerScope(caller), limit, cursor: cursor ?? undefined, now });
    return NextResponse.json({
      quotes: page.quotes,
      pagination: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    });
  } catch (error) {
    return quoteApiErrorResponse(error);
  }
}

export async function getPortalQuoteApi(
  request: Request,
  publicId: string,
  dependencies: PortalQuoteApiDependencies = {},
): Promise<NextResponse> {
  try {
    const now = dependencies.now?.() ?? new Date();
    const caller = await requireOwnPortalCaller(request, dependencies);
    await enforceRateLimit(dependencies, {
      key: `portal-quote-detail:${caller.ownerDomain}:${caller.user.id}`,
      limit: DETAIL_RATE_LIMIT,
    }, now);
    const findQuote = dependencies.findQuote ?? findOwnPortalQuote;
    const quote = await findQuote({ ...callerScope(caller), publicId, now });
    if (!quote) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ quote });
  } catch (error) {
    return quoteApiErrorResponse(error);
  }
}

function quoteApiErrorResponse(error: unknown): NextResponse {
  if (error instanceof PortalServiceAuthenticationError || error instanceof PortalQuoteSessionError) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (error instanceof PortalQuoteValidationError) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  if (error instanceof PortalQuoteRateLimitError) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  // Intentionally discard internals: database text and identifiers never leak.
  void error;
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
