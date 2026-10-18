import { describe, expect, it } from "vitest";
import { filmOrderStepRole, nextActionOf } from "@/app/film-orders/film-orders-client";
import type { FilmOrderView } from "@/lib/film-order-shared";

function order(buyerDomain: string): FilmOrderView {
  return {
    buyer_domain: buyerDomain,
    created_by_email: buyerDomain === "727.co.jp" ? "buyer@727.co.jp" : "buyer@kanei-trade.co.jp",
    status: "pending",
  } as FilmOrderView;
}

describe("film order action mapping", () => {
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
