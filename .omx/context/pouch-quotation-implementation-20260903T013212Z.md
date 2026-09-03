# Pouch Quotation System Implementation Context

## Target
Implement the approved pouch quotation design as a runnable Next.js application with a usable quotation UI, exact cost engine, and executable verification.

## Authority
- Canonical design: `pouch-quotation-system-design.md`
- Interview source: `.omx/specs/deep-interview-pouch-quotation-system.md`
- Existing durable Ultragoal run is complete; this is a new implementation scope.

## Required behavior
- Japanese UI; sellable pouch quantity is the quantity basis; chambers are fill compartments.
- Bulk formula: `quantity * chambers * fill * 1.1 + methodInitial + 500 * fillingLanes * fill`; hopper initial 2,000 ml, pressure initial 8,000 ml.
- Digital film: round each SKU required length to 100m; reject total <500m or any SKU <300m; provide structured corrections.
- Custom pouch adds JPY 400,000 per specification once, separate from fixed lot cost.
- Approved-only commission is 20% of tax-exclusive subtotal and remains internal-only.
- Customer output must exclude cost, procurement, margin, commission, and internal metadata.
- Preserve Next.js/Vercel architecture and document phases; do not invent unverified Seven template, tax/rounding, digital color price, or custom-size conversion values.

## Implementation scope for first runnable increment
- Next.js app, quotation calculation screen, client-side provisional calculation plus server/shared deterministic calculation core.
- Use exact Decimal arithmetic in the calculation core.
- Use standard design values already fixed in the document; expose unverified inputs as explicit warnings/blocked states.
- No database/authentication/PDF production integration in this increment.
- Include unit tests for bulk, film quantity/price, digital minimums, custom cost, commission, Decimal reconciliation.
- Include browser smoke/E2E for input, validation, calculation, result split, and output-separation behavior.

## Verification contract
- Lint, typecheck, unit tests, build, and E2E/browser smoke must pass or produce explicit evidence-backed failures.
- Numeric audit must pass the fixed cases and cross-check component totals against final cost.
