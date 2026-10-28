import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-sample-bulk-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
const { ensureAdministratorSeed } = await import("@/lib/auth-store");
const { saveQuotation } = await import("@/lib/quotation-store");
const {
  approveQuotationGate,
  getQuotation,
  SampleBulkConfirmationRequiredError,
  updateQuotationSampleBulkConfirmation,
} = await import("@/lib/quotation-store");

const actorId = await ensureAdministratorSeed();

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation sample bulk gate", () => {
  it("requires sample bulk receipt and confirmation before internal approval", async () => {
    const input: QuotationRecordInput = {
      quotationNumber: "S7-SAMPLE-BULK-001",
      status: "draft",
      issueDate: "2026-10-23",
      validUntil: "2026-11-23",
      customerName: "Sample Bulk Test",
      customerContact: "",
      productName: "Sample Pouch",
      sizeSummary: "50×60mm / 1連",
      quantity: "10000",
      fillingCostPerPiece: "1",
      filmCostPerPiece: "1",
      filmMeterPrice: "100",
      filmOrderLengthM: "100",
      targetMargin: "0.4",
      taxRatePercent: "10",
      pricePerPiece: "5",
      subtotal: "50000",
      tax: "5000",
      grandTotal: "55000",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: "sample-bulk-test",
      resultHash: "sample-bulk-hash",
      payload: {
        sampleBulkRequired: true,
        sampleBulkConfirmation: { required: true, status: "pending" },
      },
    };
    const record = await saveQuotation(input, actorId);
    await expect(approveQuotationGate(record.id, "internal", actorId))
      .resolves.toMatchObject({ status: "draft", internalApproval: expect.anything() });

    await expect(updateQuotationSampleBulkConfirmation(record.id, "record-received", {}, actorId))
      .rejects.toThrow("sample_bulk_quantity_required");
    await updateQuotationSampleBulkConfirmation(record.id, "record-received", {
      receivedMl: "5000",
      note: "受領完了",
    }, actorId);
    const confirmed = await updateQuotationSampleBulkConfirmation(record.id, "confirm", {
      note: "充填条件へ反映済み",
    }, actorId);
    expect(confirmed.payload.sampleBulkConfirmation).toMatchObject({
      required: true,
      status: "confirmed",
      receivedMl: "5000",
    });
    await expect(approveQuotationGate(record.id, "internal", actorId)).rejects.toThrow("invalid_approval_transition");
    const persisted = await getQuotation(record.id);
    expect(persisted?.payload.sampleBulkConfirmation).toMatchObject({ status: "confirmed" });
  });
});
