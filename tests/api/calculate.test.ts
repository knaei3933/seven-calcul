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
