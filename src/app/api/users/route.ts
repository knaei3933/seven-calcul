import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { createUser, listUsers } from "@/lib/auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json({ users: await listUsers() });
  } catch {
    return NextResponse.json({ error: "user_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const created = await createUser(await request.json());
    return NextResponse.json({ user: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "duplicate_email") {
      return NextResponse.json({ error: "duplicate_email" }, { status: 409 });
    }
    return NextResponse.json({ error: "invalid_user" }, { status: 400 });
  }
}
