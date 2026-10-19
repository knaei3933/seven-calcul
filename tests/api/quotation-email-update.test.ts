// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-email-update-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@email-update.test";
process.env.ADMIN_PASSWORD = "admin-email-update-password";
process.env.ADMIN_NAME = "Email Update Admin";

const { PATCH: patchQuotation } = await import("@/app/api/quotations/[id]/route");
const { createSession, createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const {
  approveQuotationGate,
  getQuotation,
  getQuotationPdf,
  saveQuotation,
  saveQuotationPdf,
  updateQuotationStatus,
} = await import("@/lib/quotation-store");

const baseInput: QuotationRecordInput = {
  quotationNumber: "S7-EMAIL-UPDATE-001",
  status: "draft",
  issueDate: "2026-10-19",
  validUntil: "2026-11-19",
  customerName: "Legacy Email Customer",
  customerContact: "Legacy Contact",
  productName: "Legacy Email Pouch",
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
    customerPostalCode: "100-0001",
    customerTelephone: "03-0000-0000",
    customerAddress: "Legacy Address",
  },
};

function request(id: number, body: unknown, token: string): Request {
  return new Request(`http://localhost/api/quotations/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: `pouch_session=${token}` },
    body: JSON.stringify(body),
  });
}

function context(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("issued quotation customer email correction", () => {
  it("corrects a missing or stale address on draft and sent quotations without changing the PDF", async () => {
    const owner = await createUser({
      email: "owner@email-update.test",
      name: "Email Update Owner",
      password: "owner-email-update-password",
      role: "user",
    });
    const token = (await createSession(owner.id)).token;
    const record = await saveQuotation(baseInput, owner.id, "user");
    const idContext = context(record.id);

    const draftResponse = await patchQuotation(
      request(record.id, { customerEmail: "Legacy.Customer@Example.test" }, token),
      idContext,
    );
    expect(draftResponse.status).toBe(200);
    const draftUpdated = (await draftResponse.json()).record;
    expect(draftUpdated.payload.customerEmail).toBe("legacy.customer@example.test");

    await saveQuotationPdf(record.id, Buffer.from("%PDF-legacy-email-quotation"), `${record.quotationNumber}.pdf`);
    const pdfBefore = await getQuotationPdf(record.id);
    await approveQuotationGate(record.id, "internal", owner.id);
    await updateQuotationStatus(record.id, "sent", owner.id);

    const sentResponse = await patchQuotation(
      request(record.id, { customerEmail: "corrected@example.test" }, token),
      idContext,
    );
    expect(sentResponse.status).toBe(200);
    const sentUpdated = (await sentResponse.json()).record;
    expect(sentUpdated.payload.customerEmail).toBe("corrected@example.test");
    expect(sentUpdated.payload.customerAddress).toBe("Legacy Address");

    const pdfAfter = await getQuotationPdf(record.id);
    expect(pdfBefore).not.toBeNull();
    expect(pdfAfter).not.toBeNull();
    expect(pdfAfter!.data.equals(pdfBefore!.data)).toBe(true);
    expect(pdfAfter!.fileName).toBe(pdfBefore!.fileName);

    const invalid = await patchQuotation(request(record.id, { customerEmail: "invalid" }, token), idContext);
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_customer_email" });

    await updateQuotationStatus(record.id, "approved", owner.id);
    const approved = await patchQuotation(
      request(record.id, { customerEmail: "late@example.test" }, token),
      idContext,
    );
    expect(approved.status).toBe(409);
    await expect(approved.json()).resolves.toEqual({ error: "customer_email_update_not_allowed" });
    const unchanged = await getQuotation(record.id);
    expect(unchanged?.payload.customerEmail).toBe("corrected@example.test");
  });
});
