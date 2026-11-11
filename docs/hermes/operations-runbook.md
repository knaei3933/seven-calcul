# Hermes Operations Runbook

Version: 1.0.0 — matches `tool-schema.json` 1.0.0.

Audience: operators deploying Hermes against the pouch quotation system. Repository SSOT rule: **this repository (`/root/pouch-clacul`) is the implementation and configuration SSOT.** The NAS path `\\10.10.10.3\ai\パウチ充填事業` receives versioned, hash-verified *copies* for Hermes container staging only. Never edit artifacts on the NAS and never treat the NAS as the source of truth.

## 1. Artifacts and integrity

| Artifact | Purpose |
| --- | --- |
| `docs/hermes/tool-schema.json` | Versioned tool schema/config (8 tools, exact endpoints/scopes). |
| `docs/hermes/redaction-matrix.md` | internalActor vs customerSafe rules and forbidden fields. |
| `docs/hermes/operations-runbook.md` | This runbook. |
| `docs/hermes/release-checklist.md` | Launch blockers, gates, provider approval, rollback. |
| `docs/hermes/manifest.sha256` | SHA-256 manifest of the four files above (excludes itself). |

Generate the manifest (run from repository root, after editing any Hermes doc):

```bash
sha256sum docs/hermes/tool-schema.json docs/hermes/redaction-matrix.md \
  docs/hermes/operations-runbook.md docs/hermes/release-checklist.md \
  > docs/hermes/manifest.sha256
```

Verify (must print `OK` for all four lines):

```bash
sha256sum -c docs/hermes/manifest.sha256
```

## 2. Staging setup

1. Deploy the app to the staging environment; confirm the base URL is HTTPS.
2. Ensure the principal `ai@kanei-trade.co.jp` exists, is **active**, and is **non-admin** (`resolvePrincipal` rejects missing, mismatched, admin, or inactive principals).
3. Provision a staging credential (Section 4). Minimum scope set: `calculate:run`; add read/issue scopes as each phase is exercised.
4. Confirm staging env from Section 5; keep `AGENT_INTERNAL_APPROVAL_ENABLED` unset or `false` until policy approval exists (Section 6).
5. Run smoke tests (Section 8) against staging.

## 3. Production setup

1. Complete every item in `release-checklist.md`. All blockers must pass before enabling write scopes.
2. Deploy the app via the normal production pipeline. The app never runs on the NAS.
3. Verify `ai@kanei-trade.co.jp` is active/non-admin in production.
4. Provision a production credential with the minimum scopes needed for the approved phase (for example `calculate:run`, `quote:issue`, `quote:read`, `email_draft:read`, `approval_state:read`). Do **not** include `internal_approval:request` unless Section 6 gates are satisfied.
5. Store the token in Hermes-side secret storage (Section 5). Never place it in the repository, NAS copies, env files, or logs.
6. Run smoke tests (Section 8) in production read-only first (`credential_status`, then `calculate`), then phase-gated write tests.

## 4. Credential lifecycle

Server-side API: `src/lib/agent-auth-store.ts` exports `createAgentCredential`, `provisionAgentCredential`, `rotateAgentCredential`, and `revokeAgentCredential`. Tokens are 48 random bytes (base64url); only a SHA-256 hash is stored. There is **no repository CLI script for provisioning yet** — invoke these functions from a trusted server-side admin runtime/console. A token shown once (creation/rotation) must be copied into secret storage immediately and never re-displayed.

### Provision

- Bind to `ai@kanei-trade.co.jp`; wildcards (`*`) are rejected; duplicate/unknown scopes are rejected (`400 invalid_agent_scopes`, `400 wildcard_scope_rejected`).
- `includeInternalApproval: true` is required at issuance to grant `internal_approval:request`; otherwise the scope is stripped even if listed.
- Default TTL when using `provisionAgentCredential`: 30 days. Set an explicit expiry for production.

### Rotate

- `rotateAgentCredential(credentialId, { expiresAt, graceSeconds })` issues a replacement with the same scopes and marks the previous credential `rotated` (grace > 0) or `revoked` (grace = 0).
- Grace is bounded 0–86,400 s; default from `AGENT_ROTATION_GRACE_SECONDS` (default 0). Grace expires automatically on first use after the deadline.
- Rotate on schedule, on operator change, or on any suspicion of exposure. Update the stored token in Hermes secret storage, then confirm `credential_status` returns the new credential ID.

### Revoke

- `revokeAgentCredential(credentialId)` sets `revoked`, clears grace, and audits. Use immediately for compromise, decommissioning, or failed rotation recovery.
- Revocation of the sole credential stops all Hermes API access (fail-closed).

### Rollback of a bad rollout

1. Revoke the production credential (or rotate with `graceSeconds: 0`).
2. Disable any enabled write phase: remove `internal_approval:request` from credentials; unset `AGENT_INTERNAL_APPROVAL_ENABLED`.
3. Redeploy the last known-good app release if application code is implicated.
4. Quotations already issued remain durable history; do not retroactively edit them from Hermes. Use existing human owner-domain workflows for corrections.
5. Re-run read-only smoke tests before re-enabling.

## 5. Environment and secret storage

Agent-related environment variables (see `.env.example`):

| Variable | Default | Meaning / policy |
| --- | --- | --- |
| `AGENT_API_RATE_LIMIT` | `120` | Max requests per window per credential (1–100,000). |
| `AGENT_API_RATE_WINDOW_SECONDS` | `60` | Rate window (1–86,400 s). |
| `AGENT_ROTATION_GRACE_SECONDS` | `0` | Default rotation grace (0–86,400 s). 0 = immediate revoke. |
| `AGENT_INTERNAL_APPROVAL_ENABLED` | unset/false | Autonomous internal approval master switch. Fail-closed. |
| `AGENT_INTERNAL_APPROVAL_MAX_QUANTITY` | — | Required when enabled. Zero is a literal limit. |
| `AGENT_INTERNAL_APPROVAL_MAX_COST_JPY` | — | Required when enabled. Zero is a literal limit. |
| `AGENT_INTERNAL_APPROVAL_MAX_VALIDITY_DAYS` | — | Required when enabled. Zero is a literal limit. |
| `AGENT_INTERNAL_APPROVAL_ALLOWED_CUSTOMER_CODES` | — | Required when enabled; comma-separated; non-empty. |
| `AGENT_INTERNAL_APPROVAL_ALLOWED_PRINT_CLASSES` | — | Required when enabled; comma-separated; non-empty. |
| `AGENT_INTERNAL_APPROVAL_ACKNOWLEDGED_WARNINGS` | — | Warnings treated as acknowledged. |
| `AGENT_INTERNAL_APPROVAL_APPROVED_SNAPSHOT_AS_OF` | — | Explicitly approved snapshot dates (YYYY-MM-DD). |

Secret storage rules:

- The Hermes bearer token lives only in the Hermes container's secret manager. Reference it as `HERMES_AGENT_BEARER_TOKEN`; never bake it into images, compose files, or NAS artifacts.
- App-side secrets (`DATABASE_URL`, SMTP credentials, `QUOTATION_APPROVAL_SECRET`, `FILM_EXTERNAL_TOKEN_SECRET`, Google/OAuth keys) stay in the app host's secret store. Hermes never receives them.
- No secrets in copied files: NAS artifacts are exactly the four docs plus `manifest.sha256`; do not add anything else without regenerating the manifest.

## 6. Internal approval — disabled default and enablement gates

`AGENT_INTERNAL_APPROVAL_ENABLED` is **false/unset by default** and the evaluator is fail-closed (`internalApprovalConfigFromEnv` requires every limit; unknown/stale/missing config blocks with `409 approval_disabled` or `409 policy_limit_exceeded`).

Explicit enablement gates — all must hold:

1. Human policy approval recorded, fixing exact `MAX_QUANTITY`, `MAX_COST_JPY`, `MAX_VALIDITY_DAYS`, allowed customer codes, allowed print classes, acknowledged warnings, and approved snapshot dates.
2. Production credential re-issued/rotated with `includeInternalApproval: true` so it carries `internal_approval:request`.
3. All env vars from the table above set to the approved values; `AGENT_INTERNAL_APPROVAL_ENABLED=true`.
4. A staging run of `request_internal_approval` passes the full evaluator: active principal/scope; Kanei owner; valid draft transition; fresh calculation version/hash; canonical PDF present with verified hash; unexpired validity; no unacknowledged warnings/checklist blocks; sample-bulk confirmed when required; within all configured limits.
5. Rollout gate in `release-checklist.md` signed off.

Disable/rollback: unset `AGENT_INTERNAL_APPROVAL_ENABLED` and remove the scope from the credential. Either action alone is sufficient to block; do both.

## 7. NAS authenticated copy and hash verification

Target path: `\\10.10.10.3\ai\パウチ充填事業` (anonymous SMB is denied; use authenticated access or a configured mount).

1. From a workstation with authenticated write access to the NAS path, mount the share (do not store passwords in the repository or in scripts committed here).
2. Create a versioned destination directory, e.g. `hermes/v1.0.0/`, and copy exactly:

```text
docs/hermes/tool-schema.json
docs/hermes/redaction-matrix.md
docs/hermes/operations-runbook.md
docs/hermes/release-checklist.md
docs/hermes/manifest.sha256
```

3. On the NAS (or via the mounted path), verify:

```bash
sha256sum -c manifest.sha256
```

4. Copy nothing else: no `.env*`, no tokens, no database/backup/business data, no app code.
5. If any hash fails, delete the copy and re-deliver. Never patch NAS copies in place — fix the repository, regenerate the manifest, and redeliver.

## 8. Smoke tests

Run after every staging deploy and before production enablement. Replace `{{BASE_URL}}` with the environment's HTTPS origin; the token comes from that environment's secret storage.

Read-only:

```bash
curl -fsS -H "Authorization: Bearer ${HERMES_AGENT_BEARER_TOKEN}" \
  {{BASE_URL}}/api/agent/v1/status
```

Expected: HTTP 200 JSON with `credential.principal = ai@kanei-trade.co.jp` and exactly the granted scopes.

Scope isolation (must fail closed):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${HERMES_AGENT_BEARER_TOKEN}" \
  {{BASE_URL}}/api/agent/v1/quotes/1
```

Expected: `403` without `quote:read`; `404`/`403` per record access with it. Never `200` for a Seven-owned record.

Authentication failure (must be 401, never a leak):

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  {{BASE_URL}}/api/agent/v1/status
```

Expected: `401`.

Calculate (phase-gated; body must contain only simulator input fields — forbidden keys from `redaction-matrix.md` must be absent): issue a minimal valid `spec`/`quantity`/`printingMethod` request with `calculate:run` and confirm the response has exactly `internalActor` and `customerSafe`, no raw `CostResult` fields. Exercise gravure only when durable master DB and snapshot issuance are enabled; expect `503 gravure_master_unavailable` / `gravure_snapshot_issuance_disabled` otherwise (fail-closed, not fallback).

Write-path (staging first, then production phase gates): `issue_kanei_quote` with an `Idempotency-Key`; retry the same key and confirm `outcome: "duplicate"`; then `read_kanei_quote`, `read_kanei_email_draft`, `read_customer_approval_state`. Confirm `request_internal_approval` returns `409 approval_disabled` while disabled. After enablement gates pass, confirm one allow and the audit trail.

Full regression before release:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## 9. Omissions and limitations

- No credential-provisioning CLI exists in the repository; lifecycle functions are library exports (Section 4).
- NAS delivery is documented as a procedure; authenticated mount setup is environment-specific and out of repository scope.
- Smoke `curl` commands are templates: endpoint shapes and expected status codes are verified against current code, but live execution requires each environment's base URL and secret storage.
