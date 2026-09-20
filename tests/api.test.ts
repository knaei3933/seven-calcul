import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "calculate-legacy-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@calculate-legacy.test";
process.env.ADMIN_PASSWORD = "admin-calculate-legacy";
process.env.ADMIN_NAME = "Calculate Legacy Admin";
const { POST } = await import("@/app/api/calculate/route");
const { createUser, createSession } = await import("@/lib/auth-store");
const user = await createUser({ email: "user@calculate-legacy.test", name: "Legacy User", password: "user-calculate-legacy", role: "user" });
const session = await createSession(user.id);

function request(body: string, url = "http://localhost/api/calculate"): Request {
  return new Request(url, { method: "POST", body, headers: { "content-type": "application/json", cookie: `pouch_session=${session.token}` } });
}

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("POST /api/calculate", () => {
  it("returns deterministic Decimal result", async () => {
    const body = { spec: { sizeKey: "mouthwash-45x145", customWidthMm: "45", customLengthMm: "145", fillMlPerChamber: "30", connectedChambers: 2, fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0.37", skuCount: 1 }, quantity: "10000", printingMethod: "digital" };
    const response = POST(request(JSON.stringify(body)));
    const payload = await response;
    expect(payload.status).toBe(200);
    const json = await payload.json();
    expect(json.result.bulkUsageMl).toBe("722000");
    expect(json.result.audit.componentReconciliationDifference).toBe("0");
  });
  it("returns structured request failure", async () => {
    const response = await POST(request("{}", "http://localhost"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("succeeds when a short parallel order is raised to the 500m minimum", async () => {
    const body = {
      spec: { sizeKey: "mouthwash-45x145", customWidthMm: "45", customLengthMm: "145", fillMlPerChamber: "30", connectedChambers: 2, fillingMethod: "hopper", fillingLanes: 4, isCustom: false, colorCount: 4, bulkUnitPrice: "0.37", skuCount: 1 },
      quantity: "10000",
      printingMethod: "digital",
    };
    const response = await POST(request(JSON.stringify(body)));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.result.film.orderLengthM).toBe("500");
  });
});
