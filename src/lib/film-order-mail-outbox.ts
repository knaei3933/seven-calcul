import { getDatabaseForFilmMakerStore } from "./film-orders";
import { isUniqueViolation, type SqlClient } from "./db";
import { isKaneiTradeUser, isSevenChemicalUser } from "./film-order-access";
import {
  filmOrderNotificationEnvelopeHash,
  validateFilmOrderNotification,
  type FilmOrderNotificationAudience,
  type FilmOrderNotificationEnvelope,
  type FilmOrderNotificationEvent,
  type FilmOrderNotificationIssue,
  type FilmOrderNotificationLanguage,
  type FilmOrderMailAttachmentMetadata,
  type FilmOrderNotificationLink,
} from "./film-order-notifications";

export type FilmOrderMailEnvelopeStatus = "draft" | "composed" | "skipped" | "superseded";
export type FilmOrderMailAttemptStatus =
  | "sending"
  | "sent"
  | "failed"
  | "unknown"
  | "retry_required"
  | "skipped";

export interface FilmOrderMailOutboxRecord {
  id: number;
  orderId: number;
  dispatchGroupId: string;
  workflowKey: FilmOrderNotificationEvent;
  audience: FilmOrderNotificationAudience;
  language: FilmOrderNotificationLanguage;
  templateKey: string;
  effectiveTemplateIdentity: FilmOrderNotificationEnvelope["effectiveTemplateIdentity"];
  senderIdentity: string;
  senderEmail: string;
  intendedTo: string;
  cc: string[];
  subject: string;
  body: string;
  links: FilmOrderNotificationLink[];
  attachments: FilmOrderMailAttachmentMetadata[];
  contentHash: string;
  canonicalEnvelope: Omit<FilmOrderNotificationEnvelope, "contentHash">;
  envelopeStatus: FilmOrderMailEnvelopeStatus;
  requestedByEmail: string;
  createdAt: string;
  updatedAt: string;
}

/** Seven/customer can see only their own metadata/outcome; never bodies, links, tokens, or SMTP internals. */
export interface FilmOrderMailOutboxAudienceView {
  id: number;
  orderId: number;
  dispatchGroupId: string;
  workflowKey: FilmOrderNotificationEvent;
  audience: FilmOrderNotificationAudience;
  language: FilmOrderNotificationLanguage;
  templateKey: string;
  envelopeStatus: FilmOrderMailEnvelopeStatus;
  createdAt: string;
  updatedAt: string;
  attempts: FilmOrderMailAttemptAudienceView[];
}

export interface FilmOrderMailAttemptRecord {
  id: number;
  outboxId: number;
  attemptCount: number;
  status: FilmOrderMailAttemptStatus;
  requestedByEmail: string;
  intendedTo: string;
  actualTo: string | null;
  recipientOverridden: boolean;
  smtpMessageId: string | null;
  errorCode: string | null;
  createdAt: string;
  attemptStartedAt: string;
  attemptFinishedAt: string | null;
}

export interface FilmOrderMailAttemptAudienceView {
  id: number;
  outboxId: number;
  attemptCount: number;
  status: FilmOrderMailAttemptStatus;
  createdAt: string;
  attemptStartedAt: string;
  attemptFinishedAt: string | null;
}

interface FilmOrderMailOutboxRow {
  id: number;
  order_id: number;
  dispatch_group_id: string;
  workflow_key: FilmOrderNotificationEvent;
  audience: FilmOrderNotificationAudience;
  language: FilmOrderNotificationLanguage;
  template_key: string;
  template_identity_json: string;
  sender_identity: string;
  sender_email: string;
  intended_to: string;
  cc_json: string;
  subject: string;
  body: string;
  links_json: string;
  attachments_json: string;
  canonical_envelope_json: string;
  content_hash: string;
  envelope_status: FilmOrderMailEnvelopeStatus;
  requested_by_email: string;
  created_at: string;
  updated_at: string;
}

interface FilmOrderMailAttemptRow {
  id: number;
  outbox_id: number;
  attempt_count: number;
  status: FilmOrderMailAttemptStatus;
  requested_by_email: string;
  intended_to: string;
  actual_to: string | null;
  recipient_overridden: number | boolean;
  smtp_message_id: string | null;
  error_code: string | null;
  created_at: string;
  attempt_started_at: string;
  attempt_finished_at: string | null;
}

export class FilmOrderMailOutboxValidationError extends Error {
  readonly issues: FilmOrderNotificationIssue[];

  constructor(issues: FilmOrderNotificationIssue[]) {
    super("invalid_film_order_mail_envelope");
    this.name = "FilmOrderMailOutboxValidationError";
    this.issues = issues;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

class FilmOrderMailOutboxCorruptionError extends Error {
  constructor(column: string) {
    super(`film_order_mail_outbox_corrupted:${column}`);
    this.name = "FilmOrderMailOutboxCorruptionError";
  }
}

function parsePersistedJson(value: string, column: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new FilmOrderMailOutboxCorruptionError(column);
  }
}

function persistedStringArray(value: string, column: string): string[] {
  const parsed = parsePersistedJson(value, column);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new FilmOrderMailOutboxCorruptionError(column);
  }
  return parsed as string[];
}

function persistedEnvelopeList<T>(value: string, column: string): T[] {
  const parsed = parsePersistedJson(value, column);
  if (!Array.isArray(parsed) || parsed.some((item) => item == null || typeof item !== "object" || Array.isArray(item))) {
    throw new FilmOrderMailOutboxCorruptionError(column);
  }
  return parsed as T[];
}

function parseTemplateIdentity(value: string): FilmOrderNotificationEnvelope["effectiveTemplateIdentity"] {
  const parsed = parsePersistedJson(value, "template_identity_json");
  const candidate = parsed as Partial<FilmOrderNotificationEnvelope["effectiveTemplateIdentity"]> | null;
  if (
    !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    || typeof candidate.key !== "string" || !candidate.key
    || (candidate.source !== "default" && candidate.source !== "override")
    || typeof candidate.bindingFingerprint !== "string" || !candidate.bindingFingerprint
    || (candidate.compatibilityKey !== null && typeof candidate.compatibilityKey !== "string")
  ) throw new FilmOrderMailOutboxCorruptionError("template_identity_json");
  return {
    key: candidate.key,
    source: candidate.source,
    compatibilityKey: candidate.compatibilityKey,
    bindingFingerprint: candidate.bindingFingerprint,
  };
}

function parseCanonicalEnvelope(value: string): Omit<FilmOrderNotificationEnvelope, "contentHash"> {
  const parsed = parsePersistedJson(value, "canonical_envelope_json");
  const envelope = parsed as Partial<FilmOrderNotificationEnvelope> | null;
  if (
    !envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || !envelope.orderId || !envelope.dispatchGroupId || !envelope.workflowKey || !envelope.audience
    || !envelope.language || !envelope.templateKey || !envelope.effectiveTemplateIdentity
    || !envelope.senderIdentity || !envelope.senderEmail || !envelope.intendedTo
    || !Array.isArray(envelope.cc) || !envelope.subject || !envelope.body
    || !Array.isArray(envelope.links) || !Array.isArray(envelope.attachments)
    || !envelope.purpose || !envelope.nextStep
  ) throw new FilmOrderMailOutboxCorruptionError("canonical_envelope_json");
  const { contentHash, ...canonical } = envelope as FilmOrderNotificationEnvelope;
  void contentHash;
  return canonical;
}

function mapOutbox(row: FilmOrderMailOutboxRow): FilmOrderMailOutboxRecord {
  return {
    id: Number(row.id),
    orderId: Number(row.order_id),
    dispatchGroupId: row.dispatch_group_id,
    workflowKey: row.workflow_key,
    audience: row.audience,
    language: row.language,
    templateKey: row.template_key,
    effectiveTemplateIdentity: parseTemplateIdentity(row.template_identity_json),
    senderIdentity: row.sender_identity,
    senderEmail: row.sender_email,
    intendedTo: row.intended_to,
    cc: persistedStringArray(row.cc_json, "cc_json"),
    subject: row.subject,
    body: row.body,
    links: persistedEnvelopeList<FilmOrderNotificationLink>(row.links_json, "links_json"),
    attachments: persistedEnvelopeList<FilmOrderMailAttachmentMetadata>(row.attachments_json, "attachments_json"),
    contentHash: row.content_hash,
    canonicalEnvelope: parseCanonicalEnvelope(row.canonical_envelope_json),
    envelopeStatus: row.envelope_status,
    requestedByEmail: row.requested_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function verifyFilmOrderMailEnvelope(record: FilmOrderMailOutboxRecord): void {
  if (filmOrderNotificationEnvelopeHash(record.canonicalEnvelope) !== record.contentHash) {
    throw new FilmOrderMailOutboxCorruptionError("content_hash");
  }
}

function mapAttempt(row: FilmOrderMailAttemptRow): FilmOrderMailAttemptRecord {
  return {
    id: Number(row.id),
    outboxId: Number(row.outbox_id),
    attemptCount: Number(row.attempt_count),
    status: row.status,
    requestedByEmail: row.requested_by_email,
    intendedTo: row.intended_to,
    actualTo: row.actual_to,
    recipientOverridden: Boolean(row.recipient_overridden),
    smtpMessageId: row.smtp_message_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    attemptStartedAt: row.attempt_started_at,
    attemptFinishedAt: row.attempt_finished_at,
  };
}

function audienceAttemptView(row: FilmOrderMailAttemptRecord): FilmOrderMailAttemptAudienceView {
  return {
    id: row.id,
    outboxId: row.outboxId,
    attemptCount: row.attemptCount,
    status: row.status,
    createdAt: row.createdAt,
    attemptStartedAt: row.attemptStartedAt,
    attemptFinishedAt: row.attemptFinishedAt,
  };
}

async function attemptsForOutbox(
  outboxId: number,
  client: SqlClient,
): Promise<FilmOrderMailAttemptRecord[]> {
  const rows = await client.all<FilmOrderMailAttemptRow>(
    "SELECT * FROM film_order_mail_attempts WHERE outbox_id=? ORDER BY attempt_count",
    [outboxId],
  );
  return rows.map(mapAttempt);
}

async function insertOutbox(
  tx: SqlClient,
  envelope: FilmOrderNotificationEnvelope,
  envelopeStatus: Exclude<FilmOrderMailEnvelopeStatus, "skipped" | "superseded">,
  requestedByEmail: string,
  now: string,
): Promise<FilmOrderMailOutboxRecord> {
  await tx.run(`
    INSERT INTO film_order_mail_outbox (
      order_id, dispatch_group_id, workflow_key, audience, language, template_key,
      template_identity_json, sender_identity, intended_to, cc_json, subject, body, links_json, attachments_json,
      sender_email,
      canonical_envelope_json,
      content_hash, envelope_status, requested_by_email, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    envelope.orderId,
    envelope.dispatchGroupId,
    envelope.workflowKey,
    envelope.audience,
    envelope.language,
    envelope.templateKey,
    stableJson(envelope.effectiveTemplateIdentity),
    envelope.senderIdentity,
    envelope.intendedTo,
    stableJson(envelope.cc),
    envelope.subject,
    envelope.body,
    stableJson(envelope.links),
    stableJson(envelope.attachments),
    envelope.senderEmail,
    stableJson(envelope),
    envelope.contentHash,
    envelopeStatus,
    requestedByEmail,
    now,
    now,
  ]);
  const row = await tx.get<FilmOrderMailOutboxRow>(
    "SELECT * FROM film_order_mail_outbox WHERE dispatch_group_id=? AND workflow_key=? AND audience=?",
    [envelope.dispatchGroupId, envelope.workflowKey, envelope.audience],
  );
  if (!row) throw new Error("film_order_mail_outbox_insert_failed");
  return mapOutbox(row);
}

export async function persistFilmOrderMailEnvelopes(
  envelopes: readonly FilmOrderNotificationEnvelope[],
  options: {
    requestedByEmail: string;
    envelopeStatus?: "draft" | "composed";
    client?: SqlClient;
  },
): Promise<FilmOrderMailOutboxRecord[]> {
  if (envelopes.length === 0) throw new FilmOrderMailOutboxValidationError([{
    point: "recipient",
    code: "mail_projections_missing",
    message: "At least one notification envelope is required.",
  }]);

  const issues: FilmOrderNotificationIssue[] = [];
  const orderIds = new Set(envelopes.map((envelope) => envelope.orderId));
  const dispatchGroups = new Set(envelopes.map((envelope) => envelope.dispatchGroupId));
  const identities = new Set(envelopes.map((envelope) => `${envelope.workflowKey}:${envelope.audience}`));
  if (orderIds.size !== 1 || dispatchGroups.size !== 1) {
    issues.push({
      point: "recipient",
      code: "mail_dispatch_context_mismatch",
      message: "All envelopes in a persistence call must share one order and dispatch group.",
    });
  }
  if (identities.size !== envelopes.length) {
    issues.push({
      point: "recipient",
      code: "duplicate_mail_projection",
      message: "A dispatch group has duplicate workflow/audience envelopes.",
    });
  }
  for (const envelope of envelopes) {
    const validation = validateFilmOrderNotification(envelope);
    if (!validation.ok) issues.push(...validation.issues);
    const expectedHash = filmOrderNotificationEnvelopeHash(envelope);
    if (envelope.contentHash !== expectedHash) {
      issues.push({
        audience: envelope.audience,
        templateKey: envelope.templateKey,
        point: "purpose",
        code: "envelope_content_hash_mismatch",
        message: "Envelope content hash does not match the final object.",
      });
    }
  }
  if (issues.length > 0) throw new FilmOrderMailOutboxValidationError(issues);

  const db = options.client ?? await getDatabaseForFilmMakerStore();
  const status = options.envelopeStatus ?? "composed";
  const persistAll = async (tx: SqlClient): Promise<FilmOrderMailOutboxRecord[]> => {
    const now = new Date().toISOString();
    const result: FilmOrderMailOutboxRecord[] = [];
    for (const envelope of envelopes) {
      result.push(await insertOutbox(tx, envelope, status, options.requestedByEmail.trim(), now));
    }
    return result;
  };
  try {
    return options.client ? await persistAll(options.client) : await db.transaction(persistAll);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("duplicate_film_order_mail_envelope");
    throw error;
  }
}

async function setFilmOrderMailDraftStatus(
  dispatchGroupId: string,
  envelopeStatus: "composed" | "skipped",
  conflictCode: string,
  options: { expectedCount?: number; client?: SqlClient } = {},
): Promise<number> {
  const db = options.client ?? await getDatabaseForFilmMakerStore();
  const update = async (tx: SqlClient): Promise<number> => {
    const now = new Date().toISOString();
    const result = await tx.run(`
      UPDATE film_order_mail_outbox
      SET envelope_status=?, updated_at=?
      WHERE dispatch_group_id=? AND envelope_status='draft'
    `, [envelopeStatus, now, dispatchGroupId]);
    if (options.expectedCount != null && result.changes !== options.expectedCount) {
      throw new Error(conflictCode);
    }
    return result.changes;
  };
  return options.client ? update(options.client) : db.transaction(update);
}

export function promoteFilmOrderMailDrafts(
  dispatchGroupId: string,
  options: { expectedCount?: number; client?: SqlClient } = {},
): Promise<number> {
  return setFilmOrderMailDraftStatus(dispatchGroupId, "composed", "film_order_mail_draft_promotion_conflict", options);
}

export function skipFilmOrderMailDrafts(
  dispatchGroupId: string,
  options: { expectedCount?: number; client?: SqlClient } = {},
): Promise<number> {
  return setFilmOrderMailDraftStatus(dispatchGroupId, "skipped", "film_order_mail_draft_skip_conflict", options);
}

export async function getFilmOrderMailOutbox(
  outboxId: number,
  client?: SqlClient,
): Promise<FilmOrderMailOutboxRecord | null> {
  if (!Number.isInteger(outboxId) || outboxId <= 0) return null;
  const db = client ?? await getDatabaseForFilmMakerStore();
  const row = await db.get<FilmOrderMailOutboxRow>(
    "SELECT * FROM film_order_mail_outbox WHERE id=?",
    [outboxId],
  );
  return row ? mapOutbox(row) : null;
}

async function listOutboxRows(
  orderId: number,
  audience: FilmOrderNotificationAudience | null,
  client: SqlClient,
): Promise<FilmOrderMailOutboxRecord[]> {
  const rows = audience
    ? await client.all<FilmOrderMailOutboxRow>(
      "SELECT * FROM film_order_mail_outbox WHERE order_id=? AND audience=? ORDER BY created_at, id",
      [orderId, audience],
    )
    : await client.all<FilmOrderMailOutboxRow>(
      "SELECT * FROM film_order_mail_outbox WHERE order_id=? ORDER BY created_at, id",
      [orderId],
    );
  return rows.map(mapOutbox);
}

/** Kanei-only full-envelope read. Authorization is enforced before any SQL executes. */
export async function listFilmOrderMailOutboxForKanei(
  orderId: number,
  actorEmail: string,
  client?: SqlClient,
): Promise<Array<FilmOrderMailOutboxRecord & { attempts: FilmOrderMailAttemptRecord[] }>> {
  if (!isKaneiTradeUser(actorEmail)) throw new Error("film_order_mail_outbox_forbidden");
  const db = client ?? await getDatabaseForFilmMakerStore();
  const records = await listOutboxRows(orderId, null, db);
  return Promise.all(records.map(async (record) => ({
    ...record,
    attempts: await attemptsForOutbox(record.id, db),
  })));
}

export async function listFilmOrderMailOutboxForAudience(
  orderId: number,
  audience: FilmOrderNotificationAudience,
  actorEmail: string,
  audienceEmail?: string,
  client?: SqlClient,
): Promise<FilmOrderMailOutboxAudienceView[]> {
  const normalizedActor = actorEmail.trim().toLowerCase();
  const normalizedAudienceEmail = audienceEmail?.trim().toLowerCase();
  const identityMatch = normalizedAudienceEmail == null || normalizedActor === normalizedAudienceEmail;
  const authorized = (audience === "seven" && isSevenChemicalUser(normalizedActor) && identityMatch)
    || (audience === "kanei" && isKaneiTradeUser(normalizedActor))
    || (audience === "maker" && Boolean(normalizedAudienceEmail) && identityMatch)
    || (audience === "customer" && Boolean(normalizedActor) && identityMatch);
  if (!authorized) throw new Error("film_order_mail_outbox_forbidden");
  const db = client ?? await getDatabaseForFilmMakerStore();
  const records = await listOutboxRows(orderId, audience, db);
  return Promise.all(records.map(async (record) => {
    const attempts = await attemptsForOutbox(record.id, db);
    return {
      id: record.id,
      orderId: record.orderId,
      dispatchGroupId: record.dispatchGroupId,
      workflowKey: record.workflowKey,
      audience: record.audience,
      language: record.language,
      templateKey: record.templateKey,
      envelopeStatus: record.envelopeStatus,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      attempts: attempts.map(audienceAttemptView),
    };
  }));
}

export interface FilmOrderMailAttemptStartInput {
  outboxId: number;
  requestedByEmail: string;
  actualTo?: string | null;
  recipientOverridden?: boolean;
  client?: SqlClient;
}

export async function startFilmOrderMailAttempt(
  input: FilmOrderMailAttemptStartInput,
): Promise<FilmOrderMailAttemptRecord> {
  const db = input.client ?? await getDatabaseForFilmMakerStore();
  const insert = async (tx: SqlClient): Promise<FilmOrderMailAttemptRecord> => {
    const envelope = await tx.get<FilmOrderMailOutboxRow>(
      "SELECT * FROM film_order_mail_outbox WHERE id=?",
      [input.outboxId],
    );
    if (!envelope) throw new Error("film_order_mail_outbox_not_found");
    if (envelope.envelope_status !== "composed") {
      throw new Error("film_order_mail_outbox_not_composed");
    }
    const history = await tx.all<FilmOrderMailAttemptRow>(
      "SELECT * FROM film_order_mail_attempts WHERE outbox_id=? ORDER BY attempt_count",
      [input.outboxId],
    );
    const latest = history.at(-1);
    if (latest && !["failed", "unknown", "retry_required"].includes(latest.status)) {
      throw new Error("film_order_mail_retry_not_available");
    }
    const attemptCount = Number(latest?.attempt_count ?? 0) + 1;
    verifyFilmOrderMailEnvelope(mapOutbox(envelope));
    const actualTo = input.actualTo?.trim() || null;
    const now = new Date().toISOString();
    const actor = input.requestedByEmail.trim();
    await tx.run(`
      INSERT INTO film_order_mail_attempts (
        outbox_id, attempt_count, status, requested_by_email, intended_to, actual_to,
        recipient_overridden, created_at, attempt_started_at
      ) VALUES (?,?, 'sending', ?,?,?,?,?,?)
    `, [
      input.outboxId,
      attemptCount,
      actor,
      envelope.intended_to,
      actualTo,
      input.recipientOverridden === true ? 1 : 0,
      now,
      now,
    ]);
    const row = await tx.get<FilmOrderMailAttemptRow>(
      "SELECT * FROM film_order_mail_attempts WHERE outbox_id=? AND attempt_count=?",
      [input.outboxId, attemptCount],
    );
    if (!row) throw new Error("film_order_mail_attempt_insert_failed");
    return mapAttempt(row);
  };
  try {
    return input.client ? await insert(input.client) : await db.transaction(insert);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("duplicate_film_order_mail_attempt");
    throw error;
  }
}

export interface FilmOrderMailAttemptOutcomeInput {
  outboxId: number;
  attemptCount: number;
  status: Exclude<FilmOrderMailAttemptStatus, "sending">;
  actualTo?: string | null;
  recipientOverridden?: boolean;
  smtpMessageId?: string | null;
  errorCode?: string | null;
  client?: SqlClient;
}

export async function recordFilmOrderMailAttemptOutcome(
  input: FilmOrderMailAttemptOutcomeInput,
): Promise<FilmOrderMailAttemptRecord> {
  if (!Number.isInteger(input.attemptCount) || input.attemptCount <= 0) {
    throw new Error("invalid_film_order_mail_attempt_count");
  }
  const db = input.client ?? await getDatabaseForFilmMakerStore();
  const update = async (tx: SqlClient): Promise<FilmOrderMailAttemptRecord> => {
    const current = await tx.get<FilmOrderMailAttemptRow>(
      "SELECT * FROM film_order_mail_attempts WHERE outbox_id=? AND attempt_count=?",
      [input.outboxId, input.attemptCount],
    );
    if (!current) throw new Error("film_order_mail_attempt_not_found");
    if (current.status !== "sending") throw new Error("film_order_mail_attempt_already_final");
    const now = new Date().toISOString();
    const result = await tx.run(`
      UPDATE film_order_mail_attempts SET
        status=?, actual_to=COALESCE(?, actual_to), recipient_overridden=?, smtp_message_id=?,
        error_code=?, attempt_finished_at=?
      WHERE outbox_id=? AND attempt_count=? AND status='sending'
    `, [
      input.status,
      input.actualTo?.trim() || null,
      input.recipientOverridden == null
        ? Number(current.recipient_overridden)
        : input.recipientOverridden ? 1 : 0,
      input.smtpMessageId?.trim() || null,
      input.errorCode?.trim() || null,
      now,
      input.outboxId,
      input.attemptCount,
    ]);
    if (result.changes !== 1) throw new Error("film_order_mail_attempt_already_final");
    const updated = await tx.get<FilmOrderMailAttemptRow>(
      "SELECT * FROM film_order_mail_attempts WHERE outbox_id=? AND attempt_count=?",
      [input.outboxId, input.attemptCount],
    );
    if (!updated) throw new Error("film_order_mail_attempt_not_found");
    return mapAttempt(updated);
  };
  return input.client ? update(input.client) : db.transaction(update);
}

export async function recordFilmOrderMailSkippedAttempt(
  input: {
    outboxId: number;
    requestedByEmail: string;
    actualTo?: string | null;
    errorCode?: string | null;
    client?: SqlClient;
  },
): Promise<FilmOrderMailAttemptRecord> {
  const db = input.client ?? await getDatabaseForFilmMakerStore();
  const insert = async (tx: SqlClient): Promise<FilmOrderMailAttemptRecord> => {
    const envelope = await tx.get<FilmOrderMailOutboxRow>(
      "SELECT * FROM film_order_mail_outbox WHERE id=?",
      [input.outboxId],
    );
    if (!envelope) throw new Error("film_order_mail_outbox_not_found");
    const previous = await tx.get<{ maximum: number | null }>(
      "SELECT MAX(attempt_count) AS maximum FROM film_order_mail_attempts WHERE outbox_id=?",
      [input.outboxId],
    );
    const attemptCount = Number(previous?.maximum ?? 0) + 1;
    const now = new Date().toISOString();
    await tx.run(`
      INSERT INTO film_order_mail_attempts (
        outbox_id, attempt_count, status, requested_by_email, intended_to, actual_to,
        recipient_overridden, error_code, created_at, attempt_started_at, attempt_finished_at
      ) VALUES (?,?, 'skipped', ?,?,?,FALSE,?,?,?,?)
    `, [
      input.outboxId,
      attemptCount,
      input.requestedByEmail.trim(),
      envelope.intended_to,
      input.actualTo?.trim() || null,
      input.errorCode?.trim() || null,
      now,
      now,
      now,
    ]);
    const row = await tx.get<FilmOrderMailAttemptRow>(
      "SELECT * FROM film_order_mail_attempts WHERE outbox_id=? AND attempt_count=?",
      [input.outboxId, attemptCount],
    );
    if (!row) throw new Error("film_order_mail_attempt_insert_failed");
    return mapAttempt(row);
  };
  try {
    return input.client ? await insert(input.client) : await db.transaction(insert);
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("duplicate_film_order_mail_attempt");
    throw error;
  }
}

/** Crash recovery turns durable sending evidence into unknown; it never invents sent. */
export async function recoverStaleFilmOrderMailSendingAttempts(
  staleBefore: string,
  client?: SqlClient,
): Promise<FilmOrderMailAttemptRecord[]> {
  const db = client ?? await getDatabaseForFilmMakerStore();
  const recover = async (tx: SqlClient): Promise<FilmOrderMailAttemptRecord[]> => {
    const stale = await tx.all<FilmOrderMailAttemptRow>(`
      SELECT * FROM film_order_mail_attempts
      WHERE status='sending' AND attempt_started_at<=?
      ORDER BY attempt_started_at, id
    `, [staleBefore]);
    const now = new Date().toISOString();
    const recovered: FilmOrderMailAttemptRecord[] = [];
    for (const row of stale) {
      const result = await tx.run(`
        UPDATE film_order_mail_attempts
        SET status='unknown', attempt_finished_at=?
        WHERE id=? AND status='sending'
      `, [now, row.id]);
      if (result.changes === 1) {
        const updated = await tx.get<FilmOrderMailAttemptRow>(
          "SELECT * FROM film_order_mail_attempts WHERE id=?",
          [row.id],
        );
        if (updated) recovered.push(mapAttempt(updated));
      }
    }
    return recovered;
  };
  return client ? recover(client) : db.transaction(recover);
}
