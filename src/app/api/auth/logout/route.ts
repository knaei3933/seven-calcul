import { NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  deleteSession,
  readSessionCookie,
  sessionCookieOptions,
} from "@/lib/auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const token = await readSessionCookie(request);
  await deleteSession(token);
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0));
  return response;
}
