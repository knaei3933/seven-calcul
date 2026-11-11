// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "agent-quote-read-api-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "agent-read-admin-password";
process.env.ADMIN_NAME = "Agent Read Admin";
process.env.AGENT_API_RATE_LIMIT = "100";
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const sendMailMock = vi.fn();
vi.mock("@/lib/mail-sender", () => ({
  sendMail: sendMailMock,
  isSmtpConfigured: () => true,
}));

const {
  agentAuthDatabaseForTest,
  createAgentCredential,
  ensureAgentPrincipalForTest,
  resetAgentAuthForTest,
} = await import("@/lib/agent-auth-store");
const { resetAgentQuoteServiceForTest } = await import("@/lib/agent-quote-service");
const { GET: getQuote } = await import("@/app/api/agent/v1/quotes/[id]/route");
const { GET: getEmailDraft } = await import("@/app/api/agent/v1/quotes/[id]/email-draft/route");
const { GET: getApprovalState } = await import(
  "@/app/api/agent/v1/quotes/[id]/customer-approval-state/route"
);
const { createUser } = await import("@/lib/auth-store");
const {
  approveQuotationGate,
  getDatabaseForTest,
  getQuotation,
  saveQuotation,
  updateQuotationStatus,
} = await import("@/lib/quotation-store");

await ensureAgentPrincipalForTest();

function input(number: string, customerEmail = "buyer@example.test"): QuotationRecordInput {
  return {
    quotationNumber: number,
    status: "draft",
    issueDate: "2026-11-10",
    validUntil: "2099-12-31",
    customerName: "株式会社エージェント読者",
    customerContact: "ご担当者",
    productName: "テストパウチ",
    sizeSummary: "40×145mm",
    quantity: "10000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "1",
    filmMeterPrice: "200",
    filmOrderLengthM: "500",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "100000",
    tax: "10000",
    grandTotal: "110000",
    deliveryDate: "別途相談",
    paymentTerms: "月末締め翌月末払い",
    notes: "",
    calculationVersion: "manual-agent-read",
    resultHash: "a".repeat(64),
    payload: {
      customerEmail,
      pricingSnapshot: { secret: "internal" },
      commission: "hidden",
    },
  };
}

const kaneiCreator = await createUser({
  email: "quote-owner@kanei-trade.co.jp",
  name: "Kanei Quote Owner",
  password: "quote-owner-password",
  role: "user",
});
const pdfSha256 = createHash("sha256").update(Buffer.from("%PDF-", "utf8")).digest("hex");
const readable = await saveQuotation(input("KT-AGENT-READ-001"), kaneiCreator.id);
const seven = await saveQuotation(input("KT-AGENT-SEVEN-001"), kaneiCreator.id);
const db = await getDatabaseForTest();
await db.run(
  "UPDATE quotations SET owner_domain = 'seven', quotation_number = 'S7-AGENT-READ-001' WHERE id = ?",
  [seven.id],
);
await db.run(
  "UPDATE quotations SET pdf_data = X'255044462d', pdf_file_name = ?, pdf_uploaded_at = ?, pdf_sha256 = ? WHERE id = ?",
  ["kanei.pdf", new Date().toISOString(), pdfSha256, readable.id],
);

const reader = await createAgentCredential({
  name: "quote reader",
  scopes: ["quote:read", "email_draft:read", "approval_state:read"],
  expiresAt: new Date(Date.now() + 60_000),
});
const limited = await createAgentCredential({
  name: "summary-only reader",
  scopes: ["quote:read"],
  expiresAt: new Date(Date.now() + 60_000),
});

function request(path: string, token: string): Request {
  return new Request(`https://app.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function context(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

async function auditRows(operation: string): Promise<Record<string, unknown>[]> {
  const auditDb = await agentAuthDatabaseForTest();
  return auditDb.all<Record<string, unknown>>(
    "SELECT * FROM agent_audit_events WHERE operation = ? ORDER BY occurred_at, id",
    [operation],
  );
}

const forbiddenSummaryKeys = [
  "cost", "costTotal", "totalCostPerPiece", "costPerPieceComponents", "margin", "profit",
  "film", "filmOrder", "supplier", "pricingSnapshot", "payload", "payloadJson", "resultHash",
  "calculationRequest", "fullAugmentedCalculationRequest", "commission", "approvalUrl",
  "grandTotal", "pricePerPiece", "subtotal", "tax", "customerContact", "customerEmail",
];

function assertNoForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(forbiddenSummaryKeys).not.toContain(key);
    assertNoForbiddenKeys(child);
  }
}

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await resetAgentAuthForTest();
  await resetAgentQuoteServiceForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("scoped agent Kanei quote reads", () => {
  it("returns a bounded summary only after durable Kanei authorization", async () => {
    const response = await getQuote(request("/api/agent/v1/quotes/missing", reader.token), context(readable.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.quotation).toEqual({
      id: readable.id,
      number: "KT-202611-001",
      ownerDomain: "kanei",
      status: "draft",
      dates: {
        issueDate: "2026-11-10",
        validUntil: "2099-12-31",
        deliveryDate: "別途相談",
        createdAt: readable.createdAt,
        updatedAt: readable.updatedAt,
      },
      customer: { name: "株式会社エージェント読者" },
      product: { name: "テストパウチ" },
      spec: "40×145mm",
      quantity: "10000",
      pdf: {
        available: true,
        fileName: "お見積書_テストパウチ(株式会社エージェント読者)_261110.pdf",
        sha256: pdfSha256,
        byteLength: 5,
      },
      approvals: {
        internal: { approved: false, approvedAt: null },
        customer: { approvedAt: null, source: null },
      },
    });
    assertNoForbiddenKeys(body);
    expect((await auditRows("agent.quote.read")).at(-1)).toMatchObject({
      outcome: "allow",
      quotation_id: String(readable.id),
    });
  });

  it("denies Seven-owned records and missing scopes", async () => {
    for (const call of [
      () => getQuote(request("/x", reader.token), context(seven.id)),
      () => getEmailDraft(request("/x", reader.token), context(seven.id)),
      () => getApprovalState(request("/x", reader.token), context(seven.id)),
    ]) {
      const response = await call();
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "quote_owner_action_forbidden" });
    }

    const response = await getEmailDraft(request("/x", limited.token), context(readable.id));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "agent_scope_denied" });
    expect((await auditRows("agent.quote.email_draft.read")).some((event) => event.reason === "agent_scope_denied")).toBe(true);
  });

  it("generates an existing customer draft without dispatch and marks approval material internal-only", async () => {
    const before = await getEmailDraft(request("/x", reader.token), context(readable.id));
    expect(before.status).toBe(200);
    const draft = await before.json();
    expect(draft.recipient).toBe("buyer@example.test");
    expect(draft.subject).toContain("KT-202611-001");
    expect(draft.pdf).toEqual({
      available: true,
      fileName: "お見積書_テストパウチ(株式会社エージェント読者)_261110.pdf",
      sha256: pdfSha256,
      byteLength: 5,
    });
    expect(draft.approvalMaterial).toEqual({
      policy: "internal_actor_only",
      approvalUrl: null,
      approvalUrlEmbeddedInBody: false,
      approvalTokenFieldPolicy: "not_returned",
    });
    expect(draft.body).not.toContain("/quote-approvals/");

    await approveQuotationGate(readable.id, "internal", kaneiCreator.id);
    await updateQuotationStatus(readable.id, "sent", kaneiCreator.id);
    const approvedResponse = await getEmailDraft(request("/x", reader.token), context(readable.id));
    const approved = await approvedResponse.json();
    expect(Object.keys(approved.approvalMaterial)).toEqual([
      "policy",
      "approvalUrl",
      "approvalUrlEmbeddedInBody",
      "approvalTokenFieldPolicy",
    ]);
    expect(approved.approvalMaterial.approvalUrl).toMatch(/^https:\/\/app\.test\/quote-approvals\/[\w-]+\.[\w-]+$/u);
    expect(approved.approvalMaterial.approvalUrlEmbeddedInBody).toBe(true);
    expect(approved.approvalMaterial.approvalTokenFieldPolicy).toBe("not_returned");
    expect(sendMailMock).not.toHaveBeenCalled();
    expect((await auditRows("agent.quote.email_draft.read")).at(-1)).toMatchObject({
      outcome: "allow",
      quotation_id: String(readable.id),
    });
  });

  it("requires every endpoint to authenticate", async () => {
    const unauthenticated = new Request("https://app.test/x");
    const responses = await Promise.all([
      getQuote(unauthenticated, context(readable.id)),
      getEmailDraft(unauthenticated, context(readable.id)),
      getApprovalState(unauthenticated, context(readable.id)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    const persisted = await getQuotation(readable.id);
    expect(persisted?.customerApproval).toBeNull();
  });
});
