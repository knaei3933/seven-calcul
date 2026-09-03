# Planner Review: Pouch Quotation System Design Update

## RALPLAN-DR Summary

### Principles

1. Preserve one canonical Japanese design document.
2. Keep connected-pouch, chamber, film-lane, and SKU quantities unambiguous.
3. Make commercial and production calculations deterministic and auditable.
4. Protect Seven-facing output from internal cost and commission disclosure.
5. Preserve the existing architecture and avoid an unrelated rewrite.

### Decision Drivers

1. The interview resolved all core calculation and terminology decisions.
2. The requested deliverable is a focused documentation update, not implementation.
3. Unknown Seven template, tax, rounding, digital color-price, and custom-size details must remain confirmation/configuration inputs.

### Viable Options

1. **Focused in-place revision — recommended.** Preserves established architecture and parameters while reconciling formulas, terminology, records, and scenarios. Requires disciplined cross-section consistency.
2. **Append an addendum.** Lower immediate disruption but risks duplicate or contradictory rules and weakens the single canonical source.
3. **Complete rewrite.** Could improve narrative flow but risks losing brownfield architecture and exceeds the requested bounded update.

Only Option A is selected because it directly meets canonical-source and scope constraints without discarding valid design evidence. Option B fails the single-source principle because newly resolved rules would live beside legacy rules without eliminating contradictions. Option C fails minimality and increases regression risk across preserved architecture and phased implementation.

## Plan Summary

**Plan saved to:** `.omx/plans/prd-pouch-quotation-design-update.md`

**Scope:** Focused Japanese documentation update across business flow, required inputs and terminology, bulk calculation, digital film and color rules, custom charge, Seven-facing output, quotation records, approval/commission state, database design, calculation pseudocode, and validation scenarios in `pouch-quotation-system-design.md`; estimated complexity: MEDIUM.

## Requirements and Acceptance

- Requirements: make the existing design executable by a later implementation team while keeping it documentation-only and preserving the existing Next.js/Vercel architecture.
- Acceptance criteria: `.omx/plans/prd-pouch-quotation-design-update.md` defines 12 checkable outcomes.
- Verification contract: `.omx/plans/test-spec-pouch-quotation-design-update.md` maps each outcome to static checks, numeric contract tests, data/engine consistency checks, and a review checklist.

## Implementation Steps

1. Reconcile the overview and business flow with Kanai Trading issuance, Seven Chemical approval, revision control, approved-only commission, and internal-only disclosure. Reference: existing `pouch-quotation-system-design.md:8`.
2. Tighten required inputs and terminology so width/length, quantity, fill, filling method, connected form, custom flag, color count, and SKU lengths have explicit units. Reference: `pouch-quotation-system-design.md:43`.
3. Replace ambiguous bulk prose with the exact hopper and pressure formula contract and both worked examples. Reference: `pouch-quotation-system-design.md:113`.
4. Reconcile digital SKU minimums, upward `100m` approximation, quantity recalculation, color-price extensibility, and `JPY 400,000` custom charge. References: `pouch-quotation-system-design.md:348`, `pouch-quotation-system-design.md:482`.
5. Align quotation records, status transitions, revisions, Seven-facing fields, and internal commission fields with the customer/confidentiality boundary. References: `pouch-quotation-system-design.md:566`, `pouch-quotation-system-design.md:885`.
6. Align calculation-engine interfaces and database fields with connected chambers, filling, SKU validation, custom charge, color extensibility, approval state, commission, and audit JSON. References: `pouch-quotation-system-design.md:660`, `pouch-quotation-system-design.md:769`.
7. Expand validation scenarios so each PRD criterion and calculator contract has a concrete expected result. Reference: `pouch-quotation-system-design.md:934`.
8. Run the test specification as a documentation review and correct any narrative/data/pseudocode divergence before planning handoff.

## Risks and Verification

- Risks / mitigations: terminology drift, omitted pressure test fill, internal-data leakage, false precision from unresolved external values, and database/pseudocode divergence are addressed in the PRD risk table and TC-01 through TC-11.
- Verification: static review, numeric examples, acceptance matrix, cross-layer consistency matrix, architecture-preservation check, and unconfirmed-value inventory.
- Stop condition: complete only when every acceptance criterion and test-contract item passes or remains an explicit external confirmation item; otherwise return to Planner.

## Handoff Guidance

Proceed to Architect review of business, data, calculation, confidentiality, and testability boundaries. Architect review must complete before Critic review. Do not begin implementation from this plan; Ralplan remains a planning workflow.
