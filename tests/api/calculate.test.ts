import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/calculate/route";

const validInput = {
  spec: {
    sizeKey: "mouthwash-45x145",
    customWidthMm: "45",
    customLengthMm: "145",
    fillMlPerChamber: "30",
    connectedChambers: 1,
    fillingMethod: "hopper",
    fillingLanes: 4,
    isCustom: false,
    colorCount: 4,
    bulkUnitPrice: "0.37",
    skuCount: 1,
  },
  quantity: "10000",
  printingMethod: "digital",
};

describe("calculate API", () => {
  it("rejects an incomplete request before calculation", async () => {
    const response = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({ quantity: "10000", printingMethod: "digital" }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects an invalid parallel SKU count", async () => {
    const response = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({ ...validInput, spec: { ...validInput.spec, skuCount: 0 } }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_sku_count" });
  });
});

describe("calculate API recommendations", () => {
  it("returns D/K/Y candidates and preserves the original basis", async () => {
    const response = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({
        ...validInput,
        printingMethod: "gravure",
        recommendationMode: true,
      }),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.candidates.length).toBeGreaterThan(0);
    expect(payload.candidates.length).toBeLessThanOrEqual(9);
    expect(new Set(payload.candidates.map((candidate: any) => candidate.route))).toEqual(new Set(["D", "K", "Y"]));
    expect(payload.originalResult.quantity).toBe("10000");
    expect(payload.result.quantity).toBe("10000");
    expect(payload.result.selectedCandidateId).toBe("");
  });

  it("switches the active result to a selected candidate while returning the original", async () => {
    const first = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({
        ...validInput,
        printingMethod: "gravure",
        recommendationMode: true,
      }),
    }));
    const list = (await first.json()).candidates as Array<{ id: string }>;
    const response = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({
        ...validInput,
        printingMethod: "gravure",
        recommendationMode: true,
        selectedCandidateId: list[0].id,
      }),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.selectedCandidateId).toBe(list[0].id);
    expect(payload.originalResult.quantity).toBe("10000");
  });
});
