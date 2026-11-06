import { filmOrderBuyerDomainOf, isKaneiTradeUser, isSevenChemicalUser } from "./film-order-access";
import type { FilmOrderView } from "./film-order-shared";

export type FilmOrderDisclosureAudience = "seven" | "kanei" | "customer" | "maker" | "unknown";

export function filmOrderDisclosureAudience(actorEmail: string | null | undefined): FilmOrderDisclosureAudience {
  if (isSevenChemicalUser(actorEmail)) return "seven";
  if (isKaneiTradeUser(actorEmail)) return "kanei";
  return "unknown";
}

const SEVEN_FORBIDDEN_KEYS = new Set([
  "film_maker_id",
  "makerId",
  "film_maker_snapshot_json",
  "makerSnapshot",
  "supplier_resolution",
  "supplierResolution",
  "makerCompanyName",
  "makerEmail",
  "makerLanguage",
  "supplier_name",
  "supplier_email",
  "supplierEmail",
  "purchaseOrder",
  "supplier_order_note",
]);

const CUSTOMER_FORBIDDEN_KEYS = new Set([
  ...SEVEN_FORBIDDEN_KEYS,
  "buyer_domain",
  "created_by_email",
  "seven_contact_email",
  "supplier_approval_status",
  "supplierApprovalStatus",
  "supplier_approval_at",
  "supplierApprovalAt",
  "supplier_approval_by",
  "supplierApprovalBy",
  "supplier_approval_note",
  "supplierApprovalNote",
  "buyer_approval_status",
  "buyerApprovalStatus",
  "buyer_approval_at",
  "buyerApprovalAt",
  "buyer_approval_by",
  "buyerApprovalBy",
]);

function safeFilmOrderOwnerCompany(order: FilmOrderView): "seven" | "kanei" | "unresolved" {
  try {
    return filmOrderBuyerDomainOf(order);
  } catch {
    return "unresolved";
  }
}

function cloneWithoutForbidden(value: unknown, forbidden: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneWithoutForbidden(item, forbidden));
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) continue;
    if (key === "events" && Array.isArray(child)) {
      result[key] = child.map((event) => {
        const source = event && typeof event === "object" ? event as Record<string, unknown> : {};
        return {
          id: source.id,
          order_id: source.order_id,
          type: source.type,
          created_at: source.created_at,
        };
      });
      continue;
    }
    result[key] = cloneWithoutForbidden(child, forbidden);
  }
  return result;
}

export function serializeFilmOrderForActor(
  order: FilmOrderView,
  actorEmail: string | null | undefined,
  viewerRole?: string | null,
): Record<string, unknown> {
  const audience = filmOrderDisclosureAudience(actorEmail);
  if (audience === "kanei") return structuredClone(order) as unknown as Record<string, unknown>;
  const forbidden = audience === "seven" ? SEVEN_FORBIDDEN_KEYS : CUSTOMER_FORBIDDEN_KEYS;
  const projected = cloneWithoutForbidden(order, forbidden) as Record<string, unknown>;
  if (Array.isArray(projected.files)) {
    projected.files = projected.files.map((file) => {
      const source = file && typeof file === "object" ? file as Record<string, unknown> : {};
      return {
        id: source.id,
        order_id: source.order_id,
        category: source.category,
        file_name: source.file_name,
        url: source.url,
        version: source.version,
        created_at: source.created_at,
      };
    });
  }
  if (viewerRole === "admin" && audience === "unknown") {
    projected.ownerCompany = safeFilmOrderOwnerCompany(order);
  }
  return projected;
}

interface LifecycleOutcome {
  audience: "maker" | "seven" | "kanei" | "customer";
  attemptCount: number;
  status: string;
  intendedTo: string;
  recipientOverridden: boolean;
}

interface MailPreviewEnvelope {
  audience: "maker" | "seven" | "kanei" | "customer";
  intendedTo: string;
  cc: string[];
  language: string;
  subject: string;
  body: string;
  links: Array<{ key: string; url: string; label?: string }>;
  attachments: Array<Record<string, unknown>>;
  contentHash: string;
  effectiveTemplateIdentity: { key: string; source: string; compatibilityKey: string | null };
}

interface MailPreview {
  dispatchGroupId: string;
  event: string;
  envelopes: MailPreviewEnvelope[];
  stagedTokenHashes: readonly string[];
  warnings?: string[];
}

interface FilmOrderActionResult {
  order?: FilmOrderView;
  preview?: unknown;
  lifecycle?: { dispatchGroupId: string; workflowCompleted: boolean; notificationCompleted: boolean; outcomes: LifecycleOutcome[] } | null;
  mails?: readonly unknown[];
}

export function serializeFilmOrderActionForActor(
  result: FilmOrderActionResult,
  actorEmail: string | null | undefined,
  viewerRole?: string | null,
): Record<string, unknown> {
  const audience = filmOrderDisclosureAudience(actorEmail);
  if (audience === "kanei") return structuredClone(result) as unknown as Record<string, unknown>;
  const order = result.order ? serializeFilmOrderForActor(result.order, actorEmail, viewerRole) : undefined;
  const outcomes = (result.lifecycle?.outcomes ?? [])
    .filter((outcome) => outcome.audience === audience)
    .map((outcome) => ({
      audience: outcome.audience,
      attemptCount: outcome.attemptCount,
      status: outcome.status,
      intendedTo: outcome.intendedTo,
      recipientOverridden: outcome.recipientOverridden === true,
    }));
  const response: Record<string, unknown> = { order };
  if (result.preview) {
    const raw = result.preview as MailPreview;
    const envelopes = audience === "seven"
      ? raw.envelopes.filter((envelope) => envelope.audience === "seven").map((envelope) => ({
        ...envelope,
        attachments: envelope.attachments.map((attachment) => ({
          fileName: attachment.fileName,
          category: attachment.category,
          version: attachment.version,
        })),
      }))
      : [];
    response.preview = {
      dispatchGroupId: raw.dispatchGroupId,
      event: raw.event,
      envelopes,
      plannedAudiences: raw.envelopes.map((envelope) => envelope.audience),
      stagedTokenHashes: raw.stagedTokenHashes,
      warnings: raw.warnings ?? [],
    };
  }
  if (result.lifecycle) {
    response.lifecycle = {
      dispatchGroupId: result.lifecycle.dispatchGroupId,
      workflowCompleted: result.lifecycle.workflowCompleted,
      notificationCompleted: result.lifecycle.notificationCompleted,
      outcomes,
    };
  }
  return response;
}
