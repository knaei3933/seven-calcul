import { withLegacySevenQuotationSave } from "../helpers/legacy-quotation-fixture";
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecord, QuotationRecordInput } from "@/lib/quotation-shared";


const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-owner-actions-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "audit-admin@action.test";
process.env.ADMIN_PASSWORD = "audit-admin-password";
process.env.ADMIN_NAME = "Audit Admin";

const { PATCH: patchQuotation, DELETE: deleteQuotation, GET: getQuotation } =
  await import("@/app/api/quotations/[id]/route");
const { GET: listQuotations, POST: issueQuotation } = await import("@/app/api/quotations/route");
const { POST: savePdf, GET: getPdf } = await import("@/app/api/quotations/[id]/pdf/route");
const { GET: getChecklists, PATCH: patchChecklist } = await import("@/app/api/quotations/[id]/checklists/route");
const { GET: getSampleBulk, POST: postSampleBulk } = await import("@/app/api/quotations/[id]/sample-bulk/route");
const { POST: postApproval } = await import("@/app/api/quotations/[id]/approvals/route");
const { POST: sendQuotationEmail } = await import("@/app/api/quotations/[id]/send/route");
const { GET: getCustomerApproval, POST: postCustomerApproval } =
  await import("@/app/api/quotations/approvals/[token]/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const {
  approveQuotationGate,
  createLegacyChecklistsForQuotation,
  getQuotation: getQuotationRecord,
  saveQuotation: directSaveQuotation,
  updateQuotationStatus,
} = await import("@/lib/quotation-store");
const saveQuotation = withLegacySevenQuotationSave(directSaveQuotation);
const { createSession, createUser } = await import("@/lib/auth-store");
const { buildCustomerApprovalToken } = await import("@/lib/quotation-approval-token");

function input(number: string, status: QuotationRecord["status"] = "draft"): QuotationRecordInput {
  return {
    quotationNumber: number,
    status,
    issueDate: "2026-11-04",
    validUntil: "2099-12-31",
    customerName: "Authorization Customer",
    customerContact: "Authorization Contact",
    productName: "Authorization Pouch",
    sizeSummary: "50×90mm / 1連",
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
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "manual-entry",
    resultHash: "",
    payload: {
      customerEmail: "authorization.customer@example.test",
      customerPostalCode: "100-0001",
      customerTelephone: "03-0000-0000",
      customerAddress: "Authorization Address",
      sampleBulkRequired: true,
      sampleBulkConfirmation: { required: true, status: "pending" },
    },
  };
}

async function tokenFor(email: string, password: string): Promise<string> {
  const response = await login(new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  }));
  const token = response.headers.get("set-cookie")?.match(/pouch_session=([^;]+)/)?.[1];
  if (!token) throw new Error(`login failed for ${email}`);
  return token;
}

function request(url: string, init: RequestInit, token?: string): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { cookie: `pouch_session=${token}` } : {}),
    },
  });
}

function context(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

function pdfForm(): FormData {
  const form = new FormData();
  form.set("pdf", new Blob([Buffer.from("%PDF-owner-action-test")], { type: "application/pdf" }), "quote.pdf");
  return form;
}

const sevenCreator = await createUser({
  email: "creator@727.co.jp",
  name: "Seven Creator",
  password: "seven-creator-password",
  role: "user",
});
const sevenPeer = await createUser({
  email: "peer@727.co.jp",
  name: "Seven Peer",
  password: "seven-peer-password",
  role: "user",
});
const kaneiUser = await createUser({
  email: "cross@kanei-trade.co.jp",
  name: "Kanei Cross",
  password: "kanei-cross-password",
  role: "user",
});
const kaneiAdmin = await createUser({
  email: "admin@kanei-trade.co.jp",
  name: "Kanei Admin",
  password: "kanei-admin-password",
  role: "admin",
});
const creatorToken = await createSession(sevenCreator.id).then((session) => session.token);
const peerToken = await createSession(sevenPeer.id).then((session) => session.token);
const kaneiToken = await createSession(kaneiUser.id).then((session) => session.token);
const kaneiAdminToken = await createSession(kaneiAdmin.id).then((session) => session.token);
const crossAdminToken = await tokenFor("audit-admin@action.test", "audit-admin-password");

const sevenQuote = await saveQuotation(input("S7-AUTH-ACTION-001"), sevenCreator.id);
const unresolvedQuote = await saveQuotation(input("S7-AUTH-UNRESOLVED-001"), sevenCreator.id);
const db = await import("@/lib/quotation-store").then((store) => store.getDatabaseForTest());
await db.run("UPDATE quotations SET owner_domain = 'unresolved' WHERE quotation_number = 'S7-AUTH-UNRESOLVED-001'");
await createLegacyChecklistsForQuotation(sevenQuote, "digital");
const unresolvedPersisted = await getQuotationRecord(unresolvedQuote.id);

describe("quotation owner-scoped action authorization", () => {
  it("restricts reads while allowing cross-company admin visibility", async () => {
    const wrongDomainRead = await getQuotation(
      request(`http://localhost/api/quotations/${sevenQuote.id}`, {}, kaneiToken),
      context(sevenQuote.id),
    );
    expect(wrongDomainRead.status).toBe(403);
    await expect(wrongDomainRead.json()).resolves.toEqual({ error: "quotation_forbidden" });

    const wrongDomainList = await listQuotations(request("http://localhost/api/quotations?limit=100", {}, kaneiToken));
    const wrongDomainPayload = await wrongDomainList.json();
    expect(wrongDomainPayload.records.map((record: QuotationRecord) => record.id)).not.toContain(sevenQuote.id);

    const adminRead = await getQuotation(
      request(`http://localhost/api/quotations/${sevenQuote.id}`, {}, crossAdminToken),
      context(sevenQuote.id),
    );
    expect(adminRead.status).toBe(200);
    await expect(adminRead.json()).resolves.toMatchObject({
      record: { id: sevenQuote.id, ownerDomain: "seven", payload: { customerEmail: "authorization.customer@example.test" } },
    });

    const adminList = await listQuotations(request("http://localhost/api/quotations?limit=100", {}, crossAdminToken));
    const adminPayload = await adminList.json();
    expect(adminPayload.records.map((record: QuotationRecord) => record.id)).toContain(sevenQuote.id);
  });

  it("denies cross-domain status and email mutations but allows creator and same-domain actors", async () => {
    const adminStatus = await patchQuotation(request(`http://localhost/api/quotations/${sevenQuote.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    }, crossAdminToken), context(sevenQuote.id));
    expect(adminStatus.status).toBe(403);
    await expect(adminStatus.json()).resolves.toEqual({ error: "owner_action_forbidden" });

    const kaneiStatus = await patchQuotation(request(`http://localhost/api/quotations/${sevenQuote.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    }, kaneiToken), context(sevenQuote.id));
    expect(kaneiStatus.status).toBe(403);
    await expect(kaneiStatus.json()).resolves.toEqual({ error: "owner_action_forbidden" });

    const peerStatus = await patchQuotation(request(`http://localhost/api/quotations/${sevenQuote.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    }, peerToken), context(sevenQuote.id));
    expect(peerStatus.status).toBe(409);
    await expect(peerStatus.json()).resolves.toEqual({ error: "invalid_status_transition" });

    const adminEmail = await patchQuotation(request(`http://localhost/api/quotations/${sevenQuote.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerEmail: "admin@example.test" }),
    }, crossAdminToken), context(sevenQuote.id));
    expect(adminEmail.status).toBe(403);

    const kaneiEmail = await patchQuotation(request(`http://localhost/api/quotations/${sevenQuote.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerEmail: "kanei@example.test" }),
    }, kaneiToken), context(sevenQuote.id));
    expect(kaneiEmail.status).toBe(403);

    const creatorEmail = await patchQuotation(request(`http://localhost/api/quotations/${sevenQuote.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerEmail: "creator-corrected@example.test" }),
    }, creatorToken), context(sevenQuote.id));
    expect(creatorEmail.status).toBe(200);
    await expect(creatorEmail.json()).resolves.toMatchObject({
      record: { payload: { customerEmail: "creator-corrected@example.test" } },
    });
  });

  it("restricts PDF overwrite to the quote owner company while admins retain read-only access", async () => {
    const bytes = Buffer.from("%PDF-owner-action-canonical");
    const adminForm = new FormData();
    adminForm.set("pdf", new Blob([bytes], { type: "application/pdf" }), "admin.pdf");
    const adminPdf = await savePdf(request(`http://localhost/api/quotations/${sevenQuote.id}/pdf`, {
      method: "POST",
      body: adminForm,
    }, crossAdminToken), context(sevenQuote.id));
    expect(adminPdf.status).toBe(403);
    await expect(adminPdf.json()).resolves.toEqual({ error: "owner_action_forbidden" });

    const kaneiForm = new FormData();
    kaneiForm.set("pdf", new Blob([bytes], { type: "application/pdf" }), "kanei.pdf");
    const kaneiPdf = await savePdf(request(`http://localhost/api/quotations/${sevenQuote.id}/pdf`, {
      method: "POST",
      body: kaneiForm,
    }, kaneiToken), context(sevenQuote.id));
    expect(kaneiPdf.status).toBe(403);

    const peerForm = new FormData();
    peerForm.set("pdf", new Blob([bytes], { type: "application/pdf" }), "peer.pdf");
    const peerPdf = await savePdf(request(`http://localhost/api/quotations/${sevenQuote.id}/pdf`, {
      method: "POST",
      body: peerForm,
    }, peerToken), context(sevenQuote.id));
    expect(peerPdf.status).toBe(200);

    const creatorDownload = await getPdf(
      request(`http://localhost/api/quotations/${sevenQuote.id}/pdf`, {}, creatorToken),
      context(sevenQuote.id),
    );
    expect(creatorDownload.status).toBe(200);
    const wrongDownload = await getPdf(
      request(`http://localhost/api/quotations/${sevenQuote.id}/pdf`, {}, kaneiToken),
      context(sevenQuote.id),
    );
    expect(wrongDownload.status).toBe(403);
    await expect(wrongDownload.json()).resolves.toEqual({ error: "pdf_forbidden" });
    const adminDownload = await getPdf(
      request(`http://localhost/api/quotations/${sevenQuote.id}/pdf`, {}, crossAdminToken),
      context(sevenQuote.id),
    );
    expect(adminDownload.status).toBe(200);
  });

  it("scopes both checklist audiences to the owner company and denies cross-domain/admin writes", async () => {
    const ownerLists = await getChecklists(
      request(`http://localhost/api/quotations/${sevenQuote.id}/checklists`, {}, creatorToken),
      context(sevenQuote.id),
    );
    expect(ownerLists.status).toBe(200);
    const lists = await ownerLists.json();
    const customerItem = lists.checklists.find((item: { audience: string }) => item.audience === "CUSTOMER")?.items[0];
    const internalItem = lists.checklists.find((item: { audience: string }) => item.audience === "INTERNAL_QA")?.items[0];
    expect(customerItem).toBeTruthy();
    expect(internalItem).toBeTruthy();

    for (const token of [crossAdminToken, kaneiToken]) {
      const response = await patchChecklist(request(`http://localhost/api/quotations/${sevenQuote.id}/checklists`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: "CUSTOMER", itemId: customerItem.id, accepted: true }),
      }, token), context(sevenQuote.id));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "owner_action_forbidden" });
    }

    const wrongInternal = await patchChecklist(request(`http://localhost/api/quotations/${sevenQuote.id}/checklists`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: "INTERNAL_QA", itemId: internalItem.id, accepted: true }),
    }, peerToken), context(sevenQuote.id));
    expect(wrongInternal.status).toBe(200);

    const kaneiInternal = await patchChecklist(request(`http://localhost/api/quotations/${sevenQuote.id}/checklists`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: "INTERNAL_QA", itemId: internalItem.id, accepted: true }),
    }, kaneiToken), context(sevenQuote.id));
    expect(kaneiInternal.status).toBe(403);

    const ownerCustomer = await patchChecklist(request(`http://localhost/api/quotations/${sevenQuote.id}/checklists`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audience: "CUSTOMER", itemId: customerItem.id, accepted: true }),
    }, creatorToken), context(sevenQuote.id));
    expect(ownerCustomer.status).toBe(200);
  });

  it("denies cross-domain/admin sample mutations and allows owner receipt/confirmation", async () => {
    const wrongRead = await getSampleBulk(
      request(`http://localhost/api/quotations/${sevenQuote.id}/sample-bulk`, {}, kaneiToken),
      context(sevenQuote.id),
    );
    expect(wrongRead.status).toBe(403);

    for (const token of [crossAdminToken, kaneiToken]) {
      const denied = await postSampleBulk(request(`http://localhost/api/quotations/${sevenQuote.id}/sample-bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "record-received", receivedMl: "5000" }),
      }, token), context(sevenQuote.id));
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({ error: "sample_bulk_confirmation_forbidden" });
    }

    const received = await postSampleBulk(request(`http://localhost/api/quotations/${sevenQuote.id}/sample-bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record-received", receivedMl: "5000", note: "owner receipt" }),
    }, peerToken), context(sevenQuote.id));
    expect(received.status).toBe(200);

    const confirmed = await postSampleBulk(request(`http://localhost/api/quotations/${sevenQuote.id}/sample-bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm", note: "owner confirmation" }),
    }, creatorToken), context(sevenQuote.id));
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({
      confirmation: { status: "confirmed", receivedMl: "5000" },
    });
  });

  it("routes internal approval through the owner company and denies cross-company admins", async () => {
    const adminApproval = await postApproval(request(`http://localhost/api/quotations/${sevenQuote.id}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: "internal" }),
    }, crossAdminToken), context(sevenQuote.id));
    expect(adminApproval.status).toBe(403);
    await expect(adminApproval.json()).resolves.toEqual({ error: "internal_approval_forbidden" });

    const kaneiApproval = await postApproval(request(`http://localhost/api/quotations/${sevenQuote.id}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: "internal" }),
    }, kaneiAdminToken), context(sevenQuote.id));
    expect(kaneiApproval.status).toBe(403);

    const ownerApproval = await postApproval(request(`http://localhost/api/quotations/${sevenQuote.id}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate: "internal" }),
    }, creatorToken), context(sevenQuote.id));
    expect(ownerApproval.status).toBe(200);
    await expect(ownerApproval.json()).resolves.toMatchObject({ record: { internalApproval: expect.anything() } });
  });

  it("blocks owner-specific send before SMTP/design validation for wrong-domain actors", async () => {
    const denied = await sendQuotationEmail(request(`http://localhost/api/quotations/${sevenQuote.id}/send`, {
      method: "POST",
    }, kaneiToken), context(sevenQuote.id));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({ error: "customer_request_forbidden" });

    const authorized = await sendQuotationEmail(request(`http://localhost/api/quotations/${sevenQuote.id}/send`, {
      method: "POST",
    }, creatorToken), context(sevenQuote.id));
    expect([409, 503]).toContain(authorized.status);
    expect(authorized.status).not.toBe(403);
  });

  it("fails unresolved owner workflow actions closed while retaining creator/admin reads and creator deletion", async () => {
    const unresolvedContext = context(unresolvedQuote.id);
    const creatorRead = await getQuotation(
      request(`http://localhost/api/quotations/${unresolvedQuote.id}`, {}, creatorToken),
      unresolvedContext,
    );
    const adminRead = await getQuotation(
      request(`http://localhost/api/quotations/${unresolvedQuote.id}`, {}, crossAdminToken),
      unresolvedContext,
    );
    expect(creatorRead.status).toBe(200);
    expect(adminRead.status).toBe(200);

    const unresolvedRequests = [
      patchQuotation(request(`http://localhost/api/quotations/${unresolvedQuote.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "sent" }),
      }, creatorToken), unresolvedContext),
      patchQuotation(request(`http://localhost/api/quotations/${unresolvedQuote.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerEmail: "unresolved@example.test" }),
      }, creatorToken), unresolvedContext),
      savePdf(request(`http://localhost/api/quotations/${unresolvedQuote.id}/pdf`, {
        method: "POST",
        body: pdfForm(),
      }, creatorToken), unresolvedContext),
      patchChecklist(request(`http://localhost/api/quotations/${unresolvedQuote.id}/checklists`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience: "CUSTOMER", itemId: "any", accepted: true }),
      }, creatorToken), unresolvedContext),
      postApproval(request(`http://localhost/api/quotations/${unresolvedQuote.id}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gate: "internal" }),
      }, creatorToken), unresolvedContext),
      sendQuotationEmail(request(`http://localhost/api/quotations/${unresolvedQuote.id}/send`, {
        method: "POST",
      }, creatorToken), unresolvedContext),
    ];
    const statuses = await Promise.all(unresolvedRequests.map((response) => response.then((result) => result.status)));
    expect(statuses).toEqual([403, 403, 403, 403, 409, 409]);

    const deleted = await deleteQuotation(
      request(`http://localhost/api/quotations/${unresolvedQuote.id}`, { method: "DELETE" }, creatorToken),
      unresolvedContext,
    );
    expect(deleted.status).toBe(200);
    await expect(getQuotationRecord(unresolvedQuote.id)).resolves.toBeNull();
  });

  it("keeps external customer approval tokens quote/email scoped and owner-branded", async () => {
    const sentQuote = await saveQuotation(input("S7-AUTH-TOKEN-001"), sevenCreator.id);
    await approveQuotationGate(sentQuote.id, "internal", sevenCreator.id);
    await updateQuotationStatus(sentQuote.id, "sent", sevenCreator.id);
    const tokenBefore = buildCustomerApprovalToken(await getQuotationRecord(sentQuote.id) as QuotationRecord);
    const scopedView = await getCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${tokenBefore}`),
      { params: Promise.resolve({ token: tokenBefore }) },
    );
    expect(scopedView.status).toBe(200);
    const scopedPayload = await scopedView.json();
    expect(scopedPayload.quotation.owner).toMatchObject({ ownerDomain: "seven", brandLabel: "Seven Chemical" });

    await patchQuotation(request(`http://localhost/api/quotations/${sentQuote.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerEmail: "rotated@example.test" }),
    }, creatorToken), context(sentQuote.id));
    const staleView = await getCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${tokenBefore}`),
      { params: Promise.resolve({ token: tokenBefore }) },
    );
    expect(staleView.status).toBe(403);
    await expect(staleView.json()).resolves.toEqual({ error: "invalid_customer_approval_token" });

    const rotatedRecord = await getQuotationRecord(sentQuote.id);
    const validToken = buildCustomerApprovalToken(rotatedRecord!);
    const approved = await postCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${validToken}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acknowledge: true }),
      }),
      { params: Promise.resolve({ token: validToken }) },
    );
    expect(approved.status).toBe(200);
    await expect(getQuotationRecord(sentQuote.id)).resolves.toMatchObject({ customerApproval: expect.anything() });
  });

  it("rejects a wrong-company issuance revision for an existing quote number", async () => {
    const form = new FormData();
    form.set("pdf", new Blob([Buffer.from("%PDF-wrong-owner")], { type: "application/pdf" }), "wrong.pdf");
    form.set("payload", JSON.stringify(input("S7-AUTH-ACTION-001")));
    const response = await issueQuotation(request("http://localhost/api/quotations", {
      method: "POST",
      body: form,
    }, kaneiAdminToken));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
  });
});

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});
