// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-send-pdf-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@send-pdf.test";
process.env.ADMIN_PASSWORD = "admin-send-pdf-password";
process.env.ADMIN_NAME = "Send PDF Admin";
process.env.MAIL_RECIPIENT_OVERRIDE = "kim@kanei-trade.co.jp";
const designDataRoot = join(databaseDirectory, "design-data");
process.env.DESIGN_DATA_ROOT = designDataRoot;

const sendMailMock = vi.fn();
vi.mock("@/lib/mail-sender", () => ({
  isSmtpConfigured: () => true,
  sendMail: (...args: Parameters<typeof sendMailMock>) => sendMailMock(...args),
}));

const { POST: sendQuotation } = await import("@/app/api/quotations/[id]/send/route");
const { GET: getCustomerApproval, POST: postCustomerApproval } = await import("@/app/api/quotations/approvals/[token]/route");
const { createSession, createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const {
  approveQuotationGate,
  getDatabaseForTest,
  getQuotation,
  getQuotationPdf,
  saveQuotation,
  saveQuotationPdf,
} = await import("@/lib/quotation-store");
const { filmOrderExistsForQuotation } = await import("@/lib/film-orders");

const baseInput: QuotationRecordInput = {
  quotationNumber: "S7-SEND-PDF-001",
  status: "draft",
  issueDate: "2026-10-18",
  validUntil: "2026-11-18",
  customerName: "PDF Mail Customer",
  customerContact: "Customer Contact",
  productName: "PDF Mail Pouch",
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
  payload: {
    customerEmail: "customer@example.test",
    customerPostalCode: "100-0001",
    customerTelephone: "03-0000-0000",
    customerAddress: "Test Address",
  },
};

function context(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

let token: string;
let record: Awaited<ReturnType<typeof saveQuotation>>;
let owner: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  const designDirectory = join(designDataRoot, "RDA5090_1");
  await mkdir(designDirectory, { recursive: true });
  await writeFile(join(designDirectory, "RDA5090_1_7_C.ai"), "%AI-canonical-design");
  await writeFile(join(designDirectory, "RDA5090_1_7_C.pdf"), "%PDF-canonical-design");
  owner = await createUser({
    email: "owner@send-pdf.test",
    name: "PDF Mail Owner",
    password: "owner-send-pdf-password",
    role: "user",
  });
  token = (await createSession(owner.id)).token;
  record = await saveQuotation(baseInput, owner.id, "user");
  await saveQuotationPdf(record.id, Buffer.from("%PDF-canonical-quotation"), `${record.quotationNumber}.pdf`);
  await approveQuotationGate(record.id, "internal", owner.id);
});

function expectedPdfFileName() {
  return buildQuotationPdfFileName({
    issueDate: record.issueDate,
    productName: record.productName,
    customerName: record.customerName,
  });
}

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({
    messageId: "smtp-message-1",
    recipient: "kim@kanei-trade.co.jp",
    recipientOverridden: true,
  });
});

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation send API with canonical PDF attachment", () => {
  it("sends a formal attached quotation with a customer approval link and records customer approval", async () => {
    const storedPdf = await getQuotationPdf(record.id);
    expect(storedPdf).not.toBeNull();
    const response = await sendQuotation(
      new Request(`http://localhost/api/quotations/${record.id}/send`, {
        method: "POST",
        headers: { cookie: `pouch_session=${token}` },
      }),
      context(record.id),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.sentTo).toBe("kim@kanei-trade.co.jp");
    expect(payload.recipientOverridden).toBe(true);
    expect(payload.attachment).toEqual({
      fileName: expectedPdfFileName(),
      sizeBytes: storedPdf!.data.byteLength,
    });
    expect(payload.designAttachments.map((file: { fileName: string }) => file.fileName)).toEqual([
      "RDA5090_1_7_C.ai",
      "RDA5090_1_7_C.pdf",
    ]);
    expect(payload.approvalUrl).toMatch(/^http:\/\/localhost\/quote-approvals\/[\w.-]+$/u);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe("customer@example.test");
    expect(mail.subject).toContain(record.quotationNumber);
    expect(mail.body).toContain("いつも大変お世話になっております。パッケージラボでございます。");
    expect(mail.body).toContain("【お見積り概要】");
    expect(mail.body).toContain("【ご承認のお願い】");
    expect(mail.body).toContain(payload.approvalUrl);
    expect(mail.body).toContain("【入庫用データ（版下データ）】");
    expect(mail.body).toContain("アップロード用URLを別途ご案内");
    expect(mail.attachments).toHaveLength(3);
    expect(mail.attachments[0].filename).toBe(expectedPdfFileName());
    expect(mail.attachments[0].contentType).toBe("application/pdf");
    expect(mail.attachments[1].filename).toBe("RDA5090_1_7_C.ai");
    expect(mail.attachments[1].contentType).toBe("application/postscript");
    expect(mail.attachments[2].filename).toBe("RDA5090_1_7_C.pdf");
    expect(Buffer.from(mail.attachments[0].content)).toEqual(storedPdf!.data);
    await expect(getQuotation(record.id)).resolves.toMatchObject({ status: "sent" });

    const tokenValue = payload.approvalUrl.split("/").at(-1)!;
    const approvalView = await getCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${tokenValue}`),
      { params: Promise.resolve({ token: tokenValue }) },
    );
    expect(approvalView.status).toBe(200);
    await expect(approvalView.json()).resolves.toMatchObject({
      quotation: {
        quotationNumber: record.quotationNumber,
        status: "sent",
      },
    });

    const approval = await postCustomerApproval(
      new Request(`http://localhost/api/quotations/approvals/${tokenValue}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledge: true }),
      }),
      { params: Promise.resolve({ token: tokenValue }) },
    );
    expect(approval.status).toBe(200);
    const approvalPayload = await approval.json();
    expect(approvalPayload.quotation.status).toBe("sent");
    expect(approvalPayload.filmOrderSynced).toBe(false);
    await expect(getQuotation(record.id)).resolves.toMatchObject({
      status: "sent",
      customerApproval: { approvedAt: expect.any(String) },
    });
    await expect(filmOrderExistsForQuotation(record.id)).resolves.toBe(false);
  });

  it("does not send before Kim's internal approval", async () => {
    const owner = await createUser({
      email: "no-pdf@send-pdf.test",
      name: "No PDF Owner",
      password: "no-pdf-send-password",
      role: "user",
    });
    const noPdfRecord = await saveQuotation({
      ...baseInput,
      quotationNumber: "S7-SEND-PDF-002",
    }, owner.id, "user");
    const response = await sendQuotation(
      new Request(`http://localhost/api/quotations/${noPdfRecord.id}/send`, {
        method: "POST",
        headers: { cookie: `pouch_session=${token}` },
      }),
      context(noPdfRecord.id),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "internal_approval_required" });
    expect(sendMailMock).not.toHaveBeenCalled();
    await expect(getQuotation(noPdfRecord.id)).resolves.toMatchObject({ status: "draft" });
  });

  it("keeps the draft status when SMTP dispatch fails", async () => {
    const owner = await createUser({
      email: "smtp-failure@send-pdf.test",
      name: "SMTP Failure Owner",
      password: "smtp-failure-send-password",
      role: "user",
    });
    const smtpFailureRecord = await saveQuotation({
      ...baseInput,
      quotationNumber: "S7-SEND-PDF-004",
    }, owner.id, "user");
    await saveQuotationPdf(
      smtpFailureRecord.id,
      Buffer.from("%PDF-smtp-failure"),
      `${smtpFailureRecord.quotationNumber}.pdf`,
    );
    await approveQuotationGate(smtpFailureRecord.id, "internal", owner.id);
    sendMailMock.mockRejectedValueOnce(new Error("smtp_down"));
    const response = await sendQuotation(
      new Request(`http://localhost/api/quotations/${smtpFailureRecord.id}/send`, {
        method: "POST",
        headers: { cookie: `pouch_session=${token}` },
      }),
      context(smtpFailureRecord.id),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "send_failed" });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    await expect(getQuotation(smtpFailureRecord.id)).resolves.toMatchObject({ status: "draft" });
  });

  it("does not send when stored PDF integrity verification fails", async () => {
    const owner = await createUser({
      email: "integrity@send-pdf.test",
      name: "Integrity Owner",
      password: "integrity-send-password",
      role: "user",
    });
    const integrityRecord = await saveQuotation({
      ...baseInput,
      quotationNumber: "S7-SEND-PDF-003",
    }, owner.id, "user");
    await saveQuotationPdf(integrityRecord.id, Buffer.from("%PDF-integrity"), `${integrityRecord.quotationNumber}.pdf`);
    await approveQuotationGate(integrityRecord.id, "internal", owner.id);
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET pdf_sha256 = ? WHERE id = ?", ["damaged-digest", integrityRecord.id]);

    const response = await sendQuotation(
      new Request(`http://localhost/api/quotations/${integrityRecord.id}/send`, {
        method: "POST",
        headers: { cookie: `pouch_session=${token}` },
      }),
      context(integrityRecord.id),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "quotation_pdf_integrity_failed" });
    expect(sendMailMock).not.toHaveBeenCalled();
    await expect(getQuotation(integrityRecord.id)).resolves.toMatchObject({ status: "draft" });
  });
});
