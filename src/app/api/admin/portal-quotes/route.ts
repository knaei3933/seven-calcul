import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import {
  AdminQuoteAccessError,
  AdminQuoteValidationError,
  listAdminPortalQuotes,
  requirePortalQuoteAdmin,
  type AdminQuoteApiDependencies,
} from "@/lib/portal/admin-quote-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parsePage(value: string | null): number {
  if (value === null) return 1;
  if (!/^[1-9][0-9]*$/.test(value)) throw new AdminQuoteValidationError();
  const page = Number(value);
  if (!Number.isSafeInteger(page)) throw new AdminQuoteValidationError();
  return page;
}

function parseLimit(value: string | null): number {
  if (value === null) return 20;
  if (!/^[1-9][0-9]*$/.test(value)) throw new AdminQuoteValidationError();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new AdminQuoteValidationError();
  return limit;
}

export async function GET(
  request: Request,
  _context: { params: Promise<Record<string, never>> },
  dependencies: AdminQuoteApiDependencies = {},
): Promise<NextResponse> {
  try {
    const readUser = dependencies.getSessionUser ?? getSessionUser;
    const authenticatedUser = await readUser(request);
    if (!authenticatedUser) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    const user = requirePortalQuoteAdmin(authenticatedUser);
    const url = new URL(request.url);
    const listQuotes = dependencies.listQuotes ?? listAdminPortalQuotes;
    const result = await listQuotes({
      search: url.searchParams.get("q") ?? undefined,
      page: parsePage(url.searchParams.get("page")),
      limit: parseLimit(url.searchParams.get("limit")),
    }, dependencies);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AdminQuoteAccessError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (error instanceof AdminQuoteValidationError) {
      return NextResponse.json({ error: "validation_failed" }, { status: 400 });
    }
    return NextResponse.json({ error: "admin_portal_quotes_unavailable" }, { status: 500 });
  }
}
