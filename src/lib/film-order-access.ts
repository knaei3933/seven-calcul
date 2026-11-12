/**
 * フィルム発注ワークフローの権限。
 * フィルム発注の buyer は成約見積の durable owner から決定する。
 * - Seven-origin quote: Seven Chemical が Buyer操作、Kanei Trade がフィルム調達・ supplier approval。
 * - Kanei-origin quote: Kanei Trade が Buyer操作と supplier approval の両方を担う。
 * - maker/customer/token paths remain isolated from internal buyer ownership.
 */
export const SEVEN_CHEMICAL_EMAIL_DOMAIN = "@727.co.jp";
export const KANEI_TRADE_EMAIL_DOMAIN = "@kanei-trade.co.jp";

function hasDomain(email: string | null | undefined, domain: string): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(domain);
}

export function isSevenChemicalUser(email: string | null | undefined): boolean {
  return hasDomain(email, SEVEN_CHEMICAL_EMAIL_DOMAIN);
}

export type CustomerOwnerDomain = "seven" | "kanei";

export function customerOwnerDomainOf(email: string | null | undefined): CustomerOwnerDomain {
  return isKaneiTradeUser(email) ? "kanei" : "seven";
}

export function isKaneiTradeUser(email: string | null | undefined): boolean {
  return hasDomain(email, KANEI_TRADE_EMAIL_DOMAIN);
}

export type SupplierLocale = "ko" | "ja";

/**
 * 原材料調達先の言語。
 * - digital / K（韓国輸入）→ Korean
 * - Y（国内調達）        → Japanese
 */
export function supplierLocaleFor(order: { procurement_route: string | null | undefined }): SupplierLocale {
  return order.procurement_route === "Y" ? "ja" : "ko";
}

export function canViewFilmOrders(
  email: string | null | undefined,
  role?: string | null,
): boolean {
  if (role === "admin") return true;
  return isSevenChemicalUser(email) || isKaneiTradeUser(email);
}

export function filmOrderBuyerDomainOf(order: {
  buyer_domain: string | null | undefined;
}): "seven" | "kanei" {
  const normalized = String(order.buyer_domain ?? "").trim().toLowerCase();
  if (normalized === "727.co.jp") return "seven";
  if (normalized === "kanei-trade.co.jp") return "kanei";
  throw new Error("film_order_buyer_domain_missing");
}

export type FilmOrderActionSide = "buyer" | "kanei" | "seven" | "other_company";
export type FilmOrderViewerRole = "admin" | "user";

export type FilmOrderExecutionActorRole =
  | "kanei"
  | "seven"
  | "maker"
  | "customer"
  | "system";

const ACTION_SIDE: Record<string, FilmOrderActionSide> = {
  "mark-ordered": "buyer",
  "register-receiving": "buyer",
  "register-receiving-extra": "buyer",
  "resend-receiving-notice": "buyer",
  approve: "buyer",
  "request-re-proof": "buyer",
  // Customer/filling responsibility follows the durable buyer. Kanei remains the
  // buyer for Kanei-origin work; Seven owns these actions for Seven-origin work.
  "request-customer-design-upload": "buyer",
  "confirm-customer-design": "buyer",
  "request-customer-design-correction": "buyer",
  "set-customer-design-not-required": "buyer",
  "send-customer-proof-review": "buyer",
  "record-customer-proof-approval": "kanei",
  "register-proof": "kanei",
  "send-proof-notice": "kanei",
  "rotate-supplier-proof-token": "kanei",
  "set-supplier": "kanei",
  "select-film-maker": "kanei",
  "update-supplier-order-note": "kanei",
  "preview-supplier-po": "kanei",
  "send-po": "kanei",
  "request-ship-to-registration": "buyer",
  "register-ship-to": "buyer",
  "confirm-ship-to": "buyer",
  "remove-ship-to-destination": "buyer",
  "save-production-plan": "buyer",
  "confirm-production-plan": "buyer",
  "request-production-plan": "kanei",
  "resend-supplier-links": "kanei",
  "confirm-film-receipt": "buyer",
};

/**
 * buyer_domain は見積 owner から永続化済み。buyer actions are restricted to that
 * company; film supplier/order approval remains Kanei for both origins.
 */
export function canPerformFilmOrderAction(
  action: string,
  actorEmail: string | null | undefined,
  buyerDomain: string,
): boolean {

  const side = ACTION_SIDE[action];
  if (!side) return false;
  let buyer: "seven" | "kanei";
  try {
    buyer = filmOrderBuyerDomainOf({ buyer_domain: buyerDomain });
  } catch {
    return false;
  }
  if (side === "buyer") {
    return buyer === "seven" ? isSevenChemicalUser(actorEmail) : isKaneiTradeUser(actorEmail);
  }
  if (side === "other_company") {
    const ownerActor = buyer === "seven" ? isSevenChemicalUser(actorEmail) : isKaneiTradeUser(actorEmail);
    return (isSevenChemicalUser(actorEmail) || isKaneiTradeUser(actorEmail)) && !ownerActor;
  }
  if (side === "seven") return isSevenChemicalUser(actorEmail);
  return isKaneiTradeUser(actorEmail);
}

const TOKEN_ACTION_ROLES: Record<string, readonly FilmOrderExecutionActorRole[]> = {
  "update-eta": ["maker"],
  "report-shipment": ["maker"],
  "report-delivery": ["maker"],
  "ship-to-registered": ["customer", "system"],
  "customer-design-received": ["customer"],
  "production-plan-request": ["kanei"],
  "customer-proof-decision": ["customer"],
};

export function filmOrderExecutionActorRoleOf(
  actorEmail: string | null | undefined,
): FilmOrderExecutionActorRole {
  const actor = String(actorEmail ?? "").trim().toLowerCase();
  if (actor === "machine:maker" || actor.startsWith("machine:maker:")) return "maker";
  if (actor === "supplier" || actor.startsWith("supplier:")) return "maker";
  if (actor === "customer" || actor.startsWith("customer:")) return "customer";
  if (actor === "system" || actor.startsWith("machine:system:")) return "system";
  if (isSevenChemicalUser(actor)) return "seven";
  if (isKaneiTradeUser(actor)) return "kanei";
  // Token entry points validate purpose before invoking these fixed mutations; a
  // non-internal uploader is therefore the customer/maker side and never buyer/Kanei.
  return "customer";
}

export function canPerformFilmOrderActorAction(
  action: string,
  actorEmail: string | null | undefined,
  buyerDomain: string,
): boolean {

  const buyer = filmOrderBuyerDomainOf({ buyer_domain: buyerDomain });
  const actor = filmOrderExecutionActorRoleOf(actorEmail);
  const tokenRoles = TOKEN_ACTION_ROLES[action];
  if (tokenRoles) return tokenRoles.includes(actor);
  const side = ACTION_SIDE[action];
  if (!side) return false;
  // 校正最終承認は両社とも実行できる内部ダブルチェックにする。
  // buyer以外の操作（発注数量変更など）は従来どおり buyer_domain で制限する。
  if (action === "approve") return actor === "seven" || actor === "kanei";
  const roles: readonly FilmOrderExecutionActorRole[] = side === "buyer"
    ? [buyer]
    : side === "kanei"
      ? ["kanei"]
      : side === "other_company"
        ? buyer === "seven" ? ["kanei"] : ["seven"]
        : side === "seven"
          ? ["seven"]
        : ["seven", "kanei"];
  return roles.includes(actor) || (action === "register-proof" && actor === "maker");
}

/** 発注ワークフロー一覧は Seven/Kanei が共有する。処理権限は buyer/seller role で分離する。 */
export function canViewFilmOrderRow(
  orderBuyerDomain: string,
  actorEmail: string | null | undefined,
  actorRole?: FilmOrderViewerRole,
): boolean {
  // Role-admin may supervise neutral/system-account reads; company authority remains
  // buyer-domain based for every mutation.
  if (actorRole === "admin") return true;
  void orderBuyerDomain;
  return isSevenChemicalUser(actorEmail) || isKaneiTradeUser(actorEmail);
}

// ---- 後方互換用（ページ表示など） ----
export function canRegisterFilmOrderReceiving(
  email: string | null | undefined,
  buyerDomain: string,
): boolean {
  return canPerformFilmOrderAction("register-receiving", email, buyerDomain);
}

export function canManageFilmOrderProof(email: string | null | undefined): boolean {
  return isKaneiTradeUser(email);
}

export function canApproveFilmOrderProof(
  email: string | null | undefined,
  buyerDomain: string,
): boolean {
  return canPerformFilmOrderAction("approve", email, buyerDomain);
}

export function canMarkFilmOrderOrdered(
  email: string | null | undefined,
  buyerDomain: string,
): boolean {
  return canPerformFilmOrderAction("mark-ordered", email, buyerDomain);
}
