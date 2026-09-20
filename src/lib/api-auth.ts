import { cookies } from "next/headers";
import {
  SESSION_COOKIE_NAME,
  getSessionUserFromToken,
  readSessionCookie,
  type AuthenticatedUser,
} from "@/lib/auth-store";

export { SESSION_COOKIE_NAME };
export type { AuthenticatedUser };

export async function getSessionUser(request: Request): Promise<AuthenticatedUser | null> {
  return requireValidSession(request);
}

async function requireValidSession(request: Request): Promise<AuthenticatedUser | null> {
  return getSessionUserFromToken(await readSessionCookie(request));
}

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  return getSessionUserFromToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}
