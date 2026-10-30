import { describe, expect, it } from "vitest";
import { canPerformFilmOrderAction, canViewFilmOrderRow } from "@/lib/film-order-access";
import { filmOrderStepRole, nextActionOf } from "@/app/film-orders/film-orders-client";
import type { FilmOrderView } from "@/lib/film-order-shared";

function order(buyerDomain: string): FilmOrderView {
  return {
    buyer_domain: buyerDomain,
    created_by_email: buyerDomain === "727.co.jp" ? "buyer@727.co.jp" : "buyer@kanei-trade.co.jp",
    status: "pending",
    customerDesign: { status: "confirmed" },
    customerProof: {
      status: "approved",
      supplierApprovalStatus: "approved",
      buyerApprovalStatus: "pending",
    },
  } as FilmOrderView;
}

describe("film order action mapping", () => {
  it("keeps Seven as the film buyer even when Kanei owns the sales channel", () => {
    expect(canPerformFilmOrderAction("mark-ordered", "seven@727.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("mark-ordered", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(false);
    expect(canViewFilmOrderRow("727.co.jp", "seven@727.co.jp")).toBe(true);
    expect(canViewFilmOrderRow("727.co.jp", "kanei@kanei-trade.co.jp")).toBe(true);
  });

  it("shares every film order row with Seven and Kanei while separating buyer actions", () => {
    expect(canViewFilmOrderRow("727.co.jp", "seven@727.co.jp")).toBe(true);
    expect(canViewFilmOrderRow("727.co.jp", "kanei@kanei-trade.co.jp")).toBe(true);
    expect(canViewFilmOrderRow("kanei-trade.co.jp", "seven@727.co.jp")).toBe(true);
    expect(canViewFilmOrderRow("kanei-trade.co.jp", "kanei@kanei-trade.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("register-receiving", "seven@727.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("register-receiving", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(false);
    expect(canPerformFilmOrderAction("register-receiving", "seven@727.co.jp", "kanei-trade.co.jp")).toBe(false);
    expect(canPerformFilmOrderAction("register-receiving", "kanei@kanei-trade.co.jp", "kanei-trade.co.jp")).toBe(true);
  });

  it("shows buyer actions only to the buyer company", () => {
    const seven = order("727.co.jp");
    expect(nextActionOf(seven, true, false).kind).toBe("run");
    expect(nextActionOf(seven, false, true)).toMatchObject({ kind: "none", label: "セブン化学の発注書送信待ち" });

    const kanei = order("kanei-trade.co.jp");
    expect(nextActionOf(kanei, false, true).kind).toBe("run");
    expect(nextActionOf(kanei, true, false)).toMatchObject({ kind: "none", label: "金井貿易の発注書送信待ち" });
  });

  it("maps proof approval to the buyer, not always Seven", () => {
    const seven = { ...order("727.co.jp"), status: "proof_registered" } as FilmOrderView;
    const kanei = { ...order("kanei-trade.co.jp"), status: "proof_registered" } as FilmOrderView;

    expect(nextActionOf(seven, true, false)).toMatchObject({ kind: "run", body: { action: "approve" } });
    expect(nextActionOf(seven, false, true)).toMatchObject({ kind: "none", label: "セブン化学の承認待ち" });
    expect(nextActionOf(kanei, false, true)).toMatchObject({ kind: "run", body: { action: "approve" } });
    expect(nextActionOf(kanei, true, false)).toMatchObject({ kind: "none", label: "金井貿易の承認待ち" });
  });

  it("requires Kanei seller approval before buyer final approval", () => {
    const pendingSeller = {
      ...order("727.co.jp"),
      status: "proof_registered",
      customerProof: {
        status: "approved",
        supplierApprovalStatus: "pending",
        buyerApprovalStatus: "pending",
      },
    } as FilmOrderView;

    expect(nextActionOf(pendingSeller, true, false)).toMatchObject({
      kind: "none",
      label: "金井貿易の校正承認待ち",
    });
    expect(nextActionOf(pendingSeller, false, true)).toMatchObject({
      kind: "form",
      form: "seller-approval",
    });
  });

  it("maps workflow roles by buyer and seller side", () => {
    const seven = order("727.co.jp");
    const kanei = order("kanei-trade.co.jp");

    expect(filmOrderStepRole(seven, "ordered")).toBe("seven");
    expect(filmOrderStepRole(kanei, "ordered")).toBe("kanei");
    expect(filmOrderStepRole(seven, "receiving_registered")).toBe("kanei");
    expect(filmOrderStepRole(kanei, "receiving_registered")).toBe("kanei");
    expect(filmOrderStepRole(seven, "proof_registered")).toBe("seven");
    expect(filmOrderStepRole(kanei, "proof_registered")).toBe("kanei");
  });
});

describe("film order data source flow", () => {
  it("lets a Seven buyer choose its own production data first", () => {
    const seven = {
      ...order("727.co.jp"),
      status: "ordered",
      customerDesign: { status: "pending" },
    } as FilmOrderView;

    expect(nextActionOf(seven, true, false)).toMatchObject({
      kind: "form",
      form: "design-mode",
    });
    expect(nextActionOf(seven, false, true)).toMatchObject({
      kind: "none",
      label: "セブン化学の入稿方式選択待ち",
    });
  });

  it("continues a Seven buyer to production intake after mode selection", () => {
    const seven = {
      ...order("727.co.jp"),
      status: "ordered",
      customerDesign: { status: "not_required" },
    } as FilmOrderView;

    expect(nextActionOf(seven, true, false)).toMatchObject({
      kind: "form",
      form: "receiving",
    });
  });
});

  it("assigns data-source selection to Seven before buyer intake", () => {
    const seven = {
      ...order("727.co.jp"),
      status: "ordered",
      customerDesign: { status: "pending" },
    } as FilmOrderView;

    expect(filmOrderStepRole(seven, "ordered")).toBe("seven");
    expect(nextActionOf(seven, true, false)).toMatchObject({
      kind: "form",
      form: "design-mode",
    });
  });

describe("film order proof upload flow", () => {
  it("waits for the external designer upload before manual fallback", () => {
    const seven = { ...order("727.co.jp"), status: "receiving_registered" } as FilmOrderView;
    const kanei = { ...order("kanei-trade.co.jp"), status: "receiving_registered" } as FilmOrderView;

    expect(nextActionOf(seven, true, false)).toMatchObject({
      kind: "none",
      label: "デザイン校正データのアップロード待ち",
    });
    expect(nextActionOf(kanei, false, true)).toMatchObject({
      kind: "none",
      label: "デザイン校正データのアップロード待ち",
    });
    expect(filmOrderStepRole(kanei, "receiving_registered")).toBe("kanei");
  });
});

describe("ship-to registration request permission", () => {
  it("allows either Seven or Kanei to manage ship-to regardless of buyer domain", () => {
    const seven = order("727.co.jp");
    const kanei = order("kanei-trade.co.jp");

    expect(canPerformFilmOrderAction("request-ship-to-registration", "seven@727.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("request-ship-to-registration", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("request-ship-to-registration", "kanei@kanei-trade.co.jp", "kanei-trade.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("request-ship-to-registration", "seven@727.co.jp", "kanei-trade.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("register-ship-to", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("confirm-ship-to", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("request-ship-to-registration", "customer@example.test", "727.co.jp")).toBe(false);
    void seven;
    void kanei;
  });
});
