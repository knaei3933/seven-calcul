import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  authenticate,
  createSession,
  sessionCookieOptions,
} from "@/lib/auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json() as { email?: unknown; password?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }
    const user = await authenticate(body.email, body.password);
    if (!user) return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });

    const session = await createSession(user.id);
    const response = NextResponse.json({ user });
    response.cookies.set(SESSION_COOKIE_NAME, session.token, sessionCookieOptions(
      Math.max(1, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)),
    ));
    return response;
  } catch {
    return NextResponse.json({ error: "login_failed" }, { status: 500 });
  }
}
