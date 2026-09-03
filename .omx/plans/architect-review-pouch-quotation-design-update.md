# Architect Review: Pouch Quotation System Design Update

## Summary

The focused in-place revision is architecturally sound. The plan keeps the Japanese document canonical, preserves the established Next.js/Vercel architecture, and repairs the real seam between commercial quotation records and the internal cost/commission engine. Its strongest property is that every resolved quantity rule has a named unit and a deterministic verification contract, making the future implementation testable without prematurely inventing unavailable Seven Chemical or pricing data.

## Analysis

- **Canonical source and scope.** The selected focused revision avoids an addendum or rewrite. This is the right boundary: `pouch-quotation-system-design.md` already contains the preserved architecture and phased implementation, while the deep interview provides the resolved commercial and calculation semantics. A new appendage would leave legacy rules in place and create implementation ambiguity.
- **Quantity boundaries.** The plan correctly separates four quantities that could otherwise be collapsed: sellable connected pouches, independent fill chambers, film production lanes, and SKU order lengths. The formula `sellablePouchQuantity × chambersPerPouch × fillMlPerChamber × 1.1` makes the conversion explicit and TC-03 verifies the three-chamber `90ml` result.
- **Filling engine boundary.** The bulk contract keeps the common production/test term in both methods and isolates the real method difference in initial charge: `2,000ml` for hopper and `8,000ml` for pressure. TC-01 and TC-02 prove this by holding all other inputs constant, directly closing the prior pressure ambiguity.
- **Film and price extension.** Digital validation enforces both group-total and per-SKU constraints, allowing `300m + 300m` while rejecting a valid-total/invalid-SKU combination. The optional `widthBand × orderLengthBand × colorCount` lookup is extensible without creating a false default price. This is the correct extension point for future supplier data.
- **Quotation/commission boundary.** Quotation records store customer-facing commercial fields plus internal commission fields, with approval state and revision linkage. Commission is calculated only on transition to `approved`; revisions recalculate only after their own approval. The prohibition on exposing cost, supplier prices, and commission is explicit and enforceable through a customer-output field check.
- **Auditability.** Requiring immutable input and result JSON is essential because film rounding, producible quantity, filling loss, and approved subtotal can change between estimate time and later recalculation. This supports replayable quotations without turning the design task into implementation.

## Antithesis (Strongest Counterargument)

A complete rewrite could produce a cleaner product specification with one consistent data model from the outset, rather than preserving a legacy document whose film calculation sections, database sketch, and pseudocode already show minor naming and derivation drift. In-place revision therefore depends on a strong consistency gate; if the executor edits formulas but leaves divergent pseudocode or database fields, the document remains misleading even though its business flow is clearer.

## Tradeoff Tension

The plan must reconcile **preservation of brownfield decisions** with **cross-layer consistency**. Preserving the existing architecture and parameter tables minimizes regression risk, but it means the executor cannot rewrite every section freely and must propagate each semantic correction through narrative formulas, database fields, TypeScript sketches, output rules, and validation scenarios. This is the material cost of the focused option.

## Synthesis

Keep the focused revision, but treat consistency as an acceptance gate rather than a style preference. For each resolved rule, trace the same concept through all representations and use the test specification's cross-layer matrix as the completion gate. If a legacy representation cannot express the resolved semantics cleanly, update that representation within the same document rather than adding a parallel source of truth.

## Principle Checks

| Principle | Assessment |
|---|---|
| One canonical Japanese source | Pass — focused in-place revision selected |
| Explicit quantity distinctions | Pass — pouches, chambers, lanes, and SKUs are separated and tested |
| Deterministic/auditable calculations | Pass — exact formulas, rounding behavior, and input/result audit records are required |
| Internal/customer separation | Pass — commission timing and forbidden output fields are explicit |
| Preserve existing architecture | Pass — Next.js/Vercel and phased delivery remain in scope |

## Risks to Carry Into Critic Review

1. The pseudocode's `fixedLotCost` currently includes custom charge, while the PRD's separate component table may be read as keeping it outside fixed cost. The executor should show custom charge as a distinct component and make aggregation explicit.
2. Tax and rounding remain unresolved external policy. They must not be hardened into implementation defaults beyond clearly labeled confirmation/configuration inputs.
3. The Seven-facing quotation requires template data not present in the repository. The design should define required placeholders/configuration without inventing customer-private values.
4. Custom-size mapping remains open. Preserve extensibility while preventing an unvalidated width/lane/web-width guess from becoming a silent default.

## Architect Verdict

**APPROVE**

The plan is executable without guessing, preserves the necessary architecture, makes the critical boundaries testable, and explicitly holds unresolved external facts open. Proceed sequentially to Critic review.

## References

- `.omx/specs/deep-interview-pouch-quotation-system.md:13` — intent and documentation-only scope.
- `.omx/specs/deep-interview-pouch-quotation-system.md:43` — canonical chamber/filling terminology.
- `.omx/specs/deep-interview-pouch-quotation-system.md:61` — resolved bulk formulas and commission rule.
- `.omx/plans/prd-pouch-quotation-design-update.md:13` — selected focused revision and principles.
- `.omx/plans/test-spec-pouch-quotation-design-update.md:57` — numeric calculator contracts.
- `pouch-quotation-system-design.md:614` — existing quotation record foundation.
- `pouch-quotation-system-design.md:663` — existing calculation-engine interfaces.
