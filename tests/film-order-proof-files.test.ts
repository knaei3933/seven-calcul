import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-order-proof-files-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "proof-files-password";
process.env.ADMIN_NAME = "Proof Files Test";

const { saveQuotation } = await import("@/lib/quotation-store");
const { ensureAdministratorSeed } = await import("@/lib/auth-store");
const { getFilmOrder, listFilmOrders, registerProofFromUploadToken, runFilmOrderAction, syncFilmOrdersFromQuotations } = await import("@/lib/film-orders");

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

const input: QuotationRecordInput = {
  quotationNumber: "S7-PROOF-FILES-001",
  status: "approved",
  issueDate: "2026-10-19",
  validUntil: "2026-11-19",
  customerName: "校正ファイル検証株式会社",
  customerContact: "担当",
  productName: "校正ペア検証パウチ",
  sizeSummary: "50×90mm / 1連",
  quantity: "10000",
  fillingCostPerPiece: "4",
  filmCostPerPiece: "5",
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
  calculationVersion: "proof-files-test",
  resultHash: "proof-files-hash",
  payload: {
    purchaseOrder: {
      printingMethod: "digital",
      pouchQuantity: "10000",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      requiredLengthM: "100",
      orderLengthM: "500",
      webWidthMm: 476,
      lanes: 4,
      pitchMm: "96",
      prodMultiplier: 1,
      colorCount: 4,
      skuColorCounts: ["4"],
      skuOrderDetails: [{
        skuCode: "SKU-1",
        name: "校正ペア検証",
        quantity: "10000",
        colorCount: "4",
        requiredLengthM: "100",
        orderLengthM: "500",
        webWidthMm: 476,
        multiplier: 1,
      }],
    },
  },
};

describe("film proof AI/PDF registration", () => {
  let orderId = 0;

  beforeAll(async () => {
    await ensureAdministratorSeed();
    await saveQuotation(input, 1, "admin");
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const order = orders.find((item) => item.quotation_number === input.quotationNumber)!;
    orderId = order.id;
    await runFilmOrderAction(orderId, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(orderId, "set-customer-design-not-required", { reason: "AI+PDF regression" }, "seven@727.co.jp");
    await runFilmOrderAction(orderId, "register-receiving", {
      aiFileName: "入稿.ai",
      guideAcknowledged: true,
      aiFileUrl: "https://drive.google.com/file/d/receivingai/view",
    }, "seven@727.co.jp");
  });

  it("registers optional PDF together with required AI proof", async () => {
    const notice = await runFilmOrderAction(orderId, "send-proof-notice", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    const token = String(notice.mails?.[0]?.text ?? "").match(/\/film-orders\/upload\/([^\s"]+)/u)?.[1] ?? "";
    expect(token).not.toBe("");
    const before = await getFilmOrder(orderId);
    const orderNumber = before!.order_number;

    const uploaded = await registerProofFromUploadToken({
      token,
      fileName: `${orderNumber}_proof.ai`,
      fileUrl: "https://drive.google.com/file/d/proofai/view",
      pdfFileName: `${orderNumber}_proof.pdf`,
      pdfFileUrl: "https://drive.google.com/file/d/proofpdf/view",
    });
    expect(uploaded.status).toBe("proof_registered");
    const proofs = uploaded.files.filter((file) => file.category === "proof");
    expect(proofs.map((file) => file.file_name)).toEqual([`${orderNumber}_proof.ai`, `${orderNumber}_proof.pdf`]);
    expect(proofs.map((file) => file.url)).toContain("https://drive.google.com/file/d/proofpdf/view");
  });

  it("registers optional PDF with internal proof registration", async () => {
    await runFilmOrderAction(orderId, "request-re-proof", { comment: "AI+PDF内部登録", supplierMessage: "교정본을 수정해서 다시 제출해 주십시오." }, "seven@727.co.jp");
    const registered = await runFilmOrderAction(orderId, "register-proof", {
      aiFileName: "proof_v2.ai",
      aiFileUrl: "https://drive.google.com/file/d/internalai/view",
      pdfFileName: "proof_v2.pdf",
      pdfFileUrl: "https://drive.google.com/file/d/internalpdf/view",
    }, "kanei@kanei-trade.co.jp");
    const proofs = registered.order.files.filter((file) => file.category === "proof");
    expect(proofs.map((file) => file.file_name)).toContain("proof_v2.ai");
    expect(proofs.map((file) => file.file_name)).toContain("proof_v2.pdf");
  });
});
