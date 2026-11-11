// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CalculationInput, CostResult } from "@/lib/calculation";
import type { CalculationChecklistSnapshot } from "@/lib/calculation-checklist";

const databaseDirectory = await mkdtemp(join(tmpdir(), "agent-quote-issue-api-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "admin-quote-issue-password";
process.env.ADMIN_NAME = "Agent Quote Issue Admin";
process.env.AGENT_API_RATE_LIMIT = "100";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const { agentAuthDatabaseForTest, createAgentCredential, ensureAgentPrincipalForTest, resetAgentAuthForTest } =
  await import("@/lib/agent-auth-store");
const { resetAgentQuoteServiceForTest } = await import("@/lib/agent-quote-service");
const { POST: issueQuote } = await import("@/app/api/agent/v1/quotes/route");
const { calculatePouchCost } = await import("@/lib/calculation");
const { defaultParameters } = await import("@/lib/constants");
const { buildCalculationChecklistSnapshot } = await import("@/lib/calculation-checklist");
const { resolveFilmUnitPrices } = await import("@/lib/film-price-store");
const { getDatabaseForTest, getQuotationByNumber } = await import("@/lib/quotation-store");

await ensureAgentPrincipalForTest();

const baseCalculationRequest: CalculationInput = {
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
  recommendationMode: true,
};

async function validIssueRequest(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const request = structuredClone(baseCalculationRequest);
  const asOf = new Date().toISOString().slice(0, 10);
  request.parameters = {
    ...(request.parameters ?? {}),
    filmUnitPrices: await resolveFilmUnitPrices(asOf, defaultParameters.filmUnitPrices),
  };
  const candidateBasis = calculatePouchCost(request);
  const candidate = candidateBasis.recommendationCandidates?.find((entry) => entry.recommended)
    ?? candidateBasis.recommendationCandidates?.[0];
  expect(candidate).toBeDefined();
  const result = calculatePouchCost({
    ...request,
    selectedCandidateId: candidate!.id,
    selectedCandidateTargetMargins: ["0.4"],
  });
  const checklist = buildCalculationChecklistSnapshot(result, {
    quotationNumber: "agent-issuance-pending",
    customerName: "株式会社エージェント",
    printingMethod: result.printingMethod,
    sourceHash: result.audit.resultJsonSha256,
    resultHash: result.audit.resultJsonSha256,
    filmComposition: "PET12/AL7/LLDPE60",
    bulkUnitPrice: "0.37",
    widthMm: "40",
    lengthMm: "145",
    pitchMm: "0",
    pitchAddMm: "0",
    lanes: 4,
  }) as CalculationChecklistSnapshot;
  expect(result.selectedCandidateId).toMatch(/^[A-Z]-/);
  return {
    calculationRequest: request,
    calculationEvidence: {
      calculationVersion: result.audit.calculationVersion,
      resultHash: result.audit.resultJsonSha256,
    },
    calculationChecklist: checklist,
    selectedCandidateId: result.selectedCandidateId,
    issue: {
      issueDate: "2026-11-09",
      validUntil: "2026-12-09",
      customerName: "株式会社エージェント",
      customerContact: "ご担当者",
      customerCode: "AGENT-001",
      customerPostalCode: "650-0000",
      customerAddress: "神戸市テスト1-1",
      customerTelephone: "078-000-0000",
      customerEmail: "buyer@example.test",
      productName: "テストパウチ",
      sizeSummary: "40×145mm",
      deliveryDate: "別途相談",
      paymentTerms: "月末締め翌月末払い",
      notes: "",
      filmComposition: "PET12/AL7/LLDPE60",
      greeting: "",
    },
    ...overrides,
  };
}

async function post(body: unknown, token: string, key = "idempotency-key-valid-001"): Promise<Response> {
  return issueQuote(new Request("https://app.test/api/agent/v1/quotes", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  }));
}

async function quotationCount(): Promise<number> {
  const db = await getDatabaseForTest();
  const row = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quotations");
  return Number(row?.count ?? 0);
}

async function auditRows(operation: string): Promise<Record<string, unknown>[]> {
  const db = await agentAuthDatabaseForTest();
  return await db.all<Record<string, unknown>>(
    "SELECT * FROM agent_audit_events WHERE operation = ? ORDER BY occurred_at, rowid",
    [operation],
  );
}

afterAll(async () => {
  await resetAgentAuthForTest();
  await resetAgentQuoteServiceForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("authenticated agent quote issuance", () => {
  it("issues one Kanei quotation with a shared KT number and deterministic server PDF", async () => {
    const credential = await createAgentCredential({
      name: "quote-issuer",
      scopes: ["quote:issue"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const before = await quotationCount();
    const response = await post(await validIssueRequest(), credential.token);
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.outcome).toBe("issued");
    expect(body.quotation.ownerDomain).toBe("kanei");
    expect(body.quotation.number).toMatch(/^KT-\d{6}-\d{3}$/u);
    expect(body.calculation.version).toMatch(/^2026-/u);
    expect(body.calculation.resultHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(body.selectedCandidate.id).toMatch(/^[A-Z]-/);
    expect(body.pdf.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(body.pdf.byteLength).toBeGreaterThan(1000);
    expect(body.nextStates).toEqual({
      emailDraftAvailable: true,
      humanMailDispatchPending: true,
      customerTokenPending: true,
    });
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "cost", "margin", "profit", "supplier", "pricingSnapshot", "commission",
      "customerEmail", "customerName",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(serialized).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}|secret-[A-Za-z0-9-]+/u);
    const persisted = await getQuotationByNumber(body.quotation.number);
    expect(persisted?.ownerDomain).toBe("kanei");
    expect(persisted?.resultHash).toBe(body.calculation.resultHash);
    expect(await quotationCount()).toBe(before + 1);
    expect((await auditRows("quote.issue")).at(-1)).toMatchObject({
      outcome: "allow",
      reason: "quotation_issued",
      quotation_number: body.quotation.number,
    });
  });

  it("rejects a client-supplied existing number without mutating it", async () => {
    const credential = await createAgentCredential({
      name: "number-rejector",
      scopes: ["quote:issue"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const request = await validIssueRequest();
    request.quotationNumber = "KT-202611-999";
    const before = await quotationCount();
    const response = await post(request, credential.token, "idempotency-key-number-01");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(await quotationCount()).toBe(before);
    expect((await auditRows("quote.issue.failure")).at(-1)).toMatchObject({
      outcome: "error",
      reason: "invalid_request",
    });
  });

  it("rejects forbidden pricing authority and invalid provenance before creating a row", async () => {
    const credential = await createAgentCredential({
      name: "authority-rejector",
      scopes: ["quote:issue"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    for (const [mutationIndex, [expected, mutation]] of ([
      ["client_pricing_authority_rejected", { issuePricePerPiece: "1" }],
      ["client_pricing_authority_rejected", { checklistSupplierName: "secret-supplier" }],
      ["calculation_provenance_invalid", { resultHash: "0".repeat(64) }],
    ] as const).entries()) {
      const request = await validIssueRequest();
      if ("issuePricePerPiece" in mutation) {
        (request.issue as Record<string, unknown>).pricePerPiece = mutation.issuePricePerPiece;
      } else if ("checklistSupplierName" in mutation) {
        (request.calculationChecklist as Record<string, unknown>).supplierName = mutation.checklistSupplierName;
      } else {
        (request.calculationEvidence as Record<string, unknown>).resultHash = mutation.resultHash;
      }
      const before = await quotationCount();
      const response = await post(request, credential.token, `idempotency-key-reject-${mutationIndex}`);
      expect(response.status).toBe(expected === "client_pricing_authority_rejected" ? 400 : 400);
      await expect(response.json()).resolves.toEqual({ error: expected });
      expect(await quotationCount()).toBe(before);
    }
  });
  it("replays the original success as a duplicate and rejects the same key with a different fingerprint", async () => {
    const credential = await createAgentCredential({
      name: "idempotency-owner",
      scopes: ["quote:issue"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const request = await validIssueRequest();
    const before = await quotationCount();
    const first = await post(request, credential.token, "idempotency-key-replay-001");
    const original = await first.json();
    const replayResponse = await post(request, credential.token, "idempotency-key-replay-001");
    const replay = await replayResponse.json();
    expect(first.status).toBe(201);
    expect(replayResponse.status).toBe(200);
    expect(replay).toEqual({
      ...original,
      outcome: "duplicate",
      idempotency: { replay: true },
    });
    expect(await quotationCount()).toBe(before + 1);
    expect((await auditRows("quote.issue.duplicate")).some((event) => event.reason === "duplicate_issued")).toBe(true);

    const changed = await validIssueRequest();
    (changed.issue as Record<string, unknown>).customerName = "株式会社別件";
    const conflict = await post(changed, credential.token, "idempotency-key-replay-001");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "idempotency_conflict" });
    expect(await quotationCount()).toBe(before + 1);
    expect((await auditRows("quote.issue.conflict")).at(-1)).toMatchObject({
      outcome: "deny",
      reason: "idempotency_conflict",
    });
  });

  it("creates one quotation for concurrent same-credential same-key requests", async () => {
    const credential = await createAgentCredential({
      name: "idempotency-racer",
      scopes: ["quote:issue"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const request = await validIssueRequest();
    const before = await quotationCount();
    const responses = await Promise.all([
      post(request, credential.token, "idempotency-key-race-001"),
      post(request, credential.token, "idempotency-key-race-001"),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(new Set(bodies.map((body) => body.quotation.number)).size).toBe(1);
    expect(await quotationCount()).toBe(before + 1);
    const persisted = await getQuotationByNumber(bodies[0].quotation.number);
    expect(persisted?.quotationNumber).toMatch(/^KT-\d{6}-\d{3}$/u);
  });

  it("denies credentials without quote:issue", async () => {
    const credential = await createAgentCredential({
      name: "calculate-only-issuer",
      scopes: ["calculate:run"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const before = await quotationCount();
    const response = await post(await validIssueRequest(), credential.token, "idempotency-key-scope-01");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "agent_scope_denied" });
    expect(await quotationCount()).toBe(before);
  });

  it("rejects owner-domain and stale legacy ownership overrides", async () => {
    const credential = await createAgentCredential({
      name: "owner-override-rejector",
      scopes: ["quote:issue"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    for (const key of ["ownerDomain", "quotationNumber"]) {
      const request = await validIssueRequest();
      request[key] = key === "ownerDomain" ? "seven" : "S7-STALE-001";
      const before = await quotationCount();
      const response = await post(request, credential.token, `idempotency-key-owner-${key}`);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
      expect(await quotationCount()).toBe(before);
    }
  });
});
