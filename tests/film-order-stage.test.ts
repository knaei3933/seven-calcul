import { describe, expect, it } from "vitest";
import {
  FILM_ORDER_TRANSITIONS,
  assertFilmOrderActionGuard,
  assertFilmOrderDeliveryDocumentGuard,
  filmOrderActionAvailability,
  filmOrderStageOf,
  filmOrderWorkflowStageLabels,
} from "@/lib/film-order-stage";

const activeMaker = {
  id: 7,
  email: "maker@example.test",
  isActive: true,
  procurementRoute: "K",
  printMethod: "gravure",
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "pending" as const,
    supplierResolution: "master_selected" as const,
    supplierEmail: "maker@example.test",
    makerId: 7,
    makerSnapshot: activeMaker,
    procurementRoute: "K",
    printingMethod: "gravure",
    shipToStatus: "not_provided" as const,
    customerDesignStatus: "confirmed" as const,
    customerProofStatus: "pending" as const,
    supplierApprovalStatus: "pending" as const,
    buyerApprovalStatus: "pending" as const,
    receivingAiRegistered: true,
    receivingPdfRegistered: true,
    customerProofPdfRegistered: true,
    ...overrides,
  };
}

describe("canonical film-order stage derivation", () => {
  it("labels every canonical stage", () => {
    expect(Object.keys(filmOrderWorkflowStageLabels)).toHaveLength(14);
  });

  it("derives every existing primary status", () => {
    expect(filmOrderStageOf({ status: "pending" })).toBe("contract_accepted");
    expect(filmOrderStageOf({ status: "ordered", orderedAt: "2026-01-01" })).toBe("maker_requested");
    expect(filmOrderStageOf({ status: "receiving_registered", receivingRegisteredAt: "2026-01-02" })).toBe("data_intake");
    expect(filmOrderStageOf({
      status: "proof_registered",
      proofRegisteredAt: "2026-01-03",
      customerProofStatus: "pending",
      supplierApprovalStatus: "pending",
      buyerApprovalStatus: "pending",
    })).toBe("customer_review");
    expect(filmOrderStageOf({
      status: "proof_registered",
      customerProofStatus: "approved",
      supplierApprovalStatus: "approved",
      buyerApprovalStatus: "pending",
    })).toBe("approved");
    expect(filmOrderStageOf({
      status: "re_proof_requested",
      reProofRequestedAt: "2026-01-04",
      customerProofStatus: "correction_requested",
    })).toBe("correction");
    expect(filmOrderStageOf({ status: "final_approved", finalApprovedAt: "2026-01-05" })).toBe("final_approvals");
  });

  it("authoritative timestamps override stale primary status", () => {
    const finalApproved = {
      status: "final_approved" as const,
      finalApprovedAt: "2026-01-05",
      supplierApprovalStatus: "approved" as const,
      buyerApprovalStatus: "approved" as const,
    };
    expect(filmOrderStageOf({ ...finalApproved, poSentAt: "2026-01-06" })).toBe("po");
    expect(filmOrderStageOf({ ...finalApproved, poSentAt: "2026-01-06", etaUpdatedAt: "2026-01-07" })).toBe("eta");
    expect(filmOrderStageOf({ ...finalApproved, poSentAt: "2026-01-06", etaUpdatedAt: "2026-01-07", shippedAt: "2026-01-08" })).toBe("shipment");
    expect(filmOrderStageOf({ ...finalApproved, shippedAt: "2026-01-08", deliveredAt: "2026-01-09" })).toBe("delivery");
    expect(filmOrderStageOf({
      ...finalApproved,
      buyerApprovalStatus: "pending" as const,
      deliveredAt: "2026-01-09",
      receivedAt: "2026-01-10",
    })).toBe("receipt");
    expect(filmOrderStageOf({
      ...finalApproved,
      deliveredAt: "2026-01-09",
      receivedAt: "2026-01-10",
      customerProofStatus: "approved" as const,
    })).toBe("complete");
  });

  it("maps every defined transition", () => {
    expect(FILM_ORDER_TRANSITIONS.map((transition) => transition.action)).toEqual([
      "mark-ordered",
      "register-receiving",
      "register-proof",
      "send-customer-proof-review",
      "record-customer-proof-approval",
      "approve",
      "request-re-proof",
      "send-po",
      "update-eta",
      "report-shipment",
      "report-delivery",
      "confirm-film-receipt",
    ]);
    for (const transition of FILM_ORDER_TRANSITIONS) {
      expect(transition.from).not.toHaveLength(0);
      expect(filmOrderWorkflowStageLabels[transition.to]).toBeTruthy();
    }
  });
});

describe("film-order action guards", () => {
  it("blocks maker contact until the resolution and route/print snapshot agree", () => {
    const finalMakerState = {
      status: "final_approved" as const,
      supplierApprovalStatus: "approved" as const,
      buyerApprovalStatus: "approved" as const,
      shipToStatus: "confirmed" as const,
    };
    expect(() => assertFilmOrderActionGuard(order({ ...finalMakerState, supplierResolution: "legacy_unresolved" }), "send-po"))
      .toThrow("film_maker_resolution_required");
    expect(() => assertFilmOrderActionGuard(order({ ...finalMakerState, makerId: 8 }), "send-po"))
      .toThrow("film_maker_not_found");
    expect(() => assertFilmOrderActionGuard(order({
      ...finalMakerState,
      makerSnapshot: { ...activeMaker, isActive: false },
    }), "send-po")).toThrow("film_maker_inactive");
    expect(() => assertFilmOrderActionGuard(order({
      ...finalMakerState,
      makerSnapshot: { ...activeMaker, procurementRoute: "Y" },
    }), "send-po")).toThrow("film_maker_route_mismatch");
    expect(() => assertFilmOrderActionGuard(order({
      ...finalMakerState,
      makerSnapshot: { ...activeMaker, printMethod: "digital" },
    }), "send-po")).toThrow("film_maker_print_method_mismatch");
  });

  it("requires the complete AI/PDF maker packet", () => {
    expect(() => assertFilmOrderActionGuard(order({ status: "ordered", receivingAiRegistered: false }), "register-receiving"))
      .toThrow("maker_data_packet_required");
    expect(() => assertFilmOrderActionGuard(order({ status: "final_approved", receivingPdfRegistered: false, shipToStatus: "confirmed", supplierApprovalStatus: "approved", buyerApprovalStatus: "approved" }), "send-po"))
      .toThrow("maker_data_packet_required");
    expect(() => assertFilmOrderActionGuard(order({ status: "ordered" }), "register-receiving")).not.toThrow();
  });

  it("blocks customer proof review without registered proof and correction-loop bypass", () => {
    expect(() => assertFilmOrderActionGuard(order({
      status: "proof_registered",
      customerProofPdfRegistered: false,
    }), "send-customer-proof-review")).toThrow("customer_proof_pdf_required");
    expect(() => assertFilmOrderActionGuard(order({
      status: "proof_registered",
      customerProofStatus: "correction_requested",
    }), "record-customer-proof-approval")).toThrow("invalid_status_transition");
    expect(() => assertFilmOrderActionGuard(order({
      status: "proof_registered",
      customerProofStatus: "pending",
    }), "approve")).toThrow("customer_proof_release_required");
    expect(() => assertFilmOrderActionGuard(order({
      status: "proof_registered",
      customerProofStatus: "approved",
    }), "approve")).toThrow("supplier_approval_required");
  });

  it("gates supplier PO on both approvals and confirmed ship-to", () => {
    const final = order({
      status: "final_approved",
      poSentAt: null,
      supplierApprovalStatus: "approved",
      buyerApprovalStatus: "approved",
      shipToStatus: "confirmed",
    });
    expect(filmOrderActionAvailability(final, "send-po").available).toBe(true);
    expect(() => assertFilmOrderActionGuard({ ...final, supplierApprovalStatus: "pending" }, "send-po"))
      .toThrow("supplier_approval_required");
    expect(() => assertFilmOrderActionGuard({ ...final, buyerApprovalStatus: "pending" }, "send-po"))
      .toThrow("buyer_approval_required");
    expect(() => assertFilmOrderActionGuard({ ...final, shipToStatus: "registered" }, "send-po"))
      .toThrow("ship_to_confirmation_required");
  });

  it("enforces logistics ordering and forbids late delivery-document uploads", () => {
    const shipped = order({
      status: "final_approved",
      poSentAt: "2026-01-06",
      supplierApprovalStatus: "approved",
      buyerApprovalStatus: "approved",
      shipToStatus: "confirmed",
      shippedAt: "2026-01-08",
    });
    expect(() => assertFilmOrderActionGuard(order({ poSentAt: "2026-01-06", shipToStatus: "confirmed" }), "report-shipment"))
      .not.toThrow();
    expect(() => assertFilmOrderActionGuard(shipped, "report-delivery")).not.toThrow();
    expect(() => assertFilmOrderActionGuard(order({ poSentAt: "2026-01-06", shipToStatus: "confirmed" }), "report-delivery"))
      .toThrow("invalid_delivery_transition");
    expect(() => assertFilmOrderActionGuard({ ...shipped, deliveredAt: "2026-01-09" }, "confirm-film-receipt")).not.toThrow();
    expect(() => assertFilmOrderActionGuard({ ...shipped, deliveredAt: "2026-01-09", receivedAt: "2026-01-10" }, "confirm-film-receipt"))
      .not.toThrow();
    expect(() => assertFilmOrderActionGuard(shipped, "confirm-film-receipt")).toThrow("invalid_receipt_transition");
    expect(() => assertFilmOrderDeliveryDocumentGuard({
      status: "final_approved",
      poSentAt: "2026-01-06",
      shippedAt: "2026-01-08",
      deliveredAt: "2026-01-09",
    })).toThrow("invalid_delivery_transition");
  });

  it("keeps resend state-safe and role-aware", () => {
    const final = order({
      status: "final_approved",
      poSentAt: "2026-01-06",
      supplierApprovalStatus: "approved",
      buyerApprovalStatus: "approved",
      shipToStatus: "confirmed",
    });
    expect(() => assertFilmOrderActionGuard(final, "resend-supplier-links")).not.toThrow();
    expect(() => assertFilmOrderActionGuard({ ...final, poSentAt: null }, "resend-supplier-links"))
      .toThrow("film_order_resend_conflict");
    expect(filmOrderActionAvailability(final, "send-po", "buyer").available).toBe(false);
    expect(filmOrderActionAvailability(final, "send-po", "buyer").reasons).toEqual(["actor_role_forbidden"]);
  });
});
