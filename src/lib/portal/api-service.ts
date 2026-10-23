import { NextResponse } from "next/server";
import {
  PortalIdentityError,
  authenticatePortalSession,
  authenticatePortalUserWithState,
  createPortalEmailVerificationWithCooldown,
  createPortalSession,
  createPortalUser,
  getPortalUserByEmail,
  incrementPortalRateLimit,
  revokePortalSession,
  verifyPortalUserAndProvisionCustomer,
} from "@/lib/portal/identity-store";
import {
  PortalServiceAuthenticationError,
  requirePortalServiceToken,
} from "@/lib/portal/service-auth";
import {
  createPortalMailSender,
  type PortalMailSender,
} from "@/lib/portal/mail-sender";

export interface PortalApiDependencies {
  now?: () => Date;
  mailSender?: PortalMailSender;
  clientFingerprint?: string;
}

interface StrictBody {
  value: Record<string, unknown>;
}

interface RegistrationInput {
  companyName: string;
  contactName: string;
  postalCode: string;
  address: string;
  telephone: string;
  email: string;
  password: string;
}

interface PortalUserProjection {
  id: number;
  email: string;
  companyName: string;
  contactName: string;
  postalCode: string;
  address: string;
  telephone: string;
  customerCode: string;
  ownerDomain: "kanei";
  isVerified: boolean;
  isActive: boolean;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
const VERIFICATION_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

class ValidationError extends Error {
  constructor() {
    super("validation_failed");
  }
}

class RateLimitError extends Error {
  constructor() {
    super("rate_limited");
  }
}

class PortalSessionError extends Error {
  constructor() {
    super("session_expired");
  }
}

async function readStrictObject(request: Request): Promise<StrictBody> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ValidationError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError();
  }
  return { value: parsed as Record<string, unknown> };
}

function strictFields(
  body: Record<string, unknown>,
  allowlist: readonly string[],
): void {
  const fields = new Set(Object.keys(body));
  if (fields.size !== allowlist.length || allowlist.some((field) => !fields.has(field))) {
    throw new ValidationError();
  }
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = body[field];
  if (typeof value !== "string") throw new ValidationError();
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > maxLength) throw new ValidationError();
  return trimmed;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new ValidationError();
  return email;
}

function validateRegistration(body: Record<string, unknown>): RegistrationInput {
  strictFields(body, [
    "companyName", "contactName", "postalCode", "address", "telephone", "email", "password",
  ]);
  const email = normalizeEmail(requiredString(body, "email", 254));
  const password = body.password;
  if (typeof password !== "string" || password.length < 10 || password.length > 200) {
    throw new ValidationError();
  }
  return {
    companyName: requiredString(body, "companyName", 200),
    contactName: requiredString(body, "contactName", 200),
    postalCode: requiredString(body, "postalCode", 32),
    address: requiredString(body, "address", 500),
    telephone: requiredString(body, "telephone", 50),
    email,
    password,
  };
}

function userProjection(user: Awaited<ReturnType<typeof getPortalUserByEmail>>): PortalUserProjection {
  if (!user) throw new PortalIdentityError("portal_user_not_found");
  return {
    id: user.id,
    email: user.email,
    companyName: user.companyName,
    contactName: user.contactName,
    postalCode: user.postalCode,
    address: user.address,
    telephone: user.telephone,
    customerCode: user.customerCode,
    ownerDomain: user.ownerDomain,
    isVerified: user.isVerified,
    isActive: user.isActive,
    verifiedAt: user.verifiedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function requestClientFingerprint(request: Request, dependencies: PortalApiDependencies): string {
  if (dependencies.clientFingerprint !== undefined) {
    return CLIENT_FINGERPRINT_PATTERN.test(dependencies.clientFingerprint)
      ? dependencies.clientFingerprint
      : "unknown";
  }
  const value = request.headers.get("x-portal-client-fingerprint")?.trim() ?? "";
  // Invalid browser-injected values are ignored. The BFF derives the only
  // accepted value after this handler has authenticated the service token.
  return CLIENT_FINGERPRINT_PATTERN.test(value) ? value : "unknown";
}

async function enforceRateLimit(input: {
  key: string;
  limit: number;
  windowSeconds: number;
  now: Date;
}): Promise<void> {
  const result = await incrementPortalRateLimit({
    key: input.key,
    limit: input.limit,
    windowSeconds: input.windowSeconds,
    now: input.now,
  });
  if (result.count > input.limit) throw new RateLimitError();
}

async function enforceAccountAndClientRateLimits(input: {
  action: "register" | "verify" | "resend" | "login";
  accountId: string;
  clientFingerprint: string;
  limit: number;
  windowSeconds: number;
  now: Date;
}): Promise<void> {
  await enforceRateLimit({
    key: `portal-${input.action}:${input.accountId}`,
    limit: input.limit,
    windowSeconds: input.windowSeconds,
    now: input.now,
  });
  await enforceRateLimit({
    key: `portal-${input.action}:client:${input.clientFingerprint}`,
    limit: input.limit,
    windowSeconds: input.windowSeconds,
    now: input.now,
  });
}

function sessionToken(request: Request): string | null {
  return request.headers.get("x-portal-session-token");
}

async function requirePortalSession(
  request: Request,
  now: Date,
): Promise<NonNullable<Awaited<ReturnType<typeof authenticatePortalSession>>>> {
  const token = sessionToken(request);
  if (!token) throw new PortalSessionError();
  const user = await authenticatePortalSession(token, {
    now,
    metadata: {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    },
  });
  if (!user) throw new PortalSessionError();
  return user;
}

async function register(
  request: Request,
  now: Date,
  mailSender: PortalMailSender,
  dependencies: PortalApiDependencies,
): Promise<NextResponse> {
  const input = validateRegistration((await readStrictObject(request)).value);
  await enforceAccountAndClientRateLimits({
    action: "register",
    accountId: input.email,
    clientFingerprint: requestClientFingerprint(request, dependencies),
    limit: 5,
    windowSeconds: 60 * 60,
    now,
  });
  const existing = await getPortalUserByEmail(input.email);
  if (existing) throw new PortalIdentityError("duplicate_email");
  const user = await createPortalUser(input);
  const verification = await createPortalEmailVerificationWithCooldown({
    email: input.email,
    ttlSeconds: VERIFICATION_TTL_SECONDS,
    maxAttempts: VERIFICATION_ATTEMPTS,
    cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    now,
  });
  await mailSender({
    to: input.email,
    subject: "ポータル本登録の確認",
    body: `確認コード: ${verification.code}\n有効期限: ${verification.expiresAt}`,
  });
  return NextResponse.json({ user: userProjection(user) }, { status: 201 });
}

async function verify(
  request: Request,
  now: Date,
  dependencies: PortalApiDependencies,
): Promise<NextResponse> {
  const body = (await readStrictObject(request)).value;
  strictFields(body, ["email", "code"]);
  const email = normalizeEmail(requiredString(body, "email", 254));
  const code = requiredString(body, "code", 200);
  await enforceAccountAndClientRateLimits({
    action: "verify",
    accountId: email,
    clientFingerprint: requestClientFingerprint(request, dependencies),
    limit: 10,
    windowSeconds: 60 * 60,
    now,
  });
  const user = await verifyPortalUserAndProvisionCustomer({ email, code, now });
  return NextResponse.json({ user: userProjection(user) });
}

async function resend(
  request: Request,
  now: Date,
  mailSender: PortalMailSender,
  dependencies: PortalApiDependencies,
): Promise<NextResponse> {
  const body = (await readStrictObject(request)).value;
  strictFields(body, ["email"]);
  const email = normalizeEmail(requiredString(body, "email", 254));
  await enforceAccountAndClientRateLimits({
    action: "resend",
    accountId: email,
    clientFingerprint: requestClientFingerprint(request, dependencies),
    limit: 3,
    windowSeconds: 60 * 60,
    now,
  });
  const user = await getPortalUserByEmail(email);
  if (!user || user.isVerified || !user.isActive) {
    throw new PortalIdentityError("verification_not_found");
  }
  const verification = await createPortalEmailVerificationWithCooldown({
    email,
    ttlSeconds: VERIFICATION_TTL_SECONDS,
    maxAttempts: VERIFICATION_ATTEMPTS,
    cooldownSeconds: RESEND_COOLDOWN_SECONDS,
    now,
  });
  await mailSender({
    to: email,
    subject: "ポータル確認コードの再送",
    body: `確認コード: ${verification.code}\n有効期限: ${verification.expiresAt}`,
  });
  return NextResponse.json({ accepted: true });
}

async function login(
  request: Request,
  now: Date,
  dependencies: PortalApiDependencies,
): Promise<NextResponse> {
  const body = (await readStrictObject(request)).value;
  strictFields(body, ["email", "password"]);
  const email = normalizeEmail(requiredString(body, "email", 254));
  if (typeof body.password !== "string" || body.password.length < 1 || body.password.length > 200) {
    throw new ValidationError();
  }
  await enforceAccountAndClientRateLimits({
    action: "login",
    accountId: email,
    clientFingerprint: requestClientFingerprint(request, dependencies),
    limit: 10,
    windowSeconds: 15 * 60,
    now,
  });
  const loginState = await authenticatePortalUserWithState(email, body.password);
  if (loginState.status === "unverified") {
    return NextResponse.json({ error: "email_unverified" }, { status: 403 });
  }
  if (loginState.status !== "authenticated") throw new PortalIdentityError("invalid_credentials");
  const user = loginState.user;
  const session = await createPortalSession(user.id, {
    ttlSeconds: SESSION_TTL_SECONDS,
    now,
    metadata: {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
    },
  });
  return NextResponse.json({
    user: userProjection(user),
    session: { token: session.token, expiresAt: session.expiresAt },
  });
}

async function logout(request: Request, now: Date): Promise<NextResponse> {
  const user = await requirePortalSession(request, now);
  const token = sessionToken(request)!;
  await revokePortalSession(token);
  return NextResponse.json({ success: true, user: userProjection(user) });
}

async function me(request: Request, now: Date): Promise<NextResponse> {
  const user = await requirePortalSession(request, now);
  return NextResponse.json({ user: userProjection(user) });
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof PortalServiceAuthenticationError) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (error instanceof ValidationError) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  if (error instanceof RateLimitError) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (error instanceof PortalSessionError) {
    return NextResponse.json({ error: "session_expired" }, { status: 401 });
  }
  if (error instanceof PortalIdentityError) {
    switch (error.code) {
      case "duplicate_email":
      case "conflict":
      case "duplicate_customer_code":
        return NextResponse.json({ error: "conflict" }, { status: 409 });
      case "invalid_portal_user":
        return NextResponse.json({ error: "validation_failed" }, { status: 400 });
      case "invalid_credentials":
      case "portal_service_login_forbidden":
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      case "verification_attempts_exceeded":
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      case "verification_not_found":
      case "verification_expired":
      case "invalid_verification_code":
        return NextResponse.json({ error: "email_verification_failed" }, { status: 400 });
      case "rate_limited":
      case "rate_limit_invalid":
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      default:
        return NextResponse.json({ error: "email_verification_failed" }, { status: 400 });
    }
  }
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

export async function handlePortalApiRequest(
  request: Request,
  action: "register" | "verify" | "resend" | "login" | "logout" | "me",
  dependencies: PortalApiDependencies = {},
): Promise<NextResponse> {
  const now = dependencies.now?.() ?? new Date();
  const mailSender = dependencies.mailSender ?? createPortalMailSender();
  try {
    requirePortalServiceToken(request.headers.get("authorization"));
    if (action === "register") return await register(request, now, mailSender, dependencies);
    if (action === "verify") return await verify(request, now, dependencies);
    if (action === "resend") return await resend(request, now, mailSender, dependencies);
    if (action === "login") return await login(request, now, dependencies);
    if (action === "logout") return await logout(request, now);
    return await me(request, now);
  } catch (error) {
    // Intentionally discard exception details; responses and logs carry no secrets or stacks.
    void error;
    return errorResponse(error);
  }
}
