# Test Specification: Pouch Quotation System Design Update

## Scope

This is a documentation-only verification specification for `pouch-quotation-system-design.md`. It defines static acceptance checks, calculation-contract tests, quotation-state scenarios, and documentation review evidence. It does not execute application code or require new repository tests.

## Traceability

| PRD criterion | Verification |
|---|---|
| Japanese single-source document | File path, language, and duplicate-document check |
| Commercial flow and approved-only commission | Business-flow and quotation-state scenario matrix |
| Required inputs and units | Input/terminology matrix check |
| Exact bulk formulas | Formula check plus hopper/pressure numeric examples |
| Connected pouch semantics | Quantity/chamber/lane traceability check |
| Digital film minimums | Valid and invalid SKU scenarios |
| Custom charge | Cost-contract scenario |
| Seven-facing and internal boundaries | Output-field disclosure check |
| Database/pseudocode consistency | Cross-layer field and rule matrix |
| Validation scenarios | Acceptance-to-scenario matrix |
| Preserved architecture | Architecture and phased-delivery regression check |
| Unverified values remain configurable | Open-confirmation inventory check |

## Static Documentation Checks

1. Confirm the target path is `pouch-quotation-system-design.md`.
2. Confirm the document remains primarily Japanese and contains no separate Korean requirements section.
3. Confirm the document still contains Next.js, Vercel, and phased implementation content.
4. Confirm the canonical Japanese terms are present and used consistently:
   - 連結後パウチ枚数
   - 室
   - 充填量（ml/室）
   - 充填列数
5. Confirm there is no customer-facing section that displays 原価内訳, 仕入値, supplier prices, 成功報酬, or commission.
6. Confirm unverified Seven template fields, tax and rounding, digital color prices, and custom-size mapping are labeled confirmation/configuration inputs rather than fixed assumptions.

## Calculator Contract Tests

### TC-01 — Hopper bulk formula

Input:

- sellable pouches: `10,000`
- chambers per pouch: `2`
- fill volume: `30ml/室`
- filling lanes: `4`
- method: `hopper`

Expected:

```text
chambers = 10,000 × 2 = 20,000
testFillMl = 500 × 4 × 30 = 60,000
bulkUsageMl = 20,000 × 30 × 1.1 + 2,000 + 60,000 = 722,000
```

### TC-02 — Pressure bulk formula

Reuse TC-01 inputs but select pressure filling.

Expected:

```text
testFillMl = 60,000
bulkUsageMl = 20,000 × 30 × 1.1 + 8,000 + 60,000 = 728,000
```

The pressure result must contain the same test-fill term as hopper filling; only the initial charge differs.

### TC-03 — Connected fill conversion

Input: `3連`, `1,000` sellable pouches, `30ml/室`.

Expected:

```text
chambers = 3,000
fill per sellable pouch = 3 × 30 = 90ml
```

### TC-04 — Valid two-SKU digital order

Input: SKU A `300m`, SKU B `300m`.

Expected: valid because total `600m >= 500m` and every SKU is at least `300m`.

### TC-05 — Invalid group total

Any digital group whose rounded total is below `500m` must be invalid with a total-minimum correction proposal.

### TC-06 — Invalid SKU minimum

Input examples:

- `250m + 300m`: SKU A is below `300m`; invalid.
- `450m + 50m`: total is `500m`, but SKU B is below `300m`; invalid.

Expected: no finalized quotation and a structured correction proposal.

### TC-07 — Approximate order and quantity recalculation

A required film length not already aligned to `100m` is rounded upward to the next `100m`. The resulting producible quantity is then recalculated from pitch, film lanes, loss, and applicable production multiplier. The document must not imply that rounding alone determines sellable quantity.

### TC-08 — Custom specification charge

For `isCustom = true`, add exactly `JPY 400,000` once for the specification. For `isCustom = false`, add `JPY 0`. The document must show the charge as a distinct internal cost component.

### TC-09 — Approved commission

For an approved quotation with tax-exclusive subtotal `JPY 1,000,000` and default commission rate `20%`:

```text
commissionAmount = 1,000,000 × 0.20 = 200,000
```

The amount is internal-only and calculation is triggered only by the `approved` transition.

### TC-10 — Non-approved commission

For `draft`, `sent`, `rejected`, and `expired`, `commissionAmount` must remain zero/null or otherwise be unusable, and the document must state that no payable/applicable commission is generated.

### TC-11 — Revision after approval

When an approved quotation changes, create a new revision linked to the prior version. Preserve prior audit data, recalculate costs/commercial output, and calculate a new commission only after the revision reaches `approved`.

## Data and Engine Consistency Checks

For every resolved rule below, the narrative formula, database model, and pseudocode must use compatible names and units:

1. sellable-pouch quantity and total chamber count;
2. `fillMlPerChamber`, filling method, filling lanes, initial charge, loss rate, and test-fill term;
3. SKU required/order lengths and digital validation result;
4. custom flag and specification charge;
5. color count and optional color-specific price lookup;
6. quotation status, revision, approval timestamp, commission basis, and commission amount;
7. immutable input/result audit JSON.

## Review Checklist

- [ ] All PRD acceptance criteria are represented in the document.
- [ ] Formulas use explicit units and produce the TC-01 through TC-11 expectations.
- [ ] Seven-facing fields do not include internal cost or commission.
- [ ] Quotation state and revision behavior are explicit.
- [ ] Database and pseudocode cover the same business rules as the narrative.
- [ ] Existing architecture and development phases remain present.
- [ ] No implementation code, migration, UI, PDF, or test source was added.
- [ ] No unverified value was converted into a false default.

## Completion Evidence

Record completed checklist items and any remaining external confirmation items in the planning handoff. A documentation change is complete only when every static check, calculator contract, consistency check, and review item passes or its unresolved external dependency is explicitly listed as a confirmation input.
