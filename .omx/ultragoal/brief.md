# Brief: Pouch Quotation System Design Update

## Objective
Implement the approved Ralplan by updating only `pouch-quotation-system-design.md` into the execution-ready Japanese design specified by `.omx/plans/prd-pouch-quotation-design-update.md`.

## Authoritative inputs
- Planning handoff: `.omx/plans/execution-handoff-pouch-quotation-design-update.md`
- PRD: `.omx/plans/prd-pouch-quotation-design-update.md`
- Verification contract: `.omx/plans/test-spec-pouch-quotation-design-update.md`
- Interview specification: `.omx/specs/deep-interview-pouch-quotation-system.md`
- Existing target: `pouch-quotation-system-design.md`

## Scope
Documentation-only update to the existing Japanese design. Preserve Next.js/Vercel architecture and phased implementation. Cover business flow, canonical inputs/terms, hopper and pressure bulk formulas, connected pouches, digital SKU minimums, custom charge, color extensibility, Seven-facing output confidentiality, quotation records/revision/approval, internal 20% commission, database/pseudocode consistency, and validation scenarios.

## Non-goals
No application code, migrations, tests, UI, PDF implementation, Korean duplicate, or unrelated rewrite.

## Invariants
- 「枚」 is a sellable connected pouch; 「室」 is one fill chamber; fill volume is ml/室.
- Hopper and pressure both include `500 × filling lanes × fill`; initial charges are 2,000ml and 8,000ml respectively.
- Digital film requires total >=500m and every SKU >=300m; 300m+300m is valid.
- Custom pouch adds JPY 400,000 per specification.
- Commission defaults to 20% of tax-exclusive subtotal and is internal-only, calculated only after approval.
- Unverified Seven template metadata, tax/rounding, digital color prices, and custom-size mappings remain confirmation/configuration inputs.

## Verification
Apply the complete static checks and TC-01 through TC-11 in the test specification. Confirm the PRD acceptance matrix, architecture preservation, customer-facing/internal disclosure boundary, and absence of non-target implementation changes. Record evidence in the Ultragoal ledger and final handoff.
