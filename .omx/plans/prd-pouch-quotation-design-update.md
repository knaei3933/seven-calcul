# PRD: Pouch Quotation System Design Update

## Metadata

- Planning source: `.omx/specs/deep-interview-pouch-quotation-system.md`
- Context snapshot: `.omx/context/pouch-quotation-system-20260831T131742Z.md`
- Target artifact: `pouch-quotation-system-design.md`
- Artifact language: Japanese
- Execution scope: documentation-only

## Objective

Update the existing Japanese design document so Kanai Trading can reliably calculate and issue Seven Chemical pouch quotations. The document must define all required inputs, connected-pouch and filling calculations, digital-film constraints, custom charges, quotation records, approval states, and the internal 20% commission while ensuring that costs, supplier prices, and commission never appear on the customer-facing quotation.

## Evidence Base

- The existing document already defines the intended Next.js, Vercel, admin, database, calculation-engine, Seven-facing quotation, and phased-implementation architecture.
- The interview resolved the canonical terminology: 連結後パウチ枚数, 室, 充填量（ml/室）, and 充填列数.
- Existing requirements include width, length, fill volume, sellable-pouch quantity, filling method, connected form, custom flag, color count, and SKU order lengths.
- The existing design has no complete pressure-filling rationale, no explicit quotation revision record, no customer-approval commission timing rule, and no end-to-end acceptance traceability matrix.

## Principles

1. Keep the Japanese design document as the single canonical product/design source.
2. Distinguish sellable connected pouches, filling chambers, film production lanes, and SKU order lengths.
3. Make every calculation deterministic, unit-explicit, and testable by future TypeScript tests.
4. Separate internal cost and commission data from Seven Chemical-facing output.
5. Preserve the existing architecture and phased implementation while removing ambiguity.

## Decision Drivers

1. The deep interview resolved pressure filling, chamber conversion, film minimums, custom charge, and commission basis.
2. The task is bounded to one Japanese documentation update and excludes implementation, UI, database migration, tests, and PDF generation.
3. Unverified Seven template metadata, tax and rounding policies, color-specific digital prices, and custom-size mappings must remain confirmation/configuration inputs rather than invented values.

## Alternatives Considered

### Option A — Focused In-Place Design Revision

Revise the existing sections while preserving the document structure and architecture.

- Pros: preserves established decisions, minimizes drift, keeps one canonical source, and directly repairs only ambiguous sections.
- Cons: requires careful synchronization of formulas, database fields, pseudocode, and scenarios.

### Option B — Add an Implementation Addendum

Append a new section containing all newly resolved rules.

- Pros: lower immediate risk of removing legacy context.
- Cons: creates duplicated and potentially contradictory rules, weakens the single-source-of-truth principle, and still requires later consolidation.

### Option C — Complete Document Rewrite

Replace the document with a newly structured specification.

- Pros: can produce a cleaner narrative.
- Cons: increases the chance of losing established architecture, parameter tables, implementation phases, and brownfield evidence; exceeds the bounded update scope.

**Selected option:** A. It best satisfies the canonical-document, preserve-architecture, and minimal-scope principles.

## Required Document Content

### 1. Commercial Flow and Confidentiality

The overview and business flow must describe:

1. Kanai Trading enters or reviews the pouch specification, filling conditions, quantity, commercial terms, and margin.
2. The pure calculation engine produces an auditable cost and draft quotation result.
3. Kanai Trading issues the Seven Chemical-facing quotation.
4. Seven Chemical approves, rejects, allows expiry, or requests a revision.
5. Commission is calculated only after the quotation status becomes `approved`.

The default commission is `20% × tax-exclusive subtotal`. Tax basis and monetary rounding remain configurable and explicitly marked as final confirmation items. Commission, internal cost, supplier prices, and margin must be documented as internal-only and prohibited from standard Seven-facing output.

### 2. Canonical Inputs and Terminology

The required-input matrix must cover:

| Input | Canonical unit / semantics |
|---|---|
| Pouch width and length | mm; standard values resolve through the size master |
| Fill volume | ml/室, entered per filling chamber |
| Quantity | connected sellable pouches (連結後パウチ枚数) |
| Filling method | ホッパ充填 or 加圧充填 |
| Connected form | 1連=1室, 2連=2室, 3連=3室, 4連=4室 |
| Custom flag | standard or custom |
| Digital color count | integer; extensible to a color-specific price table |
| SKU lengths | list of order lengths in metres for digital validation |

The document must explicitly distinguish:

- 1 sellable pouch = one connected unit.
- 1室 = one independent fill chamber within that unit.
- Total fill per sellable pouch = chamber count × ml/室.
- Film lanes are production lanes and are managed separately from chamber count.

### 3. Bulk Calculation Contract

The document must state one exact contract for both filling methods:

```text
bulkUsageMl =
  sellablePouchQuantity × chambersPerPouch × fillMlPerChamber × 1.1
  + initialChargeMl
  + 500 × fillingLanes × fillMlPerChamber

initialChargeMl:
  hopper = 2,000 ml
  pressure = 8,000 ml
```

The document must state that pressure filling includes the same 500-run test-fill term as hopper filling; only the initial charge differs. It must include worked examples for both methods and preserve `ml`, connected-pouch, and chamber units at every step.

### 4. Digital Film, Custom, and Color Rules

Digital film validation must require:

```text
totalOrderLengthM >= 500
for every SKU: orderLengthM >= 300
```

Therefore `300m + 300m = 600m` is valid. Any group total below `500m` or any SKU below `300m` must fail validation with actionable correction options: raise each SKU to `300m`, consolidate/reassign SKUs, or apply the system-generated minimum viable allocation. Approximate order lengths are rounded upward to `100m`, then producible quantity is recalculated from pitch, lanes, loss, and applicable production multipliers.

The custom-pouch rule must add `JPY 400,000` once per custom specification. The digital color model must expose `width band × order-length band × color count` extensibility but must not invent unavailable color prices; when no color-specific table exists, the document must state that the applicable common price is used and the UI/result discloses that color-specific pricing was not applied.

### 5. Quotation Records and Seven-Facing Output

The quotation design must define the required customer-facing fields: issuer and customer identity blocks, quotation number and revision, issue and validity dates, product description, specification summary, quantity, unit, unit price, amount, delivery term, payment term, tax-exclusive subtotal, tax, tax-inclusive total, notes, and approval/reference fields that are confirmed for Seven Chemical.

The record design must preserve:

- immutable calculation input and result JSON for audit and recalculation;
- draft → sent → approved/rejected/expired status transitions;
- latest approved revision controls;
- tax-exclusive subtotal, tax rate, tax, total, commission rate, commission amount, approval timestamp, and revision linkage;
- internal-only access to cost and commission fields.

### 6. Data and Calculation-Engine Alignment

Database and pseudocode sections must agree on:

- connected pouch quantity versus total chamber count;
- `fillMlPerChamber`, filling method, filling lanes, loss rate, initial charge, and test-fill term;
- digital SKU list, required length, rounded order length, validation result, and correction proposal;
- custom flag and charge;
- digital color-count extension without inventing a default color price;
- quotation status, revision, approval timestamp, commission basis, and commission amount;
- storage of both input and result JSON.

The calculation engine must expose deterministic validation before quotation generation. Invalid film, quantity, fill, custom, color, or approval inputs must return structured errors and correction proposals instead of a finalized quotation.

### 7. Verification Scenarios

The validation section must map each acceptance criterion to at least one reproducible scenario, including:

1. `300m + 300m` is valid.
2. A group below `500m` is invalid.
3. Any SKU below `300m` is invalid even when the total is at least `500m`.
4. Hopper and pressure bulk formulas produce the same test-fill term but different initial charges.
5. A three-chamber pouch at `30ml/室` has `90ml` total fill per sellable pouch.
6. A custom specification adds exactly `JPY 400,000`.
7. An approved tax-exclusive subtotal of `JPY 1,000,000` generates `JPY 200,000` internal commission.
8. Non-approved quotation states generate no commission.
9. Approximate film lengths round upward by `100m` and quantity is recomputed from production parameters.
10. A revision creates a new quotation version and recomputes commission only after that revision is approved.

## Non-Goals

- Do not implement source code, database migrations, tests, UI, or PDF generation.
- Do not create Korean or bilingual requirements documents.
- Do not expose cost breakdown, supplier prices, or commission on customer-facing quotations.
- Do not invent Seven Chemical private template values, tax or rounding policy, digital color prices, or custom-size mappings.
- Do not replace the existing Next.js/Vercel architecture or phased implementation plan.

## Acceptance Criteria

1. The document is Japanese and remains the single target design artifact.
2. The Kanai Trading → Seven Chemical → approval → commission flow is explicit and commission is limited to approved quotations.
3. Every required input and its unit appears in the input and terminology sections.
4. Hopper and pressure formulas exactly implement the resolved bulk contract.
5. Sellable pouch count, chamber count, film lanes, and SKU order lengths are distinguishable.
6. Digital film rules accept `300m + 300m` and reject any group total below `500m` or SKU below `300m`.
7. Custom pouch adds `JPY 400,000` per specification.
8. Seven-facing output and internal commission boundaries are explicit and do not overlap.
9. Database and pseudocode designs cover all resolved rules and use consistent names/units.
10. Validation scenarios cover every edge case listed above and map to the acceptance criteria.
11. Existing Next.js/Vercel architecture and phased delivery remain intact.
12. Unverified template, tax, color-price, and custom-size values remain confirmation/configuration inputs.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Quantity terminology drifts between narrative, formulas, and pseudocode | Wrong chamber count and bulk volume | Use the canonical input matrix and run a terminology trace before review |
| Pressure formula accidentally omits test fill | Understated bulk cost and quotation | State the common test term once and test both methods against expected millilitres |
| Internal cost or commission leaks into customer output | Commercial confidentiality failure | Mark fields internal-only and validate the Seven-facing field list |
| Unverified prices or Seven metadata are treated as confirmed | Incorrect quotations and false certainty | Label unresolved values as confirmation/configuration inputs and leave no invented defaults |
| Database, pseudocode, and narrative diverge | Future implementation defects | Cross-check each resolved rule across all three representations |

## Definition of Done

The planner handoff is complete when the design document satisfies every acceptance criterion without introducing an unrelated rewrite, all explicit formulas are internally consistent, and the validation scenarios provide concrete evidence for a future implementation review.
