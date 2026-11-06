// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-owner-approval-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@owner-approval.test";
process.env.ADMIN_PASSWORD = "admin-owner-approval-password";
process.env.ADMIN_NAME = "Owner Approval Admin";

const { POST: postApprovalRoute } = await import("@/app/api/quotations/[id]/approvals/route");
const { GET: getCustomerApproval, POST: postCustomerApproval } = await import(
  "@/app/api/quotations/approvals/[token]/route"
);
const { createSession, createUser, closeDatabaseForTest } = await import(
  "@/lib/auth-store"
);
const { buildCustomerApprovalToken } = await import("@/lib/quotation-approval-token");
const { buildCustomerQuotationEmail, customerQuotationSenderName } = await import("@/lib/quotation-email");
const {
  approveQuotationGate,
  getQuotation,
  QuotationApprovalForbiddenError,
  getDatabaseForTest,
  saveQuotation,
  updateQuotationStatus,
} = await import("@/lib/quotation-store");
const { quotationOwnerProfile } = await import("@/lib/quote-owner-profiles");

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function input(number: string, customerEmail = "customer@example.test"): QuotationRecordInput {
  return {
    quotationNumber: number,
    status: "draft",
    issueDate: "2026-11-04",
    validUntil: "2099-12-31",
    customerName: "Owner Routing Customer",
    customerContact: "Customer Contact",
    productName: "Owner Routing Pouch",
    sizeSummary: "50×90mm / 1連",
    quantity: "1000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "1",
    filmMeterPrice: "200",
    filmOrderLengthM: "500",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "10000",
    tax: "1000",
    grandTotal: "11000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "manual-entry",
    resultHash: "",
    payload: { customerEmail },
  };
}

const kaneiCreator = await createUser({
  email: "kanei-owner@kanei-trade.co.jp",
  name: "Kanei Owner",
  password: "kanei-owner-routing-password",
  role: "user",
});
const kaneiApprover = await createUser({
  email: "kanei-approver@kanei-trade.co.jp",
  name: "Kanei Approver",
  password: "kanei-approver-routing-password",
  role: "admin",
});
const sevenCreator = await createUser({
  email: "seven-owner@727.co.jp",
  name: "Seven Owner",
  password: "seven-owner-routing-password",
  role: "user",
});
const sevenApprover = await createUser({
  email: "seven-approver@727.co.jp",
  name: "Seven Approver",
  password: "seven-approver-routing-password",
  role: "admin",
});
let kaneiTokenRecord = await saveQuotation(input("KT-OWNER-APPROVAL-001"), kaneiCreator.id);
const sevenTokenRecord = await saveQuotation(input("S7-OWNER-APPROVAL-001"), sevenCreator.id);
const kaneiRecordId = kaneiTokenRecord.id;
await (await getDatabaseForTest()).run(
  "UPDATE quotations SET owner_domain='kanei', quotation_number='KT-OWNER-APPROVAL-001' WHERE id=?",
  [kaneiTokenRecord.id],
);
kaneiTokenRecord = (await getQuotation(kaneiRecordId))!;

describe("quotation owner approval routing", () => {
  it("requires the quote owner domain for each internal approval chain", async () => {
    await expect(approveQuotationGate(kaneiTokenRecord.id, "internal", sevenApprover.id))
      .rejects.toBeInstanceOf(QuotationApprovalForbiddenError);
    await expect(approveQuotationGate(sevenTokenRecord.id, "internal", kaneiApprover.id))
      .rejects.toBeInstanceOf(QuotationApprovalForbiddenError);
    await expect(approveQuotationGate(sevenTokenRecord.id, "internal", kaneiCreator.id))
      .rejects.toBeInstanceOf(QuotationApprovalForbiddenError);

    const kaneiApproved = await approveQuotationGate(kaneiTokenRecord.id, "internal", kaneiApprover.id);
    const sevenApproved = await approveQuotationGate(sevenTokenRecord.id, "internal", sevenApprover.id);
    expect(kaneiApproved.internalApproval?.approvedBy?.email).toBe(kaneiApprover.email);
    expect(sevenApproved.internalApproval?.approvedBy?.email).toBe(sevenApprover.email);
  });

  it("rejects cross-owner customer evidence recording while preserving owner records", async () => {
    await updateQuotationStatus(kaneiTokenRecord.id, "sent", kaneiApprover.id);
    await updateQuotationStatus(sevenTokenRecord.id, "sent", sevenApprover.id);
    await expect(approveQuotationGate(kaneiTokenRecord.id, "customerApproval", sevenApprover.id))
      .rejects.toBeInstanceOf(QuotationApprovalForbiddenError);
    const kaneiRecorded = await approveQuotationGate(kaneiTokenRecord.id, "customerApproval", kaneiApprover.id);
    expect(kaneiRecorded.customerApproval?.approvedBy?.email).toBe(kaneiApprover.email);
    expect(kaneiRecorded.customerApproval?.customerIpHash).toBeNull();
  });

  it("rejects an admin API internal approval outside the admin's owner domain", async () => {
    const anotherSeven = await saveQuotation(input("S7-OWNER-APPROVAL-002"), sevenCreator.id);
    const session = await createSession(kaneiApprover.id);
    const response = await postApprovalRoute(
      new Request(`http://localhost/api/quotations/${anotherSeven.id}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `pouch_session=${session.token}` },
        body: JSON.stringify({ gate: "internal" }),
      }),
      { params: Promise.resolve({ id: String(anotherSeven.id) }) },
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "internal_approval_forbidden" });
    await expect(getQuotation(anotherSeven.id)).resolves.toMatchObject({
      ownerDomain: "seven",
      internalApproval: null,
    });
  });

  it("derives customer mail branding and sender identity from the durable quote owner", () => {
    const kaneiMail = buildCustomerQuotationEmail(
      { ...kaneiTokenRecord, internalApproval: { approvedAt: "2026-11-04T00:00:00.000Z", approvedBy: null } },
      "https://example.test/approve-kanei",
      "kanei.pdf",
    );
    const sevenMail = buildCustomerQuotationEmail(
      { ...sevenTokenRecord, internalApproval: { approvedAt: "2026-11-04T00:00:00.000Z", approvedBy: null } },
      "https://example.test/approve-seven",
      "seven.pdf",
    );
    expect(kaneiMail.body).toContain("金井貿易株式会社");
    expect(kaneiMail.body).toContain("shapepouch@package-lab.com");
    expect(customerQuotationSenderName(kaneiTokenRecord)).toBe("カネイトレード");
    expect(sevenMail.body).toContain("株式会社セブン化学");
    expect(sevenMail.body).toContain("gotou@727.co.jp");
    expect(customerQuotationSenderName(sevenTokenRecord)).toBe("株式会社セブン化学");
    expect(kaneiMail.body).not.toContain("株式会社セブン化学");
    expect(sevenMail.body).not.toContain("shapepouch@package-lab.com");
  });

  it("returns token-scoped owner branding and rejects valid legacy tokens for unresolved owners", async () => {
    const sevenCurrent = await getQuotation(sevenTokenRecord.id);
    const sevenToken = buildCustomerApprovalToken(sevenCurrent!);
    const view = await getCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${sevenToken}`),
      { params: Promise.resolve({ token: sevenToken }) },
    );
    expect(view.status).toBe(200);
    const viewPayload = await view.json();
    expect(viewPayload.quotation.owner).toMatchObject({
      ownerDomain: "seven",
      brandLabel: "Seven Chemical",
      legalName: "株式会社セブン化学",
      logoUrl: "/seven-chemical-logo.png",
      defaultContactEmail: "gotou@727.co.jp",
    });

    const db = await getDatabaseForTest();
    const unresolved = await saveQuotation(input("KT-UN-OWNER-APPROVAL-001"), kaneiCreator.id);
    await db.run(
      "UPDATE quotations SET owner_domain = 'unresolved', status = 'sent', internal_approved_at = ?, internal_approved_by = ? WHERE id = ?",
      ["2026-11-04T00:00:00.000Z", kaneiCreator.id, unresolved.id],
    );
    const unresolvedPersisted = await getQuotation(unresolved.id);
    expect(unresolvedPersisted).toMatchObject({ ownerDomain: "unresolved", internalApproval: { approvedAt: "2026-11-04T00:00:00.000Z" } });
    const unresolvedToken = buildCustomerApprovalToken(unresolvedPersisted!);
    const unresolvedView = await getCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${unresolvedToken}`),
      { params: Promise.resolve({ token: unresolvedToken }) },
    );
    expect(unresolvedView.status).toBe(409);
    await expect(unresolvedView.json()).resolves.toEqual({ error: "unresolved_quote_owner" });
    const unresolvedApproval = await postCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${unresolvedToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acknowledge: true }),
      }),
      { params: Promise.resolve({ token: unresolvedToken }) },
    );
    expect(unresolvedApproval.status).toBe(409);
    await expect(getQuotation(unresolved.id)).resolves.toMatchObject({
      ownerDomain: "unresolved",
      customerApproval: null,
    });
  });

  it("keeps owner profile branding independent from a viewer or admin", () => {
    expect(quotationOwnerProfile(kaneiTokenRecord.ownerDomain)?.brandLabel).toBe("Kanei Trade");
    expect(quotationOwnerProfile(sevenTokenRecord.ownerDomain)?.brandLabel).toBe("Seven Chemical");
    expect(quotationOwnerProfile("unresolved")).toBeNull();
  });
});
