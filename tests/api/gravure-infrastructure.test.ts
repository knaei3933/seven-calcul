import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-auth")>("@/lib/api-auth");
  return {
    ...actual,
    getSessionUser: async () => ({
      id: 1,
      email: "admin@example.com",
      name: "Admin",
      role: "admin" as const,
    }),
  };
});

vi.mock("@/lib/gravure-price-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/gravure-price-store")>("@/lib/gravure-price-store");
  return {
    ...actual,
    assertDurableGravureDatabase: () => {
      throw new actual.GravureInfrastructureError("secret postgres host pg1.internal");
    },
    isGravureSnapshotIssuanceEnabled: () => true,
    verifyGravureSnapshotIssuance: async () => {
      throw new actual.GravureInfrastructureError("secret snapshot row details");
    },
  };
});

const { POST: calculatePost } = await import("@/app/api/calculate/route");
const { POST: quotationPost } = await import("@/app/api/quotations/route");

describe("gravure infrastructure errors", () => {
  it("returns a detail-free 503 from calculate", async () => {
    const response = await calculatePost(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({ printingMethod: "gravure", quantity: "10000", spec: { sizeKey: "tube-35x80" } }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "gravure_master_unavailable" });
  });

  it("returns a detail-free 503 from quotations", async () => {
    const response = await quotationPost(new Request("http://localhost/api/quotations", {
      method: "POST",
      body: JSON.stringify({
        quotationNumber: "INFRA-1",
        status: "draft",
        issueDate: "2026-10-13",
        validUntil: "2026-11-13",
        customerName: "Customer",
        customerContact: "",
        productName: "Product",
        sizeSummary: "35x80",
        quantity: "10000",
        fillingCostPerPiece: "0",
        filmCostPerPiece: "0",
        filmMeterPrice: "0",
        filmOrderLengthM: "0",
        targetMargin: "0.3",
        taxRatePercent: "10",
        pricePerPiece: "0",
        subtotal: "0",
        tax: "0",
        grandTotal: "0",
        deliveryDate: "",
        paymentTerms: "",
        notes: "",
        calculationVersion: "",
        resultHash: "",
        payload: {
          pricingSnapshot: { id: "snapshot", sha256: "hash" },
        },
      }),
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "gravure_master_unavailable" });
  });
});
