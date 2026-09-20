import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { updateUser, type UserRole } from "@/lib/auth-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  const current = await getSessionUser(request);
  if (!current) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (current.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { id } = await context.params;
  try {
    const body = await request.json() as {
      name?: unknown;
      password?: unknown;
      role?: unknown;
      isActive?: unknown;
    };
    if (current.id === Number(id) && body.isActive === false) {
      return NextResponse.json({ error: "cannot_deactivate_self" }, { status: 400 });
    }
    const updated = await updateUser(Number(id), {
      name: body.name as string | undefined,
      password: body.password as string | undefined,
      role: body.role as UserRole | undefined,
      isActive: body.isActive as boolean | undefined,
    });
    return NextResponse.json({ user: updated });
  } catch (error) {
    if (!(error instanceof Error)) {
      return NextResponse.json({ error: "user_update_failed" }, { status: 500 });
    }
    if (error.message === "user_not_found") return NextResponse.json({ error }, { status: 404 });
    if (error.message === "last_active_admin") return NextResponse.json({ error }, { status: 400 });
    return NextResponse.json({ error: error.message || "invalid_user" }, { status: 400 });
  }
}
