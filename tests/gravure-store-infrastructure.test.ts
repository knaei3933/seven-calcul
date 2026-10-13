import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SqlClient } from "@/lib/db";

const sqlState = vi.hoisted(() => ({ phase: "connection" as "connection" | "resolve" | "snapshot" | "write" }));
let consoleError: MockInstance;

const failingSqlClient = {
  dialect: "sqlite" as const,
  exec: vi.fn(async () => undefined),
  get: vi.fn(async (sql: string) => {
    if (sql.includes("gravure_schema_migrations")) return { version: 1 };
    if (sql.includes("calculation_master_snapshots")) {
      if (sqlState.phase === "snapshot") throw new Error("secret snapshot read failure");
      return undefined;
    }
    if (sqlState.phase === "write" && sql.includes("gravure_y_supplier_prices")) return { id: 1 };
    return undefined;
  }),
  all: vi.fn(async () => {
    if (sqlState.phase === "resolve") throw new Error("secret master read failure");
    return [];
  }),
  run: vi.fn(async () => {
    if (sqlState.phase === "write") throw new Error("secret snapshot write failure");
    return { changes: 1, lastInsertRowid: 1 };
  }),
  transaction: async <T,>(operation: (client: SqlClient) => Promise<T>) => operation(failingSqlClient as SqlClient),
  close: vi.fn(async () => undefined),
};

vi.mock("@/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db")>("@/lib/db");
  return {
    ...actual,
    getSqlClient: vi.fn(async () => {
      if (sqlState.phase === "connection") throw new Error("secret connection refused");
      return failingSqlClient;
    }),
  };
});

async function freshStore() {
  vi.resetModules();
  return import("@/lib/gravure-price-store");
}

afterEach(() => {
  sqlState.phase = "connection";
  vi.clearAllMocks();
});

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("gravure store infrastructure normalization", () => {
  it("normalizes connection failures without SQL details", async () => {
    const { getGravureMigrationVersion, GravureInfrastructureError } = await freshStore();
    const error = await getGravureMigrationVersion().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GravureInfrastructureError);
    expect((error as Error).message).toBe("gravure_master_unavailable");
    expect((error as Error).message).not.toContain("secret");
    const diagnostic = consoleError.mock.calls
      .map((call) => JSON.parse(String(call[1])) as Record<string, string>)
      .find((payload) => payload.category === "gravure_master_unavailable");
    expect(diagnostic).toMatchObject({ errorName: "Error" });
    expect(diagnostic?.diagnosticRef).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret");
  });

  it("normalizes master read failures", async () => {
    const { resolveGravureMasters, GravureInfrastructureError } = await freshStore();
    sqlState.phase = "resolve";
    const error = await resolveGravureMasters("2026-10-13").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GravureInfrastructureError);
    expect((error as Error).message).toBe("gravure_master_unavailable");
  });

  it("normalizes snapshot read failures", async () => {
    const { getGravureSnapshot, GravureInfrastructureError } = await freshStore();
    sqlState.phase = "snapshot";
    const error = await getGravureSnapshot("0197aaaa-bbbb-7ccc-8ddd-eeeeffff0000").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GravureInfrastructureError);
    expect((error as Error).message).toBe("gravure_master_unavailable");
  });

  it("normalizes snapshot write failures", async () => {
    const { saveGravureSnapshot, GravureInfrastructureError } = await freshStore();
    sqlState.phase = "write";
    const result = {
      printingMethod: "gravure",
      quantity: "10000",
      connectedChambers: 1,
      fillingMethod: "hopper",
      selectedCandidateId: "",
      recommendationCandidates: [],
      audit: { resultJsonSha256: "result-hash" },
    };
    const error = await saveGravureSnapshot({
      asOf: "2026-10-13",
      digitalValues: {},
      resolved: { asOf: "2026-10-13", yRows: [], kSet: null, fallbackVersions: { y: "y", k: "k" } },
      request: { spec: { customWidthMm: "35", customLengthMm: "80" } },
      result,
      createdBy: "test@example.com",
    } as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GravureInfrastructureError);
    expect((error as Error).message).toBe("gravure_master_unavailable");
  });

  it("preserves overlap validation while normalizing SQL transport failures", async () => {
    const { createGravureYMasterRow, GravureInfrastructureError, GravureOverlapError } = await freshStore();
    sqlState.phase = "write";
    const input = {
      webWidthMm: 356,
      laneCount: 1,
      printTierM: 2000,
      approxOutputLengthM: "1700",
      supplierUnitPriceYenPerM: "150",
      plateBaseYenPerColor: "27000",
      sellerMarkup: "1.25",
      effectiveFrom: "2026-10-13",
    };
    await expect(createGravureYMasterRow(input, "tester@example.com")).rejects.toBeInstanceOf(GravureOverlapError);
    await expect(createGravureYMasterRow(input, "tester@example.com")).rejects.not.toBeInstanceOf(GravureInfrastructureError);
  });
});
