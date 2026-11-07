import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSqlClient, type SqlClient } from "./db";
import { sendMail, type MailSendResult } from "./mailer";
import { registeredJapaneseDisplayNameKo } from "./japanese-text-ko";
import { withRecipientSubjectPrefix, type MailAudience } from "./mail-subject";
import type { PurchaseOrderSnapshot } from "./purchase-order";
import { quotationOwnerDomainFromStorage, type QuotationRecord } from "./quotation-shared";
import {
  canPerformFilmOrderActorAction,
  canViewFilmOrderRow,
  filmOrderBuyerDomainOf,
  isSevenChemicalUser,
  isKaneiTradeUser,
  type SupplierLocale,
} from "./film-order-access";
import {
  DEFAULT_FILM_PROOF_EMAIL,
  type CustomerDesignTracking,
  type FilmOrderRow as SharedFilmOrderRow,
  type SampleBulkStatus,
  type SampleBulkTracking,
  type CustomerDesignStatus,
  type CustomerProofStatus,
  type CustomerProofTracking,
  type ProductionPlanTracking,
  type ProductionPlanStatus,
  type DeliveryDocument,
  type DeliveryNoteDraft,
  type FilmDeliveryTracking,
  type ShipToStatus,
  type ShipToTracking,
} from "./film-order-shared";
import { isInternalLegacySupplier } from "./film-maker-reconciliation";
import type { FilmOrderMailConfirmResult, FilmOrderMailPreview } from "./film-order-mail-lifecycle";
import { resolveFilmOrderExternalOrigin } from "./film-order-origin";
import { isFilmOrderLifecycleWorkflowAction } from "./film-order-lifecycle-actions";
import { recoverStaleFilmOrderMailSendingAttempts } from "./film-order-mail-outbox";
import {
  assertFilmOrderActionGuard,
  assertFilmOrderDeliveryDocumentGuard,
  type FilmOrderGuardInput,
  type FilmWorkflowAction,
} from "./film-order-stage";
import { customerDesignFolderId, findDriveFiles } from "./google-drive";
import {
  getCustomer,
  getDeliveryDestination,
  listDeliveryDestinations,
  markDeliveryDestinationUsed,
  upsertDeliveryDestination,
  validateDeliveryDestinationInput,
} from "./customer-store";
import type { CustomerDeliveryDestination, CustomerMaster } from "./quotation-shared";

interface FilmOrderRow extends SharedFilmOrderRow {
  purchase_order_json: string;
  sample_bulk_status: SampleBulkStatus;
  bulk_usage_reference_ml: string;
  sample_requested_ml: string | null;
  sample_received_ml: string | null;
  sample_adjusted_ml: string | null;
  sample_bulk_adjustment_count: number;
  sample_bulk_recipient_name: string;
  sample_bulk_recipient_postal_code: string;
  sample_bulk_recipient_address: string;
  sample_bulk_requested_at: string | null;
  sample_bulk_received_at: string | null;
  sample_bulk_confirmed_at: string | null;
  sample_bulk_adjustment_requested_at: string | null;
  sample_bulk_request_note: string;
  sample_bulk_receive_note: string;
  sample_bulk_adjustment_reason: string;
}

export function filmDesignNotificationTo(): string {
  return process.env.FILM_DESIGN_TO ?? DEFAULT_FILM_PROOF_EMAIL;
}

export function sevenChemicalContactEmail(): string {
  return process.env.SEVEN_CHEMICAL_CONTACT_EMAIL?.trim() || "gotou@727.co.jp";
}

/**
 * Durable film-order buyer ownership comes from the quotation owner, never the actor who
 * happens to open the list. With owner_domain present, only explicit resolved owners may
 * backfill a truly missing/empty buyer. Unknown and explicitly unresolved rows stay closed.
 */
async function reconcileFilmOrderOwnership(db: SqlClient): Promise<void> {
  const hasQuotationOwnerColumn = db.dialect === "postgres"
    ? Boolean((await db.get<{ exists: number | boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'quotations' AND column_name = 'owner_domain'
      ) AS exists
    `))?.exists)
    : Boolean((await db.all<{ name: string }>("PRAGMA table_info(quotations)"))
      .some((column) => column.name === "owner_domain"));
  if (!hasQuotationOwnerColumn) {
    const hasQuotationsTable = db.dialect === "postgres"
      ? Boolean((await db.get<{ exists: number | boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 'quotations'
        ) AS exists
      `))?.exists)
      : Boolean((await db.all<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='quotations'
      `)).length);
    if (!hasQuotationsTable) return;
    const hasUsersTable = db.dialect === "postgres"
      ? Boolean((await db.get<{ exists: number | boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 'users'
        ) AS exists
      `))?.exists)
      : Boolean((await db.all<{ name: string }>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='users'
      `)).length);
    if (!hasUsersTable) return;
    // Film-order-only test databases and pre-G001 replicas still carry creator identity.
    // Keep reconciliation alive, but never invent an owner from an unrelated actor.
    await db.exec(db.dialect === "postgres" ? `
      UPDATE film_orders f
      SET buyer_domain = CASE
        WHEN u.email LIKE '%@727.co.jp' THEN '727.co.jp'
        WHEN u.email LIKE '%@kanei-trade.co.jp' THEN 'kanei-trade.co.jp'
        ELSE f.buyer_domain
      END
      FROM quotations q JOIN users u ON u.id=q.created_by
      WHERE f.quotation_id=q.id
    ` : `
      UPDATE film_orders
      SET buyer_domain = CASE
        WHEN u.email LIKE '%@727.co.jp' THEN '727.co.jp'
        WHEN u.email LIKE '%@kanei-trade.co.jp' THEN 'kanei-trade.co.jp'
        ELSE film_orders.buyer_domain
      END
      FROM quotations q JOIN users u ON u.id=q.created_by
      WHERE film_orders.quotation_id=q.id
    `);
    return;
  }
  await db.exec(db.dialect === "postgres" ? `
    UPDATE film_orders f
    SET buyer_domain = CASE
      WHEN q.owner_domain = 'seven' THEN '727.co.jp'
      WHEN q.owner_domain = 'kanei' THEN 'kanei-trade.co.jp'
      ELSE f.buyer_domain
    END
    FROM quotations q
    WHERE f.quotation_id = q.id
      AND q.owner_domain IN ('seven', 'kanei')
      AND (f.buyer_domain IS NULL OR f.buyer_domain = '')
  ` : `
    UPDATE film_orders
    SET buyer_domain = CASE
      WHEN q.owner_domain = 'seven' THEN '727.co.jp'
      WHEN q.owner_domain = 'kanei' THEN 'kanei-trade.co.jp'
      ELSE film_orders.buyer_domain
    END
    FROM quotations q
    WHERE film_orders.quotation_id = q.id
      AND q.owner_domain IN ('seven', 'kanei')
      AND (
        film_orders.buyer_domain IS NULL
        OR film_orders.buyer_domain = ''
      )
  `);
  await db.run(`
    UPDATE film_orders
    SET seven_contact_email = ?
    WHERE buyer_domain = '727.co.jp'
      AND (seven_contact_email IS NULL OR seven_contact_email = '' OR seven_contact_email NOT LIKE '%@727.co.jp')
  `, [sevenChemicalContactEmail()]);
  await db.run(`
    UPDATE film_orders
    SET seven_contact_email = created_by_email
    WHERE buyer_domain = 'kanei-trade.co.jp'
      AND created_by_email LIKE '%@kanei-trade.co.jp'
      AND (seven_contact_email IS NULL OR seven_contact_email = '' OR seven_contact_email NOT LIKE '%@kanei-trade.co.jp')
  `);
  await db.run(`
    UPDATE film_orders
    SET seven_contact_email = ?
    WHERE buyer_domain = 'kanei-trade.co.jp'
      AND (seven_contact_email IS NULL OR seven_contact_email = '')
  `, [filmDesignNotificationTo()]);
}

/**
 * Film-order recipients are owned by the selected maker snapshot or explicit order supplier email.
 * Route/configured fallbacks are forbidden; centralized test-mode routing happens only in the mailer.
 */
export function supplierDestinationFor(order: Pick<FilmOrder, "supplier_email" | "makerEmail">): { to: string | null; route: "order" } {
  return { to: order.makerEmail?.trim() || order.supplier_email.trim() || null, route: "order" };
}

interface FilmOrderRow {
  id: number;
  order_number: string;
  quotation_id: number;
  quotation_number: string;
  product_name: string;
  customer_name: string;
  printing_method: string;
  procurement_route: string;
  film_composition: string;
  order_length_m: string;
  web_width_mm: string;
  pouch_quantity: string;
  supplier_name: string;
  supplier_email: string;
  seven_contact_email: string;
  buyer_domain: string;
  po_sent_at: string | null;
  eta_token: string | null;
  eta_expires_at: string | null;
  eta_date: string | null;
  eta_note: string | null;
  eta_updated_at: string | null;
  proof_upload_token: string | null;
  proof_upload_expires_at: string | null;
  status: FilmOrderStatus;
  re_proof_count: number;
  current_proof_round: number;
  ordered_at: string | null;
  receiving_registered_at: string | null;
  proof_registered_at: string | null;
  re_proof_requested_at: string | null;
  final_approved_at: string | null;
  customer_design_status: CustomerDesignStatus;
  customer_design_requested_at: string | null;
  customer_design_received_at: string | null;
  customer_design_confirmed_at: string | null;
  customer_design_correction_count: number;
  customer_design_correction_reason: string;
  customer_proof_status: CustomerProofStatus;
  customer_proof_requested_at: string | null;
  customer_proof_approved_at: string | null;
  customer_proof_correction_count: number;
  customer_proof_correction_reason: string;
  supplier_approval_status: "pending" | "approved" | "legacy_exempt";
  supplier_approval_at: string | null;
  supplier_approval_by: string;
  supplier_approval_note: string;
  buyer_approval_status: "pending" | "approved";
  buyer_approval_at: string | null;
  buyer_approval_by: string;
  supplier_order_note: string;
  purchase_order_json: string;
  notes: string;
  sample_bulk_status: SampleBulkStatus;
  bulk_usage_reference_ml: string;
  sample_requested_ml: string | null;
  sample_received_ml: string | null;
  sample_adjusted_ml: string | null;
  sample_bulk_adjustment_count: number;
  sample_bulk_recipient_name: string;
  sample_bulk_recipient_postal_code: string;
  sample_bulk_recipient_address: string;
  sample_bulk_requested_at: string | null;
  sample_bulk_received_at: string | null;
  sample_bulk_confirmed_at: string | null;
  sample_bulk_adjustment_requested_at: string | null;
  sample_bulk_request_note: string;
  sample_bulk_receive_note: string;
  sample_bulk_adjustment_reason: string;
  created_at: string;
  updated_at: string;
  created_by_email: string;
  updated_by_email: string;
}

export {
  FILM_ORDER_STATUSES,
  filmOrderStatusLabels,
  FILM_RECEIVING_FOLDER_URL,
  FILM_PROOF_FOLDER_URL,
  buildFilmOrderFileName,
} from "./film-order-shared";
export type {
  FilmOrderStatus,
  FilmOrderFileCategory,
  FilmOrderFileRecord,
  FilmOrderEventRecord,
  FilmOrder,
  FilmOrderView,
} from "./film-order-shared";


import {
  buildFilmOrderFileName,
  FILM_PROOF_FOLDER_URL,
  FILM_RECEIVING_FOLDER_URL,
  type FilmOrder,
  type FilmOrderFileCategory,
  type FilmOrderFileRecord,
  type FilmOrderEventRecord,
  type FilmOrderStatus,
  type FilmOrderView,
  type ShipToDestinationEntry,
} from "./film-order-shared";

export type FilmOrderAction =
  | "mark-ordered"
  | "set-supplier"
  | "select-film-maker"
  | "register-receiving"
  | "send-proof-notice"
  | "register-proof"
  | "approve"
  | "request-re-proof"
  | "update-supplier-order-note"
  | "preview-supplier-po"
  | "send-po"
  | "confirm-film-receipt"
  | "resend-receiving-notice"
  | "register-receiving-extra"
  | "rotate-supplier-proof-token"
  | "request-customer-design-upload"
  | "confirm-customer-design"
  | "request-customer-design-correction"
  | "set-customer-design-not-required"
  | "send-customer-proof-review"
  | "record-customer-proof-approval"
  | "request-ship-to-registration"
  | "register-ship-to"
  | "confirm-ship-to"
  | "remove-ship-to-destination"
  | "save-production-plan"
  | "confirm-production-plan"
  | "request-production-plan"
  | "resend-supplier-links"
  | "update-eta"
  | "report-shipment"
  | "report-delivery"
  | "request-ship-to-registration"
  | "ship-to-registered"
  | "request-customer-design-upload"
  | "request-customer-design-correction"
  | "customer-design-received"
  | "production-plan-request"
  | "customer-proof-decision";

let schemaReady: Promise<SqlClient> | null = null;

const FILM_MAKERS_TABLE = `
  CREATE TABLE IF NOT EXISTS film_makers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    maker_code TEXT NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL,
    language TEXT NOT NULL CHECK(language IN ('ja','ko')),
    print_method TEXT NOT NULL CHECK(print_method IN ('gravure','digital')),
    procurement_route TEXT NOT NULL CHECK(procurement_route IN ('K','Y')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL DEFAULT '',
    updated_by_email TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_film_makers_route_print_active
    ON film_makers(procurement_route, print_method, is_active);
`;

const FILM_ORDER_MAIL_TABLES = `
  CREATE TABLE IF NOT EXISTS film_order_mail_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    dispatch_group_id TEXT NOT NULL,
    workflow_key TEXT NOT NULL,
    audience TEXT NOT NULL CHECK(audience IN ('maker','seven','kanei','customer')),
    language TEXT NOT NULL CHECK(language IN ('ja','ko')),
    template_key TEXT NOT NULL,
    template_identity_json TEXT NOT NULL,
    sender_identity TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    intended_to TEXT NOT NULL,
    cc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    links_json TEXT NOT NULL DEFAULT '[]',
    attachments_json TEXT NOT NULL DEFAULT '[]',
    canonical_envelope_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    envelope_status TEXT NOT NULL DEFAULT 'draft' CHECK(envelope_status IN ('draft','composed','skipped','superseded')),
    requested_by_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_film_mail_outbox_group_envelope
    ON film_order_mail_outbox(dispatch_group_id, workflow_key, audience);
  CREATE INDEX IF NOT EXISTS idx_film_mail_outbox_order_created
    ON film_order_mail_outbox(order_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_film_mail_outbox_order_workflow_status
    ON film_order_mail_outbox(order_id, workflow_key, envelope_status);
  CREATE INDEX IF NOT EXISTS idx_film_mail_outbox_group_audience
    ON film_order_mail_outbox(dispatch_group_id, audience);
  CREATE TABLE IF NOT EXISTS film_order_mail_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outbox_id INTEGER NOT NULL REFERENCES film_order_mail_outbox(id) ON DELETE CASCADE,
    attempt_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('sending','sent','failed','unknown','retry_required','skipped')),
    requested_by_email TEXT NOT NULL DEFAULT '',
    intended_to TEXT NOT NULL,
    actual_to TEXT,
    recipient_overridden BOOLEAN NOT NULL DEFAULT FALSE,
    smtp_message_id TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    attempt_started_at TEXT NOT NULL,
    attempt_finished_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_film_mail_attempt_count
    ON film_order_mail_attempts(outbox_id, attempt_count);
  CREATE INDEX IF NOT EXISTS idx_film_mail_attempt_outbox_status
    ON film_order_mail_attempts(outbox_id, status, attempt_count);
  CREATE INDEX IF NOT EXISTS idx_film_mail_attempt_sending_recovery
    ON film_order_mail_attempts(status, attempt_started_at);
`;

const BASE_SCHEMA = `
  ${FILM_MAKERS_TABLE}
  CREATE TABLE IF NOT EXISTS film_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    quotation_id INTEGER NOT NULL REFERENCES quotations(id),
    quotation_number TEXT NOT NULL,
    customer_code TEXT NOT NULL DEFAULT '',
    product_name TEXT NOT NULL DEFAULT '',
    customer_name TEXT NOT NULL DEFAULT '',
    printing_method TEXT NOT NULL DEFAULT '',
    procurement_route TEXT NOT NULL DEFAULT '',
    film_composition TEXT NOT NULL DEFAULT '',
    order_length_m TEXT NOT NULL DEFAULT '',
    web_width_mm TEXT NOT NULL DEFAULT '',
    pouch_quantity TEXT NOT NULL DEFAULT '',
    film_maker_id INTEGER REFERENCES film_makers(id),
    film_maker_snapshot_json TEXT,
    legacy_supplier_match_json TEXT,
    supplier_resolution TEXT NOT NULL DEFAULT 'legacy_unresolved' CHECK(supplier_resolution IN ('legacy_unresolved','master_selected','legacy_exempt')),
    supplier_name TEXT NOT NULL DEFAULT '',
    supplier_email TEXT NOT NULL DEFAULT '',
    seven_contact_email TEXT NOT NULL DEFAULT '',
    buyer_domain TEXT NOT NULL DEFAULT '',
    po_sent_at TEXT,
    eta_token TEXT,
    eta_expires_at TEXT,
    eta_date TEXT,
    eta_note TEXT,
    eta_updated_at TEXT,
    film_shipped_on TEXT,
    film_shipped_at TEXT,
    film_carrier TEXT NOT NULL DEFAULT '',
    film_tracking_number TEXT NOT NULL DEFAULT '',
    film_shipment_note TEXT NOT NULL DEFAULT '',
    film_delivery_document_name TEXT NOT NULL DEFAULT '',
    film_delivery_document_url TEXT NOT NULL DEFAULT '',
    film_delivery_documents_json TEXT NOT NULL DEFAULT '[]',
    film_delivered_on TEXT,
    film_delivered_at TEXT,
    film_delivery_note TEXT NOT NULL DEFAULT '',
    film_received_at TEXT,
    film_received_note TEXT NOT NULL DEFAULT '',
    film_received_by_email TEXT NOT NULL DEFAULT '',
    delivery_note_draft_json TEXT NOT NULL DEFAULT '{}',
    delivery_note_updated_at TEXT,
    delivery_note_updated_by TEXT NOT NULL DEFAULT '',
    ship_to_destination_id BIGINT,
    ship_to_status TEXT NOT NULL DEFAULT 'not_provided' CHECK(ship_to_status IN ('not_provided','registered','confirmed')),
    ship_to_label TEXT NOT NULL DEFAULT '',
    ship_to_company_name TEXT NOT NULL DEFAULT '',
    ship_to_department TEXT NOT NULL DEFAULT '',
    ship_to_contact_name TEXT NOT NULL DEFAULT '',
    ship_to_postal_code TEXT NOT NULL DEFAULT '',
    ship_to_address TEXT NOT NULL DEFAULT '',
    ship_to_building TEXT NOT NULL DEFAULT '',
    ship_to_phone TEXT NOT NULL DEFAULT '',
    ship_to_email TEXT NOT NULL DEFAULT '',
    ship_to_note TEXT NOT NULL DEFAULT '',
    ship_to_requested_at TEXT,
    ship_to_requested_by TEXT NOT NULL DEFAULT '',
    ship_to_registered_at TEXT,
    ship_to_registered_by TEXT NOT NULL DEFAULT '',
    ship_to_saved_to_master BOOLEAN NOT NULL DEFAULT FALSE,
    ship_to_confirmed_at TEXT,
    ship_to_confirmed_by TEXT NOT NULL DEFAULT '',
    production_plan_status TEXT NOT NULL DEFAULT 'not_set' CHECK(production_plan_status IN ('not_set','tentative','confirmed','adjusted')),
    production_plan_start_date TEXT,
    production_plan_end_date TEXT,
    production_plan_note TEXT NOT NULL DEFAULT '',
    production_plan_updated_at TEXT,
    production_plan_updated_by TEXT NOT NULL DEFAULT '',
    proof_upload_token TEXT,
    proof_upload_expires_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','ordered','receiving_registered','proof_registered','re_proof_requested','final_approved')),
    customer_design_status TEXT NOT NULL DEFAULT 'pending' CHECK(customer_design_status IN ('pending','requested','received','correction_requested','confirmed','not_required','legacy_exempt')),
    customer_design_requested_at TEXT,
    customer_design_received_at TEXT,
    customer_design_confirmed_at TEXT,
    customer_design_correction_count INTEGER NOT NULL DEFAULT 0,
    customer_design_correction_reason TEXT NOT NULL DEFAULT '',
    customer_proof_status TEXT NOT NULL DEFAULT 'pending' CHECK(customer_proof_status IN ('pending','requested','approved','correction_requested','legacy_exempt')),
    customer_proof_requested_at TEXT,
    customer_proof_approved_at TEXT,
    customer_proof_correction_count INTEGER NOT NULL DEFAULT 0,
    customer_proof_correction_reason TEXT NOT NULL DEFAULT '',
    current_proof_round INTEGER NOT NULL DEFAULT 1,
    supplier_approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(supplier_approval_status IN ('pending','approved','legacy_exempt')),
    supplier_approval_at TEXT,
    supplier_approval_by TEXT NOT NULL DEFAULT '',
    supplier_approval_note TEXT NOT NULL DEFAULT '',
    buyer_approval_status TEXT NOT NULL DEFAULT 'pending' CHECK(buyer_approval_status IN ('pending','approved')),
    buyer_approval_at TEXT,
    buyer_approval_by TEXT NOT NULL DEFAULT '',
    supplier_order_note TEXT NOT NULL DEFAULT '',
    re_proof_count INTEGER NOT NULL DEFAULT 0,
    ordered_at TEXT,
    receiving_registered_at TEXT,
    proof_registered_at TEXT,
    re_proof_requested_at TEXT,
    final_approved_at TEXT,
    purchase_order_json TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    sample_bulk_status TEXT NOT NULL DEFAULT 'pending' CHECK(sample_bulk_status IN ('not_required','pending','requested','received','confirmed','adjustment_requested')),
    bulk_usage_reference_ml TEXT NOT NULL DEFAULT '0',
    sample_requested_ml TEXT,
    sample_received_ml TEXT,
    sample_adjusted_ml TEXT,
    sample_bulk_adjustment_count INTEGER NOT NULL DEFAULT 0,
    sample_bulk_recipient_name TEXT NOT NULL DEFAULT '株式会社セブン化学 責任技術者：福井　健二',
    sample_bulk_recipient_postal_code TEXT NOT NULL DEFAULT '〒582-0017',
    sample_bulk_recipient_address TEXT NOT NULL DEFAULT '大阪府柏原市太平寺1丁目12番1号',
    sample_bulk_requested_at TEXT,
    sample_bulk_received_at TEXT,
    sample_bulk_confirmed_at TEXT,
    sample_bulk_adjustment_requested_at TEXT,
    sample_bulk_request_note TEXT NOT NULL DEFAULT '',
    sample_bulk_receive_note TEXT NOT NULL DEFAULT '',
    sample_bulk_adjustment_reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL DEFAULT '',
    updated_by_email TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS film_order_external_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    film_order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po','customer_ship_to','maker_customer_design','maker_eta')),
    token_hash TEXT NOT NULL UNIQUE,
    token_state TEXT NOT NULL DEFAULT 'active' CHECK(token_state IN ('staged','active','revoked')),
    dispatch_group_id TEXT,
    audience_email TEXT,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    last_used_ip_hash TEXT,
    created_by_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT film_order_external_token_state_consistency CHECK((token_state='revoked')=(revoked_at IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS idx_film_orders_status ON film_orders(status);
  CREATE INDEX IF NOT EXISTS idx_film_orders_quotation ON film_orders(quotation_id);
  CREATE TABLE IF NOT EXISTS film_order_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN ('customer_design','receiving','proof','final')),
    file_name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT '',
    uploaded_by_email TEXT NOT NULL DEFAULT '',
    file_size_bytes INTEGER,
    content_type TEXT,
    checksum TEXT,
    checksum_algorithm TEXT,
    drive_file_id TEXT,
    uploaded_via TEXT,
    client_ip_hash TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_film_order_files_order ON film_order_files(order_id);
  CREATE TABLE IF NOT EXISTS film_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    actor_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_film_order_events_order ON film_order_events(order_id);
  CREATE TABLE IF NOT EXISTS film_order_ship_to_destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
    destination_id BIGINT,
    position INTEGER NOT NULL DEFAULT 0,
    label TEXT NOT NULL DEFAULT '',
    company_name TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    contact_name TEXT NOT NULL DEFAULT '',
    postal_code TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    building TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    registered_by TEXT NOT NULL DEFAULT '',
    confirmed_at TEXT,
    confirmed_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_film_order_ship_to_destinations_order
    ON film_order_ship_to_destinations(order_id, position, id);
  ${FILM_ORDER_MAIL_TABLES}
`;

const POSTGRES_SCHEMA = BASE_SCHEMA.replaceAll(
  "INTEGER PRIMARY KEY AUTOINCREMENT",
  "INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
);

const EXTERNAL_TOKEN_PURPOSES = [
  "supplier_proof",
  "customer_design",
  "customer_proof_review",
  "supplier_po",
  "customer_ship_to",
  "maker_customer_design",
  "maker_eta",
] as const;

export type ExternalTokenPurpose = typeof EXTERNAL_TOKEN_PURPOSES[number];

const PUBLIC_PROOF_EXTENSIONS = [".ai", ".pdf"] as const;
const PUBLIC_PROOF_MAX_BYTES = 15 * 1024 * 1024;

export interface ExternalTokenRow {
  id: number;
  film_order_id: number;
  purpose: ExternalTokenPurpose;
  token_hash: string;
  token_state: "staged" | "active" | "revoked";
  audience_email: string | null;
  dispatch_group_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  last_used_ip_hash: string | null;
  created_by_email: string;
  created_at: string;
  updated_at: string;
}

export interface IssuedExternalToken {
  token: string;
  expiresAt: Date;
}

function externalTokenSecret(): string {
  const secret = process.env.FILM_EXTERNAL_TOKEN_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("film_external_token_secret_required");
  }
  return secret;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signExternalToken(orderId: number, purpose: ExternalTokenPurpose, expiresAt: number, nonce: string): string {
  return createHmac("sha256", `${externalTokenSecret()}:film-external-token`)
    .update(`${orderId}.${purpose}.${expiresAt}.${nonce}`)
    .digest("base64url");
}

export function filmExternalTokenForTest(orderId: number, purpose: ExternalTokenPurpose, expiresAtMs: number, nonce: string): string {
  return `${orderId}.${purpose}.${expiresAtMs}.${nonce}.${signExternalToken(orderId, purpose, expiresAtMs, nonce)}`;
}

export function filmExternalTokenHashForTest(rawToken: string): string {
  return sha256(rawToken);
}

export async function issueStagedFilmOrderExternalToken(
  db: SqlClient,
  orderId: number,
  purpose: ExternalTokenPurpose,
  actorEmail: string,
  options: {
    audienceEmail?: string | null;
    dispatchGroupId: string;
    ttlDays?: number;
  },
): Promise<IssuedExternalToken & { tokenHash: string }> {
  const expiresAtMs = Date.now() + (options.ttlDays ?? 30) * 24 * 60 * 60 * 1000;
  const nonce = randomBytes(18).toString("base64url");
  const rawToken = filmExternalTokenForTest(orderId, purpose, expiresAtMs, nonce);
  const tokenHash = filmExternalTokenHashForTest(rawToken);
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO film_order_external_tokens (
      film_order_id,purpose,token_state,token_hash,dispatch_group_id,audience_email,expires_at,
      created_by_email,created_at,updated_at
    ) VALUES (?,?,'staged',?,?,?,?,?,?,?)
  `, [
    orderId,
    purpose,
    tokenHash,
    options.dispatchGroupId,
    options.audienceEmail?.trim() || null,
    new Date(expiresAtMs).toISOString(),
    actorEmail,
    now,
    now,
  ]);
  return { token: rawToken, expiresAt: new Date(expiresAtMs), tokenHash };
}

export async function promoteStagedFilmOrderExternalTokens(
  tx: SqlClient,
  orderId: number,
  tokenHashes: readonly string[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const tokenHash of tokenHashes) {
    await tx.run(`
      UPDATE film_order_external_tokens
      SET token_state='revoked', revoked_at=?, updated_at=?
      WHERE film_order_id=? AND purpose=(
        SELECT purpose FROM film_order_external_tokens WHERE film_order_id=? AND token_hash=?
      ) AND token_state='active'
    `, [now, now, orderId, orderId, tokenHash]);
    const result = await tx.run(`
      UPDATE film_order_external_tokens
      SET token_state='active', updated_at=?
      WHERE film_order_id=? AND token_hash=? AND token_state='staged'
        AND revoked_at IS NULL AND expires_at>?
    `, [now, orderId, tokenHash, now]);
    if (result.changes !== 1) throw new Error("film_order_staged_token_invalid");
  }
}

export async function revokeStagedFilmOrderExternalTokens(
  tx: SqlClient,
  orderId: number,
  tokenHashes: readonly string[],
): Promise<void> {
  const now = new Date().toISOString();
  for (const tokenHash of tokenHashes) {
    await tx.run(`
      UPDATE film_order_external_tokens
      SET token_state='revoked', revoked_at=?, updated_at=?
      WHERE film_order_id=? AND token_hash=? AND token_state='staged'
    `, [now, now, orderId, tokenHash]);
  }
}

function parseExternalToken(raw: string, expectedPurpose: ExternalTokenPurpose): { orderId: number; expiresAt: number } | null {
  const parts = raw.split(".");
  if (parts.length !== 5) return null;
  const orderId = Number(parts[0]);
  const purpose = parts[1];
  const expiresAt = Number(parts[2]);
  const nonce = parts[3];
  const signature = parts[4];
  if (!Number.isInteger(orderId) || orderId <= 0) return null;
  if (purpose !== expectedPurpose) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  if (!nonce || !signature) return null;
  const expected = signExternalToken(orderId, purpose, expiresAt, nonce);
  if (!safeEqualStrings(signature, expected)) return null;
  return { orderId, expiresAt };
}

function legacyEtaOrderId(raw: string): number | null {
  // The old ETA format had no purpose segment. It is read-only compatibility for
  // rows migrated into film_order_external_tokens; newly issued links are 5-part.
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  return verifyEtaToken(raw);
}

export function externalClientIpHash(request: {
  headers: { get(name: string): string | null };
}): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip")?.trim();
  if (!ip) return null;
  return createHmac("sha256", `${externalTokenSecret()}:external-client`).update(ip).digest("hex");
}

export function assertSupplierProofUploadPolicy(
  order: FilmOrder,
  fileName: string,
  sizeBytes?: number,
): void {
  if (order.status !== "receiving_registered" && order.status !== "re_proof_requested") {
    throw new Error("invalid_status_transition");
  }
  if (!validFileName(fileName) || !fileName.includes(order.order_number)) {
    throw new Error("invalid_file_name");
  }
  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (!fileName.includes(".") || !PUBLIC_PROOF_EXTENSIONS.includes(extension as typeof PUBLIC_PROOF_EXTENSIONS[number])) {
    throw new Error("unsupported_file_type");
  }
  if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > PUBLIC_PROOF_MAX_BYTES)) {
    throw new Error("file_too_large");
  }
}

export function proofUploadMaxBytes(): number {
  return PUBLIC_PROOF_MAX_BYTES;
}

const CUSTOMER_DESIGN_EXTENSIONS = [".ai", ".pdf"] as const;

export function customerDesignMaxBytes(): number {
  const parsed = Number(process.env.CUSTOMER_DESIGN_MAX_MB ?? 100);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed * 1024 * 1024) : 100 * 1024 * 1024;
}

export const DELIVERY_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;

export function assertDeliveryDocumentPolicy(
  order: FilmOrder,
  fileName: string,
  sizeBytes?: number,
): void {
  assertFilmOrderDeliveryDocumentGuard({
    status: order.status,
    poSentAt: order.po_sent_at,
    shippedAt: order.delivery.shippedAt,
    deliveredAt: order.delivery.deliveredAt,
  });
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  if (extension !== ".pdf") throw new Error("invalid_delivery_document_type");
  if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > DELIVERY_DOCUMENT_MAX_BYTES)) {
    throw new Error("file_too_large");
  }
}

export function deliveryDocumentFileName(
  order: FilmOrder,
  shipmentDate: string,
  originalFileName: string,
  uploadId: string,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(shipmentDate)) throw new Error("invalid_delivery_date");
  if (!/^[A-Za-z0-9_-]{12,64}$/u.test(uploadId)) throw new Error("invalid_upload_request");
  const withoutExtension = originalFileName.includes(".")
    ? originalFileName.slice(0, originalFileName.lastIndexOf("."))
    : originalFileName;
  const base = withoutExtension
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g, "_")
    .slice(0, 80) || "delivery_note";
  return `${order.order_number}_delivery_${shipmentDate}_${uploadId}_${base}.pdf`;
}

function customerDesignAllowed(status: CustomerDesignStatus): boolean {
  return status === "requested" || status === "received" || status === "correction_requested";
}

export function assertCustomerDesignUploadPolicy(
  order: FilmOrder,
  fileName: string,
  sizeBytes?: number,
  hasAiFile = false,
): void {
  const normalized = validFileName(fileName);
  if (!normalized) throw new Error("invalid_file_name");
  const extension = normalized.slice(normalized.lastIndexOf(".")).toLowerCase();
  if (!normalized.includes(".") || !CUSTOMER_DESIGN_EXTENSIONS.includes(extension as typeof CUSTOMER_DESIGN_EXTENSIONS[number])) {
    throw new Error("unsupported_file_type");
  }
  if (extension === ".ai") {
    if (!["requested","received","correction_requested"].includes(order.customerDesign.status)) {
      throw new Error("invalid_status_transition");
    }
  } else {
    if (!hasAiFile) throw new Error("ai_file_required");
    if (!customerDesignAllowed(order.customerDesign.status)) throw new Error("invalid_status_transition");
  }
  const max = customerDesignMaxBytes();
  if (sizeBytes != null && (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > max)) {
    throw new Error("file_too_large");
  }
}

function safeDesignBaseName(fileName: string): string {
  const raw = validFileName(fileName) ?? "design";
  const withoutExtension = raw.includes(".") ? raw.slice(0, raw.lastIndexOf(".")) : raw;
  return withoutExtension.replace(/[\\/:*?"<>|\r\n\t]/g, "_").replace(/\s+/g, "_").slice(0, 80) || "design";
}

function customerDesignFileName(order: FilmOrder, originalFileName: string): string {
  const version = 0; // The public complete route passes the next version.
  const extension = originalFileName.slice(originalFileName.lastIndexOf(".")).toLowerCase();
  return `${order.order_number}_design_v${version}_${safeDesignBaseName(originalFileName)}${extension}`;
}

async function issueExternalToken(
  db: SqlClient,
  orderId: number,
  purpose: ExternalTokenPurpose,
  actorEmail: string,
  options: { audienceEmail?: string | null; ttlDays?: number } = {},
): Promise<IssuedExternalToken> {
  const expiresAtMs = Date.now() + (options.ttlDays ?? 30) * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(expiresAtMs);
  const nonce = randomBytes(18).toString("base64url");
  const token = `${orderId}.${purpose}.${expiresAtMs}.${nonce}.${signExternalToken(orderId, purpose, expiresAtMs, nonce)}`;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE film_order_external_tokens
      SET revoked_at = ?, updated_at = ?
      WHERE film_order_id = ? AND purpose = ? AND revoked_at IS NULL
    `, [now, now, orderId, purpose]);
    await tx.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,audience_email,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)
    `, [
      orderId,
      purpose,
      sha256(token),
      options.audienceEmail?.trim() || null,
      expiresAt.toISOString(),
      actorEmail,
      now,
      now,
    ]);
  });
  await addEvent(db, orderId, "token", `外部トークンを発行/更新: ${purpose}`, actorEmail);
  return { token, expiresAt };
}

async function resolveExternalToken(
  db: SqlClient,
  rawToken: string,
  expectedPurpose: ExternalTokenPurpose,
): Promise<{ orderId: number; token: ExternalTokenRow } | null> {
  const parsed = expectedPurpose === "maker_eta"
    ? (() => {
      const typed = parseExternalToken(rawToken, expectedPurpose);
      return typed ?? (() => {
        const orderId = legacyEtaOrderId(rawToken);
        return orderId ? { orderId, expiresAt: Number.MAX_SAFE_INTEGER } : null;
      })();
    })()
    : parseExternalToken(rawToken, expectedPurpose);
  if (!parsed) return null;
  const row = await db.get<ExternalTokenRow>(
    "SELECT * FROM film_order_external_tokens WHERE token_hash = ? AND purpose = ? AND film_order_id = ?",
    [sha256(rawToken), expectedPurpose, parsed.orderId],
  );
  if (!row || row.token_state !== "active" || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { orderId: parsed.orderId, token: row };
}

export async function markFilmOrderExternalTokenUseForLifecycle(
  db: SqlClient,
  token: ExternalTokenRow,
  request?: { headers: { get(name: string): string | null } },
): Promise<void> {
  const now = new Date().toISOString();
  const ipHash = request ? externalClientIpHash(request) : null;
  await db.run(
    "UPDATE film_order_external_tokens SET last_used_at = ?, last_used_ip_hash = COALESCE(?, last_used_ip_hash), updated_at = ? WHERE id = ?",
    [now, ipHash, now, token.id],
  );
}

async function recordExternalTokenEvent(
  request: { headers: { get(name: string): string | null } } | undefined,
  rawToken: string,
  expectedPurpose: ExternalTokenPurpose,
  outcome: "allowed" | "denied",
  detail: string,
): Promise<void> {
  try {
    const db = await getDatabase();
    const resolved = await resolveExternalToken(db, rawToken, expectedPurpose);
    if (!resolved) return;
    await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
    await addEvent(
      db,
      resolved.orderId,
      "token_access",
      `${expectedPurpose} ${outcome}: ${detail}`,
      `external:${expectedPurpose}`,
    );
  } catch {
    // アクセス記録失敗でファイル応答を壊さない。
  }
}

async function migrateFilmOrderFileCategory(db: SqlClient): Promise<void> {
  if (db.dialect === "sqlite") {
    const row = await db.get<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'film_order_files'"
    );
    if (!row?.sql || row.sql.includes("'customer_design'")) return;
    await db.exec(`
      CREATE TABLE film_order_files_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK(category IN ('customer_design','receiving','proof','final')),
        file_name TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        uploaded_by_email TEXT NOT NULL DEFAULT '',
        file_size_bytes INTEGER,
        content_type TEXT,
        checksum TEXT,
        checksum_algorithm TEXT,
        drive_file_id TEXT,
        uploaded_via TEXT,
        client_ip_hash TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO film_order_files_new (
        id,order_id,category,file_name,url,version,note,uploaded_by_email,
        file_size_bytes,content_type,checksum,checksum_algorithm,drive_file_id,
        uploaded_via,client_ip_hash,user_agent,created_at
      )
      SELECT id,order_id,category,file_name,url,version,note,uploaded_by_email,
             file_size_bytes,content_type,checksum,checksum_algorithm,drive_file_id,
             uploaded_via,client_ip_hash,user_agent,created_at
      FROM film_order_files;
      DROP TABLE film_order_files;
      ALTER TABLE film_order_files_new RENAME TO film_order_files;
      CREATE INDEX IF NOT EXISTS idx_film_order_files_order ON film_order_files(order_id);
    `);
    return;
  }

  await db.exec("ALTER TABLE film_order_files DROP CONSTRAINT IF EXISTS film_order_files_category_check");
  await db.exec("ALTER TABLE film_order_files ADD CONSTRAINT film_order_files_category_check CHECK(category IN ('customer_design','receiving','proof','final'))");
}

async function migrateExternalTokenPurposes(db: SqlClient): Promise<void> {
  if (db.dialect === "sqlite") {
    const row = await db.get<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'film_order_external_tokens'"
    );
    if (!row?.sql || row.sql.includes("'maker_eta'")) return;
    await db.exec(`
      DROP INDEX IF EXISTS idx_film_external_active_token;
      ALTER TABLE film_order_external_tokens RENAME TO film_order_external_tokens_legacy_purpose;
      CREATE TABLE film_order_external_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        film_order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po','customer_ship_to','maker_customer_design','maker_eta')),
        token_hash TEXT NOT NULL UNIQUE,
        token_state TEXT NOT NULL DEFAULT 'active' CHECK(token_state IN ('staged','active','revoked')),
        dispatch_group_id TEXT,
        audience_email TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        last_used_ip_hash TEXT,
        created_by_email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
  CREATE INDEX IF NOT EXISTS idx_film_external_order_purpose_state
    ON film_order_external_tokens(film_order_id, purpose, token_state);
      INSERT INTO film_order_external_tokens (
        id,film_order_id,purpose,token_hash,audience_email,expires_at,revoked_at,
        last_used_at,last_used_ip_hash,created_by_email,created_at,updated_at
      )
      SELECT id,film_order_id,purpose,token_hash,audience_email,expires_at,revoked_at,
             last_used_at,last_used_ip_hash,created_by_email,created_at,updated_at
      FROM film_order_external_tokens_legacy_purpose;
      DROP TABLE film_order_external_tokens_legacy_purpose;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_film_external_active_token
        ON film_order_external_tokens(film_order_id, purpose)
        WHERE revoked_at IS NULL AND token_state='active';
      CREATE INDEX IF NOT EXISTS idx_film_external_order_purpose_state
        ON film_order_external_tokens(film_order_id, purpose, token_state);
    `);
    return;
  }

  if (db.dialect === "postgres") {
    const invalidPurposes = await db.all<{ purpose: string }>(`
      SELECT DISTINCT purpose FROM film_order_external_tokens
      WHERE purpose NOT IN (
        'supplier_proof','customer_design','customer_proof_review','supplier_po','customer_ship_to','maker_customer_design','maker_eta'
      )
    `);
    if (invalidPurposes.length > 0) throw new Error("invalid_film_external_token_purpose");
  }
  await db.exec("ALTER TABLE film_order_external_tokens DROP CONSTRAINT IF EXISTS film_order_external_tokens_purpose_check");
  await db.exec(`
    UPDATE film_order_external_tokens
    SET token_state='revoked', revoked_at=COALESCE(revoked_at, updated_at, created_at)
    WHERE token_state='revoked' AND revoked_at IS NULL
  `);
  await db.exec(`
    ALTER TABLE film_order_external_tokens
    ADD CONSTRAINT film_order_external_tokens_purpose_check
    CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po','customer_ship_to','maker_customer_design','maker_eta'))
  `);
}

async function migrateExternalTokenStateConsistency(db: SqlClient): Promise<void> {
  if (db.dialect === "sqlite") {
    const row = await db.get<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='film_order_external_tokens'",
    );
    if (row?.sql?.includes("film_order_external_token_state_consistency")) return;
    await db.exec(`
      ALTER TABLE film_order_external_tokens RENAME TO film_order_external_tokens_legacy_state;
      CREATE TABLE film_order_external_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        film_order_id INTEGER NOT NULL REFERENCES film_orders(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK(purpose IN ('supplier_proof','customer_design','customer_proof_review','supplier_po','customer_ship_to','maker_customer_design','maker_eta')),
        token_hash TEXT NOT NULL UNIQUE,
        token_state TEXT NOT NULL DEFAULT 'active' CHECK(token_state IN ('staged','active','revoked')),
        dispatch_group_id TEXT,
        audience_email TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        last_used_ip_hash TEXT,
        created_by_email TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CONSTRAINT film_order_external_token_state_consistency CHECK((token_state='revoked')=(revoked_at IS NOT NULL))
      );
      INSERT INTO film_order_external_tokens (
        id,film_order_id,purpose,token_hash,token_state,dispatch_group_id,audience_email,expires_at,
        revoked_at,last_used_at,last_used_ip_hash,created_by_email,created_at,updated_at
      )
      SELECT id,film_order_id,purpose,token_hash,token_state,dispatch_group_id,audience_email,expires_at,
             revoked_at,last_used_at,last_used_ip_hash,created_by_email,created_at,updated_at
      FROM film_order_external_tokens_legacy_state;
      DROP TABLE film_order_external_tokens_legacy_state;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_film_external_active_token
        ON film_order_external_tokens(film_order_id, purpose)
        WHERE revoked_at IS NULL AND token_state='active';
    `);
    return;
  }

  await db.exec("ALTER TABLE film_order_external_tokens DROP CONSTRAINT IF EXISTS film_order_external_token_state_consistency");
  await db.exec(`
    ALTER TABLE film_order_external_tokens
    ADD CONSTRAINT film_order_external_token_state_consistency
    CHECK((token_state='revoked')=(revoked_at IS NOT NULL))
  `);
}

async function migrateExternalTokenLifecycle(db: SqlClient): Promise<void> {
  const columns = db.dialect === "postgres"
    ? await db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='film_order_external_tokens'"
    )
    : await db.all<{ name: string }>("PRAGMA table_info(film_order_external_tokens)");
  const columnNames = new Set(columns.map((row) => "column_name" in row ? row.column_name : row.name));
  if (!columnNames.has("token_state")) {
    await db.run("ALTER TABLE film_order_external_tokens ADD COLUMN token_state TEXT NOT NULL DEFAULT 'active'");
  }
  if (!columnNames.has("dispatch_group_id")) {
    await db.run("ALTER TABLE film_order_external_tokens ADD COLUMN dispatch_group_id TEXT");
  }

  // Normalize legacy rows before enforcing one active token. Expired active rows are
  // revoked; older active rotations keep only the newest row per order/purpose.
  await db.exec(`
    UPDATE film_order_external_tokens
    SET token_state='revoked', revoked_at=COALESCE(revoked_at, updated_at, created_at)
    WHERE revoked_at IS NOT NULL AND token_state <> 'revoked'
  `);
  await db.exec(`
    UPDATE film_order_external_tokens
    SET token_state='revoked', revoked_at=COALESCE(revoked_at, updated_at, created_at)
    WHERE token_state='revoked' AND revoked_at IS NULL
  `);
  await db.exec(`
    UPDATE film_order_external_tokens
    SET token_state='revoked', revoked_at=COALESCE(revoked_at, updated_at, created_at)
    WHERE token_state IN ('staged','active') AND revoked_at IS NOT NULL
  `);
  await db.run(`
    UPDATE film_order_external_tokens
    SET token_state='revoked', revoked_at=COALESCE(revoked_at, updated_at, created_at)
    WHERE token_state='active' AND expires_at <= ?
  `, [new Date().toISOString()]);
  await db.exec(`
    UPDATE film_order_external_tokens
    SET token_state='revoked', revoked_at=COALESCE(revoked_at, updated_at, created_at)
    WHERE token_state='active' AND revoked_at IS NULL
      AND id NOT IN (
        SELECT MAX(id)
        FROM film_order_external_tokens
        WHERE film_order_id=film_order_external_tokens.film_order_id
          AND purpose=film_order_external_tokens.purpose
          AND token_state='active'
          AND revoked_at IS NULL
        GROUP BY film_order_id, purpose
      )
  `);

  await db.exec(`
    DROP INDEX IF EXISTS idx_film_external_active_token;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_film_external_active_token
      ON film_order_external_tokens(film_order_id, purpose)
      WHERE revoked_at IS NULL AND token_state='active'
  `);
  await migrateExternalTokenStateConsistency(db);
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_film_external_order_purpose_state
      ON film_order_external_tokens(film_order_id, purpose, token_state);
    CREATE INDEX IF NOT EXISTS idx_film_external_dispatch_state
      ON film_order_external_tokens(dispatch_group_id, token_state)
  `);
  await migrateExternalTokenDispatchAssociations(db);
}

async function migrateExternalTokenDispatchAssociations(db: SqlClient): Promise<void> {
  const staged = await db.all<{ id: number; film_order_id: number; token_hash: string }>(`
    SELECT id,film_order_id,token_hash
    FROM film_order_external_tokens
    WHERE token_state='staged' AND dispatch_group_id IS NULL
  `);
  if (staged.length === 0) return;
  const envelopes = await db.all<{
    order_id: number;
    dispatch_group_id: string;
    links_json: string;
  }>(
    "SELECT order_id,dispatch_group_id,links_json FROM film_order_mail_outbox ORDER BY created_at DESC, id DESC",
  );
  const associations = new Map<string, string>();
  for (const envelope of envelopes) {
    let links: unknown;
    try {
      links = JSON.parse(envelope.links_json);
    } catch {
      continue;
    }
    if (!Array.isArray(links)) continue;
    for (const link of links) {
      const url = link && typeof link === "object" && typeof (link as { url?: unknown }).url === "string"
        ? (link as { url: string }).url
        : "";
      const typed = url.match(/\/(?:upload|purchase-order|proof-review|ship-to|design-upload|eta)\/([^/?#]+)/u);
      if (!typed?.[1]) continue;
      let rawToken: string;
      try {
        rawToken = decodeURIComponent(typed[1]);
      } catch {
        continue;
      }
      associations.set(sha256(rawToken), envelope.dispatch_group_id);
    }
  }
  for (const token of staged) {
    const dispatchGroupId = associations.get(token.token_hash)
      ?? (envelopes.some((envelope) => envelope.order_id === token.film_order_id) ? "legacy-unassociated" : "orphan-staged");
    await db.run(
      "UPDATE film_order_external_tokens SET dispatch_group_id=? WHERE id=? AND token_state='staged' AND dispatch_group_id IS NULL",
      [dispatchGroupId, token.id],
    );
  }
}

async function migrateLegacyProofTokens(db: SqlClient): Promise<void> {
  const rows = await db.all<{ id: number; proof_upload_token: string | null; proof_upload_expires_at: string | null }>(
    "SELECT id, proof_upload_token, proof_upload_expires_at FROM film_orders WHERE proof_upload_token IS NOT NULL AND proof_upload_token != ''",
  );
  const now = Date.now();
  for (const row of rows) {
    const raw = row.proof_upload_token;
    if (!raw) continue;
    const expires = row.proof_upload_expires_at ? new Date(row.proof_upload_expires_at).getTime() : 0;
    if (!Number.isFinite(expires) || expires <= now) {
      await db.run(
        "UPDATE film_orders SET proof_upload_token = NULL, proof_upload_expires_at = NULL WHERE id = ?",
        [row.id],
      );
      continue;
    }
    const existing = await db.get<ExternalTokenRow>(
      "SELECT id FROM film_order_external_tokens WHERE token_hash = ? AND purpose = 'supplier_proof'",
      [sha256(raw)],
    );
    await db.transaction(async (tx) => {
      if (!existing) {
        await tx.run(`
          INSERT INTO film_order_external_tokens (
            film_order_id,purpose,token_hash,expires_at,created_by_email,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?)
        `, [row.id, "supplier_proof", sha256(raw), new Date(expires).toISOString(), "legacy-migration", now, now]);
      }
      await tx.run(
        "UPDATE film_orders SET proof_upload_token = NULL, proof_upload_expires_at = NULL WHERE id = ?",
        [row.id],
      );
    });
  }
}

async function migrateLegacyEtaTokens(db: SqlClient): Promise<void> {
  const rows = await db.all<{
    id: number;
    supplier_email: string;
    eta_token: string | null;
    eta_expires_at: string | null;
  }>(
    "SELECT id, supplier_email, eta_token, eta_expires_at FROM film_orders WHERE eta_token IS NOT NULL AND eta_token != ''",
  );
  const now = Date.now();
  for (const row of rows) {
    const raw = row.eta_token;
    if (!raw) continue;
    const orderId = verifyEtaToken(raw);
    const expiresRaw = row.eta_expires_at ? new Date(row.eta_expires_at).getTime() : 0;
    if (orderId !== row.id || !Number.isFinite(expiresRaw) || expiresRaw <= now) {
      await db.run(
        "UPDATE film_orders SET eta_token=NULL, eta_expires_at=NULL WHERE id=? AND eta_token=?",
        [row.id, raw],
      );
      continue;
    }
    const tokenHash = sha256(raw);
    const existing = await db.get<{ id: number; token_state: ExternalTokenRow["token_state"] }>(
      "SELECT id,token_state FROM film_order_external_tokens WHERE token_hash=? AND purpose='maker_eta'",
      [tokenHash],
    );
    const active = await db.get<{ id: number }>(`
      SELECT id FROM film_order_external_tokens
      WHERE film_order_id=? AND purpose='maker_eta' AND token_state='active' AND revoked_at IS NULL
      ORDER BY id DESC LIMIT 1
    `, [row.id]);
    const expiresAt = new Date(expiresRaw).toISOString();
    await db.transaction(async (tx) => {
      if (!existing && !active) {
        await tx.run(`
          INSERT INTO film_order_external_tokens (
            film_order_id,purpose,token_hash,token_state,audience_email,expires_at,
            created_by_email,created_at,updated_at
          ) VALUES (?,?,?,'active',?,?,?,?,?)
        `, [
          row.id,
          "maker_eta",
          tokenHash,
          row.supplier_email.trim() || null,
          expiresAt,
          "legacy-migration",
          new Date(now).toISOString(),
          new Date(now).toISOString(),
        ]);
      }
    });
  }
}

export interface UploadFileMetadata {
  fileSizeBytes?: number | null;
  contentType?: string | null;
  checksum?: string | null;
  checksumAlgorithm?: string | null;
  driveFileId?: string | null;
  uploadedVia?: string | null;
  clientIpHash?: string | null;
  userAgent?: string | null;
}

const FILM_SCHEMA_VERSION = "2026-11-08-delivery-note-draft-1";

async function getDatabase(): Promise<SqlClient> {
  schemaReady ??= (async () => {
    const db = await getSqlClient("quotations");
    await db.exec(`
      CREATE TABLE IF NOT EXISTS film_order_schema_migrations (
        slot TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const marker = await db.get<{ version: string }>(
      "SELECT version FROM film_order_schema_migrations WHERE slot = ?",
      ["film_orders"],
    );
    // マーカーがある環境では、コールドスタート毎のDDL検査を省略する。
    if (marker?.version === FILM_SCHEMA_VERSION) {
      // デジタル案件は従来 purchaseOrder の route が空だったため、韓国調达ルートへ正規化する。
      await db.exec(`
        UPDATE film_orders
        SET procurement_route = 'K'
        WHERE procurement_route = ''
          AND printing_method = 'digital'
      `);
      await reconcileFilmOrderOwnership(db);
      return db;
    }
    await db.exec(db.dialect === "postgres" ? POSTGRES_SCHEMA : BASE_SCHEMA);
    // Cold starts have the database FK above. Existing SQLite tables cannot gain an FK
    // additively; enforce film_maker_id existence through selectFilmMakerForOrder and
    // the idx_film_orders_film_maker index. PostgreSQL also gains the same named FK below.
    const migrations: Array<[string, string]> = [
      ["film_makers", FILM_MAKERS_TABLE],
      ["film_order_mail_outbox", FILM_ORDER_MAIL_TABLES],
      ["film_order_mail_outbox_sender_email", "ALTER TABLE film_order_mail_outbox ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''"],
      ["film_order_mail_outbox_template_identity", "ALTER TABLE film_order_mail_outbox ADD COLUMN template_identity_json TEXT NOT NULL DEFAULT '{}'"],
      ["film_order_mail_outbox_canonical_envelope", "ALTER TABLE film_order_mail_outbox ADD COLUMN canonical_envelope_json TEXT NOT NULL DEFAULT '{}'"],
      ["film_orders_film_maker_id", "ALTER TABLE film_orders ADD COLUMN film_maker_id INTEGER"],
      ["film_orders_film_maker_snapshot", "ALTER TABLE film_orders ADD COLUMN film_maker_snapshot_json TEXT"],
      [
        "film_orders_supplier_resolution",
        "ALTER TABLE film_orders ADD COLUMN supplier_resolution TEXT NOT NULL DEFAULT 'legacy_unresolved' CHECK(supplier_resolution IN ('legacy_unresolved','master_selected','legacy_exempt'))",
      ],
      ["film_orders_legacy_supplier_match", "ALTER TABLE film_orders ADD COLUMN legacy_supplier_match_json TEXT"],
      ["film_orders_film_maker_index", "CREATE INDEX IF NOT EXISTS idx_film_orders_film_maker ON film_orders(film_maker_id)"],
      ["film_order_files", "ALTER TABLE film_order_files ADD COLUMN url TEXT NOT NULL DEFAULT ''"],
      ["film_orders_seven_contact", "ALTER TABLE film_orders ADD COLUMN seven_contact_email TEXT NOT NULL DEFAULT ''"],
      ["film_orders_po_sent", "ALTER TABLE film_orders ADD COLUMN po_sent_at TEXT"],
      ["film_orders_customer_code", "ALTER TABLE film_orders ADD COLUMN customer_code TEXT NOT NULL DEFAULT ''"],
      ["film_orders_current_proof_round", "ALTER TABLE film_orders ADD COLUMN current_proof_round INTEGER NOT NULL DEFAULT 1"],
      ["film_orders_eta_token", "ALTER TABLE film_orders ADD COLUMN eta_token TEXT"],
      ["film_orders_eta_expires", "ALTER TABLE film_orders ADD COLUMN eta_expires_at TEXT"],
      ["film_orders_eta_date", "ALTER TABLE film_orders ADD COLUMN eta_date TEXT"],
      ["film_orders_eta_note", "ALTER TABLE film_orders ADD COLUMN eta_note TEXT"],
      ["film_orders_eta_updated", "ALTER TABLE film_orders ADD COLUMN eta_updated_at TEXT"],
      ["film_orders_film_shipped_on", "ALTER TABLE film_orders ADD COLUMN film_shipped_on TEXT"],
      ["film_orders_film_shipped_at", "ALTER TABLE film_orders ADD COLUMN film_shipped_at TEXT"],
      ["film_orders_film_carrier", "ALTER TABLE film_orders ADD COLUMN film_carrier TEXT NOT NULL DEFAULT ''"],
      ["film_orders_film_tracking_number", "ALTER TABLE film_orders ADD COLUMN film_tracking_number TEXT NOT NULL DEFAULT ''"],
      ["film_orders_film_shipment_note", "ALTER TABLE film_orders ADD COLUMN film_shipment_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_film_delivery_document_name", "ALTER TABLE film_orders ADD COLUMN film_delivery_document_name TEXT NOT NULL DEFAULT ''"],
      ["film_orders_film_delivery_document_url", "ALTER TABLE film_orders ADD COLUMN film_delivery_document_url TEXT NOT NULL DEFAULT ''"],
      ["film_orders_film_delivery_documents_json", "ALTER TABLE film_orders ADD COLUMN film_delivery_documents_json TEXT NOT NULL DEFAULT '[]'"],
      ["film_orders_film_delivered_on", "ALTER TABLE film_orders ADD COLUMN film_delivered_on TEXT"],
      ["film_orders_film_delivered_at", "ALTER TABLE film_orders ADD COLUMN film_delivered_at TEXT"],
      ["film_orders_film_delivery_note", "ALTER TABLE film_orders ADD COLUMN film_delivery_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_film_received_at", "ALTER TABLE film_orders ADD COLUMN film_received_at TEXT"],
      ["film_orders_film_received_note", "ALTER TABLE film_orders ADD COLUMN film_received_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_film_received_by_email", "ALTER TABLE film_orders ADD COLUMN film_received_by_email TEXT NOT NULL DEFAULT ''"],
      ["film_orders_delivery_note_draft", "ALTER TABLE film_orders ADD COLUMN delivery_note_draft_json TEXT NOT NULL DEFAULT '{}'"],
      ["film_orders_delivery_note_updated_at", "ALTER TABLE film_orders ADD COLUMN delivery_note_updated_at TEXT"],
      ["film_orders_delivery_note_updated_by", "ALTER TABLE film_orders ADD COLUMN delivery_note_updated_by TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_destination_id", "ALTER TABLE film_orders ADD COLUMN ship_to_destination_id BIGINT"],
      ["film_orders_ship_to_status", "ALTER TABLE film_orders ADD COLUMN ship_to_status TEXT NOT NULL DEFAULT 'not_provided'"],
      ["film_orders_ship_to_label", "ALTER TABLE film_orders ADD COLUMN ship_to_label TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_company_name", "ALTER TABLE film_orders ADD COLUMN ship_to_company_name TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_department", "ALTER TABLE film_orders ADD COLUMN ship_to_department TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_contact_name", "ALTER TABLE film_orders ADD COLUMN ship_to_contact_name TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_postal_code", "ALTER TABLE film_orders ADD COLUMN ship_to_postal_code TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_address", "ALTER TABLE film_orders ADD COLUMN ship_to_address TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_building", "ALTER TABLE film_orders ADD COLUMN ship_to_building TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_phone", "ALTER TABLE film_orders ADD COLUMN ship_to_phone TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_email", "ALTER TABLE film_orders ADD COLUMN ship_to_email TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_note", "ALTER TABLE film_orders ADD COLUMN ship_to_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_requested_at", "ALTER TABLE film_orders ADD COLUMN ship_to_requested_at TEXT"],
      ["film_orders_ship_to_requested_by", "ALTER TABLE film_orders ADD COLUMN ship_to_requested_by TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_registered_at", "ALTER TABLE film_orders ADD COLUMN ship_to_registered_at TEXT"],
      ["film_orders_ship_to_registered_by", "ALTER TABLE film_orders ADD COLUMN ship_to_registered_by TEXT NOT NULL DEFAULT ''"],
      ["film_orders_ship_to_saved_to_master", "ALTER TABLE film_orders ADD COLUMN ship_to_saved_to_master BOOLEAN NOT NULL DEFAULT FALSE"],
      ["film_orders_ship_to_confirmed_at", "ALTER TABLE film_orders ADD COLUMN ship_to_confirmed_at TEXT"],
      ["film_orders_ship_to_confirmed_by", "ALTER TABLE film_orders ADD COLUMN ship_to_confirmed_by TEXT NOT NULL DEFAULT ''"],
      ["film_orders_production_plan_status", "ALTER TABLE film_orders ADD COLUMN production_plan_status TEXT NOT NULL DEFAULT 'not_set'"],
      ["film_orders_production_plan_start_date", "ALTER TABLE film_orders ADD COLUMN production_plan_start_date TEXT"],
      ["film_orders_production_plan_end_date", "ALTER TABLE film_orders ADD COLUMN production_plan_end_date TEXT"],
      ["film_orders_production_plan_note", "ALTER TABLE film_orders ADD COLUMN production_plan_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_production_plan_updated_at", "ALTER TABLE film_orders ADD COLUMN production_plan_updated_at TEXT"],
      ["film_orders_production_plan_updated_by", "ALTER TABLE film_orders ADD COLUMN production_plan_updated_by TEXT NOT NULL DEFAULT ''"],
      ["film_orders_proof_token", "ALTER TABLE film_orders ADD COLUMN proof_upload_token TEXT"],
      ["film_orders_proof_expires", "ALTER TABLE film_orders ADD COLUMN proof_upload_expires_at TEXT"],
      // 既存テーブル（buyer_domain 導入前）向け。新規テーブルでは重複エラーを無視する。
      ["film_orders_buyer_domain", "ALTER TABLE film_orders ADD COLUMN buyer_domain TEXT NOT NULL DEFAULT ''"],
      ["film_orders_sample_bulk_status", "ALTER TABLE film_orders ADD COLUMN sample_bulk_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_bulk_usage_reference", "ALTER TABLE film_orders ADD COLUMN bulk_usage_reference_ml TEXT NOT NULL DEFAULT '0'"],
      ["film_orders_sample_requested", "ALTER TABLE film_orders ADD COLUMN sample_requested_ml TEXT"],
      ["film_orders_sample_received", "ALTER TABLE film_orders ADD COLUMN sample_received_ml TEXT"],
      ["film_orders_sample_adjusted", "ALTER TABLE film_orders ADD COLUMN sample_adjusted_ml TEXT"],
      ["film_orders_sample_bulk_adjustment_count", "ALTER TABLE film_orders ADD COLUMN sample_bulk_adjustment_count INTEGER NOT NULL DEFAULT 0"],
      ["film_orders_sample_bulk_recipient_name", "ALTER TABLE film_orders ADD COLUMN sample_bulk_recipient_name TEXT NOT NULL DEFAULT '株式会社セブン化学 責任技術者：福井　健二'"],
      ["film_orders_sample_bulk_recipient_postal_code", "ALTER TABLE film_orders ADD COLUMN sample_bulk_recipient_postal_code TEXT NOT NULL DEFAULT '〒582-0017'"],
      ["film_orders_sample_bulk_recipient_address", "ALTER TABLE film_orders ADD COLUMN sample_bulk_recipient_address TEXT NOT NULL DEFAULT '大阪府柏原市太平寺1丁目12番1号'"],
      ["film_orders_sample_bulk_requested_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_requested_at TEXT"],
      ["film_orders_sample_bulk_received_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_received_at TEXT"],
      ["film_orders_sample_bulk_confirmed_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_confirmed_at TEXT"],
      ["film_orders_sample_bulk_adjustment_requested_at", "ALTER TABLE film_orders ADD COLUMN sample_bulk_adjustment_requested_at TEXT"],
      ["film_orders_sample_bulk_request_note", "ALTER TABLE film_orders ADD COLUMN sample_bulk_request_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_sample_bulk_receive_note", "ALTER TABLE film_orders ADD COLUMN sample_bulk_receive_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_sample_bulk_adjustment_reason", "ALTER TABLE film_orders ADD COLUMN sample_bulk_adjustment_reason TEXT NOT NULL DEFAULT ''"],
      ["film_order_files_size", "ALTER TABLE film_order_files ADD COLUMN file_size_bytes INTEGER"],
      ["film_order_files_content_type", "ALTER TABLE film_order_files ADD COLUMN content_type TEXT"],
      ["film_order_files_checksum", "ALTER TABLE film_order_files ADD COLUMN checksum TEXT"],
      ["film_order_files_checksum_algorithm", "ALTER TABLE film_order_files ADD COLUMN checksum_algorithm TEXT"],
      ["film_order_files_drive_id", "ALTER TABLE film_order_files ADD COLUMN drive_file_id TEXT"],
      ["film_order_files_uploaded_via", "ALTER TABLE film_order_files ADD COLUMN uploaded_via TEXT"],
      ["film_order_files_ip_hash", "ALTER TABLE film_order_files ADD COLUMN client_ip_hash TEXT"],
      ["film_order_files_user_agent", "ALTER TABLE film_order_files ADD COLUMN user_agent TEXT"],
      ["film_orders_customer_design_status", "ALTER TABLE film_orders ADD COLUMN customer_design_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_customer_design_requested_at", "ALTER TABLE film_orders ADD COLUMN customer_design_requested_at TEXT"],
      ["film_orders_customer_design_received_at", "ALTER TABLE film_orders ADD COLUMN customer_design_received_at TEXT"],
      ["film_orders_customer_design_confirmed_at", "ALTER TABLE film_orders ADD COLUMN customer_design_confirmed_at TEXT"],
      ["film_orders_customer_design_correction_count", "ALTER TABLE film_orders ADD COLUMN customer_design_correction_count INTEGER NOT NULL DEFAULT 0"],
      ["film_orders_customer_design_correction_reason", "ALTER TABLE film_orders ADD COLUMN customer_design_correction_reason TEXT NOT NULL DEFAULT ''"],
      ["film_orders_customer_proof_status", "ALTER TABLE film_orders ADD COLUMN customer_proof_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_customer_proof_requested_at", "ALTER TABLE film_orders ADD COLUMN customer_proof_requested_at TEXT"],
      ["film_orders_customer_proof_approved_at", "ALTER TABLE film_orders ADD COLUMN customer_proof_approved_at TEXT"],
      ["film_orders_customer_proof_correction_count", "ALTER TABLE film_orders ADD COLUMN customer_proof_correction_count INTEGER NOT NULL DEFAULT 0"],
      ["film_orders_customer_proof_correction_reason", "ALTER TABLE film_orders ADD COLUMN customer_proof_correction_reason TEXT NOT NULL DEFAULT ''"],
      ["film_orders_supplier_approval_status", "ALTER TABLE film_orders ADD COLUMN supplier_approval_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_supplier_approval_at", "ALTER TABLE film_orders ADD COLUMN supplier_approval_at TEXT"],
      ["film_orders_supplier_approval_by", "ALTER TABLE film_orders ADD COLUMN supplier_approval_by TEXT NOT NULL DEFAULT ''"],
      ["film_orders_supplier_approval_note", "ALTER TABLE film_orders ADD COLUMN supplier_approval_note TEXT NOT NULL DEFAULT ''"],
      ["film_orders_buyer_approval_status", "ALTER TABLE film_orders ADD COLUMN buyer_approval_status TEXT NOT NULL DEFAULT 'pending'"],
      ["film_orders_buyer_approval_at", "ALTER TABLE film_orders ADD COLUMN buyer_approval_at TEXT"],
      ["film_orders_buyer_approval_by", "ALTER TABLE film_orders ADD COLUMN buyer_approval_by TEXT NOT NULL DEFAULT ''"],
      ["film_orders_supplier_order_note", "ALTER TABLE film_orders ADD COLUMN supplier_order_note TEXT NOT NULL DEFAULT ''"],
    ];
    if (db.dialect === "postgres") {
      // 以前は既存カラムへの ALTER を全て試行し、失敗を無視していた。
      // Neon では失敗ALTERの往復だけで数十秒になるため、1バッチで冪適に宣言する。
      const idempotentColumnMigrations = migrations
        .filter(([, sql]) => sql.startsWith("ALTER TABLE"))
        .map(([, sql]) => sql.replace(/ADD COLUMN(?! IF NOT EXISTS)/i, "ADD COLUMN IF NOT EXISTS"))
        .join(";\n");
      await db.exec(idempotentColumnMigrations);
      // BASE_SCHEMA cannot create the order index before an older table gains the new columns.
      await db.exec("CREATE INDEX IF NOT EXISTS idx_film_orders_film_maker ON film_orders(film_maker_id)");
    } else {
      const tableColumns = new Map<string, Set<string>>();
      const hasColumn = async (table: string, column: string): Promise<boolean> => {
        if (!tableColumns.has(table)) {
          const columns = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
          tableColumns.set(table, new Set(columns.map(({ name }) => name)));
        }
        return tableColumns.get(table)!.has(column);
      };
      for (const [, sql] of migrations) {
        const alter = sql.match(/^ALTER TABLE\s+(\S+)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([^\s(]+)/iu);
        if (alter && await hasColumn(alter[1]!, alter[2]!)) continue;
        await db.exec(sql);
      }
    }
    if (db.dialect === "sqlite") {
      const columns = await db.all<{ name: string }>("PRAGMA table_info(film_orders)");
      const names = new Set(columns.map((column) => column.name));
      if (names.has("sample_bulk_required_ml")) {
        await db.exec(`
          UPDATE film_orders
          SET bulk_usage_reference_ml = CASE WHEN sample_bulk_required_ml IS NOT NULL AND sample_bulk_required_ml != ''
            THEN sample_bulk_required_ml ELSE bulk_usage_reference_ml END,
            sample_bulk_required_ml = '0',
            sample_bulk_received_ml = NULL,
            sample_bulk_adjusted_ml = NULL,
            sample_bulk_status = CASE WHEN sample_bulk_status IN ('not_required') THEN sample_bulk_status ELSE 'pending' END
        `);
      }
    } else {
      const legacyColumn = await db.get<{ exists: number | boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'film_orders' AND column_name = 'sample_bulk_required_ml'
        ) AS exists
      `);
      if (legacyColumn?.exists) {
        await db.exec(`
          UPDATE film_orders
          SET bulk_usage_reference_ml = CASE WHEN sample_bulk_required_ml IS NOT NULL AND sample_bulk_required_ml != ''
            THEN sample_bulk_required_ml ELSE bulk_usage_reference_ml END,
            sample_bulk_required_ml = '0',
            sample_bulk_received_ml = NULL,
            sample_bulk_adjusted_ml = NULL,
            sample_bulk_status = CASE WHEN sample_bulk_status IN ('not_required') THEN sample_bulk_status ELSE 'pending' END
        `);
      }
    }
    await reconcileFilmOrderOwnership(db);
    {
      // 既存発注にも見積のバルク使用量から追跡カードを作成する。
      const existing = await db.all<{ id: number; payload_json: string }>(`
        SELECT f.id, q.payload_json
        FROM film_orders f
        JOIN quotations q ON q.id = f.quotation_id
        WHERE f.bulk_usage_reference_ml = '0'
      `);
      for (const row of existing) {
        try {
          const quotation = { payload: JSON.parse(row.payload_json) } as unknown as QuotationRecord;
          await db.run(
            "UPDATE film_orders SET bulk_usage_reference_ml = ? WHERE id = ?",
            [productionBulkUsageMlOf(quotation), row.id],
          );
        } catch {
          // 不正な旧payloadは参考値0のまま残す。
        }
      }
    }
    await migrateFilmOrderFileCategory(db);
    // Lifecycle columns and constraints must exist before the PostgreSQL purpose
    // migration normalizes token_state. The old external-token table has neither
    // token_state nor dispatch_group_id.
    await migrateExternalTokenLifecycle(db);
    await migrateExternalTokenPurposes(db);
    await db.exec(db.dialect === "postgres" ? `
      UPDATE film_orders f
      SET customer_code = COALESCE(NULLIF(q.payload_json::jsonb->>'customerCode', ''), f.customer_code)
      FROM quotations q
      WHERE f.quotation_id = q.id
        AND COALESCE(f.customer_code, '') = ''
    ` : `
      UPDATE film_orders
      SET customer_code = COALESCE(NULLIF(json_extract(q.payload_json, '$.customerCode'), ''), film_orders.customer_code)
      FROM quotations q
      WHERE film_orders.quotation_id = q.id
        AND COALESCE(film_orders.customer_code, '') = ''
    `);
    await db.exec(`
      UPDATE film_orders
      SET customer_design_status = 'legacy_exempt'
      WHERE status IN ('receiving_registered','proof_registered','re_proof_requested','final_approved')
        AND customer_design_status = 'pending'
    `);
    await db.exec(`
      UPDATE film_orders
      SET customer_proof_status = 'legacy_exempt'
      WHERE status IN ('proof_registered','re_proof_requested','final_approved')
        AND customer_proof_status = 'pending'
    `);
    await db.exec(`
      UPDATE film_orders
      SET supplier_approval_status = CASE
          WHEN supplier_approval_status = 'approved' THEN supplier_approval_status
          WHEN status = 'final_approved' THEN 'approved'
          WHEN customer_proof_status = 'legacy_exempt' THEN 'approved'
          ELSE 'pending'
        END,
        supplier_approval_by = CASE
          WHEN supplier_approval_by = '' AND supplier_approval_status = 'approved' THEN 'migrated:history-event'
          ELSE supplier_approval_by
        END
    `);
    await db.exec(`
      UPDATE film_orders
      SET buyer_approval_status = CASE
          WHEN status = 'final_approved' THEN 'approved'
          ELSE buyer_approval_status
        END,
        buyer_approval_by = CASE
          WHEN status = 'final_approved' AND buyer_approval_by = '' THEN 'migrated:history-event'
          ELSE buyer_approval_by
        END
    `);
    if (db.dialect === "postgres") {
      const foreignKey = await db.get<{ constraint_name: string }>(
        "SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'film_orders' AND constraint_name = 'film_orders_film_maker_id_fkey'",
      );
      if (!foreignKey) {
        await db.exec(
          "ALTER TABLE film_orders ADD CONSTRAINT film_orders_film_maker_id_fkey FOREIGN KEY (film_maker_id) REFERENCES film_makers(id)",
        );
      }
    }
    await migrateLegacyProofTokens(db);
    await migrateLegacyEtaTokens(db);
    // レガシー digital 発注は procurementRoute 未設定のまま保存されていたため K へ正規化する。
    await db.exec(`
      UPDATE film_orders
      SET procurement_route = 'K'
      WHERE procurement_route = ''
        AND printing_method = 'digital'
    `);
    // Legacy reconciliation is a suggestion-only data migration. It runs before the schema
    // marker advances so a failed classification/backfill cannot mark the migration complete.
    const { reconcileLegacySuppliers } = await import("./film-maker-reconciliation");
    await reconcileLegacySuppliers(db);
    // 複数納品先テーブル導入前の旧 scalar カラムを 1 件目（代表納品先）として引き継ぐ。
    await db.exec(`
      INSERT INTO film_order_ship_to_destinations (
        order_id, destination_id, position, label, company_name, department, contact_name,
        postal_code, address, building, phone, email, note,
        registered_at, registered_by, confirmed_at, confirmed_by, created_at
      )
      SELECT
        f.id, f.ship_to_destination_id, 0, f.ship_to_label, f.ship_to_company_name,
        f.ship_to_department, f.ship_to_contact_name, f.ship_to_postal_code, f.ship_to_address,
        f.ship_to_building, f.ship_to_phone, f.ship_to_email, f.ship_to_note,
        COALESCE(f.ship_to_registered_at, f.created_at), f.ship_to_registered_by,
        f.ship_to_confirmed_at, f.ship_to_confirmed_by, COALESCE(f.ship_to_registered_at, f.created_at)
      FROM film_orders f
      WHERE f.ship_to_company_name != ''
        AND NOT EXISTS (SELECT 1 FROM film_order_ship_to_destinations d WHERE d.order_id = f.id)
    `);
    const requiredColumns = [
      "film_maker_id", "supplier_resolution", "current_proof_round", "po_sent_at", "customer_code",
      "ship_to_company_name", "production_plan_status", "delivery_note_draft_json",
      "delivery_note_updated_at", "delivery_note_updated_by",
    ];
    const existingColumns = db.dialect === "sqlite"
      ? new Set((await db.all<{ name: string }>("PRAGMA table_info(film_orders)")).map(({ name }) => name))
      : new Set((await db.all<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'film_orders'
      `)).map(({ column_name }) => column_name));
    const missingColumns = requiredColumns.filter((column) => !existingColumns.has(column));
    if (missingColumns.length > 0) throw new Error(`film_order_migration_incomplete:${missingColumns.join(",")}`);
    await db.run(`
      INSERT INTO film_order_schema_migrations (slot,version,updated_at) VALUES (?,?,?)
      ON CONFLICT(slot) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at
    `, ["film_orders", FILM_SCHEMA_VERSION, new Date().toISOString()]);
    return db;
  })();
  return schemaReady;
}

/**
 * G002 では film_orders と同じトランザクション/移行スロットでマスターを管理する。
 * 直接の SqlClient は Store 層のみ使用し、API は認可つき Store 関数経由とする。
 */
export async function getDatabaseForFilmMakerStore(): Promise<SqlClient> {
  return getDatabase();
}

export async function resetFilmOrderDatabaseForTest(): Promise<void> {
  schemaReady = null;
  const { resetSqlClientForTest } = await import("./db");
  await resetSqlClientForTest();
}

/** Re-run additive schema/reconciliation checks against the existing connected database. */
export async function resetFilmOrderSchemaForTest(): Promise<void> {
  schemaReady = null;
}

function parsePurchaseOrder(value: unknown): PurchaseOrderSnapshot | null {
  if (value && typeof value === "object") return value as PurchaseOrderSnapshot;
  if (typeof value === "string" && value.trim()) {
    try {
      return JSON.parse(value) as PurchaseOrderSnapshot;
    } catch {
      return null;
    }
  }
  return null;
}

function purchaseOrderOf(quotation: QuotationRecord): PurchaseOrderSnapshot | null {
  const payload = quotation.payload as Record<string, unknown>;
  return parsePurchaseOrder(payload.purchaseOrder ?? payload.purchaseOrderJson);
}

async function nextOrderNumber(db: SqlClient): Promise<string> {
  const now = new Date();
  const prefix = `F-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}-`;
  const row = await db.get<{ order_number: string }>(
    "SELECT order_number FROM film_orders WHERE order_number LIKE ? ORDER BY order_number DESC LIMIT 1",
    [`${prefix}%`],
  );
  const last = row ? Number(row.order_number.slice(prefix.length)) : 0;
  return `${prefix}${String(Number.isFinite(last) ? last + 1 : 1).padStart(3, "0")}`;
}

function productionBulkUsageMlOf(quotation: QuotationRecord): string {
  const snapshot = quotation.payload.calculationChecklistSnapshot as { bulkUsageMl?: unknown } | undefined;
  const value = Number(snapshot?.bulkUsageMl ?? 0);
  return Number.isFinite(value) && value > 0 ? String(value) : "0";
}

function filmOrderGuardInputOf(
  row: FilmOrderRow,
  order: FilmOrder & Partial<Pick<FilmOrderView, "files" | "events">>,
  extras: Partial<FilmOrderGuardInput> = {},
): FilmOrderGuardInput {
  let makerSnapshot: FilmOrderGuardInput["makerSnapshot"] = null;
  if (row.film_maker_snapshot_json) {
    try {
      makerSnapshot = JSON.parse(row.film_maker_snapshot_json) as FilmOrderGuardInput["makerSnapshot"];
    } catch {
      makerSnapshot = null;
    }
  }
  return {
    ...order,
    supplierResolution: row.supplier_resolution,
    supplierEmail: row.supplier_email,
    makerId: row.film_maker_id,
    makerSnapshot,
    procurementRoute: order.procurement_route,
    printingMethod: order.printing_method,
    shipToStatus: order.shipTo.status,
    customerDesignStatus: order.customerDesign.status,
    customerProofStatus: order.customerProof.status,
    supplierApprovalStatus: order.customerProof.supplierApprovalStatus,
    supplierApprovalAt: order.customerProof.supplierApprovalAt,
    buyerApprovalStatus: order.customerProof.buyerApprovalStatus,
    buyerApprovalAt: order.customerProof.buyerApprovalAt,
    orderedAt: order.ordered_at,
    receivingRegisteredAt: order.receiving_registered_at,
    proofRegisteredAt: order.proof_registered_at,
    reProofRequestedAt: order.re_proof_requested_at,
    finalApprovedAt: order.final_approved_at,
    poSentAt: order.po_sent_at,
    etaUpdatedAt: order.eta_updated_at,
    shippedAt: order.delivery.shippedAt,
    deliveredAt: order.delivery.deliveredAt,
    receivedAt: order.delivery.receivedAt,
    ...extras,
  };
}

function mapOrder(row: FilmOrderRow): FilmOrder {
  const { purchase_order_json, ...rest } = row;
  let makerLanguage: FilmOrder["makerLanguage"];
  let makerCompanyName: string | undefined;
  let makerEmail: string | undefined;
  if (row.film_maker_snapshot_json) {
    try {
    const snapshot = JSON.parse(row.film_maker_snapshot_json) as { language?: unknown; companyName?: unknown; email?: unknown };
      makerLanguage = snapshot.language === "ja" || snapshot.language === "ko" ? snapshot.language : undefined;
      makerCompanyName = typeof snapshot.companyName === "string" ? snapshot.companyName : undefined;
      makerEmail = typeof snapshot.email === "string" ? snapshot.email : undefined;
    } catch {
      makerLanguage = undefined;
    }
  }
  let deliveryDocuments: DeliveryDocument[] = [];
  try {
    const parsed = JSON.parse(row.film_delivery_documents_json || "[]");
    if (Array.isArray(parsed)) {
      deliveryDocuments = parsed
        .filter((item): item is DeliveryDocument => (
          item && typeof item === "object"
          && typeof item.name === "string"
          && typeof item.url === "string"
        ))
        .map((item) => ({ name: item.name, url: item.url }))
        .slice(0, 3);
    }
  } catch {
    deliveryDocuments = [];
  }
  const sampleBulk: SampleBulkTracking = {
    status: row.sample_bulk_status,
    productionBulkUsageMl: row.bulk_usage_reference_ml || "0",
    sampleQuantityMl: row.sample_requested_ml,
    sampleReceivedMl: row.sample_received_ml,
    sampleAdjustedMl: row.sample_adjusted_ml,
    adjustmentCount: Number(row.sample_bulk_adjustment_count || 0),
    recipientName: row.sample_bulk_recipient_name,
    recipientPostalCode: row.sample_bulk_recipient_postal_code,
    recipientAddress: row.sample_bulk_recipient_address,
    requestedAt: row.sample_bulk_requested_at,
    receivedAt: row.sample_bulk_received_at,
    confirmedAt: row.sample_bulk_confirmed_at,
    adjustmentRequestedAt: row.sample_bulk_adjustment_requested_at,
    requestNote: row.sample_bulk_request_note,
    receiveNote: row.sample_bulk_receive_note,
    adjustmentReason: row.sample_bulk_adjustment_reason,
  };
  const customerDesign: CustomerDesignTracking = {
    status: row.customer_design_status,
    requestedAt: row.customer_design_requested_at,
    receivedAt: row.customer_design_received_at,
    confirmedAt: row.customer_design_confirmed_at,
    correctionCount: Number(row.customer_design_correction_count || 0),
    correctionReason: row.customer_design_correction_reason,
    note: "",
  };
  const customerProof: CustomerProofTracking = {
    status: row.customer_proof_status,
    currentRound: Number(row.current_proof_round || 1),
    requestedAt: row.customer_proof_requested_at,
    approvedAt: row.customer_proof_approved_at,
    correctionCount: Number(row.customer_proof_correction_count || 0),
    correctionReason: row.customer_proof_correction_reason,
    supplierApprovalStatus: row.supplier_approval_status,
    supplierApprovalAt: row.supplier_approval_at,
    supplierApprovalBy: row.supplier_approval_by,
    supplierApprovalNote: row.supplier_approval_note,
    buyerApprovalStatus: row.buyer_approval_status,
    buyerApprovalAt: row.buyer_approval_at,
    buyerApprovalBy: row.buyer_approval_by,
  };
  const delivery: FilmDeliveryTracking = {
    shippedOn: row.film_shipped_on,
    shippedAt: row.film_shipped_at,
    carrier: row.film_carrier,
    trackingNumber: row.film_tracking_number,
    shipmentNote: row.film_shipment_note,
    deliveryDocumentName: deliveryDocuments[0]?.name || row.film_delivery_document_name,
    deliveryDocumentUrl: deliveryDocuments[0]?.url || row.film_delivery_document_url,
    documents: deliveryDocuments.length ? deliveryDocuments : row.film_delivery_document_url ? [{ name: row.film_delivery_document_name || "納品書", url: row.film_delivery_document_url }] : [],
    deliveredOn: row.film_delivered_on,
    deliveredAt: row.film_delivered_at,
    deliveryNote: row.film_delivery_note,
    receivedAt: row.film_received_at,
    receivedNote: row.film_received_note,
    receivedByEmail: row.film_received_by_email,
  };
  const shipTo: ShipToTracking = {
    status: (row.ship_to_status || "not_provided") as ShipToStatus,
    destinationId: row.ship_to_destination_id == null ? null : Number(row.ship_to_destination_id),
    destinations: [],
    label: row.ship_to_label,
    companyName: row.ship_to_company_name,
    department: row.ship_to_department,
    contactName: row.ship_to_contact_name,
    postalCode: row.ship_to_postal_code,
    address: row.ship_to_address,
    building: row.ship_to_building,
    phone: row.ship_to_phone,
    email: row.ship_to_email,
    note: row.ship_to_note,
    registeredAt: row.ship_to_registered_at,
    registeredBy: row.ship_to_registered_by,
    savedToMaster: Number(row.ship_to_saved_to_master) === 1 || row.ship_to_saved_to_master === true,
    requestedAt: row.ship_to_requested_at,
    requestedBy: row.ship_to_requested_by,
    confirmedAt: row.ship_to_confirmed_at,
    confirmedBy: row.ship_to_confirmed_by,
  };
  const productionPlanStatus = (row.production_plan_status || "not_set") as ProductionPlanStatus;
  const productionPlan: ProductionPlanTracking = {
    status: productionPlanStatus,
    startDate: row.production_plan_start_date,
    endDate: row.production_plan_end_date,
    note: row.production_plan_note,
    updatedAt: row.production_plan_updated_at,
    updatedBy: row.production_plan_updated_by,
  };
  let deliveryNoteDraft: DeliveryNoteDraft = {
    recipientName: "株式会社セブン化学",
    senderName: "金井貿易株式会社",
    issueDate: "",
    arrivalEstimateDate: "",
    productName: row.product_name,
    specification: `${row.film_composition}${row.web_width_mm ? ` / ${row.web_width_mm}mm` : ""}`,
    quantity: row.pouch_quantity,
    filmLength: row.order_length_m,
    remarks: "",
  };
  try {
    const parsed = JSON.parse(row.delivery_note_draft_json || "{}");
    deliveryNoteDraft = {
      recipientName: typeof parsed.recipientName === "string" ? parsed.recipientName : deliveryNoteDraft.recipientName,
      senderName: typeof parsed.senderName === "string" ? parsed.senderName : deliveryNoteDraft.senderName,
      issueDate: typeof parsed.issueDate === "string" ? parsed.issueDate : "",
      arrivalEstimateDate: typeof parsed.arrivalEstimateDate === "string" ? parsed.arrivalEstimateDate : "",
      productName: typeof parsed.productName === "string" && parsed.productName ? parsed.productName : deliveryNoteDraft.productName,
      specification: typeof parsed.specification === "string" && parsed.specification ? parsed.specification : deliveryNoteDraft.specification,
      quantity: typeof parsed.quantity === "string" && parsed.quantity ? parsed.quantity : deliveryNoteDraft.quantity,
      filmLength: typeof parsed.filmLength === "string" && parsed.filmLength ? parsed.filmLength : deliveryNoteDraft.filmLength,
      remarks: typeof parsed.remarks === "string" ? parsed.remarks : "",
    };
  } catch {
    // A corrupt draft remains editable from its safe defaults.
  }
  return {
    ...rest,
    makerLanguage,
    makerCompanyName,
    makerEmail,
    purchaseOrder: parsePurchaseOrder(purchase_order_json),
    sampleBulk,
    customerDesign,
    customerProof,
    productionPlan,
    delivery,
    shipTo,
    deliveryNoteDraft,
  };
}

/**
 * 成約（approved）済み見積のうち、発注管理に未反映のものを発注待ちとして登録する。
 * 冪等なので一覧取得のたびに実行してよい。
 */
export async function syncFilmOrdersFromQuotations(actorEmail = "system"): Promise<number> {
  const db = await getDatabase();
  const rows = await db.all<{ id: number }>(`
    SELECT quotations.id
    FROM quotations
    LEFT JOIN film_orders ON film_orders.quotation_id = quotations.id
    WHERE (quotations.internal_approved_at IS NOT NULL OR quotations.status = 'approved')
      AND film_orders.id IS NULL
    ORDER BY quotations.id
  `);
  const { getQuotation } = await import("./quotation-store");
  let created = 0;
  for (const row of rows) {
    const quotation = await getQuotation(row.id);
    if (!quotation) continue;
    // Approval does not repair provenance. An unresolved owner must not enter either
    // company's procurement workflow until an explicit owner migration resolves it.
    if (quotation.ownerDomain !== "seven" && quotation.ownerDomain !== "kanei") continue;
    const snapshot = purchaseOrderOf(quotation);
    const customerCode = typeof quotation.payload.customerCode === "string"
      ? quotation.payload.customerCode.trim()
      : "";
    const now = new Date().toISOString();
    const orderNumber = await nextOrderNumber(db);
    await db.run(`
      INSERT INTO film_orders (
        order_number, quotation_id, quotation_number, customer_code, product_name, customer_name, printing_method, procurement_route, film_composition, order_length_m, web_width_mm, pouch_quantity, supplier_name, supplier_email, seven_contact_email, buyer_domain, status, purchase_order_json, sample_bulk_status, bulk_usage_reference_ml, created_at, updated_at, created_by_email, updated_by_email
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      orderNumber,
      quotation.id,
      quotation.quotationNumber,
      customerCode,
      quotation.productName,
      quotation.customerName,
      snapshot?.printingMethod ?? "",
      snapshot?.procurementRoute ?? (snapshot?.printingMethod === "digital" ? "K" : ""),
      snapshot?.filmComposition ?? "",
      snapshot?.orderLengthM ?? "",
      String(snapshot?.webWidthsMm?.[0] ?? snapshot?.webWidthMm ?? ""),
      quotation.quantity,
      "",
      "",
      quotation.ownerDomain === "seven"
        ? (isSevenChemicalUser(quotation.createdBy.email) ? quotation.createdBy.email : sevenChemicalContactEmail())
        : (isKaneiTradeUser(quotation.createdBy.email) ? quotation.createdBy.email : filmDesignNotificationTo()),
      quotation.ownerDomain === "seven" ? "727.co.jp" : "kanei-trade.co.jp",
      "pending",
      JSON.stringify(snapshot ?? {}),
      "pending",
      productionBulkUsageMlOf(quotation),
      now,
      now,
      quotation.createdBy.email,
      quotation.createdBy.email,
    ]);
    const inserted = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number = ?", [orderNumber]);
    if (inserted) {
      await db.run(
        "INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)",
        [inserted.id, "created", `内部承認見積 ${quotation.quotationNumber} から発注 ${orderNumber} を作成`, actorEmail, now],
      );
      // The approved projection already fixes route and printing method. With one
      // matching active master, procurement starts without another redundant choice.
      const { autoSelectFilmMakerForOrder } = await import("./film-maker-store");
      await autoSelectFilmMakerForOrder(inserted.id, actorEmail);
      created += 1;
    }
  }
  return created;
}

export async function listFilmOrders(
  actorEmail?: string,
  actorRole?: "admin" | "user",
): Promise<FilmOrderView[]> {
  const db = await getDatabase();
  const rows = await db.all<FilmOrderRow>("SELECT * FROM film_orders ORDER BY created_at DESC, id DESC");
  const visible = rows.filter((row) => {
    return canViewFilmOrderRow(row.buyer_domain, actorEmail, actorRole);
  });
  const files = await db.all<FilmOrderFileRecord>("SELECT * FROM film_order_files ORDER BY created_at, id");
  const events = await db.all<FilmOrderEventRecord>("SELECT * FROM film_order_events ORDER BY created_at, id");
  return visible.map((row) => ({
    ...mapOrder(row),
    files: files.filter((file) => file.order_id === row.id),
    events: events.filter((event) => event.order_id === row.id),
  }));
}

/**
 * 一覧カードには親行のみ返す。ファイル・履歴はカード展開時に getFilmOrder で取得する。
 * 成約案件が増えたときに全注文の子テーブルを転送しないことが目的。
 */
export async function listFilmOrderSummaries(
  actorEmail?: string,
  actorRole?: "admin" | "user",
): Promise<FilmOrderView[]> {
  const db = await getDatabase();
  const rows = await db.all<FilmOrderRow>("SELECT * FROM film_orders ORDER BY created_at DESC, id DESC");
  return rows
    .filter((row) => {
      return canViewFilmOrderRow(row.buyer_domain, actorEmail, actorRole);
    })
    .map((row) => ({ ...mapOrder(row), files: [], events: [] }));
}

export async function getFilmOrder(id: number): Promise<FilmOrderView | null> {
  const db = await getDatabase();
  await recoverStaleFilmOrderMailSendingAttempts(
    new Date(Date.now() - 2 * 60_000).toISOString(),
    db,
  );
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [id]);
  if (!row) return null;
  const files = await db.all<FilmOrderFileRecord>(
    "SELECT * FROM film_order_files WHERE order_id = ? ORDER BY created_at, id",
    [id],
  );
  const events = await db.all<FilmOrderEventRecord>(
    "SELECT * FROM film_order_events WHERE order_id = ? ORDER BY created_at, id",
    [id],
  );
  const shipToDestinations = await listFilmOrderShipToDestinations(db, id);
  const order = mapOrder(row);
  return { ...order, files, events, shipTo: { ...order.shipTo, destinations: shipToDestinations } };
}

export async function saveDeliveryNoteDraft(
  id: number,
  input: Record<string, unknown>,
  actorEmail: string,
): Promise<FilmOrderView> {
  if (!isKaneiTradeUser(actorEmail)) throw new Error("film_order_actor_forbidden");
  const db = await getDatabase();
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [id]);
  if (!row) throw new Error("film_order_not_found");
  if (!row.po_sent_at) throw new Error("invalid_status_transition");
  const str = (key: string, max = 500): string => {
    const value = input[key];
    if (value == null) return "";
    if (typeof value !== "string") throw new Error("invalid_delivery_note");
    return value.slice(0, max).trim();
  };
  const draft: DeliveryNoteDraft = {
    recipientName: str("recipientName") || "株式会社セブン化学",
    senderName: str("senderName") || "金井貿易株式会社",
    issueDate: str("issueDate", 10),
    arrivalEstimateDate: str("arrivalEstimateDate", 10),
    productName: str("productName", 300),
    specification: str("specification", 1000),
    quantity: str("quantity", 100),
    filmLength: str("filmLength", 100),
    remarks: str("remarks", 4000),
  };
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    const result = await tx.run(`
      UPDATE film_orders SET delivery_note_draft_json=?, delivery_note_updated_at=?, delivery_note_updated_by=?, updated_at=?, updated_by_email=?
      WHERE id=? AND po_sent_at IS NOT NULL
    `, [JSON.stringify(draft), now, actorEmail, now, actorEmail, id]);
    if (Number(result.changes) !== 1) throw new Error("invalid_status_transition");
    await addEvent(
      tx,
      id,
      "delivery_note",
      `納品書下書き更新: ${draft.productName || "-"} / 到着見込 ${draft.arrivalEstimateDate || "-"}`,
      actorEmail,
    );
  });
  const saved = await getFilmOrder(id);
  if (!saved) throw new Error("film_order_update_failed");
  return saved;
}

interface ShipToDestinationDbRow {
  id: number;
  order_id: number;
  destination_id: number | null;
  position: number;
  label: string;
  company_name: string;
  department: string;
  contact_name: string;
  postal_code: string;
  address: string;
  building: string;
  phone: string;
  email: string;
  note: string;
  registered_at: string;
  registered_by: string;
  confirmed_at: string | null;
  confirmed_by: string;
}

async function listFilmOrderShipToDestinations(db: SqlClient, orderId: number): Promise<ShipToDestinationEntry[]> {
  const rows = await db.all<ShipToDestinationDbRow>(`
    SELECT * FROM film_order_ship_to_destinations WHERE order_id = ? ORDER BY position, id
  `, [orderId]);
  return rows.map((row) => ({
    id: Number(row.id),
    destinationId: row.destination_id == null ? null : Number(row.destination_id),
    position: Number(row.position),
    label: row.label,
    companyName: row.company_name,
    department: row.department,
    contactName: row.contact_name,
    postalCode: row.postal_code,
    address: row.address,
    building: row.building,
    phone: row.phone,
    email: row.email,
    note: row.note,
    registeredAt: row.registered_at,
    registeredBy: row.registered_by,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
  }));
}

const FILM_ORDER_SHIP_TO_MAX_DESTINATIONS = 10;

interface ShipToEntryParams {
  destinationId?: unknown;
  customerBasic?: unknown;
  shipToLabel?: unknown;
  shipToCompanyName?: unknown;
  shipToDepartment?: unknown;
  shipToContactName?: unknown;
  shipToPostalCode?: unknown;
  shipToAddress?: unknown;
  shipToBuilding?: unknown;
  shipToPhone?: unknown;
  shipToEmail?: unknown;
  shipToNote?: unknown;
  saveShipToMaster?: unknown;
}

/** 登録確定済みの納品先。id は顧客住所録マスタID（顧客基本情報の場合は null）。 */
export interface ResolvedShipToDestination {
  id: number | null;
  label: string;
  companyName: string;
  department: string;
  contactName: string;
  postalCode: string;
  address: string;
  building: string;
  phone: string;
  email: string;
  note: string;
}

function resolvedShipToDestinationOf(destination: CustomerDeliveryDestination): ResolvedShipToDestination {
  return {
    id: destination.id,
    label: destination.label,
    companyName: destination.companyName,
    department: destination.department,
    contactName: destination.contactName,
    postalCode: destination.postalCode,
    address: destination.address,
    building: destination.building,
    phone: destination.phone,
    email: destination.email,
    note: destination.note,
  };
}

/**
 * 顧客基本情報（初回登録時の住所）を納品先として解決する。
 * 住所録には保存せず、顧客マスタの値をそのまま使う。
 */
async function customerBasicShipToDestinationOf(
  order: FilmOrder,
  customerCode: string,
): Promise<ResolvedShipToDestination | null> {
  const master = await customerShipToMasterOf(order, customerCode);
  if (!master) return null;
  const input = validateDeliveryDestinationInput({
    label: "",
    companyName: master.customerName,
    department: "",
    contactName: master.customerContact,
    postalCode: master.customerPostalCode,
    address: master.customerAddress,
    building: "",
    phone: master.customerTelephone,
    email: master.customerEmail,
    note: "",
    isDefault: false,
  });
  if (!input) return null;
  return {
    id: null,
    label: "",
    companyName: input.companyName,
    department: input.department,
    contactName: input.contactName,
    postalCode: input.postalCode,
    address: input.address,
    building: input.building,
    phone: input.phone,
    email: input.email,
    note: input.note,
  };
}
/**
 * register-ship-to の納品先入力を正規化する。
 * - destinations 配列（複数対応・新UI）
 * - 旧フラットパラメータ（destinationId / shipTo* 1件分・顧客外部リンクや既存クライアント互換）
 */
function shipToEntryParamsOf(params: ShipToEntryParams & { destinations?: unknown }): ShipToEntryParams[] {
  if (Array.isArray(params.destinations)) {
    return params.destinations
      .filter((item): item is ShipToEntryParams => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .slice(0, FILM_ORDER_SHIP_TO_MAX_DESTINATIONS);
  }
  const hasFlatEntry = params.destinationId != null
    || params.shipToCompanyName != null
    || params.shipToAddress != null;
  return hasFlatEntry ? [{ ...params }] : [];
}

function shipToRegisteredEventDetail(destinations: Array<Pick<CustomerDeliveryDestination, "companyName" | "postalCode" | "address">>): string {
  const summary = destinations
    .map((destination, index) => `${index + 1}) ${destination.companyName} / ${destination.postalCode} ${destination.address}`)
    .join(" ");
  return destinations.length === 1
    ? `納品先登録: ${summary}`
    : `納品先登録（${destinations.length}件）: ${summary}`;
}

async function syncPrimaryShipToColumns(
  db: SqlClient,
  orderId: number,
  customerCode: string,
  primary: Pick<
    ResolvedShipToDestination,
    "id" | "label" | "companyName" | "department" | "contactName" | "postalCode" | "address" | "building" | "phone" | "email" | "note"
  >,
  registeredAt: string,
  registeredBy: string,
  updatedAt: string,
  updatedBy: string,
): Promise<void> {
  await db.run(`
    UPDATE film_orders SET
      customer_code=?, ship_to_destination_id=?, ship_to_status='registered', ship_to_label=?,
      ship_to_company_name=?, ship_to_department=?, ship_to_contact_name=?, ship_to_postal_code=?,
      ship_to_address=?, ship_to_building=?, ship_to_phone=?, ship_to_email=?, ship_to_note=?,
      ship_to_registered_at=?, ship_to_registered_by=?, ship_to_saved_to_master=TRUE,
      ship_to_confirmed_at=NULL, ship_to_confirmed_by='', updated_at=?, updated_by_email=?
    WHERE id=?
  `, [
    customerCode, primary.id, primary.label, primary.companyName, primary.department,
    primary.contactName, primary.postalCode, primary.address, primary.building,
    primary.phone, primary.email, primary.note, registeredAt, registeredBy, updatedAt, updatedBy, orderId,
  ]);
}

function mailBodyBase(order: FilmOrder): string {
  return [
    `発注番号: ${order.order_number}`,
    `見積番号: ${order.quotation_number}`,
    `商品名: ${order.product_name || "-"}`,
    `顧客名: ${order.customer_name || "-"}`,
    `数量: ${order.pouch_quantity ? `${Number(order.pouch_quantity).toLocaleString("ja-JP")}枚` : "-"}`,
    `印刷方式: ${order.printing_method || "-"}`,
    `フィルム構成: ${order.film_composition || "-"}`,
    `原反幅: ${order.web_width_mm ? `${order.web_width_mm}mm` : "-"}`,
    `発注長: ${order.order_length_m ? `${order.order_length_m}m` : "-"}`,
  ].join("\n");
}

function filmOrderBaseMailVars(order: FilmOrder): Record<string, string> {
  return {
    orderNumber: order.order_number,
    quotationNumber: order.quotation_number,
    productName: order.product_name || "",
    customerName: order.customer_name || "",
    quantity: order.pouch_quantity ? `${Number(order.pouch_quantity).toLocaleString("ja-JP")}枚` : "-",
    printingMethod: order.printing_method || "-",
    filmComposition: order.film_composition || "-",
    webWidthMm: order.web_width_mm || "-",
    orderLengthM: order.order_length_m || "-",
    supplierName: order.supplier_name || "",
    buyerLabel: buyerCompanyLabelOfOrder(order),
  };
}

async function addEvent(db: SqlClient, orderId: number, type: string, detail: string, actorEmail: string): Promise<void> {
  await db.run(
    "INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)",
    [orderId, type, detail, actorEmail, new Date().toISOString()],
  );
}

async function addFile(
  db: SqlClient,
  orderId: number,
  category: FilmOrderFileCategory,
  fileName: string,
  url: string,
  note: string,
  actorEmail: string,
  metadata: UploadFileMetadata = {},
): Promise<FilmOrderFileRecord> {
  const count = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM film_order_files WHERE order_id = ? AND category = ?",
    [orderId, category],
  );
  const version = Number(count?.n ?? 0) + 1;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO film_order_files (
       order_id,category,file_name,url,version,note,uploaded_by_email,
       file_size_bytes,content_type,checksum,checksum_algorithm,drive_file_id,
       uploaded_via,client_ip_hash,user_agent,created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      orderId, category, fileName, url, version, note, actorEmail,
      metadata.fileSizeBytes ?? null,
      metadata.contentType ?? null,
      metadata.checksum ?? null,
      metadata.checksumAlgorithm ?? null,
      metadata.driveFileId ?? null,
      metadata.uploadedVia ?? "internal",
      metadata.clientIpHash ?? null,
      metadata.userAgent ?? null,
      now,
    ],
  );
  const row = await db.get<FilmOrderFileRecord>(
    "SELECT * FROM film_order_files WHERE order_id = ? AND category = ? ORDER BY id DESC LIMIT 1",
    [orderId, category],
  );
  if (!row) throw new Error("film_order_file_failed");
  return row;
}

function fileLinksSection(files: string[]): string {
  const links = files.filter(Boolean);
  return links.length > 0 ? links.join("\n") : "（URL未登録: Driveフォルダのファイル名で確認してください）";
}

function supplierScopedArtworkLinks(
  order: FilmOrderView,
  token: string,
  origin: string,
): string[] {
  return order.files
    .filter((file) => file.category === "receiving")
    .map((file) => {
      const fileId = file.drive_file_id || file.url.split("/d/")[1]?.split("/")[0] || "";
      const label = file.file_name || fileId || "file";
      if (!fileId) return `${label}: (URL未登録)`;
      return `${label}: ${origin}/api/film-orders/proof-download/${encodeURIComponent(token)}?fileId=${encodeURIComponent(fileId)}`;
    });
}

function proofNoticeText(order: FilmOrder, supplierLinks: string[] = [], uploadUrl = "", localeInput?: MailLocale): string {
  const locale = localeInput ?? supplierLocale(order);
  const proofName = buildFilmOrderFileName(order, "proof", 1);
  const destination = supplierDestinationFor(order);
  if (locale === "ko") {
    return [
      "필름 제작 파트너 담당자님",
      "",
      "항상 원활한 협조를 주셔서 감사합니다. 패키지랩입니다.",
      "",
      "아래 건의 필름 제작과 교정 데이터 제작을 요청드리고자 연락드립니다.",
      "바쁘시겠지만 제작 가능 여부와 납기 전망을 확인해 주시기 바랍니다.",
      "",
      "【案件 정보】",
      localizedMailBody(order, locale),
      "",
      "【입고 데이터】",
      fileLinksSection(supplierLinks),
      "※ 파일명은 시스템에 등록된 원문 파일명을 그대로 사용합니다.",
      "",
      "【제작·교정 요청 사항】",
      "1. 입고된 데이터를 필름 도면에 따라 배치해 주십시오.",
      "2. 색상, 배치, 문자 정보에 누락이 없는지 확인해 주십시오.",
      "3. 교정 데이터는 반드시 아래 업로드 페이지로 제출해 주십시오.",
      "4. 업로드 시 파일명에 발주번호를 반드시 포함해 주십시오.",
      "",
      "【교정 데이터 제출 페이지】",
      uploadUrl,
      "",
      "※ 업로드 파일명도 시스템 규칙에 맞게 원문 상품명을 포함해 주십시오.",
      `권장 파일명：${proofName}_v번호`,
      "",
      "Google 로그인은 필요하지 않습니다. 관리 통일을 위해 다른 방식의 제출은 받고 있지 않습니다.",
      "진행 제약이나 납기 이슈가 있다면 초기에 알려주시기 바랍니다.",
      "",
      "--",
      "Package Lab",
      "shapepouch@package-lab.com",
    ].filter(Boolean).join("\n");
  }
  return [
    "フィルム製作パートナー ご担当者様",
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    "下記案件のフィルム製作と校正データ作成をお願いしたく、ご連絡いたしました。",
    "お忙しいところ恐れ入りますが、製作可否および納期見込みをご確認いただけますと幸いです。",
    "",
    "【案件情報】",
    localizedMailBody(order, locale),
    "",
    "【入稿データ】",
    fileLinksSection(supplierLinks),
    "",
    "【製作・校正依頼内容】",
    "1. 上記入稿データをフィルム図面に沿って配置してください。",
    "2. 色味・配置・文字情報に欠落がないかをご確認ください。",
    "3. 校正データは必ず下記アップロードページから返却してください。",
    "4. アップロード時はファイル名に発注番号を必ず含めてください。",
    "",
    "【校正データ返却ページ】",
    uploadUrl,
    "",
    `推奨ファイル名：${proofName}_v番号`,
        "",
    "Googleログインは不要です。その他の手段での返却は管理上一律受付できませんので、あらかじめご了承ください。",
    "ご確認のうえ、進行上の制約がある場合はお早めにお知らせください。",
    "",
    "--",
    "パッケージラボ",
    "shapepouch@package-lab.com",
  ].filter(Boolean).join("\n");
}

export interface SupplierOrderMailPreview {
  to: string | null;
  route: "order";
  subject: string;
  body: string;
  editableSubject: string;
  editableBody: string;
  etaUrl: string;
  purchaseOrderUrl: string;
}

function supplierOrderNoteText(note: string, locale: MailLocale): string {
  const trimmed = note.trim();
  if (!trimmed) return "";
  return locale === "ko"
    ? ["", "【추가 발주 지시】", trimmed].join("\n")
    : ["", "【発注時の追加指示】", trimmed].join("\n");
}

function buildSupplierPurchaseOrderMailParts(
  order: FilmOrder,
  etaUrl: string,
  purchaseOrderUrl: string,
  supplierOrderNote: string,
  localeOverride?: MailLocale,
): { locale: MailLocale; subject: string; supplierText: string; japaneseText: string } {
  const locale = localeOverride ?? supplierLocale(order);
  const noteText = supplierOrderNoteText(supplierOrderNote, locale);
  const subject = locale === "ko"
    ? `【필름 발주 요청】${order.order_number} ${order.product_name || ""}`.trim()
    : `【フィルム発注のご依頼】${order.order_number} ${order.product_name || ""}`.trim();
  const supplierText = locale === "ko"
    ? [
      "항상 원활한 협조를 주셔서 감사합니다. 패키지랩입니다.",
      "",
      "아래와 같이 필름 제작을 발주드립니다. 발주 내용을 확인하신 후 납기 전망 등록을 부탁드립니다.",
      "",
      "【발주 내용】",
      localizedMailBody(order, locale),
      noteText,
      "",
      "【요청 사항】",
      "1. 접수 가능 여부 및 제작 사양 확인",
      "2. 대략적인 납기 전망 등록",
      "3. 제작 제약이나 대안이 필요한 경우 조기 공유",
      "",
      "【납기 전망 등록 페이지】",
      etaUrl,
      "",
      "【발주서 열람·인쇄 페이지】",
      purchaseOrderUrl,
      "",
      "바쁘신 와중에도 협조해 주셔서 감사합니다.",
    ].join("\n")
    : [
      "いつも大変お世話になっております。パッケージラボでございます。",
      "",
      "下記のとおりフィルム製作をご発注申し上げます。発注内容をご確認のうえ、納期見込みのご登録をお願いいたします。",
      "",
      "【発注内容】",
      localizedMailBody(order, locale),
      noteText,
      "",
      "【ご依頼事項】",
      "1. 受領可能内容・製作仕様のご確認",
      "2. おおよその納期見込みのご登録",
      "3. 製造上の制約や代替案が必要な場合は早期ご連絡",
      "",
      "【納期見込み登録ページ】",
      etaUrl,
      "",
      "【発注書閲覧・印刷ページ】",
      purchaseOrderUrl,
      "",
      "お忙しいところ恐れ入りますが、何卒よろしくお願い申し上げます。",
    ].join("\n");
  const japaneseText = [
    `${buyerCompanyLabelOfOrder(order)} ご担当者様`,
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    `下記発注（${order.order_number}）の発注書をフィルムメーカーへ送信いたしました。`,
    "",
    "【納期見込みの確認】",
    "メーカーからの納期見込みは下記フォームに反映されます。",
    etaUrl,
    "",
    "今後ともよろしくお願い申し上げます。",
  ].join("\n");
  return { locale, subject, supplierText, japaneseText };
}

export async function buildSupplierPurchaseOrderPreview(
  order: FilmOrder,
  origin: string,
  supplierOrderNote: string,
  mailSubject?: string,
  mailBody?: string,
): Promise<SupplierOrderMailPreview> {
  if (!order.makerEmail?.trim() || !order.makerLanguage) throw new Error("film_maker_resolution_required");
  const destination = { to: order.makerEmail.trim(), route: "order" as const };
  const etaUrl = `${origin}/film-orders/eta/{issued-after-send}`;
  const purchaseOrderUrl = `${origin}/film-orders/purchase-order/{issued-after-send}`;
  const parts = buildSupplierPurchaseOrderMailParts(order, etaUrl, purchaseOrderUrl, supplierOrderNote, order.makerLanguage);
  const defaultSubject = withRecipientSubjectPrefix({
    to: destination.to ?? "",
    subject: parts.subject,
    body: parts.supplierText,
    audience: "supplier",
  });
  return {
    to: destination.to,
    route: destination.route,
    subject: mailSubject?.trim() || defaultSubject,
    body: mailBody?.trim() || parts.supplierText,
    editableSubject: mailSubject ?? defaultSubject,
    editableBody: mailBody ?? parts.supplierText,
    etaUrl,
    purchaseOrderUrl,
  };
}

function etaSecret(): string {
  return process.env.FILM_ETA_SECRET ?? process.env.AUTH_SECRET ?? "pouch-eta-dev-secret";
}

function signEta(orderId: number, expiresAt: number): string {
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  return createHmac("sha256", etaSecret()).update(`${orderId}.${expiresAt}`).digest("base64url");
}

export function buildEtaToken(orderId: number, ttlDays = 14): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + ttlDays * 24 * 60 * 60 * 1000;
  const signature = signEta(orderId, expiresAt);
  return { token: `${orderId}.${expiresAt}.${signature}`, expiresAt };
}

export function verifyEtaToken(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const orderId = Number(parts[0]);
  const expiresAt = Number(parts[1]);
  const signature = parts[2];
  if (!Number.isInteger(orderId) || orderId <= 0 || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Date.now()) return null;
  const expected = signEta(orderId, expiresAt);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !require("node:crypto").timingSafeEqual(a, b)) return null;
  return orderId;
}

function buildStableSupplierProofToken(orderId: number, expiresAtMs: number): string {
  const nonce = "stable-v1";
  return `${orderId}.supplier_proof.${expiresAtMs}.${nonce}.${signExternalToken(orderId, "supplier_proof", expiresAtMs, nonce)}`;
}

async function ensureProofUploadToken(db: SqlClient, orderId: number, options: { rotate?: boolean } = {}): Promise<string> {
  const active = await db.get<ExternalTokenRow>(`
    SELECT * FROM film_order_external_tokens
    WHERE film_order_id = ? AND purpose = 'supplier_proof' AND revoked_at IS NULL
    ORDER BY id DESC LIMIT 1
  `, [orderId]);
  const now = Date.now();
  const expiresAtMs = active ? new Date(active.expires_at).getTime() : 0;
  if (!options.rotate && active && expiresAtMs > now + 24 * 60 * 60 * 1000) {
    const candidate = buildStableSupplierProofToken(orderId, expiresAtMs);
    if (safeEqualStrings(sha256(candidate), active.token_hash)) return candidate;
  }

  const nextExpiresAtMs = now + 30 * 24 * 60 * 60 * 1000;
  const token = buildStableSupplierProofToken(orderId, nextExpiresAtMs);
  const nowIso = new Date(now).toISOString();
  const nextIso = new Date(nextExpiresAtMs).toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE film_order_external_tokens
      SET revoked_at = ?, updated_at = ?
      WHERE film_order_id = ? AND purpose = 'supplier_proof' AND revoked_at IS NULL
    `, [nowIso, nowIso, orderId]);
    await tx.run(`
      INSERT INTO film_order_external_tokens (
        film_order_id,purpose,token_hash,expires_at,created_by_email,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?)
    `, [orderId, "supplier_proof", sha256(token), nextIso, "system", nowIso, nextIso]);
  });
  await addEvent(db, orderId, "token", "外部トークンを発行/更新: supplier_proof", "system");
  return token;
}

export async function getRegisteredFilmOrderFile(fileId: string): Promise<{
  orderId: number;
  category: string;
  fileName: string;
  url: string;
} | null> {
  const db = await getDatabase();
  const row = await db.get<{ order_id: number; category: string; file_name: string; url: string }>(`
    SELECT order_id, category, file_name, url
    FROM film_order_files
    WHERE drive_file_id = ? OR url LIKE ?
    ORDER BY id DESC
    LIMIT 1
  `, [fileId, `%${fileId}%`]);
  if (!row) return null;
  return {
    orderId: Number(row.order_id),
    category: row.category,
    fileName: row.file_name,
    url: row.url,
  };
}

export async function getFilmOrderForProofUpload(token: string): Promise<FilmOrderView | null> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "supplier_proof");
  if (!resolved) throw new Error("invalid_proof_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token);
  return getFilmOrder(resolved.orderId);
}

export async function recordSupplierProofDownload(params: {
  request: { headers: { get(name: string): string | null } };
  token: string;
  fileId: string;
  order: FilmOrderView;
}): Promise<boolean> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "supplier_proof");
  if (!resolved) return false;
  const allowed = params.order.files.some((file) =>
    file.category === "receiving"
    && file.url.includes(`/d/${params.fileId}/`)
  );
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, params.request);
  await addEvent(
    db,
    resolved.orderId,
    "token_access",
    `supplier_proof download ${allowed ? "allowed" : "denied"}: ${params.fileId}`,
    "external:supplier_proof",
  );
  return allowed;
}

export async function updateEtaFromToken(
  token: string,
  etaDate: string,
  note?: string,
  origin?: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<(FilmOrderView & { mails?: MailSendResult[] }) | null> {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(etaDate) ? etaDate : null;
  if (!date) throw new Error("invalid_eta_date");
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "maker_eta");
  if (!resolved) throw new Error("invalid_eta_token");
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [resolved.orderId]);
  if (!row) throw new Error("invalid_eta_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  assertFilmOrderActionGuard(filmOrderGuardInputOf(row, mapOrder(row)), "update-eta");
  const result = await runFilmOrderAction(resolved.orderId, "update-eta", {
    etaDate: date,
    note: note?.slice(0, 1000) ?? "",
    origin: resolveFilmOrderExternalOrigin(origin),
    expectedUpdatedAt: row.updated_at,
  }, "machine:maker");
  return { ...result.order, mails: result.mails ?? [] };
}

export async function getFilmOrderForEta(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView | null> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "maker_eta");
  if (!resolved) return null;
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  return getFilmOrder(resolved.orderId);
}

export async function getFilmOrderForSupplierPurchaseOrder(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "supplier_po");
  if (!resolved) throw new Error("invalid_supplier_po_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  const order = await getFilmOrder(resolved.orderId);
  if (!order || order.status !== "final_approved" || !order.po_sent_at) {
    throw new Error("invalid_supplier_po_token");
  }
  await addEvent(
    db,
    order.id,
    "token_access",
    "supplier_po purchase-order page viewed",
    "external:supplier_po",
  );
  const refreshed = await getFilmOrder(order.id);
  if (!refreshed) throw new Error("invalid_supplier_po_token");
  return refreshed;
}

export async function updateFilmDeliveryFromToken(
  token: string,
  params: { kind: "shipment" | "delivery"; date: string; note?: string; carrier?: string; trackingNumber?: string; documentName?: string; documentUrl?: string; documents?: unknown },
  origin?: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView & { mails?: MailSendResult[] }> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "maker_eta");
  if (!resolved) throw new Error("invalid_eta_token");
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [resolved.orderId]);
  if (!row) throw new Error("invalid_eta_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  const order = mapOrder(row);
  const guard = filmOrderGuardInputOf(row, order);
  if (params.kind === "shipment") assertFilmOrderActionGuard(guard, "report-shipment");
  else {
    if (!order.delivery.shippedOn) throw new Error("shipment_report_required");
    assertFilmOrderActionGuard(guard, "report-delivery");
  }
  const result = await runFilmOrderAction(resolved.orderId, params.kind === "shipment" ? "report-shipment" : "report-delivery", {
    kind: params.kind,
    date: params.date,
    note: params.note,
    carrier: params.carrier,
    trackingNumber: params.trackingNumber,
    documentName: params.documentName,
    documentUrl: params.documentUrl,
    origin: resolveFilmOrderExternalOrigin(origin),
    expectedUpdatedAt: row.updated_at,
  }, "machine:maker");
  return { ...result.order, mails: result.mails ?? [] };
}

function validFileUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 2048 || !/^https?:\/\//i.test(trimmed)) throw new Error("invalid_file_url");
  return trimmed;
}

function validFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || trimmed.includes("/") || trimmed.includes("\\")) return null;
  return trimmed;
}

function trimParam(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

type MailLocale = "ko" | "ja";

const HANGUL = /[가-힯]/u;

function assertKoreanSupplierMessage(message: string): void {
  if (!message || !HANGUL.test(message)) throw new Error("korean_supplier_message_required");
}

function assertJapaneseSupplierMessage(message: string): void {
  if (!message) throw new Error("japanese_supplier_message_required");
}

function assertJapaneseCustomerMessage(message: string): void {
  if (!message) throw new Error("japanese_customer_message_required");
}

function supplierLocale(order: FilmOrder): MailLocale {
  return order.procurement_route === "Y" ? "ja" : "ko";
}

function printingMethodText(order: FilmOrder, locale: MailLocale): string {
  if (order.printing_method === "gravure") return locale === "ko" ? "그라비아 인쇄" : "グラビア印刷";
  if (order.printing_method === "digital") return locale === "ko" ? "디지털 인쇄" : "デジタル印刷";
  return "-";
}

function localizedMailBody(order: FilmOrder, locale: MailLocale): string {
  if (locale === "ko") {
    const productName = order.product_name || "-";
    const customerName = order.customer_name || "-";
    return [
      `발주번호：${order.order_number}`,
      `견적번호：${order.quotation_number}`,
      `품목：${productName}`,
      `고객명：${customerName}`,
      `인쇄 방식：${printingMethodText(order, locale)}`,
      `원단 폭：${order.web_width_mm ? `${order.web_width_mm}mm` : "-"}`,
      `발주 길이：${order.order_length_m ? `${Number(order.order_length_m).toLocaleString("ja-JP")}m` : "-"}`,
    ].join("\n");
  }
  return mailBodyBase(order);
}

function buyerCompanyOfOrder(order: Pick<FilmOrder, "buyer_domain">): "seven" | "kanei" {
  return filmOrderBuyerDomainOf(order);
}

function buyerCompanyLabelOfOrder(order: Pick<FilmOrder, "buyer_domain" | "created_by_email">): string {
  return buyerCompanyOfOrder(order) === "seven" ? "セブン化学" : "金井貿易";
}

function buyerMailAudienceOf(order: Pick<FilmOrder, "buyer_domain" | "created_by_email">): MailAudience {
  return buyerCompanyOfOrder(order) === "seven" ? "seven" : "kanei";
}

function kaneiApprovalNoticeTo(): string {
  return process.env.KANEI_APPROVAL_NOTICE_EMAIL?.trim()
    || process.env.ADMIN_EMAIL?.trim()
    || filmDesignNotificationTo();
}

function buyerApprovalNoticeTo(order: FilmOrder): string {
  if (buyerCompanyOfOrder(order) === "seven") {
    return order.seven_contact_email || order.created_by_email;
  }
  return order.created_by_email
    || process.env.KANEI_APPROVAL_NOTICE_EMAIL?.trim()
    || process.env.ADMIN_EMAIL?.trim()
    || filmDesignNotificationTo();
}

function proofRequestSubject(order: FilmOrder, locale: MailLocale): string {
  return locale === "ko"
    ? `【교정 데이터 제출 요청】${order.order_number} ${registeredJapaneseDisplayNameKo(order.product_name || "")}`.trim()
    : `【校正データ返却のお願い】${order.order_number} ${order.product_name || ""}`.trim();
}

async function customerDestinationFor(order: FilmOrder): Promise<{ to: string | null; name: string; contact: string }> {
  const { getQuotation } = await import("./quotation-store");
  const quotation = await getQuotation(order.quotation_id);
  const email = typeof quotation?.payload.customerEmail === "string" ? quotation.payload.customerEmail.trim() : "";
  return {
    to: email ? email : null,
    name: quotation?.customerName || order.customer_name,
    contact: quotation?.customerContact || "",
  };
}

function orderSummaryMailBase(order: FilmOrder): string[] {
  return [
    `発注番号：${order.order_number}`,
    `見積番号：${order.quotation_number}`,
    `品名：${order.product_name || "-"}`,
    `数量：${order.pouch_quantity ? `${Number(order.pouch_quantity).toLocaleString("ja-JP")}枚` : "-"}`,
  ];
}

type CustomerDesignSpecSnapshot = {
  connectedChambers?: unknown;
  fillMlPerChamber?: unknown;
  totalFillMlPerPouch?: unknown;
  fillingMethod?: unknown;
  quantity?: unknown;
  bulkUsageMl?: unknown;
  bulkUnitPrice?: unknown;
  pouchWidthMm?: unknown;
  pouchLengthMm?: unknown;
  skus?: unknown;
  chambers?: unknown;
};

type CustomerDesignSpecPayload = {
  sizeSummary?: unknown;
  skuNames?: unknown;
  skuQuantities?: unknown;
  calculationChecklistSnapshot?: CustomerDesignSpecSnapshot;
};

function customerSpecText(value: unknown, fallback = "-"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function customerSpecNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function customerSpecArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

async function customerDesignSpecificationLines(order: FilmOrder): Promise<string[]> {
  const { getQuotation } = await import("./quotation-store");
  const quotation = await getQuotation(order.quotation_id);
  const payload = (quotation?.payload ?? {}) as CustomerDesignSpecPayload;
  const snapshot = (payload.calculationChecklistSnapshot ?? {}) as CustomerDesignSpecSnapshot;
  const quantity = customerSpecNumber(order.pouch_quantity) ?? customerSpecNumber(snapshot.quantity);
  const pouchSpec = customerSpecText(payload.sizeSummary, customerSpecText(quotation?.sizeSummary, customerSpecText(snapshot.pouchWidthMm && snapshot.pouchLengthMm
    ? `${snapshot.pouchWidthMm}×${snapshot.pouchLengthMm}mm`
    : "-")));

  const connectedChambers = customerSpecNumber(snapshot.connectedChambers);
  const totalFillPerPouch = customerSpecNumber(snapshot.totalFillMlPerPouch);
  const fillingMethod = customerSpecText(snapshot.fillingMethod) === "pressure" ? "加圧充填" : "ホッパ充填";

  const skuNames = customerSpecArray<string>(payload.skuNames);
  const skuQuantities = customerSpecArray<string>(payload.skuQuantities);
  type CustomerSpecSku = {
    name?: unknown;
    quantity?: unknown;
    fillMlPerChamber?: unknown;
  };
  const snapshotSkus = customerSpecArray<CustomerSpecSku>(snapshot.skus);

  let fillingSpec = "-";
  if (connectedChambers != null && totalFillPerPouch != null) {
    fillingSpec = `${customerSpecNumber(snapshot.fillMlPerChamber)?.toLocaleString("ja-JP") ?? "-"}ml/室 × ${connectedChambers.toLocaleString("ja-JP")}室 ＝ ${totalFillPerPouch.toLocaleString("ja-JP")}ml/枚（${fillingMethod}）`;
  }

  const skuNamesText = skuNames.filter((name) => customerSpecText(name) !== "-").join(" / ");
  const bulkUsageMl = customerSpecNumber(snapshot.bulkUsageMl);
  const bulkUnitPrice = customerSpecNumber(snapshot.bulkUnitPrice);
  const bulkSupplyNote = bulkUnitPrice === 0 ? "（貴社ご支給ください）" : "";
  const bulkText = bulkUsageMl != null
    ? `${Math.round(bulkUsageMl).toLocaleString("ja-JP")}g${bulkSupplyNote}`
    : "-";

  const skuLines = (snapshotSkus.length ? snapshotSkus : []).map((sku, index) => {
    const name = customerSpecText(sku.name, customerSpecText(skuNames[index], `SKU-${index + 1}`));
    const skuQuantity = customerSpecNumber(sku.quantity) ?? customerSpecNumber(skuQuantities[index]);
    const fill = customerSpecNumber(sku.fillMlPerChamber);
    const fillText = fill != null ? ` / ${fill.toLocaleString("ja-JP")}ml/室` : "";
    return `${name} ／ ${skuQuantity != null ? `${skuQuantity.toLocaleString("ja-JP")}枚` : "-"}${fillText}`;
  });
  if (!skuLines.length && skuNamesText) {
    const skuQuantity = quantity != null ? `${quantity.toLocaleString("ja-JP")}枚` : "-";
    skuLines.push(`${skuNamesText} ／ ${skuQuantity}`);
  }

  return [
    `品名：${order.product_name || "-"}`,
    `パウチ仕様：${pouchSpec}`,
    `数量：${quantity != null ? `${quantity.toLocaleString("ja-JP")}枚` : "-"}`,
    `充填仕様：${fillingSpec}`,
    `バルク量：${bulkText}`,
    `フィルム構成：${order.film_composition || "-"}`,
    ...(skuLines.length ? [`SKU`, ...skuLines.map((line) => `・${line}`)] : []),
  ];
}

async function logMailEvents(
  db: SqlClient,
  orderId: number,
  mails: MailSendResult[],
  label: string,
  actorEmail: string,
): Promise<void> {
  for (const mail of mails) {
    const suffix = mail.dryRun ? " (dry-run)" : mail.error ? ` (error: ${mail.error})` : "";
    await addEvent(db, orderId, "email", `${label} → ${mail.to}${suffix}`, actorEmail);
  }
}

type FilmOrderLifecycleAction = import("./film-order-mail-lifecycle").FilmOrderLifecycleWorkflowAction;
type FilmOrderMailActionOrigin = import("./film-order-mail-lifecycle").FilmOrderMailActionOrigin;

async function executeFilmOrderLifecycle(
  id: number,
  action: FilmOrderLifecycleAction,
  params: Parameters<typeof runFilmOrderAction>[2],
  actorEmail: string,
  origin: string,
  mode: "preview" | "confirm" = "confirm",
): Promise<{ order?: FilmOrderView; preview?: Awaited<ReturnType<typeof import("./film-order-mail-lifecycle").prepareFilmOrderMail>>; lifecycle?: FilmOrderMailConfirmResult; mails?: MailSendResult[] }> {
  const lifecycleOrigin = resolveFilmOrderExternalOrigin(origin) as FilmOrderMailActionOrigin;
  const {
    prepareFilmOrderMail,
    confirmFilmOrderMail,
    loadFilmOrderMailPreviewForConfirm,
  } = await import("./film-order-mail-lifecycle");
  const currentOrder = await getFilmOrder(id);
  if (!currentOrder) throw new Error("film_order_not_found");
  let customerEmail = ["request-ship-to-registration","request-customer-design-upload","request-customer-design-correction","approve"].includes(action)
    ? (await customerDestinationFor(currentOrder)).to ?? undefined
    : undefined;
  if (action === "approve" && !customerEmail) {
    const lifecycleDb = await getDatabase();
    const quotationRow = await lifecycleDb.get<{ payload_json: string }>("SELECT payload_json FROM quotations WHERE id=?", [currentOrder.quotation_id]);
    try {
      const payload = quotationRow ? JSON.parse(quotationRow.payload_json) as { customerEmail?: unknown } : null;
      customerEmail = typeof payload?.customerEmail === "string" ? payload.customerEmail.trim() || undefined : undefined;
    } catch {}
  }
  const command = {
    orderId: id,
    action,
    actorEmail,
    origin: lifecycleOrigin,
    expectedUpdatedAt: params.expectedUpdatedAt ? String(params.expectedUpdatedAt) : undefined,
    aiFileName: validFileName(params.aiFileName) ?? undefined,
    aiFileUrl: validFileUrl(params.aiFileUrl) ?? undefined,
    pdfFileName: validFileName(params.pdfFileName) ?? undefined,
    pdfFileUrl: validFileUrl(params.pdfFileUrl) ?? undefined,
    finalFileName: validFileName(params.fileName) ?? undefined,
    finalFileUrl: validFileUrl(params.fileUrl) ?? undefined,
    proofFileName: (validFileName(params.aiFileName) ?? validFileName(params.fileName)) ?? undefined,
    proofFileUrl: (validFileUrl(params.aiFileUrl) || validFileUrl(params.fileUrl)) || undefined,
    proofPdfFileName: validFileName(params.pdfFileName) ?? undefined,
    proofPdfFileUrl: validFileUrl(params.pdfFileUrl) ?? undefined,
    note: trimParam(params.note, 1000) ?? undefined,
    supplierMessage: trimParam(params.supplierMessage, 2000) ?? undefined,
    approverName: trimParam(params.approverName, 200) || undefined,
    evidence: trimParam(params.evidence, 2000) || undefined,
    offlineReason: trimParam(params.offlineReason, 2000) || undefined,
    supplierOrderNote: trimParam(params.supplierOrderNote, 4000) ?? undefined,
    mailSubject: trimParam(params.mailSubject, 500) ?? undefined,
    mailBody: typeof params.mailBody === "string" ? params.mailBody.slice(0, 20000) : undefined,
    customerMessage: trimParam(params.customerMessage, 2000) ?? undefined,
    customerEmail: params.customerEmail ? String(params.customerEmail) : customerEmail,
    decision: params.decision === "approve" || params.decision === "correction" ? params.decision : undefined,
    etaDate: trimParam(params.etaDate, 10) || undefined,
    deliveryDate: trimParam(params.date ?? params.deliveryDate, 10) || undefined,
    deliveryKind: params.kind === "shipment" || params.kind === "delivery" ? params.kind : undefined,
    carrier: trimParam(params.carrier, 200) || undefined,
    trackingNumber: trimParam(params.trackingNumber, 200) || undefined,
    documentName: trimParam(params.documentName, 200) || undefined,
    documentUrl: validFileUrl(params.documentUrl) || undefined,
    receivedNote: trimParam(params.note, 1000) || undefined,
    productionPlanStartDate: trimParam(params.productionPlanStartDate, 10) || undefined,
    productionPlanEndDate: trimParam(params.productionPlanEndDate, 10) || undefined,
    ipAddressHash: params.ipAddressHash ? String(params.ipAddressHash) : null,
    tokenValue: typeof params.token === "string" ? params.token : undefined,
    shipToDestinations: params.shipToDestinations as Array<Record<string, unknown>> | undefined,
    shipToRegisteredBy: typeof params.shipToRegisteredBy === "string" ? params.shipToRegisteredBy : undefined,
    customerDesignFileName: validFileName(params.customerDesignFileName) ?? undefined,
    customerDesignFileUrl: validFileUrl(params.customerDesignFileUrl) ?? undefined,
    customerDesignNote: trimParam(params.customerDesignNote, 1000) || undefined,
    customerDesignFileSizeBytes: Number.isFinite(Number(params.customerDesignFileSizeBytes))
      && Number(params.customerDesignFileSizeBytes) >= 0
      ? Number(params.customerDesignFileSizeBytes)
      : null,
    customerDesignContentType: typeof params.customerDesignContentType === "string"
      ? params.customerDesignContentType.trim().slice(0, 255) || null
      : null,
    customerDesignChecksum: typeof params.customerDesignChecksum === "string"
      ? params.customerDesignChecksum.trim().slice(0, 255) || null
      : null,
    customerDesignChecksumAlgorithm: typeof params.customerDesignChecksumAlgorithm === "string"
      ? params.customerDesignChecksumAlgorithm.trim().slice(0, 64) || null
      : null,
    customerDesignDriveFileId: typeof params.customerDesignDriveFileId === "string"
      ? params.customerDesignDriveFileId.trim().slice(0, 255) || null
      : null,
    customerDesignUploadedVia: typeof params.customerDesignUploadedVia === "string"
      ? params.customerDesignUploadedVia.trim().slice(0, 64) || "customer_design"
      : "customer_design",
  } satisfies Parameters<typeof prepareFilmOrderMail>[0];
  const previewDispatchGroupId = typeof params.mailDispatchGroupId === "string"
    ? params.mailDispatchGroupId.trim()
    : "";
  const suppliedHashes = Array.isArray(params.mailEnvelopeHashes)
    ? params.mailEnvelopeHashes.filter((hash): hash is string => typeof hash === "string" && hash.length > 0)
    : [];
  if (mode === "preview") {
    return { preview: await prepareFilmOrderMail(command) };
  }
  const preview = previewDispatchGroupId && suppliedHashes.length
    ? await loadFilmOrderMailPreviewForConfirm(id, previewDispatchGroupId, command)
    : await prepareFilmOrderMail(command);
  const expectedHashes = suppliedHashes.length
    ? suppliedHashes
    : preview.envelopes.map((envelope) => envelope.contentHash);
  let lifecycle = await confirmFilmOrderMail(preview, expectedHashes);
  let order = await getFilmOrder(id);
  if (!order) throw new Error("film_order_update_failed");
  if (action === "approve" && order.shipTo.status !== "confirmed" && customerEmail) {
    const shipRequest = await executeFilmOrderLifecycle(id, "request-ship-to-registration", {}, actorEmail, origin, "confirm");
    lifecycle = {
      ...shipRequest.lifecycle!,
      dispatchGroupId: `${lifecycle.dispatchGroupId},${shipRequest.lifecycle!.dispatchGroupId}`,
      outcomes: [...lifecycle.outcomes, ...shipRequest.lifecycle!.outcomes],
    };
    order = await getFilmOrder(id);
    if (!order) throw new Error("film_order_update_failed");
  }
  return {
    order,
    lifecycle,
    mails: lifecycle.outcomes.map((outcome) => ({
      to: outcome.actualTo ?? outcome.intendedTo,
      requestedTo: outcome.recipientOverridden ? outcome.intendedTo : undefined,
      recipientOverridden: outcome.recipientOverridden,
      subject: outcome.subject,
      text: outcome.body,
      dryRun: outcome.status === "skipped",
      messageId: outcome.smtpMessageId ?? undefined,
      error: outcome.errorCode ?? undefined,
    })),
  };
}

export async function runFilmOrderAction(
  id: number,
  action: FilmOrderAction,
  params: {
    fileName?: unknown;
    fileUrl?: unknown;
    aiFileName?: unknown;
    aiFileUrl?: unknown;
    pdfFileName?: unknown;
    pdfFileUrl?: unknown;
    note?: unknown;
    comment?: unknown;
    supplierName?: unknown;
    supplierEmail?: unknown;
    makerId?: unknown;
    origin?: unknown;
    reason?: unknown;
    supplierMessage?: unknown;
    customerMessage?: unknown;
    approverName?: unknown;
    evidence?: unknown;
    offlineReason?: unknown;
    destinationId?: unknown;
    destinations?: unknown;
    destinationRowId?: unknown;
    shipToLabel?: unknown;
    shipToCompanyName?: unknown;
    shipToDepartment?: unknown;
    shipToContactName?: unknown;
    shipToPostalCode?: unknown;
    shipToAddress?: unknown;
    shipToBuilding?: unknown;
    shipToPhone?: unknown;
    shipToEmail?: unknown;
    shipToNote?: unknown;
    saveShipToMaster?: unknown;
    supplierOrderNote?: unknown;
    mailSubject?: unknown;
    mailBody?: unknown;
    finalFileName?: unknown;
    finalFileUrl?: unknown;
    guideAcknowledged?: unknown;
    productionPlanStartDate?: unknown;
    productionPlanEndDate?: unknown;
    productionPlanNote?: unknown;
    expectedUpdatedAt?: unknown;
    etaDate?: unknown;
    date?: unknown;
    deliveryDate?: unknown;
    kind?: unknown;
    carrier?: unknown;
    trackingNumber?: unknown;
    documentName?: unknown;
    documentUrl?: unknown;
    decision?: unknown;
    customerEmail?: unknown;
    ipAddressHash?: unknown;
    mailMode?: unknown;
    mailDispatchGroupId?: unknown;
    mailEnvelopeHashes?: unknown;
    token?: unknown;
    shipToDestinations?: unknown;
    shipToRegisteredBy?: unknown;
    customerDesignFileName?: unknown;
    customerDesignFileUrl?: unknown;
    customerDesignNote?: unknown;
    customerDesignFileSizeBytes?: unknown;
    customerDesignContentType?: unknown;
    customerDesignChecksum?: unknown;
    customerDesignChecksumAlgorithm?: unknown;
    customerDesignDriveFileId?: unknown;
    customerDesignUploadedVia?: unknown;
  },
  actorEmail: string,
): Promise<{ order: FilmOrderView; mails?: MailSendResult[]; preview?: SupplierOrderMailPreview | FilmOrderMailPreview; lifecycle?: FilmOrderMailConfirmResult }> {
  const db = await getDatabase();
  const now = new Date().toISOString();
  // 納品先登録など外部リンクを生成しない操作では、実行時ホストが deployment allowlist と一致しなくても失敗させてはいけない。
  const originRequiresAllowlist = isFilmOrderLifecycleWorkflowAction(action) || action === "preview-supplier-po";
  const origin = originRequiresAllowlist
    ? resolveFilmOrderExternalOrigin(params.origin)
    : typeof params.origin === "string" ? params.origin.trim() : "";
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [id]);
  if (!row) throw new Error("film_order_not_found");
  if (!canPerformFilmOrderActorAction(action, actorEmail, row.buyer_domain)) {
    throw new Error("film_order_actor_forbidden");
  }
  const order = mapOrder(row);

  const workflowGuard = filmOrderGuardInputOf(row, order);
  const workflowAction = action as FilmWorkflowAction;
  if (
    workflowAction === "register-receiving"
    || workflowAction === "send-proof-notice"
    || workflowAction === "rotate-supplier-proof-token"
    || workflowAction === "request-re-proof"
    || workflowAction === "resend-receiving-notice"
    || workflowAction === "send-po"
    || workflowAction === "resend-supplier-links"
  ) {
    if (workflowAction === "register-receiving") {
      const aiName = validFileName(params.aiFileName);
      const aiUrl = validFileUrl(params.aiFileUrl);
      const pdfName = params.pdfFileName == null ? null : validFileName(params.pdfFileName);
      const pdfUrl = params.pdfFileName == null ? null : validFileUrl(params.pdfFileUrl);
      workflowGuard.receivingAiRegistered = Boolean(aiName?.toLowerCase().endsWith(".ai") && aiUrl);
      workflowGuard.receivingPdfRegistered = Boolean(pdfName?.toLowerCase().endsWith(".pdf") && pdfUrl);
    } else {
      const current = await getFilmOrder(id);
      workflowGuard.receivingAiRegistered = Boolean(current?.files.some((file) =>
        file.category === "receiving" && file.file_name.toLowerCase().endsWith(".ai")
      ));
      workflowGuard.receivingPdfRegistered = Boolean(current?.files.some((file) =>
        file.category === "receiving" && file.file_name.toLowerCase().endsWith(".pdf")
      ));
    }
  } else if (workflowAction === "send-customer-proof-review") {
    const current = await getFilmOrder(id);
    workflowGuard.customerProofPdfRegistered = Boolean(current?.files.some((file) =>
      file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf")
    ));
  }
  if (
    workflowAction === "mark-ordered"
    || workflowAction === "send-proof-notice"
    || workflowAction === "rotate-supplier-proof-token"
    || workflowAction === "register-proof"
    || workflowAction === "send-customer-proof-review"
    || workflowAction === "record-customer-proof-approval"
    || workflowAction === "approve"
    || workflowAction === "request-re-proof"
    || workflowAction === "send-po"
    || workflowAction === "resend-receiving-notice"
    || workflowAction === "resend-supplier-links"
  ) {
    assertFilmOrderActionGuard(workflowGuard, workflowAction);
  }

  if (action === "register-receiving" && !["confirmed", "not_required", "legacy_exempt"].includes(order.customerDesign.status)) {
    throw new Error("customer_design_confirmation_required");
  }
  if (action === "confirm-film-receipt") {
    if (!order.delivery.deliveredOn || !order.delivery.deliveredAt) throw new Error("delivery_report_required");
    if (order.delivery.receivedAt) throw new Error("invalid_status_transition");
  }

  const mailMode = params.mailMode === "preview" || params.mailMode === "confirm" ? params.mailMode : "confirm";
  const lifecycleActionCandidates: FilmOrderLifecycleAction[] = [
    "register-receiving",
    "send-proof-notice",
    "rotate-supplier-proof-token",
    ...((validFileName(params.fileName) || validFileName(params.aiFileName)) ? ["register-proof" as const] : []),
    "send-customer-proof-review",
    "record-customer-proof-approval",
    "approve",
    "request-re-proof",
    "send-po",
    "resend-supplier-links",
    "resend-receiving-notice",
    "request-production-plan",
    "request-ship-to-registration",
    "ship-to-registered",
    "request-customer-design-upload",
    "request-customer-design-correction",
    "customer-design-received",
    "production-plan-request",
    "update-eta",
    "report-shipment",
    "report-delivery",
    "confirm-film-receipt",
    "customer-proof-decision",
  ];
  if (lifecycleActionCandidates.includes(action as FilmOrderLifecycleAction)) {
    const lifecycleCommand = await executeFilmOrderLifecycle(id, action as FilmOrderLifecycleAction, {
      ...params,
      expectedUpdatedAt: order.updated_at,
    }, actorEmail, origin, mailMode);
    if (mailMode === "preview") {
      const previewOrder = await getFilmOrder(id);
      if (!previewOrder) throw new Error("film_order_update_failed");
      return { order: previewOrder, mails: [], preview: lifecycleCommand.preview, lifecycle: undefined };
    }
    return {
      order: lifecycleCommand.order!,
      mails: lifecycleCommand.mails ?? [],
      lifecycle: lifecycleCommand.lifecycle,
    };
  }

  if (action === "register-ship-to") {
    let customerCode = order.customer_code;
    if (!customerCode) {
      const { getQuotation } = await import("./quotation-store");
      const quotation = await getQuotation(order.quotation_id);
      customerCode = typeof quotation?.payload.customerCode === "string"
        ? quotation.payload.customerCode.trim()
        : "";
      if (customerCode) {
        await db.run(
          "UPDATE film_orders SET customer_code = ? WHERE id = ?",
          [customerCode, id],
        );
      }
    }
    if (!customerCode) throw new Error("customer_code_required");

    const ownerCandidates = shipToCustomerOwnerCandidatesOf(order);
    const requestedEntries = shipToEntryParamsOf(params);
    if (!requestedEntries.length || requestedEntries.length > FILM_ORDER_SHIP_TO_MAX_DESTINATIONS) {
      throw new Error("invalid_ship_to");
    }
    const resolvedDestinations: ResolvedShipToDestination[] = [];
    for (const entry of requestedEntries) {
      if (entry.customerBasic === true) {
        const basic = await customerBasicShipToDestinationOf(order, customerCode);
        if (!basic) throw new Error("invalid_ship_to");
        resolvedDestinations.push(basic);
        continue;
      }
      const destinationId = Number(entry.destinationId);
      if (Number.isInteger(destinationId) && destinationId > 0) {
        let matched: CustomerDeliveryDestination | null = null;
        let matchedOwner: "seven" | "kanei" = ownerCandidates[0];
        for (const candidateOwner of ownerCandidates) {
          const found = await getDeliveryDestination(candidateOwner, customerCode, destinationId);
          if (found) {
            matched = found;
            matchedOwner = candidateOwner;
            break;
          }
        }
        if (!matched) throw new Error("delivery_destination_not_found");
        matched = await markDeliveryDestinationUsed(matchedOwner, customerCode, destinationId) ?? matched;
        resolvedDestinations.push(resolvedShipToDestinationOf(matched));
      } else {
        const input = validateDeliveryDestinationInput({
          label: entry.shipToLabel,
          companyName: entry.shipToCompanyName,
          department: entry.shipToDepartment,
          contactName: entry.shipToContactName,
          postalCode: entry.shipToPostalCode,
          address: entry.shipToAddress,
          building: entry.shipToBuilding,
          phone: entry.shipToPhone,
          email: entry.shipToEmail,
          note: entry.shipToNote,
          isDefault: entry.saveShipToMaster === true,
        });
        if (!input) throw new Error("invalid_ship_to");
        const addressBookOwner = await shipToAddressBookOwnerOf(order, customerCode);
        resolvedDestinations.push(resolvedShipToDestinationOf(await upsertDeliveryDestination(addressBookOwner, customerCode, input)));
      }
    }

    // 複数納品先は登録し直すたびに未確定行を差し替える。1件目を代表納品先として旧 scalar カラムへ同期する。
    await db.run("DELETE FROM film_order_ship_to_destinations WHERE order_id = ?", [id]);
    for (const [index, destination] of resolvedDestinations.entries()) {
      await db.run(`
        INSERT INTO film_order_ship_to_destinations (
          order_id, destination_id, position, label, company_name, department, contact_name,
          postal_code, address, building, phone, email, note, registered_at, registered_by, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `, [
        id, destination.id, index, destination.label, destination.companyName, destination.department,
        destination.contactName, destination.postalCode, destination.address, destination.building,
        destination.phone, destination.email, destination.note, now, actorEmail, now,
      ]);
    }
    await syncPrimaryShipToColumns(db, id, customerCode, resolvedDestinations[0], now, actorEmail, now, actorEmail);
    await addEvent(db, id, "ship_to", shipToRegisteredEventDetail(resolvedDestinations), actorEmail);
  } else if (action === "confirm-ship-to") {
    const hasLegacyShipTo = Boolean(order.shipTo.companyName || order.shipTo.address || order.shipTo.phone);
    const destinationRows = await listFilmOrderShipToDestinations(db, id);
    if (!destinationRows.length && !hasLegacyShipTo) {
      throw new Error("ship_to_not_registered");
    }
    await db.transaction(async (tx) => {
      const currentState = await tx.get<{ ship_to_status: ShipToStatus }>(
        "SELECT ship_to_status FROM film_orders WHERE id=?",
        [id],
      );
      if (!currentState || currentState.ship_to_status === "confirmed") {
        throw new Error("invalid_status_transition");
      }
      await tx.run(
        "UPDATE film_order_ship_to_destinations SET confirmed_at = ?, confirmed_by = ? WHERE order_id = ?",
        [now, actorEmail, id],
      );
      const committed = await tx.run(`
        UPDATE film_orders SET
          ship_to_status='confirmed', ship_to_confirmed_at=?, ship_to_confirmed_by=?,
          updated_at=?, updated_by_email=?
        WHERE id=? AND ship_to_status <> 'confirmed'
      `, [now, actorEmail, now, actorEmail, id]);
      if (committed.changes !== 1) throw new Error("film_order_state_conflict");
    });
    await addEvent(
      db,
      id,
      "ship_to",
      destinationRows.length > 1 ? `納品先確認（${destinationRows.length}件）` : "納品先確認",
      actorEmail,
    );
  } else if (action === "remove-ship-to-destination") {
    if (order.shipTo.status === "confirmed") throw new Error("invalid_status_transition");
    const rowId = Number(params.destinationRowId);
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error("invalid_ship_to");
    const existing = await db.get<{ id: number }>(
      "SELECT id FROM film_order_ship_to_destinations WHERE id = ? AND order_id = ?",
      [rowId, id],
    );
    if (!existing) throw new Error("ship_to_destination_not_found");
    await db.run("DELETE FROM film_order_ship_to_destinations WHERE id = ?", [rowId]);
    const remaining = await listFilmOrderShipToDestinations(db, id);
    let customerCode = order.customer_code;
    if (!customerCode) {
      const { getQuotation } = await import("./quotation-store");
      const quotation = await getQuotation(order.quotation_id);
      customerCode = typeof quotation?.payload.customerCode === "string"
        ? quotation.payload.customerCode.trim()
        : "";
    }
    if (remaining.length) {
      for (const [index, destination] of remaining.entries()) {
        await db.run("UPDATE film_order_ship_to_destinations SET position = ? WHERE id = ?", [index, destination.id]);
      }
      const primary = remaining[0];
      await syncPrimaryShipToColumns(
        db,
        id,
        customerCode,
        {
          id: primary.destinationId ?? primary.id,
          label: primary.label,
          companyName: primary.companyName,
          department: primary.department,
          contactName: primary.contactName,
          postalCode: primary.postalCode,
          address: primary.address,
          building: primary.building,
          phone: primary.phone,
          email: primary.email,
          note: primary.note,
        },
        primary.registeredAt,
        primary.registeredBy || actorEmail,
        now,
        actorEmail,
      );
    } else {
      await db.run(`
        UPDATE film_orders SET
          ship_to_destination_id=NULL, ship_to_status='not_provided', ship_to_label='',
          ship_to_company_name='', ship_to_department='', ship_to_contact_name='', ship_to_postal_code='',
          ship_to_address='', ship_to_building='', ship_to_phone='', ship_to_email='', ship_to_note='',
          ship_to_registered_at=NULL, ship_to_registered_by='', ship_to_saved_to_master=FALSE,
          ship_to_confirmed_at=NULL, ship_to_confirmed_by='', updated_at=?, updated_by_email=?
        WHERE id=?
      `, [now, actorEmail, id]);
    }
    await addEvent(db, id, "ship_to", `納品先削除（残${remaining.length}件）`, actorEmail);
  } else if (action === "save-production-plan" || action === "confirm-production-plan") {
    const startDate = /^\d{4}-\d{2}-\d{2}$/u.test(String(params.productionPlanStartDate)) ? String(params.productionPlanStartDate) : "";
    const endDate = /^\d{4}-\d{2}-\d{2}$/u.test(String(params.productionPlanEndDate)) ? String(params.productionPlanEndDate) : "";
    const note = trimParam(params.productionPlanNote, 1000);
    if (!startDate || !endDate) throw new Error("invalid_production_plan_date");
    if (endDate < startDate) throw new Error("invalid_production_plan_range");
    const previousStatus = order.productionPlan.status;
    const status = action === "confirm-production-plan"
      ? "confirmed"
      : previousStatus === "confirmed" || previousStatus === "adjusted"
        ? "adjusted"
        : "tentative";
    await db.run(`
      UPDATE film_orders SET
        production_plan_status=?, production_plan_start_date=?, production_plan_end_date=?,
        production_plan_note=?, production_plan_updated_at=?, production_plan_updated_by=?,
        updated_at=?, updated_by_email=?
      WHERE id=?
    `, [status, startDate, endDate, note, now, actorEmail, now, actorEmail, id]);
    await addEvent(
      db,
      id,
      "production_plan",
      `${status === "confirmed" ? "生産予定確定" : "生産予定保存"}: ${startDate}〜${endDate}${note ? ` / ${note}` : ""}`,
      actorEmail,
    );
  } else if (action === "set-supplier") {
    const supplierName = trimParam(params.supplierName, 200);
    const supplierEmail = trimParam(params.supplierEmail, 254);
    if (supplierEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supplierEmail)) throw new Error("invalid_supplier_email");
    if (!supplierEmail) throw new Error("invalid_supplier_email");
    if (isInternalLegacySupplier({ email: supplierEmail, companyName: supplierName })) {
      throw new Error("internal_film_maker_rejected");
    }
    const exemptionReason = trimParam(params.reason, 1000);
    if (!exemptionReason) throw new Error("legacy_exempt_reason_required");
    await db.run(
      "UPDATE film_orders SET supplier_name = ?, supplier_email = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [supplierName, supplierEmail, now, actorEmail, id],
    );
    await addEvent(
      db,
      id,
      "legacy_supplier_reconciliation",
      `レガシー除外（初期供給者設定）: ${exemptionReason} / ${supplierName || "-"} / ${supplierEmail}`,
      actorEmail,
    );
  } else if (action === "select-film-maker") {
    // 選択のみで連絡/送信は行わない。G003以降の遷移は既存ガードに従う。
    const makerId = Number(params.makerId);
    const { selectFilmMakerForOrder } = await import("./film-maker-store");
    await selectFilmMakerForOrder(id, makerId, actorEmail);
  } else if (action === "mark-ordered") {
    if (order.status !== "pending") throw new Error("invalid_status_transition");
    await db.run(
      "UPDATE film_orders SET status = 'ordered', ordered_at = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [now, now, actorEmail, id],
    );
    await addEvent(db, id, "status", `成約 → 発注書送信済み（${buyerCompanyLabelOfOrder(order)}からメール送信）`, actorEmail);
  } else if (action === "update-supplier-order-note") {
    if (order.status !== "final_approved") throw new Error("invalid_status_transition");
    const supplierOrderNote = trimParam(params.supplierOrderNote, 4000);
    await db.run(
      "UPDATE film_orders SET supplier_order_note = ?, updated_at = ?, updated_by_email = ? WHERE id = ?",
      [supplierOrderNote, now, actorEmail, id],
    );
    await addEvent(db, id, "supplier_order", `発注時メモ更新${supplierOrderNote ? `: ${supplierOrderNote}` : "（空欄）"}`, actorEmail);
  } else if (action === "preview-supplier-po") {
    if (order.status !== "final_approved") throw new Error("invalid_status_transition");
    const current = await getFilmOrder(id);
    if (!current) throw new Error("film_order_update_failed");
    const preview = await buildSupplierPurchaseOrderPreview(
      current,
      origin,
      typeof params.supplierOrderNote === "string"
        ? trimParam(params.supplierOrderNote, 4000)
        : order.supplier_order_note,
      typeof params.mailSubject === "string" ? trimParam(params.mailSubject, 500) : undefined,
      typeof params.mailBody === "string" ? params.mailBody.slice(0, 20000) : undefined,
    );
    return { order: current, preview };
  } else if (action === "set-customer-design-not-required") {
    if (!["pending","requested","received","correction_requested"].includes(order.customerDesign.status)) {
      throw new Error("invalid_status_transition");
    }
    const reason = trimParam(params.reason, 2000);
    if (!reason) throw new Error("customer_design_not_required_reason_required");
    await db.run(`
      UPDATE film_orders
      SET customer_design_status = 'not_required', customer_design_correction_reason = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [reason, now, actorEmail, id]);
    await addEvent(db, id, "customer_design", `顧客デザイン不要に設定: ${reason}`, actorEmail);
  } else if (action === "confirm-customer-design") {
    if (order.customerDesign.status !== "received") throw new Error("invalid_status_transition");
    const current = await getFilmOrder(id);
    if (!current?.files.some((file) => file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai"))) {
      throw new Error("customer_design_file_required");
    }
    await db.run(`
      UPDATE film_orders
      SET customer_design_status = 'confirmed', customer_design_confirmed_at = ?, updated_at = ?, updated_by_email = ?
      WHERE id = ?
    `, [now, now, actorEmail, id]);
    await addEvent(db, id, "customer_design", "顧客デザインを確定", actorEmail);
  } else if (action === "register-receiving-extra") {
    if (order.status !== "receiving_registered" && order.status !== "proof_registered" && order.status !== "re_proof_requested") {
      throw new Error("invalid_status_transition");
    }
    const fileName = validFileName(params.fileName);
    if (!fileName) throw new Error("invalid_file_name");
    const fileUrl = validFileUrl(params.fileUrl);
    if (!fileUrl) throw new Error("invalid_file_url");
    await addFile(db, id, "receiving", fileName, fileUrl, trimParam(params.note, 1000), actorEmail);
    await addEvent(db, id, "file", `入稿データ追加: ${fileName}`, actorEmail);
  } else {
    throw new Error("unknown_action");
  }

  const result = await getFilmOrder(id);
  if (!result) throw new Error("film_order_update_failed");
  return { order: result };
}

export async function filmOrderExistsForQuotation(quotationId: number): Promise<boolean> {
  const db = await getDatabase();
  const row = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE quotation_id = ?", [quotationId]);
  return Boolean(row);
}

export interface CustomerShipToDestinationOption {
  id: number;
  label: string;
  companyName: string;
  department: string;
  contactName: string;
  postalCode: string;
  address: string;
  building: string;
  phone: string;
  email: string;
  note: string;
  isDefault: boolean;
}

export interface CustomerShipToFormValues {
  label: string;
  companyName: string;
  department: string;
  contactName: string;
  postalCode: string;
  address: string;
  building: string;
  phone: string;
  email: string;
  note: string;
}

export interface CustomerShipToRequestView {
  orderNumber: string;
  productName: string;
  customerName: string;
  customerCode: string;
  requestedAt: string | null;
  expiresAt: string;
  status: "not_provided" | "registered" | "confirmed";
  currentDestination: CustomerShipToFormValues | null;
  /** この注文に登録済みの納品先一覧（複数対応）。 */
  registeredDestinations: Array<{
    id: number;
    label: string;
    companyName: string;
    department: string;
    contactName: string;
    postalCode: string;
    address: string;
    building: string;
    phone: string;
  }>;
  defaultDestination: CustomerShipToFormValues | null;
  destinations: CustomerShipToDestinationOption[];
}

async function shipToCustomerCodeOf(order: FilmOrder): Promise<string> {
  if (order.customer_code) return order.customer_code;
  const { getQuotation } = await import("./quotation-store");
  const quotation = await getQuotation(order.quotation_id);
  const customerCode = typeof quotation?.payload.customerCode === "string"
    ? quotation.payload.customerCode.trim()
    : "";
  return customerCode;
}

function customerShipToDestinationOption(destination: CustomerDeliveryDestination): CustomerShipToDestinationOption {
  return {
    id: destination.id,
    label: destination.label,
    companyName: destination.companyName,
    department: destination.department,
    contactName: destination.contactName,
    postalCode: destination.postalCode,
    address: destination.address,
    building: destination.building,
    phone: destination.phone,
    email: destination.email,
    note: destination.note,
    isDefault: destination.isDefault,
  };
}

function customerShipToFormValuesOfDestination(destination: CustomerDeliveryDestination): CustomerShipToFormValues {
  return {
    label: destination.label,
    companyName: destination.companyName,
    department: destination.department,
    contactName: destination.contactName,
    postalCode: destination.postalCode,
    address: destination.address,
    building: destination.building,
    phone: destination.phone,
    email: destination.email,
    note: destination.note,
  };
}

/** 納品先の顧客マスタ解決順。K-コードなどは buyer と異なるオーナーで管理されているため両ドメインを試す。 */
export function shipToCustomerOwnerCandidatesOf(order: Pick<FilmOrder, "buyer_domain">): Array<"seven" | "kanei"> {
  const primary: "seven" | "kanei" = filmOrderBuyerDomainOf(order);
  return primary === "seven" ? ["seven", "kanei"] : ["kanei", "seven"];
}

async function customerShipToMasterOf(order: FilmOrder, customerCode: string): Promise<CustomerMaster | null> {
  for (const ownerDomain of shipToCustomerOwnerCandidatesOf(order)) {
    const master = await getCustomer(ownerDomain, customerCode);
    if (master) return master;
  }
  return null;
}

/** 住所録の保存先オーナー。顧客マスタが存在するドメイン（なければ buyer 側）を返す。 */
async function shipToAddressBookOwnerOf(order: FilmOrder, customerCode: string): Promise<"seven" | "kanei"> {
  for (const ownerDomain of shipToCustomerOwnerCandidatesOf(order)) {
    if (await getCustomer(ownerDomain, customerCode)) return ownerDomain;
  }
  return shipToCustomerOwnerCandidatesOf(order)[0];
}

/** 管理画面用: 顧客基本情報（初回登録時の住所）を納品先候補として返す。 */
export async function getFilmOrderCustomerBasicShipToDestination(orderId: number): Promise<ResolvedShipToDestination | null> {
  const order = await getFilmOrder(orderId);
  if (!order) throw new Error("film_order_not_found");
  const customerCode = await shipToCustomerCodeOf(order);
  if (!customerCode) return null;
  return customerBasicShipToDestinationOf(order, customerCode);
}

export async function getFilmOrderForShipToRequest(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<CustomerShipToRequestView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "customer_ship_to");
  if (!resolved) throw new Error("invalid_ship_to_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  const order = await getFilmOrder(resolved.orderId);
  if (!order) throw new Error("film_order_not_found");
  const customerCode = await shipToCustomerCodeOf(order);
  if (!customerCode) throw new Error("customer_code_required");
  const [master, destinations] = await Promise.all([
    customerShipToMasterOf(order, customerCode),
    (async () => {
      // 顧客マスタのオーナードメインに関係なく住所録候補を返す（K-コードは金井所有のケースがある）。
      const lists = await Promise.all(
        shipToCustomerOwnerCandidatesOf(order).map((ownerDomain) => listDeliveryDestinations(ownerDomain, customerCode)),
      );
      return lists.flat();
    })(),
  ]);
  const defaultDestination = master
    ? {
      label: "",
      companyName: master.customerName,
      department: "",
      contactName: master.customerContact,
      postalCode: master.customerPostalCode,
      address: master.customerAddress,
      building: "",
      phone: master.customerTelephone,
      email: master.customerEmail,
      note: "",
    }
    : null;
  await addEvent(db, order.id, "token_access", "customer_ship_to request page viewed", "external:customer_ship_to");
  return {
    orderNumber: order.order_number,
    productName: order.product_name,
    customerName: order.customer_name,
    customerCode,
    requestedAt: order.shipTo.requestedAt,
    expiresAt: resolved.token.expires_at,
    status: order.shipTo.status,
    registeredDestinations: order.shipTo.destinations.map((destination) => ({
      id: destination.id,
      label: destination.label,
      companyName: destination.companyName,
      department: destination.department,
      contactName: destination.contactName,
      postalCode: destination.postalCode,
      address: destination.address,
      building: destination.building,
      phone: destination.phone,
    })),
    currentDestination: order.shipTo.companyName || order.shipTo.address
      ? {
        label: order.shipTo.label,
        companyName: order.shipTo.companyName,
        department: order.shipTo.department,
        contactName: order.shipTo.contactName,
        postalCode: order.shipTo.postalCode,
        address: order.shipTo.address,
        building: order.shipTo.building,
        phone: order.shipTo.phone,
        email: order.shipTo.email,
        note: order.shipTo.note,
      }
      : null,
    defaultDestination,
    destinations: destinations.map(customerShipToDestinationOption),
  };
}

export async function registerShipToFromCustomerToken(params: {
  token: string;
  destinationId?: unknown;
  values?: unknown;
  saveAsDefault?: unknown;
  request?: { headers: { get(name: string): string | null } };
  origin?: unknown;
}): Promise<{ order: FilmOrderView; destination: CustomerDeliveryDestination }> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "customer_ship_to");
  if (!resolved) throw new Error("invalid_ship_to_token");
  const order = await getFilmOrder(resolved.orderId);
  if (!order) throw new Error("film_order_not_found");
  if (order.shipTo.status === "confirmed") throw new Error("ship_to_already_confirmed");
  const customerCode = await shipToCustomerCodeOf(order);
  if (!customerCode) throw new Error("customer_code_required");
  const ownerCandidates = shipToCustomerOwnerCandidatesOf(order);

  const destinationId = Number(params.destinationId);
  let destination: CustomerDeliveryDestination;
  let destinationOwner: "seven" | "kanei" = ownerCandidates[0];
  if (Number.isInteger(destinationId) && destinationId > 0) {
    let selected: CustomerDeliveryDestination | null = null;
    for (const candidateOwner of ownerCandidates) {
      selected = await getDeliveryDestination(candidateOwner, customerCode, destinationId);
      if (selected) {
        destinationOwner = candidateOwner;
        break;
      }
    }
    if (!selected) throw new Error("delivery_destination_not_found");
    destination = selected;
  } else {
    const input = validateDeliveryDestinationInput({
      ...(typeof params.values === "object" && params.values ? params.values as Record<string, unknown> : {}),
      isDefault: params.saveAsDefault === true,
    });
    if (!input) throw new Error("invalid_ship_to");
    const addressBookOwner = await shipToAddressBookOwnerOf(order, customerCode);
    destination = await upsertDeliveryDestination(addressBookOwner, customerCode, input);
    destinationOwner = addressBookOwner;
  }
  destination = await markDeliveryDestinationUsed(destinationOwner, customerCode, destination.id) ?? destination;
  const registeredBy = `customer:${resolved.token.audience_email || "external"}`;
  const existingRows = await listFilmOrderShipToDestinations(db, order.id);
  const existingDestinationRows = existingRows.map((row) => ({
    destinationId: row.destinationId,
    label: row.label,
    companyName: row.companyName,
    department: row.department,
    contactName: row.contactName,
    postalCode: row.postalCode,
    address: row.address,
    building: row.building,
    phone: row.phone,
    email: row.email,
    note: row.note,
  }));
  const result = await runFilmOrderAction(order.id, "ship-to-registered", {
    shipToDestinations: [...existingDestinationRows, destination],
    shipToRegisteredBy: registeredBy,
    customerEmail: resolved.token.audience_email ?? undefined,
    token: params.token,
    ipAddressHash: params.request ? externalClientIpHash(params.request) : null,
    origin: resolveFilmOrderExternalOrigin(params.origin),
    expectedUpdatedAt: order.updated_at,
  }, registeredBy);
  return { order: result.order, destination };
}

export async function getFilmOrderForCustomerProofReview(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "customer_proof_review");
  if (!resolved) throw new Error("invalid_customer_proof_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  const order = await getFilmOrder(resolved.orderId);
  if (
    !order
    || !["proof_registered","re_proof_requested"].includes(order.status)
    || !["requested","approved","correction_requested"].includes(order.customerProof.status)
  ) throw new Error("invalid_customer_proof_token");
  return order;
}

export async function decideCustomerProofReview(params: {
  token: string;
  decision: "approve" | "correction";
  reason?: string;
  request?: { headers: { get(name: string): string | null } };
  origin?: unknown;
}): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "customer_proof_review");
  if (!resolved) throw new Error("invalid_customer_proof_token");
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [resolved.orderId]);
  if (!row) throw new Error("invalid_customer_proof_token");
  const result = await runFilmOrderAction(resolved.orderId, "customer-proof-decision", {
    decision: params.decision,
    customerMessage: params.reason,
    token: params.token,
    ipAddressHash: params.request ? externalClientIpHash(params.request) : null,
    origin: resolveFilmOrderExternalOrigin(params.origin),
    expectedUpdatedAt: row.updated_at,
  }, "customer");
  return result.order;
}

export async function getFilmOrderForCustomerDesign(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "customer_design");
  if (!resolved) throw new Error("invalid_customer_design_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  const order = await getFilmOrder(resolved.orderId);
  if (!order || !["requested","received","correction_requested"].includes(order.customerDesign.status)) {
    throw new Error("invalid_customer_design_token");
  }
  return order;
}

export async function getFilmOrderForMakerCustomerDesign(
  token: string,
  request?: { headers: { get(name: string): string | null } },
): Promise<FilmOrderView | null> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, token, "maker_customer_design");
  if (!resolved) throw new Error("invalid_maker_customer_design_token");
  await markFilmOrderExternalTokenUseForLifecycle(db, resolved.token, request);
  return getFilmOrder(resolved.orderId);
}

export async function recordMakerCustomerDesignDownload(params: {
  request: { headers: { get(name: string): string | null } };
  token: string;
  fileId: string;
  order: FilmOrderView;
}): Promise<boolean> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "maker_customer_design");
  if (!resolved) return false;
  const allowed = params.order.files.some((file) =>
    file.category === "customer_design"
    && file.url.includes(`/d/${params.fileId}/`)
  );
  await addEvent(
    db,
    resolved.orderId,
    "token_access",
    `maker_customer_design download ${allowed ? "allowed" : "denied"}: ${params.fileId}`,
    "external:maker_customer_design",
  );
  return allowed;
}

export function nextCustomerDesignFileName(
  order: FilmOrderView,
  originalFileName: string,
): string {
  const version = order.files.filter((file) => file.category === "customer_design").length + 1;
  const normalized = validFileName(originalFileName);
  if (!normalized) throw new Error("invalid_file_name");
  const dot = normalized.lastIndexOf(".");
  const extension = dot > -1 ? normalized.slice(dot).toLowerCase() : "";
  const base = (dot > -1 ? normalized.slice(0, dot) : normalized)
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "design";
  return `${order.order_number}_design_v${version}_${base}${extension}`;
}

export async function registerCustomerDesignFromUploadToken(params: {
  token: string;
  fileName: string;
  fileUrl: string;
  uploader?: string;
  note?: string;
  guideAcknowledged?: boolean;
  metadata?: UploadFileMetadata;
  request?: { headers: { get(name: string): string | null } };
  origin?: unknown;
}): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "customer_design");
  if (!resolved) throw new Error("invalid_customer_design_token");
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [resolved.orderId]);
  if (!row) throw new Error("film_order_not_found");
  const order = mapOrder(row);
  const stored = await getFilmOrder(resolved.orderId);
  const hasAiFile = Boolean(stored?.files.some((file) => file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai")));
  assertCustomerDesignUploadPolicy(order, params.fileName, undefined, hasAiFile);
  if (params.guideAcknowledged !== true) throw new Error("upload_guide_acknowledgement_required");
  // An existing AI upload already produced the one-time maker handoff. A supplemental
  // PDF is durable file evidence only and must not duplicate that handoff.
  if (hasAiFile && params.fileName.toLowerCase().endsWith(".pdf")) {
    await db.transaction(async (tx) => {
      await addFile(
        tx,
        resolved.orderId,
        "customer_design",
        params.fileName,
        params.fileUrl,
        params.note ?? "",
        "machine:customer",
        {
          ...params.metadata,
          uploadedVia: params.metadata?.uploadedVia ?? "customer_design",
        },
      );
      await addEvent(
        tx,
        resolved.orderId,
        "status",
        "追加確認用PDFを受入しました。",
        "machine:customer",
      );
      await tx.run(`
        UPDATE film_orders
        SET customer_design_status='received', customer_design_received_at=?, current_proof_round=current_proof_round+1, updated_at=?, updated_by_email=?
        WHERE id=? AND customer_design_status IN ('requested','correction_requested')
      `, [new Date().toISOString(), new Date().toISOString(), "machine:customer", resolved.orderId]);
    });
    const updated = await getFilmOrder(resolved.orderId);
    if (!updated) throw new Error("film_order_update_failed");
    return updated;
  }
  const result = await runFilmOrderAction(resolved.orderId, "customer-design-received", {
    customerDesignFileName: params.fileName,
    customerDesignFileUrl: params.fileUrl,
    customerDesignNote: params.note,
    customerDesignFileSizeBytes: params.metadata?.fileSizeBytes,
    customerDesignContentType: params.metadata?.contentType,
    customerDesignChecksum: params.metadata?.checksum,
    customerDesignChecksumAlgorithm: params.metadata?.checksumAlgorithm,
    customerDesignDriveFileId: params.metadata?.driveFileId,
    customerDesignUploadedVia: params.metadata?.uploadedVia ?? "customer_design",
    token: params.token,
    ipAddressHash: params.request ? externalClientIpHash(params.request) : null,
    origin: resolveFilmOrderExternalOrigin(params.origin),
  }, "machine:customer");
  return result.order;
}

export interface InternalCustomerDesignIntakeTarget {
  quotationId: number;
  quotationNumber: string;
  ownerDomain: "seven" | "kanei";
  order: FilmOrderView;
}

export async function getFilmOrderForInternalIntakeUpload(
  quotationId: number,
): Promise<InternalCustomerDesignIntakeTarget | null> {
  if (!Number.isInteger(quotationId) || quotationId <= 0) return null;
  const db = await getDatabase();
  const row = await db.get<FilmOrderRow & {
    owner_domain: string | null;
    internal_quotation_number: string;
  }>(`
    SELECT
      film_orders.*,
      quotations.owner_domain,
      quotations.quotation_number AS internal_quotation_number
    FROM quotations
    JOIN film_orders ON film_orders.quotation_id = quotations.id
    WHERE quotations.id = ?
  `, [quotationId]);
  if (!row) return null;
  const ownerDomain = quotationOwnerDomainFromStorage(row.owner_domain);
  if (ownerDomain === "unresolved") return null;
  const order = await getFilmOrder(Number(row.id));
  if (!order) return null;
  return {
    quotationId,
    quotationNumber: row.internal_quotation_number,
    ownerDomain,
    order,
  };
}

export async function registerCustomerDesignFromInternalIntake(params: {
  quotationId: number;
  fileName: string;
  fileUrl: string;
  uploader?: string;
  note?: string;
  guideAcknowledged?: boolean;
  metadata?: UploadFileMetadata;
  request?: { headers: { get(name: string): string | null } };
  origin?: unknown;
}): Promise<FilmOrderView> {
  const target = await getFilmOrderForInternalIntakeUpload(params.quotationId);
  if (!target) throw new Error("film_order_not_found");
  const order = target.order;
  const hasAiFile = order.files.some((file) =>
    file.category === "customer_design" && file.file_name.toLowerCase().endsWith(".ai")
  );
  assertCustomerDesignUploadPolicy(order, params.fileName, undefined, hasAiFile);
  if (params.guideAcknowledged !== true) throw new Error("upload_guide_acknowledgement_required");
  // AI transfers through the lifecycle action. Once AI is present, a supplemental PDF
  // is already within the same received intake and must not restart that lifecycle.
  if (hasAiFile && params.fileName.toLowerCase().endsWith(".pdf")) {
    const db = await getDatabase();
    await addFile(
      db,
      order.id,
      "customer_design",
      params.fileName,
      params.fileUrl,
      params.note ?? "",
      "machine:customer",
      {
        ...params.metadata,
        uploadedVia: params.metadata?.uploadedVia ?? "internal_customer_design",
      },
    );
    await addEvent(
      db,
      order.id,
      "status",
      "追加確認用PDFを受入しました。",
      "machine:customer",
    );
      await db.run(`
        UPDATE film_orders
        SET customer_design_status='received', customer_design_received_at=?, current_proof_round=current_proof_round+1, updated_at=?, updated_by_email=?
        WHERE id=? AND customer_design_status IN ('requested','correction_requested')
      `, [new Date().toISOString(), new Date().toISOString(), "machine:customer", order.id]);
    const updated = await getFilmOrder(order.id);
    if (!updated) throw new Error("film_order_update_failed");
    return updated;
  }
  const result = await runFilmOrderAction(target.order.id, "customer-design-received", {
    customerDesignFileName: params.fileName,
    customerDesignFileUrl: params.fileUrl,
    customerDesignNote: params.note,
    customerDesignFileSizeBytes: params.metadata?.fileSizeBytes,
    customerDesignContentType: params.metadata?.contentType,
    customerDesignChecksum: params.metadata?.checksum,
    customerDesignChecksumAlgorithm: params.metadata?.checksumAlgorithm,
    customerDesignDriveFileId: params.metadata?.driveFileId,
    customerDesignUploadedVia: params.metadata?.uploadedVia ?? "internal_customer_design",
    ipAddressHash: params.request ? externalClientIpHash(params.request) : null,
    origin: resolveFilmOrderExternalOrigin(params.origin),
  }, "machine:customer");
  return result.order;
}

export async function registerProofFromUploadToken(params: {
  token: string;
  fileName: string;
  fileUrl: string;
  pdfFileName?: string;
  pdfFileUrl?: string;
  uploader?: string;
  note?: string;
  metadata?: UploadFileMetadata;
  pdfMetadata?: UploadFileMetadata;
  request?: { headers: { get(name: string): string | null } };
  origin?: unknown;
}): Promise<FilmOrderView> {
  const db = await getDatabase();
  const resolved = await resolveExternalToken(db, params.token, "supplier_proof");
  if (!resolved) throw new Error("invalid_proof_token");
  const row = await db.get<FilmOrderRow>("SELECT * FROM film_orders WHERE id = ?", [resolved.orderId]);
  if (!row) throw new Error("film_order_not_found");
  const order = mapOrder(row);
  assertSupplierProofUploadPolicy(order, params.fileName);
  const result = await runFilmOrderAction(resolved.orderId, "register-proof", {
    fileName: params.fileName,
    fileUrl: params.fileUrl,
    pdfFileName: params.pdfFileName,
    pdfFileUrl: params.pdfFileUrl,
    note: params.note,
    token: params.token,
    ipAddressHash: params.request ? externalClientIpHash(params.request) : null,
    origin: resolveFilmOrderExternalOrigin(params.origin),
  }, "machine:maker");
  return result.order;
}
