# Execution-Ready Spec: Pouch Quotation System Design Update

## Metadata
- Profile: standard
- Rounds: 4 (3 user-facing rounds plus one canonical terminology resolution)
- Final ambiguity: 16%
- Threshold: 20%
- Context type: brownfield
- Context snapshot: `.omx/context/pouch-quotation-system-*.md`
- Interview transcript: `.omx/interviews/pouch-quotation-system-*.md`
- Oversized-context summary: not needed

## Intent
Concretize the existing Japanese pouch cost/quotation design so Kanai Trading can quote Seven Chemical reliably and the system owner can calculate its 20% post-approval commission without exposing internal cost data.

## Desired Outcome
Update `pouch-quotation-system-design.md` into a more actionable design covering commercial flow, all required user inputs, connected pouches, filling calculation, digital film SKU minimums, custom charge, Seven Chemical quotation requirements, quotation records, commission, and validation scenarios.

## In-Scope
- Modify the existing Japanese design document only.
- Add Seven Chemical/Kanai Trading business flow and internal commission model.
- Define user input fields and unit semantics.
- Define hopper/pressure bulk formulas and connected-pouch conversion.
- Define digital film total/SKU minimum rules and correction suggestions.
- Define custom-pouch flat charge and color-count extensibility.
- Define quotation records, approval states, standard Seven-facing output requirements, and verification scenarios.
- Keep future gravure support and technical architecture aligned with the existing design.

## Out-of-Scope / Non-Goals
- Do not implement code, database migrations, tests, UI, or PDF generation in this task.
- Do not create a separate Korean requirements document or bilingual duplicate.
- Do not expose cost breakdown, supplier prices, or commission on customer-facing quotations.
- Do not invent Seven Chemical's private issuer/customer template values or unverified digital color prices.

## Decision Boundaries
- Existing Japanese document is the single source of truth.
- “枚” means one sellable connected pouch; “室” means one fill chamber; fill volume is `ml/室`.
- Chamber count: 1連=1, 2連=2, 3連=3, 4連=4.
- Both filling methods include `500 × filling lanes × fill volume`; initial charge is 2L for hopper and 8L for pressure.
- Digital order group requires total >=500m and each SKU >=300m.
- Custom pouch uses JPY 400,000 per specification by default.
- Commission defaults to 20% of tax-exclusive subtotal and is calculated only after customer approval.

## Constraints
- Japanese-language document update.
- Preserve the existing Next.js/Vercel-oriented architecture and phased implementation approach.
- Keep calculation rules auditable and explicit enough for later TypeScript tests.
- Keep unverified Seven template metadata, tax/rounding, digital color prices, and custom-size mapping as confirmation/config inputs.

## Acceptance Criteria
1. Document explains Kanai Trading → Seven Chemical → approval → 20% commission flow.
2. Required calculator inputs include width, length, fill volume, quantity, filling method, connected form, custom flag, color count, and SKU lengths.
3. Bulk formulas exactly implement:
   - Hopper: `pieces × chambers × fill × 1.1 + 2,000ml + 500 × filling lanes × fill`
   - Pressure: `pieces × chambers × fill × 1.1 + 8,000ml + 500 × filling lanes × fill`
4. Connected-pouch semantics distinguish sellable pouch count from chamber count and film lanes.
5. Digital film validation accepts 300m + 300m = 600m while rejecting any total <500m or SKU <300m.
6. Custom pouch adds JPY 400,000 per specification.
7. Seven-facing quotation requirements and internal-only commission/cost boundaries are explicit.
8. Database and pseudocode designs reflect connected pouches, filling rules, custom charge, color extensibility, quotation state, commission, and SKU validation.
9. Validation scenarios cover minimum order edge cases, filling formulas, connected conversion, custom charge, commission, and approximate quantity recalculation.

## Assumptions Exposed + Resolutions
- Pressure filling might exclude test fill. **Resolved:** include it.
- Connected-pouch fill might be per connected unit. **Resolved:** enter per chamber and multiply by chamber count.
- A separate Korean document might be desired. **Resolved:** update Japanese source only.
- Digital color count may have pricing. **Unverified:** model extensibility but do not invent prices; use common price when color-specific table is absent.

## Pressure-Pass Findings
The pressure-filling answer was revisited to confirm that the test quantity remains included and only initial charge differs. The connected-pouch terminology was then reconciled with the existing `N連/枚` language and established lane mappings.

## Brownfield Evidence
- Repository has no implementation or package manifest; it is documentation-only at interview time.
- `pouch-quotation-system-design.md` already defines the existing Next.js-oriented architecture, cost model, digital film pricing model, and open questions.
- No repo AGENTS.md, README, docs, glossary, or context snapshot existed before preflight.

## Docs/Terminology Ledger
- Canonical existing terms: デジタル印刷/デジタルフィルム, 発注長さ, 原反幅, 列数, 生産倍率.
- Added canonical terms: 連結後パウチ枚数, 室, 充填量(ml/室), 充填列数.
- User's “디지털 원단/필름” is treated as the existing digital film/printing surface, not a separate material.
- Document typo `调整` remains outside the requested calculation/commercial scope and does not create ambiguity.

## Scenario/Edge-Case Findings
- 2SKU at 300m+300m is valid because total 600m >=500m and each SKU >=300m.
- 3連 pouch at 30ml/ chamber has 90ml total fill per sellable pouch.
- Approved tax-exclusive subtotal of JPY 1,000,000 yields JPY 200,000 internal commission.
- Approximate order lengths are rounded upward by 100m, then possible quantity is recomputed from pitch, lanes, and loss.

## Technical Context
Future implementation should encode these rules in a pure calculation engine, validate all business constraints before quotation generation, and retain both input JSON and result JSON for audit/recalculation.

## Handoff
Recommended next step is `$ralplan` for architecture/test-shape review, or `$ultragoal` to implement from this spec after the design document is accepted.
