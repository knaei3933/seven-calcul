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
  const recommendationInput = {
    ...validInput,
    spec: {
      ...validInput.spec,
      sizeKey: "tube-35x80",
      customWidthMm: "35",
      customLengthMm: "80",
      fillMlPerChamber: "3",
      connectedChambers: 1,
      colorCount: 4,
    },
    quantity: "133000",
    printingMethod: "gravure",
  };

  it("returns a recommended near-quantity candidate and preserves the original basis", async () => {
    const response = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({ ...recommendationInput, recommendationMode: true }),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.candidates.length).toBeGreaterThan(0);
    expect(payload.candidates.length).toBeLessThanOrEqual(3);
    expect(payload.candidates[0].recommended).toBe(true);
    const recommended = payload.candidates.find((candidate: any) => candidate.recommended);
    expect(recommended).toBeDefined();
    expect(Math.abs(Number(recommended.adjustedQuantity) - 133000) / 133000).toBeLessThanOrEqual(0.15);
    expect(payload.candidates.some((candidate: any) => candidate.route === "K")).toBe(true);
    expect(payload.originalResult.quantity).toBe("133000");
    expect(payload.result.quantity).toBe("133000");
    expect(payload.result.selectedCandidateId).toBe("");
  });

  it("switches the active result to a selected candidate while returning the original", async () => {
    const first = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({ ...recommendationInput, recommendationMode: true }),
    }));
    const list = (await first.json()).candidates as Array<{ id: string; adjustedQuantity: string; filmTotalYen: string }>;
    const response = await POST(new Request("http://localhost/api/calculate", {
      method: "POST",
      body: JSON.stringify({
        ...recommendationInput,
        recommendationMode: true,
        selectedCandidateId: list[0].id,
      }),
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.selectedCandidateId).toBe(list[0].id);
    expect(payload.result.quantity).toBe("133000");
    expect(payload.originalResult.quantity).toBe("133000");

    expect(Number(payload.result.film.filmTotal)).toBe(Number(list[0].filmTotalYen));
  });
});
