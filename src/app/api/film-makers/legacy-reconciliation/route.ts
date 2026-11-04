import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { isKaneiTradeUser } from "@/lib/film-order-access";
import {
  backfillLegacySupplierSuggestions,
  exemptLegacyOrder,
  listLegacyReconciliations,
  selectFilmMakerForOrder,
} from "@/lib/film-maker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLASSIFICATIONS = [
  "internal",
  "ambiguous",
  "external_exact",
  "external_no_match",
] as const;

type LegacyClassification = typeof CLASSIFICATIONS[number];

function filmMakerAdminRequired(): NextResponse {
  return NextResponse.json({ error: "film_maker_admin_required" }, { status: 403 });
}

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return filmMakerAdminRequired();
  try {
    return NextResponse.json({ orders: await listLegacyReconciliations() });
  } catch {
    return NextResponse.json({ error: "legacy_reconciliation_list_failed" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  if (user.role !== "admin" || !isKaneiTradeUser(user.email)) return filmMakerAdminRequired();

  let body: Record<string, unknown>;
  try {
    body = await request.clone().json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const action = String(body.action ?? "");
    let message: string;
    if (action === "backfill") {
      const orderIds = Array.isArray(body.orderIds)
        ? body.orderIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
        : undefined;
      const result = await backfillLegacySupplierSuggestions(orderIds);
      message = `${result.suggested} 件を提案として更新しました（${result.scanned} 件調査）。`;
    } else if (action === "select") {
      const orderId = Number(body.orderId);
      const makerId = Number(body.makerId);
      if (!Number.isInteger(orderId) || orderId <= 0) throw new Error("invalid_film_order_id");
      if (!Number.isInteger(makerId) || makerId <= 0) throw new Error("invalid_film_maker_id");
      await selectFilmMakerForOrder(orderId, makerId, user.email);
      message = "フィルムメーカーを選択し、案件スナップショットを記録しました。";
    } else if (action === "exempt") {
      const orderId = Number(body.orderId);
      const reason = String(body.reason ?? "");
      const classification = body.classification as LegacyClassification;
      if (!Number.isInteger(orderId) || orderId <= 0) throw new Error("invalid_film_order_id");
      if (!CLASSIFICATIONS.includes(classification)) throw new Error("legacy_classification_conflict");
      await exemptLegacyOrder(orderId, reason, classification, user.email);
      message = "履歴を保持したまま明示的にレガシー除外にしました。";
    } else {
      throw new Error("unknown_action");
    }
    return NextResponse.json({
      ok: true,
      message,
      orders: await listLegacyReconciliations(),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "legacy_reconciliation_failed";
    const status = [
      "invalid_request",
      "unknown_action",
      "invalid_film_order_id",
      "invalid_film_maker_id",
      "film_maker_not_found",
      "film_maker_route_mismatch",
      "film_maker_print_method_mismatch",
      "film_maker_language_mismatch",
      "legacy_exempt_reason_required",
      "legacy_classification_conflict",
    ].includes(code) ? 400
      : code === "film_order_resolution_conflict" ? 409
        : code === "film_order_not_found" ? 404
          : 500;
    return NextResponse.json({ error: code }, { status });
  }
}
