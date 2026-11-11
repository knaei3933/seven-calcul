// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "agent-calculate-api-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "admin-agent-calculate-password";
process.env.ADMIN_NAME = "Agent Calculate Admin";
process.env.AGENT_API_RATE_LIMIT = "100";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

vi.mock("@/lib/calculation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/calculation")>("@/lib/calculation");
  return {
    ...actual,
    calculatePouchCost: (input: import("@/lib/calculation").CalculationInput) => {
      const result = actual.calculatePouchCost(input);
      if (process.env.AGENT_TEST_CALCULATION_VERSION === "stale") {
        return { ...result, audit: { ...result.audit, calculationVersion: "stale-test-version" } };
      }
      return result;
    },
  };
});

const {
  agentAuthDatabaseForTest,
  createAgentCredential,
  ensureAgentPrincipalForTest,
  resetAgentAuthForTest,
} = await import("@/lib/agent-auth-store");
const { POST: agentCalculate } = await import("@/app/api/agent/v1/calculate/route");
const { POST: humanCalculate } = await import("@/app/api/calculate/route");
const { createUser, createSession } = await import("@/lib/auth-store");
await ensureAgentPrincipalForTest();
const humanUser = await createUser({
  email: "human@kanei-trade.co.jp",
  name: "Human Calculate User",
  password: "human-agent-calculate-password",
  role: "admin",
});
const humanSession = await createSession(humanUser.id);

const validInput = {
  spec: {
    sizeKey: "mouthwash-40x145",
    customWidthMm: "40",
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

const gravureInput = {
  spec: {
    sizeKey: "tube-35x80",
    customWidthMm: "35",
    customLengthMm: "80",
    fillMlPerChamber: "3",
    connectedChambers: 1,
    fillingMethod: "hopper",
    fillingLanes: 4,
    isCustom: false,
    colorCount: 4,
    bulkUnitPrice: "0",
    skuCount: 1,
  },
  quantity: "133000",
  printingMethod: "gravure",
  recommendationMode: true,
};

function agentRequest(body: unknown, token?: string): Request {
  return new Request("https://app.test/api/agent/v1/calculate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function humanRequest(body: unknown, token?: string): Request {
  return new Request("https://app.test/api/calculate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function authenticatedHumanRequest(body: unknown): Request {
  return new Request("https://app.test/api/calculate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `pouch_session=${humanSession.token}`,
    },
    body: JSON.stringify(body),
  });
}

function recursivelyAssertCustomerSafe(value: unknown): void {
  const allowed = new Set([
    "quantity",
    "printingMethod",
    "connectedChambers",
    "fillingMethod",
    "size",
    "widthMm",
    "lengthMm",
    "displayedUnitPrice",
    "displayedSubtotal",
    "displayedTax",
    "displayedGrandTotal",
    "candidateOptions",
    "optionNumber",
    "label",
    "requiredLengthM",
    "orderLengthM",
    "effectiveLengthM",
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    expect(allowed.has(key)).toBe(true);
    recursivelyAssertCustomerSafe(child);
  }
}

afterAll(async () => {
  await resetAgentAuthForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("agent calculation DTO", () => {
  it("calculates a valid digital request with separate explicit projections", async () => {
    const issued = await createAgentCredential({
      name: "digital-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await agentCalculate(agentRequest(validInput, issued.token));
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(Object.keys(payload).sort()).toEqual(["customerSafe", "internalActor"]);
    expect(payload.internalActor.calculation).toMatchObject({
      authority: "digital_film_store",
      calculationVersion: expect.stringMatching(/^2026-/),
      inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(payload.internalActor.quantity).toBe("10000");
    expect(Array.isArray(payload.internalActor.candidates)).toBe(true);
    expect(payload.internalActor.warnings).toBeInstanceOf(Array);
    recursivelyAssertCustomerSafe(payload.customerSafe);
    expect(payload.customerSafe.quantity).toBe("10000");
    expect(Number(payload.customerSafe.displayedSubtotal)).toBeGreaterThan(0);
    expect(Number(payload.customerSafe.displayedGrandTotal))
      .toBe(Number(payload.customerSafe.displayedSubtotal) + Number(payload.customerSafe.displayedTax));

    const serialized = JSON.stringify(payload.customerSafe);
    for (const forbidden of [
      "cost", "costTotal", "totalCostPerPiece", "costPerPieceComponents", "margin", "profit",
      "film", "filmOrder", "supplier", "pricingSnapshot", "payload", "payloadJson",
      "resultHash", "calculationRequest", "fullAugmentedCalculationRequest", "commission",
      "approvalUrl", "token", "id",
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it("keeps candidate IDs, order, quantities, lengths, and costs traceable to the core result", async () => {
    const issued = await createAgentCredential({
      name: "candidate-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const recommendationInput = {
      ...validInput,
      spec: {
        ...validInput.spec,
        sizeKey: "tube-35x80",
        customWidthMm: "35",
        customLengthMm: "80",
        fillMlPerChamber: "3",
        bulkUnitPrice: "0",
      },
      quantity: "133000",
      printingMethod: "digital",
      recommendationMode: true,
    };
    const human = await humanCalculate(authenticatedHumanRequest(recommendationInput));
    expect(human.status).toBe(200);
    const humanPayload = await human.json();
    const first = await agentCalculate(agentRequest(recommendationInput, issued.token));
    const second = await agentCalculate(agentRequest(recommendationInput, issued.token));
    expect([first.status, second.status]).toEqual([200, 200]);
    const firstPayload = await first.json();
    const secondPayload = await second.json();
    const candidates = firstPayload.internalActor.candidates;

    expect(candidates.map((candidate: { id: string }) => candidate.id))
      .toEqual(humanPayload.candidates.map((candidate: { id: string }) => candidate.id));
    expect(candidates).toEqual(secondPayload.internalActor.candidates);
    humanPayload.candidates.forEach((expected: Record<string, unknown>, index: number) => {
      const actual = candidates[index];
      expect(actual.adjustedQuantity).toBe(expected.adjustedQuantity);
      expect(actual.requiredLengthM).toBe(expected.requiredLengthM);
      expect(actual.orderLengthM).toBe(expected.orderLengthM);
      expect(actual.effectiveLengthM).toBe(expected.effectiveLengthM);
      expect(actual.copperPlateTotalYen).toBe(expected.copperPlateTotalYen);
      expect(actual.allInTotalCostYen).toBe(expected.allInTotalCostYen);
      expect(actual.allInCostPerPieceYen).toBe(expected.allInCostPerPieceYen);
      expect(actual.allInDeltaYen).toBe(expected.allInDeltaYen);
    });
  });

  it("rejects every forbidden server-authority field before calculation", async () => {
    const issued = await createAgentCredential({
      name: "forbidden-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    for (const [field, value] of [
      ["gravureYRows", []],
      ["ySupplierRows", []],
      ["pricingSnapshot", { id: "snapshot" }],
      ["publicProjectionHash", "hash"],
      ["pricingSnapshotSha256", "hash"],
      ["fullAugmentedCalculationRequest", {}],
    ] as const) {
      const response = await agentCalculate(agentRequest({ ...validInput, [field]: value }, issued.token));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "client_pricing_authority_rejected" });
    }
  });

  it("blocks a stale calculation version instead of projecting it", async () => {
    const issued = await createAgentCredential({
      name: "stale-version-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    process.env.AGENT_TEST_CALCULATION_VERSION = "stale";
    try {
      const response = await agentCalculate(agentRequest(validInput, issued.token));
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "stale_calculation" });
    } finally {
      delete process.env.AGENT_TEST_CALCULATION_VERSION;
    }
  });

  it("requires calculate:run and records allow/deny operations without secrets or payloads", async () => {
    const allowed = await createAgentCredential({
      name: "audit-allowed-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const denied = await createAgentCredential({
      name: "audit-denied-token",
      scopes: ["quote:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(agentCalculate(agentRequest(validInput, denied.token))).resolves.toMatchObject({
      status: 403,
    });
    const response = await agentCalculate(agentRequest(validInput, allowed.token));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ internalActor: { quantity: "10000" } });

    const db = await agentAuthDatabaseForTest();
    const events = await db.all<Record<string, unknown>>(
      "SELECT * FROM agent_audit_events WHERE operation = ? ORDER BY occurred_at, id",
      ["calculate"],
    );
    const operationEvents = events.filter((event) => event.credential_id === allowed.credentialId);
    expect(operationEvents.filter((event) => event.outcome === "allow")).toHaveLength(1);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(allowed.token);
    expect(serialized).not.toContain(denied.token);
    expect(serialized).not.toContain("bulkUnitPrice");
    expect(serialized).not.toContain("payloadJson");
  });

  it("keeps agent bearer credentials outside human calculate", async () => {
    const issued = await createAgentCredential({
      name: "boundary-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(humanCalculate(humanRequest(validInput, issued.token))).resolves.toMatchObject({
      status: 401,
    });
  });

  it("uses durable gravure authority, preserves candidate parity, and redacts customerSafe", async () => {
    const issued = await createAgentCredential({
      name: "gravure-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const human = await humanCalculate(authenticatedHumanRequest(gravureInput));
    expect(human.status).toBe(200);
    const humanPayload = await human.json();
    const response = await agentCalculate(agentRequest(gravureInput, issued.token));
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.internalActor.calculation.authority).toBe("durable_gravure_snapshot");
    expect(payload.internalActor.calculation.calculationVersion).toBe("2026-10.2-gravure-master");
    expect(payload.internalActor.calculation.pricingSnapshot).toMatchObject({
      view: "redacted",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(payload.internalActor.candidates.map((candidate: { id: string }) => candidate.id))
      .toEqual(humanPayload.candidates.map((candidate: { id: string }) => candidate.id));
    humanPayload.candidates.forEach((expected: Record<string, unknown>, index: number) => {
      const actual = payload.internalActor.candidates[index];
      expect(actual.adjustedQuantity).toBe(expected.adjustedQuantity);
      expect(actual.orderLengthM).toBe(expected.orderLengthM);
      expect(actual.allInTotalCostYen).toBe(expected.allInTotalCostYen);
    });
    recursivelyAssertCustomerSafe(payload.customerSafe);
    expect(JSON.stringify(payload.customerSafe)).not.toContain("pricingSnapshot");
    expect(JSON.stringify(payload.customerSafe)).not.toContain("supplierUnitPrice");
  });

  it("rejects client gravure pricing authority exactly on the gravure path", async () => {
    const issued = await createAgentCredential({
      name: "gravure-authority-token",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const response = await agentCalculate(agentRequest({
      ...gravureInput,
      gravureYRows: [{ attacker: true }],
      ySupplierRows: [{ attacker: true }],
    }, issued.token));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "client_pricing_authority_rejected" });
  });
});
