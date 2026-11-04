import { createHash, randomUUID } from "node:crypto";
import {
  filmDesignNotificationTo,
  getDatabaseForFilmMakerStore,
  issueStagedFilmOrderExternalToken,
  promoteStagedFilmOrderExternalTokens,
  revokeStagedFilmOrderExternalTokens,
} from "./film-orders";
import {
  persistFilmOrderMailEnvelopes,
  promoteFilmOrderMailDrafts,
  recordFilmOrderMailAttemptOutcome,
  skipFilmOrderMailDrafts,
  startFilmOrderMailAttempt,
  type FilmOrderMailAttemptStatus,
} from "./film-order-mail-outbox";
import { getFilmOrderMailOutbox, verifyFilmOrderMailEnvelope } from "./film-order-mail-outbox";
import {
  buildFilmOrderNotifications,
  filmOrderNotificationEnvelopeHash,
  interpolateFilmOrderNotificationTemplate,
  validateFilmOrderNotification,
  type FilmOrderNotificationEnvelope,
  type FilmOrderNotificationEvent,
  type FilmOrderNotificationInput,
  type FilmOrderNotificationLink,
  type FilmOrderNotificationLinkKey,
} from "./film-order-notifications";
import {
  assertFilmOrderActionGuard,
  filmOrderStageOf,
  type FilmOrderActorRole,
  type FilmOrderGuardInput,
  type FilmOrderStageInput,
  type FilmWorkflowAction,
} from "./film-order-stage";
import { sendMail } from "./mailer";
import { getStrictMailSettings, interpolateMailTemplate, parseStrictMailSettings, resolveMailTemplate, type MailSettings } from "./mail-settings";
import type { SqlClient } from "./db";
import type { FilmOrderFileRecord } from "./film-order-shared";

export type FilmOrderLifecycleWorkflowAction =
  | "register-receiving"
  | "send-proof-notice"
  | "rotate-supplier-proof-token"
  | "register-proof"
  | "send-customer-proof-review"
  | "record-customer-proof-approval"
  | "approve"
  | "request-re-proof"
  | "send-po"
  | "resend-supplier-links"
  | "resend-receiving-notice"
  | "request-production-plan"
  | "request-ship-to-registration"
  | "ship-to-registered"
  | "request-customer-design-upload"
  | "request-customer-design-correction"
  | "customer-design-received"
  | "production-plan-request"
  | "update-eta"
  | "report-shipment"
  | "report-delivery"
  | "confirm-film-receipt"
  | "customer-proof-decision";

export type FilmOrderMailActionOrigin = `${"http" | "https"}://${string}`;

export interface FilmOrderMailPrepareCommand {
  orderId: number;
  action: FilmOrderLifecycleWorkflowAction;
  actorEmail: string;
  origin: FilmOrderMailActionOrigin;
  expectedUpdatedAt?: string;
  note?: string;
  supplierMessage?: string;
  supplierOrderNote?: string;
  aiFileName?: string;
  aiFileUrl?: string;
  pdfFileName?: string;
  pdfFileUrl?: string;
  proofFileName?: string;
  proofFileUrl?: string;
  proofPdfFileName?: string;
  proofPdfFileUrl?: string;
  etaDate?: string;
  deliveryDate?: string;
  deliveryKind?: "shipment" | "delivery";
  carrier?: string;
  trackingNumber?: string;
  decision?: "approve" | "correction";
  customerMessage?: string;
  customerCode?: string;
  customerEmail?: string;
  shipToDestinations?: Array<Record<string, unknown>>;
  approverName?: string;
  evidence?: string;
  offlineEvidence?: string;
  offlineReason?: string;
  receivedNote?: string;
  documentName?: string;
  documentUrl?: string;
  productionPlanStartDate?: string;
  productionPlanEndDate?: string;
  shipToRequested?: boolean;
  shipToRegisteredBy?: string;
  tokenValue?: string;
  finalFileName?: string;
  finalFileUrl?: string;
  customerDesignFileName?: string;
  customerDesignFileUrl?: string;
  customerDesignNote?: string;
  ipAddressHash?: string | null;
}

type FilmOrderMailTokenPurpose =
  | "supplier_proof"
  | "supplier_po"
  | "customer_proof_review"
  | "customer_ship_to"
  | "customer_design"
  | "maker_eta";

interface FilmOrderMailStagedToken {
  linkKey: FilmOrderNotificationLinkKey;
  tokenHash: string;
  url: string;
  expiresAt: string;
}

export interface FilmOrderMailPreview {
  dispatchGroupId: string;
  orderId: number;
  command: FilmOrderMailPrepareCommand;
  event: FilmOrderNotificationEvent;
  workflowCompleted: false;
  envelopes: Array<Pick<
    FilmOrderNotificationEnvelope,
    "audience" | "intendedTo" | "cc" | "language" | "subject" | "body" | "links" | "attachments" | "contentHash" | "effectiveTemplateIdentity"
  >>;
  stagedTokens: Array<Pick<FilmOrderMailStagedToken, "linkKey" | "url" | "expiresAt">>;
  stagedTokenHashes: readonly string[];
  warnings: string[];
}

export interface FilmOrderMailAudienceOutcome {
  audience: FilmOrderNotificationEnvelope["audience"];
  attemptCount: number;
  status: FilmOrderMailAttemptStatus;
  intendedTo: string;
  actualTo: string | null;
  recipientOverridden: boolean;
  smtpMessageId: string | null;
  errorCode: string | null;
  subject: string;
  body: string;
}

export interface FilmOrderMailConfirmResult {
  dispatchGroupId: string;
  workflowCompleted: boolean;
  notificationCompleted: boolean;
  outcomes: FilmOrderMailAudienceOutcome[];
}

const ACTION_EVENTS: Record<FilmOrderLifecycleWorkflowAction, FilmOrderNotificationEvent> = {
  "register-receiving": "receiving_data_request",
  "send-proof-notice": "maker_proof_request",
  "rotate-supplier-proof-token": "maker_proof_request",
  "register-proof": "proof_received",
  "send-customer-proof-review": "customer_proof_review",
  "record-customer-proof-approval": "final_approval",
  approve: "final_approval",
  "request-re-proof": "re_proof_request",
  "send-po": "supplier_purchase_order",
  "resend-supplier-links": "link_resend",
  "resend-receiving-notice": "receiving_data_request",
  "request-production-plan": "production_plan_request",
  "request-ship-to-registration": "ship_to_request",
  "ship-to-registered": "ship_to_registered",
  "request-customer-design-upload": "customer_design_upload",
  "request-customer-design-correction": "customer_design_correction",
  "customer-design-received": "customer_design_received",
  "production-plan-request": "production_plan_request",
  "update-eta": "eta_update",
  "report-shipment": "shipment_report",
  "report-delivery": "delivery_report",
  "confirm-film-receipt": "receipt_completion",
  "customer-proof-decision": "customer_proof_decision",
};

const ACTION_ROLES: Record<FilmOrderLifecycleWorkflowAction, "buyer" | "kanei" | "maker" | "system" | "customer"> = {
  "register-receiving": "buyer",
  "send-proof-notice": "kanei",
  "rotate-supplier-proof-token": "kanei",
  "register-proof": "kanei",
  "send-customer-proof-review": "kanei",
  "record-customer-proof-approval": "kanei",
  approve: "buyer",
  "request-re-proof": "buyer",
  "send-po": "kanei",
  "resend-supplier-links": "kanei",
  "resend-receiving-notice": "buyer",
  "request-production-plan": "kanei",
  "request-ship-to-registration": "buyer",
  "ship-to-registered": "system",
  "request-customer-design-upload": "kanei",
  "request-customer-design-correction": "kanei",
  "customer-design-received": "customer",
  "production-plan-request": "kanei",
  "update-eta": "maker",
  "report-shipment": "maker",
  "report-delivery": "maker",
  "confirm-film-receipt": "buyer",
  "customer-proof-decision": "customer",
};

function eventRequiresMaker(event: FilmOrderNotificationEvent): boolean {
  return [
    "receiving_data_request",
    "maker_proof_request",
    "re_proof_request",
    "final_approval",
    "supplier_purchase_order",
    "eta_update",
    "shipment_report",
    "delivery_report",
    "receipt_completion",
    "link_resend",
  ].includes(event);
}

interface MakerSnapshotJson {
  id?: number | string;
  companyName?: string;
  contactName?: string;
  email?: string;
  language?: "ja" | "ko";
  isActive?: boolean | number;
  procurementRoute?: string;
  printMethod?: string;
}

interface RawOrder {
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
  film_maker_id: number | null;
  film_maker_snapshot_json: string | null;
  supplier_resolution: "legacy_unresolved" | "master_selected" | "legacy_exempt";
  supplier_name: string;
  supplier_email: string;
  seven_contact_email: string;
  po_sent_at: string | null;
  eta_updated_at: string | null;
  eta_date: string | null;
  eta_token: string | null;
  film_shipped_on: string | null;
  film_shipped_at: string | null;
  film_delivered_at: string | null;
  film_delivered_on: string | null;
  film_received_at: string | null;
  ship_to_status: "not_provided" | "registered" | "confirmed";
  status: NonNullable<FilmOrderGuardInput["status"]>;
  re_proof_count: number;
  ordered_at: string | null;
  receiving_registered_at: string | null;
  proof_registered_at: string | null;
  re_proof_requested_at: string | null;
  final_approved_at: string | null;
  customer_design_correction_count: number;
  customer_design_status: NonNullable<FilmOrderGuardInput["customerDesignStatus"]>;
  customer_proof_correction_count: number;
  customer_proof_status: NonNullable<FilmOrderGuardInput["customerProofStatus"]>;
  supplier_approval_status: "pending" | "approved" | "legacy_exempt";
  supplier_approval_at: string | null;
  buyer_approval_status: "pending" | "approved";
  buyer_approval_at: string | null;
  updated_at: string;
}

const STAGE_GUARD_ACTIONS: readonly FilmWorkflowAction[] = [
  "register-receiving", "send-proof-notice", "rotate-supplier-proof-token", "register-proof",
  "send-customer-proof-review", "record-customer-proof-approval", "approve", "request-re-proof",
  "send-po", "resend-supplier-links", "update-eta", "report-shipment", "report-delivery", "confirm-film-receipt", "resend-receiving-notice",
];

function assertLifecycleGuard(
  guard: FilmOrderGuardInput,
  action: FilmOrderLifecycleWorkflowAction,
  actorRole: FilmOrderActorRole,
): void {
  if ((STAGE_GUARD_ACTIONS as readonly string[]).includes(action)) {
    assertFilmOrderActionGuard(guard, action as FilmWorkflowAction, actorRole);
  }
  assertCustomLifecycleGuard(guard, action);
}

function assertCustomLifecycleGuard(guard: FilmOrderGuardInput, action: FilmOrderLifecycleWorkflowAction): void {
  const fail = (code: string): void => { throw new Error(code); };
  if (action === "request-ship-to-registration" && (guard.status === "pending" || guard.shipToStatus === "confirmed")) fail("invalid_status_transition");
  if (action === "ship-to-registered" && !["not_provided", "registered"].includes(guard.shipToStatus ?? "")) fail("invalid_status_transition");
  if (action === "request-customer-design-upload" && !["pending", "ordered"].includes(guard.status ?? "") && !(guard.customerDesignStatus === "received")) fail("invalid_status_transition");
  if (action === "request-customer-design-correction" && guard.customerDesignStatus !== "received") fail("invalid_status_transition");
  if (action === "customer-design-received" && !["requested", "correction_requested"].includes(guard.customerDesignStatus ?? "")) fail("invalid_status_transition");
  if (action === "request-production-plan" && !guard.poSentAt) fail("invalid_status_transition");
  if (action === "resend-receiving-notice" && guard.status !== "receiving_registered") fail("invalid_status_transition");
  if (action === "customer-proof-decision" && (guard.status !== "proof_registered" || guard.customerProofStatus !== "requested")) fail("invalid_customer_proof_decision");
}

function guardOf(row: RawOrder, files: FilmOrderFileRecord[], action: FilmOrderLifecycleWorkflowAction): FilmOrderGuardInput {
  const receivingAi = files.some((file) => file.category === "receiving" && file.file_name.toLowerCase().endsWith(".ai"));
  const receivingPdf = files.some((file) => file.category === "receiving" && file.file_name.toLowerCase().endsWith(".pdf"));
  const parsed = row.film_maker_snapshot_json ? JSON.parse(row.film_maker_snapshot_json) as MakerSnapshotJson : null;
  const packetAction = ["register-receiving", "send-proof-notice", "rotate-supplier-proof-token", "request-re-proof", "send-po", "resend-supplier-links", "resend-receiving-notice"].includes(action);
  return {
    id: row.id,
    status: row.status,
    orderedAt: row.ordered_at,
    receivingRegisteredAt: row.receiving_registered_at,
    proofRegisteredAt: row.proof_registered_at,
    reProofRequestedAt: row.re_proof_requested_at,
    finalApprovedAt: row.final_approved_at,
    customerDesignStatus: row.customer_design_status,
    customerProofStatus: row.customer_proof_status,
    supplierApprovalStatus: row.supplier_approval_status,
    supplierApprovalAt: row.supplier_approval_at,
    buyerApprovalStatus: row.buyer_approval_status,
    buyerApprovalAt: row.buyer_approval_at,
    poSentAt: row.po_sent_at,
    etaUpdatedAt: row.eta_updated_at,
    shippedAt: row.film_shipped_at,
    deliveredAt: row.film_delivered_at,
    receivedAt: row.film_received_at,
    procurementRoute: row.procurement_route,
    printingMethod: row.printing_method,
    supplierResolution: row.supplier_resolution,
    supplierEmail: row.supplier_email,
    makerId: row.film_maker_id,
    makerSnapshot: parsed ? {
      id: parsed.id,
      email: parsed.email,
      isActive: parsed.isActive,
      procurementRoute: parsed.procurementRoute,
      printMethod: parsed.printMethod,
    } : null,
    shipToStatus: row.ship_to_status,
    receivingAiRegistered: action === "register-receiving" ? false : packetAction && receivingAi,
    receivingPdfRegistered: action === "register-receiving" ? false : packetAction && receivingPdf,
    customerProofPdfRegistered: files.some((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf")),
  };
}

async function lifecycleMailSettingsOf(tx: SqlClient): Promise<MailSettings> {
  let row: { settings_json: string } | undefined;
  const present = tx.dialect === "postgres"
    ? Boolean((await tx.get<{ present: number | null }>("SELECT TO_REGCLASS('mail_settings') AS present"))?.present)
    : Boolean(await tx.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mail_settings'",
    ));
  if (!present) {
    return defaultMailSettings();
  }
  row = await tx.get<{ settings_json: string }>("SELECT settings_json FROM mail_settings WHERE id=1");
  if (!row) return defaultMailSettings();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.settings_json);
  } catch {
    throw new Error("film_order_mail_settings_corrupted");
  }
  return parseStrictMailSettings(parsed);
}

function strictMakerSnapshot(row: RawOrder): {
  id: number;
  companyName: string;
  contactName: string;
  email: string;
  language: "ja" | "ko";
  isActive: boolean;
  procurementRoute: string;
  printMethod: string;
  source: string;
} | null {
  if (!row.film_maker_snapshot_json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.film_maker_snapshot_json);
  } catch {
    throw new Error("film_maker_snapshot_corrupted");
  }
  const value = parsed as Partial<MakerSnapshotJson> | null;
  if (
    !value || typeof value.id !== "number" || !value.companyName || typeof value.contactName !== "string"
    || typeof value.email !== "string" || (value.language !== "ja" && value.language !== "ko")
    || !(value.isActive === true || value.isActive === 1)
    || typeof value.procurementRoute !== "string" || typeof value.printMethod !== "string"
    || !value.email.trim()
  ) throw new Error("film_maker_snapshot_invalid");
  return {
    id: value.id,
    companyName: value.companyName,
    contactName: value.contactName,
    email: value.email,
    language: value.language,
    isActive: value.isActive === true || value.isActive === 1,
    procurementRoute: value.procurementRoute,
    printMethod: value.printMethod,
    source: row.film_maker_snapshot_json,
  };
}

function latestMailAttachments(files: readonly FilmOrderFileRecord[]): FilmOrderNotificationInput["attachments"] {
  const selected = new Map<string, FilmOrderFileRecord>();
  const order = (file: FilmOrderFileRecord): readonly [number, string, number] => [
    Number(file.version ?? 0),
    file.created_at,
    Number(file.id ?? 0),
  ];
  const preferred = (candidate: FilmOrderFileRecord, current: FilmOrderFileRecord): boolean => {
    const [candidateVersion, candidateCreated, candidateId] = order(candidate);
    const [currentVersion, currentCreated, currentId] = order(current);
    if (candidateVersion !== currentVersion) return candidateVersion > currentVersion;
    if (candidateCreated !== currentCreated) return candidateCreated > currentCreated;
    return candidateId > currentId;
  };
  for (const file of files) {
    const extension = file.file_name.toLowerCase().endsWith(".ai") ? "ai" : file.file_name.toLowerCase().endsWith(".pdf") ? "pdf" : "";
    if (!extension) continue;
    const key = `${file.category}:${extension}`;
    const current = selected.get(key);
    if (!current || preferred(file, current)) selected.set(key, file);
  }
  return [...selected.values()]
    .sort((left, right) => Number(left.id ?? 0) - Number(right.id ?? 0))
    .map((file) => ({ fileName: file.file_name, category: file.category, version: file.version, contentType: file.content_type ?? undefined }));
}

function stableFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]));
    }
    return item ?? null;
  };
  const encoded = JSON.stringify(canonical(value));
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function dispatchWarnings(settings: MailSettings): string[] {
  const warnings: string[] = [];
  if (settings.testMode.enabled) warnings.push("mail_test_mode_enabled");
  if (process.env.MAIL_RECIPIENT_OVERRIDE?.trim()) warnings.push("mail_environment_recipient_override_enabled");
  return warnings;
}

type LifecycleMailProjectionContext = {
  tx: SqlClient;
  raw: RawOrder;
  command: FilmOrderMailPrepareCommand;
  event: FilmOrderNotificationEvent;
  dispatchGroupId: string;
  links: FilmOrderNotificationInput["links"];
  currentFiles: FilmOrderFileRecord[];
  makerRecipient: string;
  customerRecipient: string;
};

async function projectLifecycleMail(context: LifecycleMailProjectionContext): Promise<{
  effective: FilmOrderNotificationEnvelope[];
  settings: MailSettings;
  input: FilmOrderNotificationInput;
}> {
  const maker = strictMakerSnapshot(context.raw);
  const settings = await lifecycleMailSettingsOf(context.tx);
  const input: FilmOrderNotificationInput = {
    orderId: context.raw.id,
    dispatchGroupId: context.dispatchGroupId,
    orderNumber: context.raw.order_number,
    productName: context.raw.product_name,
    productSpecification: context.command.action === "send-po" && context.command.supplierOrderNote
      ? `${specificationOf(context.raw)}; ${context.command.supplierOrderNote}`
      : specificationOf(context.raw),
    workflowStage: filmOrderStageOf(context.raw),
    recipients: {
      maker: context.makerRecipient,
      seven: context.raw.seven_contact_email,
      kanei: filmDesignNotificationTo(),
      customer: context.customerRecipient,
    },
    senderIdentity: {
      maker: "Kanei Trade Film Workflow",
      seven: "Kanei Trade Film Workflow",
      kanei: "Film Workflow System",
      customer: "Kanei Trade Film Workflow",
    },
    senderEmail: settings.sender.email,
    maker: maker ? {
      companyName: maker.companyName,
      contactName: maker.contactName,
      email: maker.email,
      language: maker.language,
    } : undefined,
    customerName: context.raw.customer_name,
    quotationNumber: context.raw.quotation_number,
    links: context.links,
    attachments: latestMailAttachments(context.currentFiles),
    customerMessage: context.command.customerMessage ?? undefined,
    customerReceivingInputRequired: false,
    customerEtaActionRequired: context.event === "eta_update" || context.event === "production_plan_request",
    linkResendAudiences: context.event === "link_resend" ? ["maker", "seven", "kanei"] : undefined,
    bindingFingerprint: stableFingerprint({ maker: maker?.source ?? null, templateSettings: settings.templates }),
  };
  const built = buildFilmOrderNotifications(context.event, input);
  if (!built.ok) throw new Error(`invalid_film_order_mail:${built.errors.map((issue) => `${issue.audience ?? "*"}:${issue.code}`).join(",")}`);
  const effective = built.envelopes.map((envelope) => {
    const override = settings.templates[envelope.effectiveTemplateIdentity.key] ?? settings.templates[envelope.templateKey];
    if (!override) return envelope;
    const variables = {
      orderNumber: envelope.orderNumber,
      productName: envelope.productName,
      productSpecification: envelope.productSpecification,
      workflowStage: envelope.workflowStage,
      customerName: input.customerName ?? "",
      quotationNumber: input.quotationNumber ?? "",
      makerCompanyName: input.maker?.companyName ?? "",
      deadlineAt: envelope.deadlineAt ?? "",
      originalSubject: envelope.subject,
      originalBody: envelope.body,
    };
    const resolved = resolveMailTemplate(settings, envelope.effectiveTemplateIdentity.key, { subject: envelope.subject, body: envelope.body }, variables);
    const candidate = {
      ...envelope,
      subject: interpolateMailTemplate(resolved.subject, variables),
      body: interpolateMailTemplate(resolved.body, variables),
      cc: override.cc ? [...new Set(override.cc)] : envelope.cc,
      effectiveTemplateIdentity: { ...envelope.effectiveTemplateIdentity, source: "override" as const },
    };
    const rendered = { ...candidate, contentHash: filmOrderNotificationEnvelopeHash(candidate) };
    const validation = validateFilmOrderNotification(rendered, {
      makerCompanyName: input.maker?.companyName,
      makerContact: [input.maker?.contactName, input.maker?.email].filter(Boolean).join(" "),
    });
    if (!validation.ok) throw new Error(`invalid_film_order_mail_template:${validation.issues.map((issue) => issue.code).join(",")}`);
    return rendered;
  });
  return { effective, settings, input };
}

function defaultMailSettings(): MailSettings {
  return {
    version: 1,
    sender: {
      name: process.env.FILM_MAIL_SENDER_NAME?.trim() || "Package Lab",
      email: process.env.FILM_MAIL_SENDER_EMAIL?.trim() || process.env.MAIL_FROM?.trim() || "",
    },
    globalCc: [],
    recipients: { design: "", seven: "", kaneiApprovals: "", supplierKorean: "", supplierJapanese: "" },
    testMode: { enabled: false, recipient: "" },
    templates: {},
  };
}

function specificationOf(row: RawOrder): string {
  return [row.film_composition, `${row.web_width_mm}mm web`, `${row.order_length_m}m`, `${row.pouch_quantity} pouches`, row.printing_method].filter(Boolean).join(", ");
}

async function customerRecipientOf(tx: SqlClient, quotationId: number): Promise<string> {
  const row = await tx.get<{ payload_json: string }>("SELECT payload_json FROM quotations WHERE id=?", [quotationId]);
  if (!row) return "";
  try {
    const payload = JSON.parse(row.payload_json) as { customerEmail?: unknown };
    return typeof payload.customerEmail === "string" ? payload.customerEmail.trim() : "";
  } catch {
    return "";
  }
}

async function loadLifecycleFiles(tx: SqlClient, orderId: number): Promise<FilmOrderFileRecord[]> {
  return tx.all<FilmOrderFileRecord>("SELECT * FROM film_order_files WHERE order_id=? ORDER BY created_at, id", [orderId]);
}

async function loadLifecycleOrder(tx: SqlClient, orderId: number): Promise<RawOrder> {
  const row = await tx.get<RawOrder>("SELECT * FROM film_orders WHERE id=?", [orderId]);
  if (!row) throw new Error("film_order_not_found");
  return row;
}

async function nextLifecycleFileVersion(
  tx: SqlClient,
  orderId: number,
  category: "receiving" | "proof",
): Promise<number> {
  const row = await tx.get<{ version: number | null }>(
    "SELECT MAX(version) AS version FROM film_order_files WHERE order_id=? AND category=?",
    [orderId, category],
  );
  return Math.max(1, Number(row?.version ?? 0) + 1);
}

async function lockLifecycleOrder(tx: SqlClient, orderId: number): Promise<RawOrder> {
  const row = await tx.get<RawOrder>(
    `SELECT * FROM film_orders WHERE id=?${tx.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    [orderId],
  );
  if (!row) throw new Error("film_order_not_found");
  return row;
}

export async function prepareFilmOrderMail(
  command: FilmOrderMailPrepareCommand,
  options: { client?: SqlClient } = {},
): Promise<FilmOrderMailPreview> {
  const db = options.client ?? await getDatabaseForFilmMakerStore();
  return db.transaction(async (tx) => {
    const raw = await loadLifecycleOrder(tx, command.orderId);
    if (command.expectedUpdatedAt && command.expectedUpdatedAt !== raw.updated_at) throw new Error("film_order_version_conflict");
    const currentFiles = await loadLifecycleFiles(tx, command.orderId);
    const guard = guardOf(raw, currentFiles, command.action);
    if (command.action === "register-receiving") {
      guard.receivingAiRegistered = /\.ai$/iu.test(command.aiFileName ?? "") && Boolean(command.aiFileUrl);
      guard.receivingPdfRegistered = /\.pdf$/iu.test(command.pdfFileName ?? "") && Boolean(command.pdfFileUrl);
    } else if (command.action === "register-proof") {
      guard.customerProofPdfRegistered = /\.pdf$/iu.test(command.proofPdfFileName ?? "");
    }
    assertLifecycleGuard(guard, command.action, ACTION_ROLES[command.action]);

    const event = ACTION_EVENTS[command.action];
    const requiresMaker = eventRequiresMaker(event);
    const maker = requiresMaker ? strictMakerSnapshot(raw) : raw.film_maker_snapshot_json ? strictMakerSnapshot(raw) : null;
    let makerRecipient = "";
    if (requiresMaker) {
      if (!maker) throw new Error("film_maker_resolution_required");
      if (!maker.isActive) throw new Error("film_maker_inactive");
      if (raw.film_maker_id == null || Number(raw.film_maker_id) !== maker.id) throw new Error("film_maker_not_found");
      if (maker.procurementRoute.toUpperCase() !== raw.procurement_route.toUpperCase()) throw new Error("film_maker_route_mismatch");
      if (maker.printMethod.toLowerCase() !== raw.printing_method.toLowerCase()) throw new Error("film_maker_print_method_mismatch");
      makerRecipient = maker.email.trim();
      if (!makerRecipient) throw new Error("supplier_destination_missing");
    }
    const customerRecipient = command.customerEmail?.trim() || await customerRecipientOf(tx, raw.quotation_id);
    const dispatchGroupId = `film-mail-${randomUUID()}`;
    const staged: FilmOrderMailStagedToken[] = [];
    const stageToken = async (
      linkKey: FilmOrderMailStagedToken["linkKey"],
      purpose: FilmOrderMailTokenPurpose,
      url: string,
      ttlDays: number,
      audienceEmail: string,
    ): Promise<void> => {
      const issued = await issueStagedFilmOrderExternalToken(tx, raw.id, purpose, command.actorEmail, { audienceEmail, dispatchGroupId, ttlDays });
      staged.push({ linkKey, tokenHash: issued.tokenHash, url: url.replace("__TOKEN__", encodeURIComponent(issued.token)), expiresAt: issued.expiresAt.toISOString() });
    };
    if (command.action === "request-ship-to-registration") {
      await stageToken("customer_design_upload", "customer_ship_to", `${command.origin}/film-orders/ship-to/__TOKEN__`, 30, customerRecipient);
    }
    if (command.action === "request-customer-design-upload" || command.action === "request-customer-design-correction") {
      await stageToken("customer_design_upload", "customer_design", `${command.origin}/film-orders/design-upload/__TOKEN__`, 30, customerRecipient);
    }
    if (event === "receiving_data_request" || event === "maker_proof_request" || event === "re_proof_request" || event === "link_resend") {
      const existingProofRows = await tx.all<{ links_json: string }>(`
        SELECT o.links_json FROM film_order_mail_outbox o
        WHERE o.order_id=? AND o.audience='maker' AND o.links_json LIKE '%maker_proof_upload%'
          AND (o.content_hash IN (SELECT token_hash FROM film_order_external_tokens WHERE film_order_id=? AND purpose='supplier_proof' AND token_state='active' AND revoked_at IS NULL))
        ORDER BY o.created_at DESC, o.id DESC LIMIT 1
      `, [raw.id, raw.id]);
      const existingLink = existingProofRows.flatMap((row) => {
        try {
          return JSON.parse(row.links_json) as Array<{ key: string; url: string }>;
        } catch {
          throw new Error("film_order_mail_outbox_corrupted:links_json");
        }
      }).find((link) => link.key === "maker_proof_upload");
      const existingToken = existingLink?.url.split("/upload/")[1]?.split("?")[0];
      const existingHash = existingToken ? (await import("./film-orders")).filmExternalTokenHashForTest(decodeURIComponent(existingToken)) : null;
      const activeExisting = existingHash
        ? await tx.get<{ token_hash: string }>(
          "SELECT token_hash FROM film_order_external_tokens WHERE film_order_id=? AND token_hash=? AND purpose='supplier_proof' AND token_state='active' AND revoked_at IS NULL",
          [raw.id, existingHash],
        )
        : null;
      if (activeExisting && existingToken && existingHash) {
        staged.push({ linkKey: "maker_proof_upload", tokenHash: existingHash, url: `${command.origin}/film-orders/upload/${encodeURIComponent(existingToken)}`, expiresAt: new Date(Date.now() + 86400000).toISOString() });
      } else {
        await stageToken("maker_proof_upload", "supplier_proof", `${command.origin}/film-orders/upload/__TOKEN__`, 30, makerRecipient);
      }
    }
    if (event === "supplier_purchase_order" || event === "link_resend") {
      await stageToken("maker_purchase_order", "supplier_po", `${command.origin}/film-orders/purchase-order/__TOKEN__`, 90, makerRecipient);
    }
    if (event === "supplier_purchase_order" || event === "eta_update") {
      await stageToken("maker_eta_report", "maker_eta", `${command.origin}/film-orders/eta/__TOKEN__`, 14, makerRecipient);
    }
    const proofPdf = currentFiles.filter((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf")).at(-1);
    if (event === "customer_proof_review" || event === "link_resend") {
      if (!customerRecipient) throw new Error("customer_email_required");
      if (!proofPdf) throw new Error("customer_proof_pdf_required");
      if (event === "customer_proof_review") {
        await stageToken("customer_proof_review", "customer_proof_review", `${command.origin}/film-orders/proof-review/__TOKEN__`, 30, customerRecipient);
      }
    }
    const links: FilmOrderNotificationLink[] = staged.map((token) => ({ key: token.linkKey, url: token.url }));
    if (["ship_to_request", "ship_to_registered", "customer_design_upload", "customer_design_correction", "customer_design_received", "production_plan_request"].includes(event)) {
      links.push({ key: "customer_design_upload", url: `${command.origin}/film-orders` });
    }
    links.push({ key: "maker_receiving_packet", url: `${command.origin}/film-orders` });
    links.push({ key: "seven_order_summary", url: `${command.origin}/film-orders` });
    links.push({ key: "kanei_order_management", url: `${command.origin}/film-orders` });
    const projection = await projectLifecycleMail({
      tx,
      raw,
      command,
      event,
      dispatchGroupId,
      links,
      currentFiles,
      makerRecipient,
      customerRecipient,
    });
    await persistFilmOrderMailEnvelopes(projection.effective, { requestedByEmail: command.actorEmail, envelopeStatus: "draft", client: tx });
    return {
      dispatchGroupId,
      orderId: raw.id,
      command,
      event,
      workflowCompleted: false,
      envelopes: projection.effective.map(({
        audience, intendedTo, cc, language, subject, body, links, attachments, contentHash, effectiveTemplateIdentity,
      }) => ({
        audience, intendedTo, cc, language, subject, body, links, attachments, contentHash, effectiveTemplateIdentity,
      })),
      stagedTokens: staged.map(({ linkKey, url, expiresAt }) => ({ linkKey, url, expiresAt })),
      stagedTokenHashes: staged.map((token) => token.tokenHash),
      warnings: dispatchWarnings(projection.settings),
    };
  });
}

export async function loadFilmOrderMailPreviewForConfirm(
  orderId: number,
  dispatchGroupId: string,
  command: FilmOrderMailPrepareCommand,
  options: { client?: SqlClient } = {},
): Promise<FilmOrderMailPreview> {
  const db = options.client ?? await getDatabaseForFilmMakerStore();
  const rows = await db.all<{ id: number; workflow_key: FilmOrderNotificationEvent }>(`
    SELECT id,workflow_key FROM film_order_mail_outbox
    WHERE order_id=? AND dispatch_group_id=? AND envelope_status='draft'
    ORDER BY id
  `, [orderId, dispatchGroupId]);
  if (!rows.length) throw new Error("film_order_mail_dispatch_not_found");
  const records = [];
  for (const row of rows) {
    const record = await getFilmOrderMailOutbox(Number(row.id), db);
    if (!record) throw new Error("film_order_mail_dispatch_not_found");
    verifyFilmOrderMailEnvelope(record);
    records.push(record);
  }
  const stagedTokenRows = await db.all<{ token_hash: string }>(
    `SELECT DISTINCT token_hash FROM film_order_external_tokens
     WHERE film_order_id=? AND dispatch_group_id=? AND token_state='staged'
     ORDER BY token_hash`,
    [orderId, dispatchGroupId],
  );
  return {
    dispatchGroupId,
    orderId,
    command,
    event: records[0]!.workflowKey,
    workflowCompleted: false,
    envelopes: records.map(({
      audience, intendedTo, cc, language, subject, body, links, attachments, contentHash, effectiveTemplateIdentity,
    }) => ({
      audience, intendedTo, cc, language, subject, body, links, attachments, contentHash, effectiveTemplateIdentity,
    })),
    stagedTokens: [],
    stagedTokenHashes: stagedTokenRows.map((row) => row.token_hash),
    warnings: [],
  };
}

export async function cancelFilmOrderMailForActor(
  orderId: number,
  dispatchGroupId: string,
  actorEmail: string,
  options: { client?: SqlClient } = {},
): Promise<{ skippedCount: number; revokedTokenCount: number; authoritativeStateChanged: false }> {
  const db = options.client ?? await getDatabaseForFilmMakerStore();
  const rows = await db.all<{ requested_by_email: string }>(
    "SELECT requested_by_email FROM film_order_mail_outbox WHERE order_id=? AND dispatch_group_id=?",
    [orderId, dispatchGroupId],
  );
  if (!rows.length) throw new Error("film_order_mail_dispatch_not_found");
  const requester = actorEmail.trim().toLowerCase();
  if (rows.some((row) => row.requested_by_email.trim().toLowerCase() !== requester)) {
    throw new Error("film_order_mail_cancel_forbidden");
  }
  return cancelFilmOrderMail(orderId, dispatchGroupId, options);
}

export async function cancelFilmOrderMail(
  orderId: number,
  dispatchGroupId: string,
  options: { client?: SqlClient } = {},
): Promise<{ skippedCount: number; revokedTokenCount: number; authoritativeStateChanged: false }> {
  const db = options.client ?? await getDatabaseForFilmMakerStore();
  return db.transaction(async (tx) => {
    const before = await lockLifecycleOrder(tx, orderId);
    const draftCount = Number((await tx.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM film_order_mail_outbox WHERE dispatch_group_id=? AND order_id=? AND envelope_status='draft'",
      [dispatchGroupId, orderId],
    ))?.count ?? 0);
    if (draftCount === 0) throw new Error("film_order_mail_confirm_conflict");
    const skipped = await skipFilmOrderMailDrafts(dispatchGroupId, { expectedCount: draftCount, client: tx });
    const rows = await tx.all<{ token_hash: string }>(
      "SELECT token_hash FROM film_order_external_tokens WHERE film_order_id=? AND dispatch_group_id=? AND token_state='staged'",
      [orderId, dispatchGroupId],
    );
    await revokeStagedFilmOrderExternalTokens(tx, orderId, rows.map((row) => row.token_hash));
    const after = await loadLifecycleOrder(tx, orderId);
    if (before.updated_at !== after.updated_at || before.status !== after.status) throw new Error("film_order_cancel_state_mutation_forbidden");
    return { skippedCount: skipped, revokedTokenCount: rows.length, authoritativeStateChanged: false };
  });
}

async function commitBusinessTransition(tx: SqlClient, command: FilmOrderMailPrepareCommand): Promise<void> {
  const current = await loadLifecycleOrder(tx, command.orderId);
  const previousAt = Date.parse(current.updated_at);
  const now = new Date(Math.max(Date.now(), (Number.isFinite(previousAt) ? previousAt : 0) + 1)).toISOString();
  const actor = command.actorEmail;
  switch (command.action) {
    case "register-receiving": {
      const aiName = command.aiFileName ?? "";
      const aiUrl = command.aiFileUrl ?? "";
      const pdfName = command.pdfFileName ?? null;
      const pdfUrl = command.pdfFileUrl ?? null;
      const receivingVersion = await nextLifecycleFileVersion(tx, command.orderId, "receiving");
      await tx.run(`
        INSERT INTO film_order_files (
          order_id,category,file_name,url,version,uploaded_by_email,created_at
        ) VALUES (?,'receiving',?,?,?,?,?)
      `, [command.orderId, aiName, aiUrl, receivingVersion, actor, now]);
      if (pdfName && pdfUrl) {
        await tx.run(`
          INSERT INTO film_order_files (
            order_id,category,file_name,url,version,uploaded_by_email,created_at
          ) VALUES (?,'receiving',?,?,?,?,?)
        `, [command.orderId, pdfName, pdfUrl, receivingVersion, actor, now]);
      }
      await tx.run(`
        UPDATE film_orders SET status='receiving_registered', receiving_registered_at=?, updated_at=?, updated_by_email=?
        WHERE id=? AND status='ordered' AND updated_at=?
      `, [now, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "register-proof": {
      const fileName = command.proofFileName ?? "";
      const fileUrl = command.proofFileUrl ?? "";
      if (!fileName) throw new Error("invalid_ai_file");
      const proofVersion = await nextLifecycleFileVersion(tx, command.orderId, "proof");
      await tx.run(`
        INSERT INTO film_order_files (order_id,category,file_name,url,version,uploaded_by_email,created_at)
        VALUES (?,'proof',?,?,?,?,?)
      `, [command.orderId, fileName, fileUrl || "", proofVersion, actor, now]);
      if (command.proofPdfFileName && command.proofPdfFileUrl) {
        await tx.run(`
          INSERT INTO film_order_files (order_id,category,file_name,url,version,uploaded_by_email,created_at)
          VALUES (?,'proof',?,?,?,?,?)
        `, [command.orderId, command.proofPdfFileName, command.proofPdfFileUrl, proofVersion, actor, now]);
      }
      await tx.run(`
        UPDATE film_orders SET status='proof_registered', proof_registered_at=?, updated_at=?, updated_by_email=?
        WHERE id=? AND status IN ('receiving_registered','re_proof_requested') AND updated_at=?
      `, [now, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "request-re-proof": {
      const current = await loadLifecycleOrder(tx, command.orderId);
      await tx.run(`
        UPDATE film_orders SET status='re_proof_requested', re_proof_count=?, re_proof_requested_at=?, updated_at=?, updated_by_email=?
        WHERE id=? AND status='proof_registered' AND updated_at=?
      `, [current.re_proof_count + 1, now, now, actor, command.orderId, current.updated_at]);
      return;
    }
    case "send-customer-proof-review": {
      await tx.run(`
        UPDATE film_orders SET customer_proof_status='requested', customer_proof_requested_at=?, updated_at=?, updated_by_email=?
        WHERE id=? AND status='proof_registered' AND customer_proof_status IN ('pending','requested','correction_requested') AND updated_at=?
      `, [now, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "record-customer-proof-approval": {
      await tx.run("INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)", [command.orderId, "customer_proof", `金井貿易校正承認: 承認者 ${command.approverName ?? "-"} / 根拠 ${command.offlineEvidence ?? command.evidence ?? "-"} / 理由 ${command.offlineReason ?? "-"}`, actor, now]);
      await tx.run(`
        UPDATE film_orders SET customer_proof_status='approved', customer_proof_approved_at=?,
          supplier_approval_status='approved', supplier_approval_at=?, supplier_approval_by=?,
          updated_at=?, updated_by_email=?
        WHERE id=? AND status='proof_registered' AND customer_proof_status IN ('pending','requested','approved')
          AND supplier_approval_status='pending' AND updated_at=?
      `, [now, now, actor, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "approve": {
      if (command.finalFileName) {
        await tx.run(`
          INSERT INTO film_order_files (order_id,category,file_name,url,version,uploaded_by_email,created_at)
          VALUES (?,'final',?,?,1,?,?)
        `, [command.orderId, command.finalFileName, command.finalFileUrl ?? "", actor, now]);
      }
      await tx.run(`
        UPDATE film_orders SET status='final_approved', final_approved_at=?, buyer_approval_status='approved',
          buyer_approval_at=?, buyer_approval_by=?, updated_at=?, updated_by_email=?
        WHERE id=? AND status='proof_registered' AND customer_proof_status IN ('approved','legacy_exempt')
          AND supplier_approval_status IN ('approved','legacy_exempt') AND buyer_approval_status='pending' AND updated_at=?
      `, [now, now, actor, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "send-po": {
      await tx.run(`
        UPDATE film_orders SET po_sent_at=?, supplier_order_note=?, updated_at=?, updated_by_email=?
        WHERE id=? AND status='final_approved' AND po_sent_at IS NULL AND ship_to_status='confirmed' AND updated_at=?
      `, [now, command.supplierOrderNote ?? "", now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "request-ship-to-registration": {
      await tx.run("INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)", [command.orderId, "ship_to", `顧客納品先登録依頼メール送信: ${command.customerEmail ?? "-"}`, actor, now]);
      await tx.run(`
        UPDATE film_orders SET ship_to_requested_at=?, ship_to_requested_by=?, updated_at=?, updated_by_email=?
        WHERE id=? AND ship_to_status <> 'confirmed' AND updated_at=?
      `, [now, actor, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "ship-to-registered": {
      const destinations = command.shipToDestinations ?? [];
      await tx.run("DELETE FROM film_order_ship_to_destinations WHERE order_id=?", [command.orderId]);
      for (const [index, destination] of destinations.entries()) {
        const value = (key: string): string => String((destination as Record<string, unknown>)[key] ?? "");
        await tx.run(`
          INSERT INTO film_order_ship_to_destinations (
            order_id,destination_id,position,label,company_name,department,contact_name,postal_code,address,building,
            phone,email,note,registered_at,registered_by,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [command.orderId, destination.destinationId == null ? null : Number(destination.destinationId), index,
          value("label"), value("companyName"), value("department"), value("contactName"), value("postalCode"), value("address"),
          value("building"), value("phone"), value("email"), value("note"), now, actor, now]);
      }
      const primary = destinations[0] as Record<string, unknown> | undefined;
      await tx.run(`
        UPDATE film_orders SET
          ship_to_status='registered', ship_to_label=?, ship_to_company_name=?, ship_to_department=?,
          ship_to_contact_name=?, ship_to_postal_code=?, ship_to_address=?, ship_to_building=?, ship_to_phone=?,
          ship_to_email=?, ship_to_note=?, ship_to_registered_at=?, ship_to_registered_by=?, updated_at=?, updated_by_email=?
        WHERE id=? AND ship_to_status <> 'confirmed' AND updated_at=?
      `, [String(primary?.label ?? ""), String(primary?.companyName ?? ""), String(primary?.department ?? ""), String(primary?.contactName ?? ""),
        String(primary?.postalCode ?? ""), String(primary?.address ?? ""), String(primary?.building ?? ""), String(primary?.phone ?? ""),
        String(primary?.email ?? ""), String(primary?.note ?? ""), now, actor, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "request-customer-design-upload": {
      await tx.run(`
        UPDATE film_orders SET customer_design_status='requested', customer_design_requested_at=?, updated_at=?, updated_by_email=?
        WHERE id=? AND updated_at=?
      `, [now, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "request-customer-design-correction": {
      const current = await loadLifecycleOrder(tx, command.orderId);
      await tx.run(`
        UPDATE film_orders SET customer_design_status='correction_requested',
          customer_design_correction_count=?, customer_design_correction_reason=?, updated_at=?, updated_by_email=?
        WHERE id=? AND customer_design_status='received' AND updated_at=?
      `, [current.customer_design_correction_count + 1, command.customerMessage ?? "", now, actor, command.orderId, current.updated_at]);
      return;
    }
    case "customer-design-received": {
      const fileName = command.customerDesignFileName ?? "";
      const fileUrl = command.customerDesignFileUrl ?? "";
      if (!fileName || !fileUrl) throw new Error("customer_design_file_required");
      await tx.run(`
        INSERT INTO film_order_files (order_id,category,file_name,url,version,note,uploaded_by_email,uploaded_via,created_at)
        VALUES (?,'customer_design',?,?,1,?,?,'customer_design',?)
      `, [command.orderId, fileName, fileUrl, command.customerDesignNote ?? "", actor, now]);
      await tx.run(`
        UPDATE film_orders SET customer_design_status='received', customer_design_received_at=?, updated_at=?, updated_by_email=?
        WHERE id=? AND customer_design_status IN ('requested','correction_requested') AND updated_at=?
      `, [now, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "production-plan-request":
    case "request-production-plan": {
      await tx.run("UPDATE film_orders SET updated_at=?, updated_by_email=? WHERE id=? AND updated_at=?", [now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "update-eta": {
      await tx.run("INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)", [command.orderId, "eta", `納期見込み入力: ${command.etaDate ?? ""}${command.note ? ` / ${command.note}` : ""}`, actor, now]);
      const date = command.etaDate ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("invalid_eta_date");
      await tx.run(`
        UPDATE film_orders SET eta_date=?, eta_note=?, eta_updated_at=?, updated_at=?, updated_by_email='supplier'
        WHERE id=? AND po_sent_at IS NOT NULL AND updated_at=?
      `, [date, command.note ?? "", now, now, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "report-shipment": {
      await tx.run("INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)", [command.orderId, "delivery", `メーカー出荷報告: ${command.deliveryDate ?? ""}${command.carrier ? ` / ${command.carrier}` : ""}${command.trackingNumber ? ` / ${command.trackingNumber}` : ""}`, actor, now]);
      const date = command.deliveryDate ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("invalid_delivery_date");
      await tx.run(`
        UPDATE film_orders SET film_shipped_on=?, film_shipped_at=?, film_carrier=?, film_tracking_number=?, film_shipment_note=?, film_delivery_document_name=?, film_delivery_document_url=?, updated_at=?, updated_by_email='supplier'
        WHERE id=? AND po_sent_at IS NOT NULL AND film_shipped_at IS NULL AND film_delivered_at IS NULL AND ship_to_status='confirmed' AND updated_at=?
      `, [date, now, command.carrier ?? "", command.trackingNumber ?? "", command.note ?? "", command.documentName ?? "", command.documentUrl ?? "", now, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "report-delivery": {
      await tx.run("INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)", [command.orderId, "delivery", `メーカー納品報告: ${command.deliveryDate ?? ""}${command.note ? ` / ${command.note}` : ""}`, actor, now]);
      const date = command.deliveryDate ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("invalid_delivery_date");
      await tx.run(`
        UPDATE film_orders SET film_delivered_on=?, film_delivered_at=?, film_delivery_note=?, updated_at=?, updated_by_email='supplier'
        WHERE id=? AND film_shipped_at IS NOT NULL AND film_delivered_at IS NULL AND updated_at=?
      `, [date, now, command.note ?? "", now, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "confirm-film-receipt": {
      await tx.run(`
        UPDATE film_orders SET film_received_at=?, film_received_note=?, film_received_by_email=?, updated_at=?, updated_by_email=?
        WHERE id=? AND film_delivered_at IS NOT NULL AND film_received_at IS NULL AND updated_at=?
      `, [now, command.receivedNote ?? "", actor, now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
    }
    case "customer-proof-decision": {
      await tx.run("INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)", [command.orderId, "customer_proof", command.decision === "approve" ? `顧客が校正を承認 (${now})` : `顧客修正依頼: ${command.customerMessage ?? ""}`, "customer", now]);
      if (command.ipAddressHash) await tx.run("INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)", [command.orderId, "audit", `顧客判断IPハッシュ: ${command.ipAddressHash}`, "customer", now]);
      if (command.decision === "approve") {
        await tx.run(`
          UPDATE film_orders SET customer_proof_status='approved', customer_proof_approved_at=?, updated_at=?, updated_by_email='customer'
          WHERE id=? AND status='proof_registered' AND customer_proof_status='requested' AND updated_at=?
        `, [now, now, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      } else {
        const current = await loadLifecycleOrder(tx, command.orderId);
        await tx.run(`
          UPDATE film_orders SET customer_proof_status='correction_requested',
            customer_proof_correction_count=?, customer_proof_correction_reason=?, updated_at=?, updated_by_email='customer'
          WHERE id=? AND status='proof_registered' AND customer_proof_status='requested' AND updated_at=?
        `, [current.customer_proof_correction_count + 1, command.customerMessage ?? "", now, command.orderId, current.updated_at]);
      }
      return;
    }
    case "send-proof-notice":
    case "resend-receiving-notice":
    case "rotate-supplier-proof-token":
    case "resend-supplier-links":
      await tx.run("UPDATE film_orders SET updated_at=?, updated_by_email=? WHERE id=? AND updated_at=?", [now, actor, command.orderId, (await loadLifecycleOrder(tx, command.orderId)).updated_at]);
      return;
  }
}

export async function confirmFilmOrderMail(
  preview: FilmOrderMailPreview,
  expectedHashes: readonly string[],
  options: { client?: SqlClient } = {},
): Promise<FilmOrderMailConfirmResult> {
  const db = options.client ?? await getDatabaseForFilmMakerStore();
  const command = preview.command;
  const attempts = await db.transaction(async (tx) => {
    const before = await lockLifecycleOrder(tx, command.orderId);
    if (command.expectedUpdatedAt && command.expectedUpdatedAt !== before.updated_at) throw new Error("film_order_state_conflict");
    const rows = await tx.all<{ id: number; envelope_status: string }>(
      "SELECT id,envelope_status FROM film_order_mail_outbox WHERE dispatch_group_id=? AND order_id=? ORDER BY id",
      [preview.dispatchGroupId, command.orderId],
    );
    if (!rows.length) throw new Error("film_order_mail_dispatch_not_found");
    if (rows.some((row) => row.envelope_status !== "draft")) throw new Error("film_order_mail_dispatch_not_draft");
    const persisted = [];
    for (const row of rows) {
      const record = await getFilmOrderMailOutbox(Number(row.id), tx);
      if (!record) throw new Error("film_order_mail_outbox_not_found");
      verifyFilmOrderMailEnvelope(record);
      persisted.push(record);
    }
    const hashes = persisted.map((draft) => draft.contentHash);
    if (expectedHashes.length !== hashes.length || [...expectedHashes].sort().join("|") !== [...hashes].sort().join("|")) {
      throw new Error("film_order_mail_hash_mismatch");
    }
    const expectedStagedHashes = [...new Set(preview.stagedTokenHashes)];
    const staged = expectedStagedHashes.length
      ? await tx.all<{ token_hash: string; purpose: string; audience_email: string | null; expires_at: string }>(
        `SELECT token_hash,purpose,audience_email,expires_at FROM film_order_external_tokens
         WHERE film_order_id=? AND token_state='staged'
           AND dispatch_group_id=?
           AND token_hash IN (${expectedStagedHashes.map(() => "?").join(",")})`,
        [command.orderId, preview.dispatchGroupId, ...expectedStagedHashes],
      )
      : [];
    if (staged.length !== expectedStagedHashes.length) throw new Error("film_order_staged_token_invalid");
    if (staged.some((token) => !token.audience_email || new Date(token.expires_at).getTime() <= Date.now())) {
      throw new Error("film_order_staged_token_invalid");
    }
    const currentFiles = await loadLifecycleFiles(tx, command.orderId);
    const raw = await loadLifecycleOrder(tx, command.orderId);
    if (command.action === "record-customer-proof-approval") {
      const offlineEvidence = command.offlineEvidence ?? command.evidence;
      if (!offlineEvidence?.trim() || !command.offlineReason?.trim()) {
        throw new Error("customer_proof_evidence_required");
      }
    }
    const guard = guardOf(raw, currentFiles, command.action);
    if (command.action === "register-receiving") {
      guard.receivingAiRegistered = /\.ai$/iu.test(command.aiFileName ?? "") && Boolean(command.aiFileUrl);
      guard.receivingPdfRegistered = /\.pdf$/iu.test(command.pdfFileName ?? "") && Boolean(command.pdfFileUrl);
    }
    assertLifecycleGuard(guard, command.action, ACTION_ROLES[command.action]);
    const requiresMaker = eventRequiresMaker(preview.event);
    const maker = requiresMaker || raw.film_maker_snapshot_json ? strictMakerSnapshot(raw) : null;
    let makerRecipient = "";
    if (requiresMaker) {
      if (!maker) throw new Error("film_maker_resolution_required");
      if (!maker.isActive) throw new Error("film_maker_inactive");
      if (raw.film_maker_id == null || Number(raw.film_maker_id) !== maker.id) throw new Error("film_maker_not_found");
      if (maker.procurementRoute.toUpperCase() !== raw.procurement_route.toUpperCase()) throw new Error("film_maker_route_mismatch");
      if (maker.printMethod.toLowerCase() !== raw.printing_method.toLowerCase()) throw new Error("film_maker_print_method_mismatch");
      makerRecipient = maker.email.trim();
      if (!makerRecipient) throw new Error("supplier_destination_missing");
    }
    const customerRecipient = command.customerEmail?.trim() || await customerRecipientOf(tx, raw.quotation_id);
    const linkByUrl = new Map<string, NonNullable<FilmOrderNotificationInput["links"]>[number]>();
    for (const record of persisted) for (const link of record.canonicalEnvelope.links) linkByUrl.set(link.url, link);
    for (const key of ["maker_receiving_packet", "seven_order_summary", "kanei_order_management"] as const) {
      linkByUrl.set(`${command.origin}/film-orders#${key}`, { key, url: `${command.origin}/film-orders` });
    }
    const projection = await projectLifecycleMail({
      tx,
      raw,
      command,
      event: preview.event,
      dispatchGroupId: preview.dispatchGroupId,
      links: [...linkByUrl.values()],
      currentFiles,
      makerRecipient,
      customerRecipient,
    });
    for (const record of persisted) {
      const identity = `${record.canonicalEnvelope.workflowKey}:${record.canonicalEnvelope.audience}`;
      const current = projection.effective.find((envelope) => `${envelope.workflowKey}:${envelope.audience}` === identity);
      if (!current || stableFingerprint({ ...record.canonicalEnvelope, contentHash: record.contentHash }) !== stableFingerprint(current)) {
        throw new Error("film_order_mail_preview_stale");
      }
    }
    await commitBusinessTransition(tx, command);
    const committed = await loadLifecycleOrder(tx, command.orderId);
    if (committed.updated_at === before.updated_at) throw new Error("film_order_state_conflict");
    await promoteStagedFilmOrderExternalTokens(tx, command.orderId, staged.map((token) => token.token_hash));
    if (command.tokenValue) {
      const { filmExternalTokenHashForTest } = await import("./film-orders");
      await tx.run(
        "UPDATE film_order_external_tokens SET last_used_at=?, last_used_ip_hash=COALESCE(?, last_used_ip_hash), updated_at=? WHERE film_order_id=? AND token_hash=?",
        [new Date().toISOString(), command.ipAddressHash ?? null, new Date().toISOString(), command.orderId, filmExternalTokenHashForTest(command.tokenValue)],
      );
    }
    await tx.run(
      "INSERT INTO film_order_events (order_id,type,detail,actor_email,created_at) VALUES (?,?,?,?,?)",
      [command.orderId, "mail_audit", `dispatch intent ${preview.dispatchGroupId}`, command.actorEmail, new Date().toISOString()],
    );
    await promoteFilmOrderMailDrafts(preview.dispatchGroupId, { expectedCount: persisted.length, client: tx });
    const started = [];
    for (const draft of persisted) {
      started.push(await startFilmOrderMailAttempt({ outboxId: Number(draft.id), requestedByEmail: command.actorEmail, client: tx }));
    }
    return { started, settings: projection.settings };
  });

  const outcomes: FilmOrderMailAudienceOutcome[] = [];
  for (const attempt of attempts.started) {
    const envelope = await getFilmOrderMailOutbox(attempt.outboxId, db);
    if (!envelope) throw new Error("film_order_mail_outbox_not_found");
    verifyFilmOrderMailEnvelope(envelope);
    const smtp = await sendMail({
      to: envelope.intendedTo,
      subject: envelope.subject,
      text: envelope.body,
      cc: [...envelope.cc],
      audience: envelope.audience === "maker" ? "supplier" : envelope.audience === "seven" ? "seven" : envelope.audience === "kanei" ? "kanei" : "customer",
      exactEnvelope: true,
      senderEmail: envelope.senderEmail,
      strictSettings: attempts.settings,
    });
    const status: FilmOrderMailAttemptStatus = smtp.dryRun
      ? "skipped"
      : smtp.messageId
        ? "sent"
        : smtp.error && /timeout|socket|connection/iu.test(smtp.error)
          ? "unknown"
          : smtp.error
            ? "retry_required"
            : "unknown";
    const final = await recordFilmOrderMailAttemptOutcome({
      outboxId: attempt.outboxId,
      attemptCount: attempt.attemptCount,
      status,
      actualTo: smtp.to,
      recipientOverridden: smtp.recipientOverridden === true,
      errorCode: smtp.error ?? null,
    });
    outcomes.push({
      audience: envelope.audience,
      attemptCount: final.attemptCount,
      status: final.status,
      intendedTo: envelope.intendedTo,
      actualTo: final.actualTo,
      recipientOverridden: final.recipientOverridden,
      smtpMessageId: final.smtpMessageId,
      errorCode: final.errorCode,
      subject: envelope.subject,
      body: envelope.body,
    });
  }

  return {
    dispatchGroupId: preview.dispatchGroupId,
    workflowCompleted: true,
    notificationCompleted: outcomes.every((outcome) => outcome.status === "sent"),
    outcomes,
  };
}

export async function retryFilmOrderMailDispatch(
  orderId: number,
  dispatchGroupId: string,
  actorEmail: string,
): Promise<FilmOrderMailConfirmResult> {
  const db = await getDatabaseForFilmMakerStore();
  const rows = await db.all<{ id: number }>(
    "SELECT id FROM film_order_mail_outbox WHERE order_id=? AND dispatch_group_id=? AND envelope_status='composed' ORDER BY id",
    [orderId, dispatchGroupId],
  );
  if (!rows.length) throw new Error("film_order_mail_retry_not_available");
  const records = [];
  for (const row of rows) {
    const record = await getFilmOrderMailOutbox(Number(row.id), db);
    if (!record) throw new Error("film_order_mail_outbox_not_found");
    verifyFilmOrderMailEnvelope(record);
    records.push(record);
  }
  const settings = await getStrictMailSettings();
  const outcomes: FilmOrderMailAudienceOutcome[] = [];
  for (const envelope of records) {
    const history = await db.all<{ id: number; attempt_count: number; status: FilmOrderMailAttemptStatus; actual_to: string | null; recipient_overridden: number | boolean; smtp_message_id: string | null; error_code: string | null }>(
      "SELECT * FROM film_order_mail_attempts WHERE outbox_id=? ORDER BY attempt_count",
      [envelope.id],
    );
    const latest = history.at(-1);
    const retryable = latest && ["failed", "unknown", "retry_required"].includes(latest.status);
    if (!retryable) {
      outcomes.push({
        audience: envelope.audience,
        attemptCount: latest?.attempt_count ?? 0,
        status: latest?.status ?? "skipped",
        intendedTo: envelope.intendedTo,
        actualTo: latest?.actual_to ?? null,
        recipientOverridden: Boolean(latest?.recipient_overridden),
        smtpMessageId: latest?.smtp_message_id ?? null,
        errorCode: latest?.error_code ?? null,
        subject: envelope.subject,
        body: envelope.body,
      });
      continue;
    }
    const attempt = await startFilmOrderMailAttempt({ outboxId: envelope.id, requestedByEmail: actorEmail });
    const smtp = await sendMail({
      to: envelope.intendedTo,
      subject: envelope.subject,
      text: envelope.body,
      cc: [...envelope.cc],
      audience: envelope.audience === "maker" ? "supplier" : envelope.audience === "seven" ? "seven" : envelope.audience === "kanei" ? "kanei" : "customer",
      exactEnvelope: true,
      senderEmail: envelope.senderEmail,
      strictSettings: settings,
    });
    const status: FilmOrderMailAttemptStatus = smtp.dryRun
      ? "skipped"
      : smtp.messageId
        ? "sent"
        : smtp.error && /timeout|socket|connection/iu.test(smtp.error)
          ? "unknown"
          : smtp.error
            ? "retry_required"
            : "unknown";
    const final = await recordFilmOrderMailAttemptOutcome({
      outboxId: envelope.id,
      attemptCount: attempt.attemptCount,
      status,
      actualTo: smtp.to,
      recipientOverridden: smtp.recipientOverridden === true,
      errorCode: smtp.error ?? null,
    });
    outcomes.push({
      audience: envelope.audience,
      attemptCount: final.attemptCount,
      status: final.status,
      intendedTo: envelope.intendedTo,
      actualTo: final.actualTo,
      recipientOverridden: final.recipientOverridden,
      smtpMessageId: final.smtpMessageId,
      errorCode: final.errorCode,
      subject: envelope.subject,
      body: envelope.body,
    });
  }
  return { dispatchGroupId, workflowCompleted: false, notificationCompleted: outcomes.every((outcome) => outcome.status === "sent"), outcomes };
}
