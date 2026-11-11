// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CalculationInput } from "@/lib/calculation";
import type { CalculationChecklistSnapshot } from "@/lib/calculation-checklist";
import type { PurchaseOrderSnapshot } from "@/lib/purchase-order";
import type { QuotationRecord } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "agent-internal-approval-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "agent-approval-admin-password";
process.env.ADMIN_NAME = "Agent Approval Admin";
process.env.AGENT_API_RATE_LIMIT = "1000";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const enabledConfig = {
  AGENT_INTERNAL_APPROVAL_ENABLED: "true",
  AGENT_INTERNAL_APPROVAL_MAX_QUANTITY: "100000",
  AGENT_INTERNAL_APPROVAL_MAX_COST_JPY: "999999999",
  AGENT_INTERNAL_APPROVAL_MAX_VALIDITY_DAYS: "365",
  AGENT_INTERNAL_APPROVAL_ALLOWED_CUSTOMER_CODES: "AGENT-001",
  AGENT_INTERNAL_APPROVAL_ALLOWED_PRINT_CLASSES: "digital,gravure",
  AGENT_INTERNAL_APPROVAL_ACKNOWLEDGED_WARNINGS: "seven_template_unconfirmed,tax_rounding_unconfirmed,digital_color_price_not_applied",
};
for (const [key, value] of Object.entries(enabledConfig)) process.env[key] = value;

const { agentAuthDatabaseForTest, createAgentCredential, ensureAgentPrincipalForTest, resetAgentAuthForTest } =
  await import("@/lib/agent-auth-store");
const { resetAgentQuoteServiceForTest } = await import("@/lib/agent-quote-service");
const { resetInternalApprovalPolicyForTest } = await import("@/lib/agent-approval-policy");
const { POST: issueQuote } = await import("@/app/api/agent/v1/quotes/route");
const { POST: requestApproval } = await import(
  "@/app/api/agent/v1/quotes/[id]/internal-approval-request/route"
);
const { calculatePouchCost } = await import("@/lib/calculation");
const { defaultParameters } = await import("@/lib/constants");
const { buildCalculationChecklistSnapshot } = await import("@/lib/calculation-checklist");
const { resolveFilmUnitPrices } = await import("@/lib/film-price-store");
const {
  getDatabaseForTest,
  getQuotation,
  getQuotationByNumber,
  approveQuotationGate,
} = await import("@/lib/quotation-store");
const { evaluateCalculationFreshness, policyLimitExceeded, internalApprovalConfigFromEnv } = await import("@/lib/agent-approval-policy");
const {
  GRAVURE_K_SOURCE_FIELDS,
  resolveGravureMasters,
  saveGravureSnapshot,
} = await import("@/lib/gravure-price-store");
const { activeMaterialWidthMm } = await import("@/lib/purchase-order");
const { readCalculationChecklistSnapshot: readCalculationChecklistSnapshotDebug } = await import("@/lib/calculation-checklist");
const { defaultGravureRollParameters } = await import("@/lib/gravure-roll");
const { GRAVURE_ROLL_COPPER_PLATE_MINIMUM_YEN } = await import("@/lib/gravure-roll");
const { D } = await import("@/lib/decimal");

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

async function validIssueRequest(printingMethod: "digital" | "gravure" = "digital"): Promise<Record<string, unknown>> {
  const request = structuredClone({ ...baseCalculationRequest, printingMethod });
  const asOf = new Date().toISOString().slice(0, 10);
  request.parameters = {
    ...(request.parameters ?? {}),
    filmUnitPrices: await resolveFilmUnitPrices(asOf, defaultParameters.filmUnitPrices),
  };
  const basis = calculatePouchCost(request);
  const candidate = basis.recommendationCandidates?.find((entry) => entry.recommended)
    ?? basis.recommendationCandidates?.[0];
  if (!candidate) throw new Error("no calculation candidate");
  const result = calculatePouchCost({
    ...request,
    selectedCandidateId: candidate.id,
    selectedCandidateTargetMargins: ["0.4"],
  });
  const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const checklist = buildCalculationChecklistSnapshot(result, {
    quotationNumber: "agent-approval-pending",
    customerName: "株式会社承認テスト",
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
  return {
    calculationRequest: request,
    calculationEvidence: {
      calculationVersion: result.audit.calculationVersion,
      resultHash: result.audit.resultJsonSha256,
    },
    calculationChecklist: checklist,
    selectedCandidateId: result.selectedCandidateId,
    issue: {
      issueDate: asOf,
      validUntil,
      customerName: "株式会社承認テスト",
      customerContact: "ご担当者",
      customerCode: "AGENT-001",
      customerPostalCode: "650-0000",
      customerAddress: "神戸市テスト1-1",
      customerTelephone: "078-000-0000",
      customerEmail: "buyer@example.test",
      productName: "承認テストパウチ",
      sizeSummary: "40×145mm",
      deliveryDate: "別途相談",
      paymentTerms: "月末締め翌月末払い",
      notes: "",
      filmComposition: "PET12/AL7/LLDPE60",
      greeting: "",
    },
  };
}

const issuer = await createAgentCredential({
  name: "approval setup issuer",
  scopes: ["quote:issue"],
  expiresAt: new Date(Date.now() + 300_000),
});
const approver = await createAgentCredential({
  name: "internal approver",
  scopes: ["internal_approval:request"],
  expiresAt: new Date(Date.now() + 300_000),
  includeInternalApproval: true,
});
const unscoped = await createAgentCredential({
  name: "internal approval unscoped",
  scopes: ["quote:read"],
  expiresAt: new Date(Date.now() + 300_000),
});

let requestCounter = 0;
async function issue(printingMethod: "digital" | "gravure" = "digital"): Promise<{ id: number; number: string; pdfSha256: string }> {
  requestCounter += 1;
  const response = await issueQuote(new Request("https://app.test/api/agent/v1/quotes", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${issuer.token}`,
      "content-type": "application/json",
      "idempotency-key": `approval-fixture-${requestCounter}`,
    },
    body: JSON.stringify(await validIssueRequest(printingMethod)),
  }));
  const body = await response.json();
  if (response.status !== 201) throw new Error(`fixture issue failed: ${JSON.stringify(body)}`);
  const record = await getQuotationByNumber(body.quotation.number);
  if (!record) throw new Error("issued fixture missing");
  return { id: record.id, number: body.quotation.number, pdfSha256: body.pdf.sha256 };
}

async function post(id: number | string, token = approver.token): Promise<Response> {
  return requestApproval(new Request("https://app.test/x", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }), { params: Promise.resolve({ id: String(id) }) });
}

async function auditRows(operation = "agent.quote.internal_approval.request") {
  const db = await agentAuthDatabaseForTest();
  return db.all<Record<string, unknown>>(
    "SELECT * FROM agent_audit_events WHERE operation=? ORDER BY occurred_at,rowid",
    [operation],
  );
}

async function configAuditRows() {
  return auditRows("agent.internal_approval.config.changed");
}

async function resetQuote(id: number): Promise<void> {
  const db = await getDatabaseForTest();
  await db.run(`
    UPDATE quotations SET
      status='draft', internal_approved_at=NULL, internal_approved_by=NULL,
      customer_approved_at=NULL, customer_approved_by=NULL, customer_approval_source=NULL
    WHERE id=?
  `, [id]);
  await db.run("DELETE FROM film_orders WHERE quotation_id=?", [id]).catch(async (error: unknown) => {
    if (!(error instanceof Error && error.message.includes("no such table: film_orders"))) throw error;
  });
}

afterAll(async () => {
  await resetAgentAuthForTest();
  await resetAgentQuoteServiceForTest();
  await resetInternalApprovalPolicyForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("policy-gated Hermes internal approval", () => {
  it("uses the exact unauthorized and forbidden_scope denials", async () => {
    const unauthenticated = await requestApproval(new Request("https://app.test/x", { method: "POST" }), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ error: "unauthorized" });

    const scoped = await post(1, unscoped.token);
    expect(scoped.status).toBe(403);
    await expect(scoped.json()).resolves.toEqual({ error: "forbidden_scope" });
    expect((await auditRows()).some((event) => event.reason === "forbidden_scope")).toBe(true);
    const scopePolicyEvent = (await auditRows())
      .filter((event) => event.reason === "forbidden_scope")
      .find((event) => String(event.metadata_json ?? "").includes("policy_evaluator"));
    expect(scopePolicyEvent).toMatchObject({ outcome: "deny" });
    expect((await auditRows()).find((event) => event.reason === "unauthorized"))
      .toMatchObject({ outcome: "deny" });
  });

  it("is disabled by default and treats missing limits as disabled", async () => {
    const quote = await issue();
    const previous = Object.entries(enabledConfig);
    for (const [key] of previous) delete process.env[key];
    const config = internalApprovalConfigFromEnv();
    expect(config.enabled).toBe(false);
    expect(config.configComplete).toBe(false);

    const missing = { ...config, enabled: true, maxQuantity: 0, maxCostJpy: 10, maxValidityDays: 10 };
    expect(missing.configComplete).toBe(false);

    const response = await post(quote.id);
    for (const [key, value] of previous) process.env[key] = value;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "approval_disabled" });
    const persisted = await getQuotation(quote.id);
    expect(persisted?.internalApproval).toBeNull();
  });

  it("rejects Seven-owned records and does not expose generic customer approval", async () => {
    const quote = await issue();
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET owner_domain='seven' WHERE id=?", [quote.id]);
    const response = await post(quote.id);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "owner_domain_blocked" });
    const ownerEvents = await auditRows();
    const ownerPolicyEvent = ownerEvents
      .filter((event) => event.reason === "owner_domain_blocked")
      .find((event) => String(event.metadata_json ?? "").includes("policy_evaluator"));
    expect(ownerPolicyEvent).toMatchObject({ outcome: "deny", reason: "owner_domain_blocked" });

    const genericAttempt = await requestApproval(new Request("https://app.test/x", {
      method: "POST",
      headers: { authorization: `Bearer ${approver.token}`, "content-type": "application/json" },
      body: JSON.stringify({ gate: "customerApproval" }),
    }), { params: Promise.resolve({ id: String(quote.id) }) });
    expect(genericAttempt.status).toBe(403);
    await expect(genericAttempt.json()).resolves.toEqual({ error: "owner_domain_blocked" });
    const persisted = await getQuotation(quote.id);
    expect(persisted?.customerApproval).toBeNull();
  });

  it("rejects an already approved transition before invoking the writer again", async () => {
    const quote = await issue();
    await approveQuotationGate(quote.id, "internal", (await getQuotation(quote.id))!.createdBy.id);
    const response = await post(quote.id);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "invalid_approval_transition" });
  });

  it("rejects stale calculation versions, stored hashes, and changed durable pricing", async () => {
    const staleVersion = await issue();
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET calculation_version='old-version' WHERE id=?", [staleVersion.id]);
    await expect((await post(staleVersion.id)).json()).resolves.toEqual({ error: "stale_calculation" });

    const staleHash = await issue();
    await db.run("UPDATE quotations SET result_hash=? WHERE id=?", ["0".repeat(64), staleHash.id]);
    await expect((await post(staleHash.id)).json()).resolves.toEqual({ error: "stale_calculation" });

    const staleMaster = await issue();
    const record = await getQuotation(staleMaster.id);
    if (!record) throw new Error("missing master fixture");
    const request = structuredClone(record.payload.calculationRequest) as CalculationInput;
    request.parameters = {
      ...(request.parameters ?? {}),
      filmUnitPrices: {
        ...(request.parameters?.filmUnitPrices ?? defaultParameters.filmUnitPrices),
        lte570: {
          ...(request.parameters?.filmUnitPrices ?? defaultParameters.filmUnitPrices).lte570,
          "500": "999",
        },
      },
    };
    await db.run(
      "UPDATE quotations SET payload_json=? WHERE id=?",
      [JSON.stringify({ ...record.payload, calculationRequest: request }), staleMaster.id],
    );
    await expect((await post(staleMaster.id)).json()).resolves.toEqual({ error: "stale_calculation" });
  });

  it("fails closed on missing canonical PDF and integrity mismatch", async () => {
    const missing = await issue();
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET pdf_data=NULL,pdf_sha256=NULL WHERE id=?", [missing.id]);
    await expect((await post(missing.id)).json()).resolves.toEqual({ error: "canonical_pdf_required" });

    const tampered = await issue();
    await db.run("UPDATE quotations SET pdf_data=X'255044462d' WHERE id=?", [tampered.id]);
    await expect((await post(tampered.id)).json()).resolves.toEqual({ error: "pdf_integrity_failed" });
  });

  it("rejects expired validity, unresolved validation, and pending sample bulk", async () => {
    const expired = await issue();
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET valid_until='2020-01-01' WHERE id=?", [expired.id]);
    await expect((await post(expired.id)).json()).resolves.toEqual({ error: "quote_expired" });

    const blocked = await issue();
    const blockedRecord = await getQuotation(blocked.id);
    if (!blockedRecord) throw new Error("missing blocked fixture");
    await db.run(
      "UPDATE quotations SET payload_json=? WHERE id=?",
      [JSON.stringify({ ...blockedRecord.payload, validationBlocks: ["customer_master_unresolved"] }), blocked.id],
    );
    await expect((await post(blocked.id)).json()).resolves.toEqual({ error: "validation_blocked" });

    const sample = await issue();
    const sampleRecord = await getQuotation(sample.id);
    if (!sampleRecord) throw new Error("missing sample fixture");
    await db.run(
      "UPDATE quotations SET payload_json=? WHERE id=?",
      [JSON.stringify({
        ...sampleRecord.payload,
        sampleBulkConfirmation: { required: true, status: "pending" },
      }), sample.id],
    );
    await expect((await post(sample.id)).json()).resolves.toEqual({ error: "sample_bulk_confirmation_required" });
  });

  it("enforces literal zero and configured quantity/cost/validity/customer/class limits", () => {
    const base = {
      quantity: "10000",
      grandTotal: "110000",
      issueDate: "2026-11-10",
      validUntil: "2026-12-10",
      payload: { customerCode: "AGENT-001", printingMethod: "digital" },
    } as const;
    const complete = {
      enabled: true,
      configComplete: true,
      maxQuantity: 100000,
      maxCostJpy: 1000000,
      maxValidityDays: 365,
      allowedCustomerCodes: ["AGENT-001"],
      allowedPrintClasses: ["digital"],
      acknowledgedWarnings: [],
      approvedSnapshotAsOf: [],
      fingerprint: "test",
    };
    expect(policyLimitExceeded(base as never, complete)).toBe(false);
    expect(policyLimitExceeded({ ...base, quantity: "100001" } as never, complete)).toBe(true);
    expect(policyLimitExceeded({ ...base, grandTotal: "1000001" } as never, complete)).toBe(true);
    expect(policyLimitExceeded({ ...base, validUntil: "2027-12-10" } as never, complete)).toBe(true);
    expect(policyLimitExceeded({
      ...base,
      payload: { customerCode: "OTHER", printingMethod: "digital" },
    } as never, complete)).toBe(true);
    expect(policyLimitExceeded({
      ...base,
      payload: { customerCode: "AGENT-001", printingMethod: "offset" },
    } as never, complete)).toBe(true);
    expect(policyLimitExceeded(base as never, { ...complete, maxCostJpy: 0 })).toBe(true);

    const quote = issue();
    return (async () => {
      const db = await getDatabaseForTest();
      const fixture = await quote;
      await db.run("UPDATE quotations SET quantity='100001' WHERE id=?", [fixture.id]);
      const response = await post(fixture.id);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "policy_limit_exceeded" });
    })();
  });

  it("approves a fresh Kanei quote through the existing writer and syncs one film order", async () => {
    const quote = await issue();
    const response = await post(quote.id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      outcome: "approved",
      quotationId: quote.id,
      quotationNumber: quote.number,
      ownerDomain: "kanei",
      calculation: {
        version: "2026-10.1",
        resultHash: body.calculation.resultHash,
      },
      pdfSha256: body.pdfSha256,
      filmOrderSynced: true,
    });
    const persisted = await getQuotation(quote.id);
    expect(persisted?.internalApproval?.approvedBy?.email).toBe("ai@kanei-trade.co.jp");
    const db = await getDatabaseForTest();
    const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE quotation_id=?", [quote.id]);
    expect(order?.id).toBeGreaterThan(0);

    const events = await auditRows();
    const allow = events.filter((event) => event.reason === "allow").at(-1);
    expect(allow).toMatchObject({
      outcome: "allow",
      reason: "allow",
      credential_id: approver.credentialId,
      principal_email: "ai@kanei-trade.co.jp",
      quotation_id: String(quote.id),
      quotation_number: quote.number,
      pdf_sha256: body.pdfSha256,
    });
    expect(String(allow?.correlation_id)).toMatch(/^[\w-]{36}$/u);

    const replay = await post(quote.id);
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toEqual({ error: "invalid_approval_transition" });
    expect(await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM film_orders WHERE quotation_id=?",
      [quote.id],
    )).toEqual({ count: 1 });
  });

  it("accepts an explicitly approved as-of snapshot after current gravure master change", async () => {
    const asOf = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
    const request: CalculationInput = structuredClone({
      ...baseCalculationRequest,
      printingMethod: "gravure",
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
    });
    const digitalValues = await resolveFilmUnitPrices(asOf, defaultParameters.filmUnitPrices);
    request.parameters = { ...(request.parameters ?? {}), filmUnitPrices: digitalValues };
    const resolved = await resolveGravureMasters(asOf);
    request.gravureParameters = resolved.kSet?.derived ?? defaultGravureRollParameters();
    request.gravureYRows = resolved.yRows;
    request.selectedCandidateId = "";
    request.selectedCandidateTargetMargins = ["0.4"];
    const candidateBasis = calculatePouchCost(request);
    const candidate = candidateBasis.recommendationCandidates?.find((entry) => entry.recommended)
      ?? candidateBasis.recommendationCandidates?.[0];
    if (!candidate) throw new Error("no gravure candidate");
    request.selectedCandidateId = candidate.id;
    const result = calculatePouchCost(request);
    const snapshot = await saveGravureSnapshot({
      asOf,
      digitalValues,
      resolved,
      request,
      result,
      createdBy: "ai@kanei-trade.co.jp",
    });
    const checklist = buildCalculationChecklistSnapshot(result, {
      quotationNumber: "gravure-approval-evaluator",
      customerName: "株式会社承認テスト",
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
      parameters: request.parameters as typeof defaultParameters,
      gravureParameters: request.gravureParameters,
      skus: [{
        quantity: result.quantity,
        fillMl: request.spec.fillMlPerChamber,
        colorCount: String(request.spec.colorCount),
        requiredLengthM: result.sasche?.requiredLengthM ?? result.film.requiredLengthM,
        orderLengthM: result.film.orderLengthM,
        unitPriceYen: result.film.unitPrice,
        multiplier: 1,
        webWidthMm: result.sasche?.webWidthMm ?? result.film.skuCosts[0]?.webWidthMm ?? 356,
        appliedBand: result.sasche ? `${result.sasche.webWidthMm}` : "lte570",
      }],
    }) as CalculationChecklistSnapshot;
    const activeWidthMm = activeMaterialWidthMm(result);
    if (activeWidthMm == null) throw new Error("no active gravure width");
    const purchaseOrder: PurchaseOrderSnapshot = {
      printingMethod: result.printingMethod,
      pouchQuantity: result.quantity,
      filmComposition: "PET12/AL7/LLDPE60",
      requiredLengthM: result.film.requiredLengthM,
      orderLengthM: result.film.orderLengthM,
      effectiveLengthM: result.film.effectiveLengthM,
      lossM: result.film.lossM,
      lossRate: request.parameters?.bulkLossRate ?? defaultParameters.bulkLossRate,
      webWidthMm: activeWidthMm,
      webWidthsMm: [activeWidthMm],
      filmCostYen: result.film.filmTotal,
      lanes: result.fillingLanes,
      pitchMm: "0",
      prodMultiplier: 1,
      colorCount: request.spec.colorCount,
      skuColorCounts: [String(request.spec.colorCount)],
      skuOrderDetails: [{
        skuCode: "SKU-1",
        name: "approval test",
        quantity: result.quantity,
        colorCount: String(request.spec.colorCount),
        requiredLengthM: result.sasche?.requiredLengthM ?? result.film.requiredLengthM,
        orderLengthM: result.film.orderLengthM,
        webWidthMm: activeWidthMm,
        multiplier: 1,
      }],
      procurementRoute: "K",
      gravureLossM: result.film.lossM,
      customMold: result.customCharge === "0" ? undefined : { quantity: "1", costYen: result.customCharge },
      copperPlate: result.gravure && result.gravure.copperPlateCount > 0 ? {
        quantity: result.gravure.copperPlateCount,
        plateWidthMm: D(result.gravure.materialWidthMm).plus(request.gravureParameters!.copperPlateWidthExtraMm).toString(),
        diameterMm: Number(D(request.gravureParameters!.copperPlateMinimumDiameterMm).div(10).toString()),
        minimumPriceYen: GRAVURE_ROLL_COPPER_PLATE_MINIMUM_YEN,
        unitPriceYen: result.gravure.copperPlateUnitPriceYen,
        priceYen: result.gravure.copperPlateCostYen,
      } : undefined,
    };
    const record = {
      id: 999001,
      quotationNumber: "KT-GRAVURE-APPROVAL-001",
      status: "draft",
      issueDate: asOf,
      validUntil: "2099-12-31",
      customerName: "株式会社承認テスト",
      customerContact: "ご担当者",
      productName: "承認テストパウチ",
      sizeSummary: "40×145mm",
      quantity: result.quantity,
      fillingCostPerPiece: "1",
      filmCostPerPiece: "1",
      filmMeterPrice: "1",
      filmOrderLengthM: result.film.orderLengthM,
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "10",
      subtotal: "10000",
      tax: "1000",
      grandTotal: "11000",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: result.audit.calculationVersion,
      resultHash: result.audit.resultJsonSha256,
      ownerDomain: "kanei",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: { id: 1, email: "ai@kanei-trade.co.jp", name: "Hermes" },
      updatedBy: null,
      internalApproval: null,
      customerApproval: null,
      payload: {
        printingMethod: "gravure",
        customerCode: "AGENT-001",
        calculationFilmTotal: result.film.filmTotal,
        resultHash: result.audit.resultJsonSha256,
        calculationRequest: request,
        calculationChecklistSnapshot: checklist,
        pricingSnapshot: {
          id: snapshot.id,
          sha256: snapshot.snapshotSha256,
          publicProjection: {
            ...snapshot.canonicalPublicProjection,
            publicProjectionHash: snapshot.publicProjectionSha256,
          },
        },
        purchaseOrder,
      },
    } as QuotationRecord;

    const db = await getDatabaseForTest();
    const stale = await db.get<{ id: string; k_source_json: string; k_derived_json: string }>(
      "SELECT id,k_source_json,k_derived_json FROM calculation_master_snapshots WHERE id=?",
      [snapshot.id],
    );
    if (!stale) throw new Error("missing durable gravure snapshot");
    const changedDerived = JSON.parse(stale.k_derived_json) as Record<string, unknown>;
    changedDerived.__testRevision = "changed-current-master";
    const source = JSON.parse(stale.k_source_json) as Record<string, string>;
    const sourceColumns = GRAVURE_K_SOURCE_FIELDS.map((field) => field);
    const sourceValues = GRAVURE_K_SOURCE_FIELDS.map((field) => source[field]);
    await db.run(
      `INSERT INTO gravure_k_parameter_sets
       (source_json,${sourceColumns.join(",")},derived_json,memo,effective_from,effective_to,updated_by,updated_at)
       VALUES (?,${sourceColumns.map(() => "?").join(",")},?,?,?,?,?,?)`,
      [
        stale.k_source_json,
        ...sourceValues,
        JSON.stringify(changedDerived),
        "approval freshness test",
        asOf,
        "9999-12-31",
        "test",
        new Date().toISOString(),
      ],
    );
    const baseConfig = internalApprovalConfigFromEnv();
    await expect(evaluateCalculationFreshness(record, baseConfig)).resolves.toMatchObject({ fresh: false });
    const approvedConfig = {
      ...baseConfig,
      approvedSnapshotAsOf: [asOf],
    };
    await expect(evaluateCalculationFreshness(record, approvedConfig)).resolves.toMatchObject({
      fresh: true,
      version: true,
      provenance: true,
      storedHashMatches: true,
      authorityCurrent: true,
    });
  });

  it("audits policy configuration changes and keeps every approval audit redacted", async () => {
    const { observeInternalApprovalConfig } = await import("@/lib/agent-approval-policy");
    const config = internalApprovalConfigFromEnv();
    await observeInternalApprovalConfig({ ...config, fingerprint: "previous-policy-fingerprint" });
    const quote = await issue();
    await resetQuote(quote.id);
    const response = await post(quote.id);
    expect(response.status).toBe(200);
    expect((await configAuditRows()).at(-1)).toMatchObject({
      outcome: "allow",
      reason: "approval_policy_config_observed",
      credential_id: approver.credentialId,
      principal_email: "ai@kanei-trade.co.jp",
    });

    const serialized = JSON.stringify(await auditRows());
    expect(serialized).not.toContain(approver.credentialId ? "Bearer " : "never");
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain("株式会社承認テスト");
    expect(serialized).not.toContain("payload_json");
  });
});
