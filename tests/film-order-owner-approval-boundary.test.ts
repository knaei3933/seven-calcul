// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canPerformFilmOrderActorAction } from "@/lib/film-order-access";
import { assertFilmOrderActionGuard, type FilmOrderGuardInput } from "@/lib/film-order-stage";

function order(buyerApprovalStatus: "pending" | "approved" = "pending"): FilmOrderGuardInput {
  return {
    id: 1,
    status: "proof_registered",
    customerProofStatus: "pending",
    supplierApprovalStatus: "pending",
    buyerApprovalStatus,
    customerProofPdfRegistered: true,
    procurementRoute: "Y",
    printingMethod: "digital",
    supplierResolution: "legacy_unresolved",
    supplierEmail: "maker@example.test",
    makerId: 1,
    makerSnapshot: { id: 1, email: "maker@example.test", isActive: true, procurementRoute: "Y", printMethod: "digital" },
  };
}

describe("film-order durable-owner approval boundary", () => {
  it("preserves Seven-only approve authority for legacy Seven-owned records", () => {
    expect(canPerformFilmOrderActorAction("approve", "seven@727.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderActorAction("approve", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(false);
    expect(() => assertFilmOrderActionGuard(order(), "approve", "buyer")).toThrow(
      "customer_proof_release_required",
    );
  });

  it("uses Kanei buyer authority for new Kanei-owned records", () => {
    expect(canPerformFilmOrderActorAction("approve", "kanei@kanei-trade.co.jp", "kanei-trade.co.jp")).toBe(true);
    expect(canPerformFilmOrderActorAction("approve", "seven@727.co.jp", "kanei-trade.co.jp")).toBe(false);
    expect(() => assertFilmOrderActionGuard(order(), "approve", "buyer")).toThrow(
      "customer_proof_release_required",
    );
  });

  it("fails closed on malformed durable owner domains for both companies", () => {
    for (const buyerDomain of ["", "example.test", "evil727.co.jp", "notkanei-trade.co.jp"]) {
      expect(() => canPerformFilmOrderActorAction("approve", "seven@727.co.jp", buyerDomain))
        .toThrow("film_order_buyer_domain_missing");
      expect(() => canPerformFilmOrderActorAction("approve", "kanei@kanei-trade.co.jp", buyerDomain))
        .toThrow("film_order_buyer_domain_missing");
    }
  });
});
