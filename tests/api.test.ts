import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/calculate/route";

describe("POST /api/calculate", () => {
  it("returns deterministic Decimal result", async () => {
    const body = { spec: { sizeKey: "mouthwash-45x145", customWidthMm: "45", customLengthMm: "145", fillMlPerChamber: "30", connectedChambers: 2, fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0.37", skuCount: 1 }, quantity: "10000", printingMethod: "digital" };
    const response = POST(new Request("http://localhost/api/calculate", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as unknown as Request);
    const payload = await response;
    expect(payload.status).toBe(200);
    const json = await payload.json();
    expect(json.result.bulkUsageMl).toBe("722000");
    expect(json.result.audit.componentReconciliationDifference).toBe("0");
  });
  it("returns structured request failure", async () => {
    const response = await POST(new Request("http://localhost", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("succeeds when a short parallel order is raised to the 500m minimum", async () => {
    const body = {
      spec: { sizeKey: "mouthwash-45x145", customWidthMm: "45", customLengthMm: "145", fillMlPerChamber: "30", connectedChambers: 2, fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0.37", skuCount: 1 },
      quantity: "10000",
      printingMethod: "digital",
    };
    const response = await POST(new Request("http://localhost/api/calculate", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.result.film.orderLengthM).toBe("500");
  });
});
