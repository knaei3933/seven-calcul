import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  getSessionUser: async () => ({
    id: 1,
    email: "kanai@kanei-trade.co.jp",
    name: "Kanai Admin",
    role: "admin" as const,
  }),
}));

vi.mock("@/lib/film-order-access", () => ({
  isKaneiTradeUser: () => true,
}));

vi.mock("@/lib/gravure-price-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gravure-price-store")>(
    "@/lib/gravure-price-store",
  );
  const error = new actual.GravureDurableDatabaseRequiredError();
  return {
    ...actual,
    listGravureKMasterRows: vi.fn(async () => {
      throw error;
    }),
    listGravureYMasterRows: vi.fn(async () => {
      throw error;
    }),
  };
});

const { GET: getY } = await import("@/app/api/film-prices/gravure/y/route");
const { GET: getK } = await import("@/app/api/film-prices/gravure/k/route");

describe("gravure master GET infrastructure errors", () => {
  it("returns 503 when Y rows require a durable database", async () => {
    const response = await getY(new Request("http://localhost/api/film-prices/gravure/y"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "durable_database_required" });
  });

  it("returns 503 when K sets require a durable database", async () => {
    const response = await getK(new Request("http://localhost/api/film-prices/gravure/k"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "durable_database_required" });
  });
});
