# Hermes Redaction Matrix

Version: 1.0.0 — matches `tool-schema.json` 1.0.0.

This matrix defines which server-authored fields Hermes may expose to the internal actor versus customer-safe output, and which fields are forbidden everywhere. Source of truth: `src/lib/agent-projections.ts`, `src/lib/agent-quote-service.ts`, `src/lib/agent-quote-read-service.ts`, `src/lib/agent-approval-service.ts`.

## Rules

1. **Two projections, never raw output.** The calculate route returns `{ internalActor, customerSafe }`. Hermes never receives the raw `CostResult`, master rows, supplier data, or unrestricted snapshot payloads.
2. **internalActor is internal-only.** Cost basis, hashes, snapshot metadata, warnings, and unresolved flags may be processed by the approved GPT provider only under the provider-processing approval in `release-checklist.md` (P-1). They must never reach customer-facing output, the canonical PDF, or customer-visible text.
3. **customerSafe is server-priced.** `displayedUnitPrice`, `displayedSubtotal`, `displayedTax`, and `displayedGrandTotal` come from `calculateAutomaticQuotation(result, "0.4")`. Hermes cannot choose or observe the margin, and no cost/profit basis appears in the projection.
4. **Client pricing authority is rejected.** Forbidden keys anywhere in calculate/issue requests return `400 client_pricing_authority_rejected` before business logic runs.
5. **Approval tokens are internal-actor only and never returned as fields.** Email drafts return at most a signed `approvalUrl`; `approvalTokenFieldPolicy` is always `"not_returned"`. Token bytes never leave the server.
6. **Customer approval is evidence-based.** Only the verified customer-token route writes token-derived evidence. Chat/email interpretation, agent reasoning, and owner-domain writes never produce `customer_approved`.
7. **Kanei-only record access.** All quote read/approval routes enforce `ownerDomain === "kanei"` plus owner-workflow authorization; Seven-owned records return `403`.
8. **Redaction survives errors.** Error responses are `{ "error": "<machine-readable reason>" }` only. They never echo payloads, corrections, tokens, supplier names, or internal economics.

## Field matrix

| Field group | internalActor | customerSafe | Notes |
| --- | --- | --- | --- |
| `quantity`, `printingMethod`, `connectedChambers`, `fillingMethod` | Yes | Yes | Non-sensitive descriptors. |
| `size` (widthMm/lengthMm) | via spec descriptors | Yes | Customer-safe presentation. |
| `displayedUnitPrice`, `displayedSubtotal`, `displayedTax`, `displayedGrandTotal` | Yes (issue response financials) | Yes | Server-derived selling amounts only. |
| `candidateOptions[]` (optionNumber, label, quantity, lengths) | Superset via `candidates[]` | Yes | Customer view omits all cost fields. |
| `candidates[]` cost fields: `filmTotalYen`, `filmCostPerPieceYen`, `incrementalFilmTotalYen`, `copperPlateTotalYen`, `allInTotalCostYen`, `allInCostPerPieceYen`, `allInDeltaYen`, `includedUnitPricePerM` | Yes | **No** | Internal economics. Never customer-facing. |
| `candidates[]` planning fields: quantities, lengths, surplus/shortage, fulfillment/practicality flags, `selectionTag`, `recommended` | Yes | Subset (quantity/lengths/label) | Server candidate IDs must be cited when comparing. |
| `calculation.calculationVersion`, `inputHash`, `resultHash`, `componentReconciliationDifference`, `digitalFilmPriceMode`, `authority` | Yes | **No** | Provenance for freshness/issuance verification. |
| `calculation.pricingSnapshot` (id, sha256, resolverVersion, asOf, `view: "redacted"`) | Yes (metadata only) | **No** | Snapshot payload never returned; metadata is hash-verifiable only. |
| `warnings[]`, `unresolvedInputFlags[]` | Yes | **No** | Operational signals; may contain internal diagnostics. |
| Quote `pdf.sha256`, `byteLength`, `rendererVersion`, `fileName` | Yes | Metadata-level | PDF bytes are served only through existing human download paths, never as agent payloads. |
| `approvals` summary / `customerApproval.state`, `approvedAt`, `source` | Yes | Summary only via summary route | State names are safe; evidence details stay internal. |
| Email `subject`, `body`, `recipient` | Yes (owner-domain draft read) | **No direct exposure rule** | Presented to the human operator for dispatch; Hermes never sends it. Body may embed the internal-actor approval URL. |
| `approvalUrl` (signed customer link) | Yes — after internal approval exists | **No** | Internal-actor only; generated server-side. |
| Approval **token bytes/fields** | **No — `not_returned`** | **No** | Never returned as a field by any agent route. |
| `designAttachments[]` metadata (fileName, sizeBytes, revision, contentType) | Yes | **No** | Attachment contents never returned. |

## Forbidden everywhere (input injection and output)

These keys are rejected on agent input (`400 client_pricing_authority_rejected`) and must never appear in any projection:

- Pricing authority: `pricePerPiece`, `subtotal`, `tax`, `grandTotal`, `filmCost`, `filmCostPerPiece`, `filmMeterPrice`, `filmOrderLengthM`, `cost`, `costs`, `costTotal`, `pricingSnapshot`
- Margin/commission: `margin`, `targetMargin`, `targetMargins`, `selectedCandidateTargetMargins`, `commission`, `commissionRate`
- Internal economics: `profit`, `resultHash` (as client-supplied authority), `supplier`
- Master-data authority (calculate input): `gravureYRows`, `ySupplierRows`, `pricingSnapshot`, `publicProjectionHash`, `pricingSnapshotSha256`, `fullAugmentedCalculationRequest`
- Checklist injection: `supplier`, `supplierName`, `pricingSnapshot`, `commission`, `commissionRate`, `payload`, `payloadJson`, `calculationFilmTotal`, `profitAudit`, `internalAudit`

Also forbidden in all Hermes/NAS artifacts: bearer tokens, session cookies, passwords, SMTP credentials, OAuth/Google service-account keys, `QUOTATION_APPROVAL_SECRET`, `FILM_EXTERNAL_TOKEN_SECRET`, approval token bytes, customer email bodies (beyond the draft-read tool's operator-facing output), raw IP addresses, and raw user-agent strings.

## Provider processing boundary (P-1)

Before production enablement, record explicit approval naming the GPT-backed Hermes provider and confirming it may process **only** the allowed `internalActor` fields listed above. `customerSafe` projections must never be sent to the provider unless a separately approved customer-facing flow requires it. Record the approval in `release-checklist.md` before rollout.
