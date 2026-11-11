# Hermes Release Checklist

Version: 1.0.0 — matches `tool-schema.json` 1.0.0. Complete every blocker before production enablement; record gate outcomes below.

## 1. GPT-provider processing approval (P-1) — launch blocker

- [ ] Decision recorded: the selected GPT-backed Hermes provider may process **only** the allowed `internalActor` fields listed in `redaction-matrix.md`.
- [ ] Explicitly recorded: `customerSafe` projections are **not** sent to the provider unless a separately approved customer-facing flow requires it.
- [ ] Provider identity, approval date, approver, and approved field list recorded in the decision log.
- [ ] No forbidden fields (Section "Forbidden everywhere" in the redaction matrix) appear in any provider-facing configuration.

## 2. Portal-v1 rejection rationale (P-2) — recorded decision

Portal v1 is **not a Hermes surface** and this decision is traceable here:

- Portal v1 exposes customer-facing identity, projections, and authorization; it does not provide Kanei owner workflow or approval authority.
- The scoped `/api/agent/v1` credential is likewise not accepted by portal/user APIs; production auth is Bearer-only on `/api/agent/v1/*`.
- Hermes must not improvise portal/session/cookie calls; session-cookie staging probes are staging-only and behind an explicit non-production flag.

- [ ] Recorded in decision log/runbook with date and approver.

## 3. Production launch blockers (P-4)

All must pass:

- [ ] Required baseline/new tests pass (`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`).
- [ ] Scoped credential lifecycle/schema enforcement passes (create/expiry/rotate/revoke/rate-limit; hash-only storage; wildcard/scope rejection).
- [ ] Route/scope isolation passes (each tool enforces its exact scope; credential rejected outside `/api/agent/v1/*`).
- [ ] Shared KT allocation concurrency passes (SQLite single-writer or equivalent; no duplicate `KT-YYYYMM-NNN`).
- [ ] Deterministic canonical PDF and redaction audit pass (pinned assets fail closed; PDF contains customer-facing selling data only).
- [ ] Issuance idempotency passes (same key + fingerprint replays; key conflict returns `409`).
- [ ] Customer-evidence provenance passes (`customer_approved` only from durable customer-token evidence).
- [ ] Durable append-only audit passes (allow/deny/error events; no credentials/cookies/raw payloads/email bodies/secrets in audit rows).
- [ ] Hermes HTTPS and secure credential storage pass (HTTPS-only base URL; token in Hermes secret storage; no secrets in artifacts).
- [ ] Staging E2E passes (all eight tools; failure paths fail closed).
- [ ] GPT-provider `internalActor` processing approval recorded (Section 1).
- [ ] Internal approval remains disabled until exact limits/freshness rules are approved (Section 4).
- [ ] NAS artifact SHA-256 verification passes if NAS rollout is included (Section 5).

## 4. Rollout gates

| Gate | Evidence required | Status |
| --- | --- | --- |
| G0 Read-only staging | `credential_status` + `calculate` smoke pass; scopes limited to `calculate:run` | ☐ |
| G1 Issue staging | `issue_kanei_quote` + idempotent replay + read tools pass on staging | ☐ |
| G2 Production read-only | Production `credential_status` + `calculate` smoke pass; rate limits set | ☐ |
| G3 Production issue | Production issuance + read tools pass; human mail dispatch and customer-token flow confirmed manually | ☐ |
| G4 Internal approval enablement | All Section 6 gates in `operations-runbook.md` satisfied; one audited allow in staging; policy fingerprint observed | ☐ |
| G5 NAS delivery (optional) | Manifest verifies on NAS; Hermes container consumes config and passes smoke | ☐ |

Rules: never enable a later gate while an earlier gate for the same environment is unmet; write scopes ship only after G1 (staging) / G3 (production); `internal_approval:request` ships only at G4.

## 5. NAS artifact gate

- [ ] Manifest regenerated from repository: `sha256sum -c docs/hermes/manifest.sha256` passes locally.
- [ ] Authenticated copy of exactly the five Hermes artifacts to `\\10.10.10.3\ai\パウチ充填事業\hermes\<version>\`.
- [ ] `sha256sum -c manifest.sha256` passes on the NAS copy.
- [ ] No `.env*`, secrets, tokens, business data, or app code copied.
- [ ] Hermes container smoke tests pass against the delivered config.

## 6. Rollback

1. Revoke/rotate-to-zero the production credential (see `operations-runbook.md` Section 4).
2. Unset `AGENT_INTERNAL_APPROVAL_ENABLED` and remove `internal_approval:request` from credentials.
3. Restrict remaining credential scopes to the last good gate (read-only if writes are implicated).
4. Redeploy last known-good app release if code is implicated.
5. Delete failed NAS copies; redeliver only after repository fix and manifest regeneration.
6. Confirm rollback with read-only smoke tests (`credential_status` must reflect reduced scopes or 401 after revocation).

## 7. Sign-off record

| Item | Approver | Date | Evidence link/ID |
| --- | --- | --- | --- |
| Provider processing approval (P-1) | | | |
| Portal-v1 rejection record (P-2) | | | |
| Production launch (P-4) | | | |
| Internal approval enablement | | | |
| NAS delivery (if used) | | | |
