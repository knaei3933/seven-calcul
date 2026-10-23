import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Server-only credential check. Import this module from server code only; the
 * token is read from process.env on every call so tests can rotate it safely.
 */
export function authenticatePortalServiceToken(
  authorizationHeader: string | null | undefined,
): boolean {
  const expected = process.env.PORTAL_SERVICE_TOKEN ?? "";
  const provided = authorizationHeader ?? "";
  if (!expected || expected.length < 32 || !provided.startsWith("Bearer ")) return false;

  const providedToken = provided.slice("Bearer ".length);
  if (providedToken.length < 32 || providedToken.length > 500) return false;

  const providedDigest = createHash("sha256").update(providedToken).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export class PortalServiceAuthenticationError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "PortalServiceAuthenticationError";
  }
}

export function requirePortalServiceToken(
  authorizationHeader: string | null | undefined,
): void {
  if (!authenticatePortalServiceToken(authorizationHeader)) {
    throw new PortalServiceAuthenticationError();
  }
}
