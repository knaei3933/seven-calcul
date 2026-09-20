import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "calculate-api-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@calculate.test";
process.env.ADMIN_PASSWORD = "admin-calculate-password";
process.env.ADMIN_NAME = "Calculate Admin";
const { POST } = await import("@/app/api/calculate/route");
const { createUser, createSession } = await import("@/lib/auth-store");
const user = await createUser({ email: "user@calculate.test", name: "Calculate User", password: "user-calculate-password", role: "user" });
const session = await createSession(user.id);

function authenticatedRequest(url: string, body: string): Request {
  return new Request(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", cookie: `pouch_session=${session.token}` },
  });
}

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

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
    const response = await POST(authenticatedRequest("http://localhost/api/calculate", JSON.stringify({ quantity: "10000", printingMethod: "digital" })));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("rejects an invalid parallel SKU count", async () => {
    const response = await POST(authenticatedRequest("http://localhost/api/calculate", JSON.stringify({ ...validInput, spec: { ...validInput.spec, skuCount: 0 } })));
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
    const response = await POST(authenticatedRequest("http://localhost/api/calculate", JSON.stringify({ ...recommendationInput, recommendationMode: true })));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.candidates.length).toBeGreaterThan(0);
    expect(payload.candidates.length).toBeLessThanOrEqual(6);
    expect(payload.candidates[0].recommended).toBe(true);
    const recommended = payload.candidates.find((candidate: any) => candidate.recommended);
    expect(recommended).toBeDefined();
    expect(Math.abs(Number(recommended.adjustedQuantity) - 133000) / 133000).toBeLessThanOrEqual(0.15);
    expect(payload.originalResult.quantity).toBe("133000");
    expect(payload.result.quantity).toBe("133000");
    expect(payload.result.selectedCandidateId).toBe("");
  });

  it("serializes server-calculated all-in economics for every displayed candidate", async () => {
    const response = await POST(authenticatedRequest("http://localhost/api/calculate", JSON.stringify({
        spec: {
          sizeKey: "tube-50x90",
          customWidthMm: "50",
          customLengthMm: "90",
          fillMlPerChamber: "3",
          connectedChambers: 1,
          fillingMethod: "hopper",
          fillingLanes: 4,
          isCustom: false,
          colorCount: 4,
          bulkUnitPrice: "0",
          skuCount: 1,
          skuQuantities: ["50000"],
          skuColorCounts: ["4"],
        },
        quantity: "50000",
        printingMethod: "digital",
        recommendationMode: true,
      })));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.candidates).toHaveLength(5);
    expect(payload.candidates.filter((candidate: any) => candidate.isFulfilling)
      .map((candidate: any) => candidate.route).sort()).toEqual(["D", "D", "K", "Y"]);
    expect(payload.candidates.filter((candidate: any) => !candidate.isFulfilling)
      .map((candidate: any) => candidate.orderLengthM)).toEqual(["1000"]);
    for (const candidate of payload.candidates) {
      expect(typeof candidate.copperPlateTotalYen).toBe("string");
      expect(typeof candidate.allInTotalCostYen).toBe("string");
      expect(typeof candidate.allInCostPerPieceYen).toBe("string");
      expect(typeof candidate.allInDeltaYen).toBe("string");
    }
  });

  it("switches the active result to a selected candidate while returning the original", async () => {
    const first = await POST(authenticatedRequest("http://localhost/api/calculate", JSON.stringify({ ...recommendationInput, recommendationMode: true })));
    const list = (await first.json()).candidates as Array<{
      id: string; adjustedQuantity: string; filmTotalYen: string;
      capacityQuantity: string; shortagePieces: string;
    }>;
    const response = await POST(authenticatedRequest("http://localhost/api/calculate", JSON.stringify({
        ...recommendationInput,
        recommendationMode: true,
        selectedCandidateId: list[0].id,
      })));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.selectedCandidateId).toBe(list[0].id);
    expect(payload.result.quantity).toBe(list[0].adjustedQuantity);
    expect(payload.originalResult.quantity).toBe("133000");

	    expect(Number(payload.result.film.filmTotal)).toBe(Number(list[0].filmTotalYen));
	  });

  it("rejects an unknown selected candidate", async () => {
    const response = await POST(authenticatedRequest("http://localhost/api/calculate", JSON.stringify({
        ...recommendationInput,
        recommendationMode: true,
        selectedCandidateId: "unknown-candidate",
      })));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "candidate_not_found" });
  });
});
