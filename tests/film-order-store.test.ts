import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-order-store-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-store-password";
process.env.ADMIN_NAME = "Seven Store";

const { saveQuotation } = await import("@/lib/quotation-store");
const { ensureAdministratorSeed } = await import("@/lib/auth-store");
const {
  buildFilmOrderFileName,
  getFilmOrder,
  getFilmOrderForEta,
  getFilmOrderForProofUpload,
  registerProofFromUploadToken,
  listFilmOrders,
  runFilmOrderAction,
  syncFilmOrdersFromQuotations,
  updateEtaFromToken,
} = await import("@/lib/film-orders");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

const purchaseOrder = {
  printingMethod: "gravure",
  pouchQuantity: "50000",
  filmComposition: "PET12+AL7+PET12+LLDPE50",
  requiredLengthM: "1333.34",
  orderLengthM: "1700",
  effectiveLengthM: "1360",
  lossM: "340",
  lossRate: "0.2",
  webWidthMm: 476,
  webWidthsMm: [476],
  lanes: 4,
  pitchMm: "96",
  prodMultiplier: 1,
  colorCount: 4,
  skuColorCounts: ["4"],
  skuOrderDetails: [{
    skuCode: "SKU-1", name: "テスト充填物", quantity: "50000", colorCount: "4",
    requiredLengthM: "1333.34", orderLengthM: "1700", webWidthMm: 476, multiplier: 1,
  }],
  procurementRoute: "Y" as const,
};

const input: QuotationRecordInput = {
  quotationNumber: "S7-FILM-STORE-001",
  status: "approved",
  issueDate: "2026-10-08",
  validUntil: "2026-11-08",
  customerName: "フィルム発注検証株式会社",
  customerContact: "担当",
  productName: "発注検証パウチ",
  sizeSummary: "60×80mm / 2連",
  quantity: "50000",
  fillingCostPerPiece: "4",
  filmCostPerPiece: "5",
  filmMeterPrice: "180",
  filmOrderLengthM: "1700",
  targetMargin: "0.3",
  taxRatePercent: "10",
  pricePerPiece: "20",
  subtotal: "1000000",
  tax: "100000",
  grandTotal: "1100000",
  deliveryDate: "",
  paymentTerms: "",
  notes: "",
  calculationVersion: "film-order-test",
  resultHash: "hash",
  payload: { purchaseOrder },
};

describe("film order store", () => {
  let orderId = 0;

  beforeAll(async () => {
    const adminId = await ensureAdministratorSeed();
    const record = await saveQuotation(input, adminId, "admin");
    orderId = record.id;
  });

  it("imports approved quotations once and numbers them per month", async () => {
    expect(await syncFilmOrdersFromQuotations("seven@727.co.jp")).toBe(1);
    expect(await syncFilmOrdersFromQuotations("seven@727.co.jp")).toBe(0);
    const orders = await listFilmOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("pending");
    expect(orders[0]!.order_number).toMatch(/^F-\d{6}-001$/u);
    expect(orders[0]!.purchaseOrder?.procurementRoute).toBe("Y");
    expect(orders[0]!.supplier_email).toBe("");
    expect(orders[0]!.seven_contact_email).toBe("seven@727.co.jp");
    expect(orders[0]!.events.some((event) => event.type === "created")).toBe(true);
  });

  it("walks the full workflow with mails recorded in dry-run mode", async () => {
    const marked = await runFilmOrderAction(orderId, "mark-ordered", {}, "kanei@kanei-trade.co.jp");
    expect(marked.order.status).toBe("ordered");
    await expect(runFilmOrderAction(orderId, "register-proof", { fileName: "x" }, "kanei@kanei-trade.co.jp"))
      .rejects.toThrow("invalid_status_transition");

    await runFilmOrderAction(orderId, "set-supplier", { supplierName: "韓国メーカー", supplierEmail: "supplier@example.co.kr" }, "kanei@kanei-trade.co.jp");
    const receiving = await runFilmOrderAction(orderId, "register-receiving", {
      aiFileName: "発注検証パウチ.ai",
      aiFileUrl: "https://drive.google.com/file/d/ai/view",
      pdfFileName: "発注検証パウチ.pdf",
      pdfFileUrl: "https://drive.google.com/file/d/pdf/view",
      note: "1回目",
    }, "seven@727.co.jp");
    expect(receiving.order.status).toBe("receiving_registered");
    expect(receiving.mails?.map((mail) => mail.to)).toEqual(["design@package-lab.com", "supplier@example.co.kr"]);
    expect(receiving.mails?.every((mail) => mail.dryRun)).toBe(true);
    expect(receiving.order.files).toHaveLength(2);
    expect(receiving.order.files[0]!.url).toBe("https://drive.google.com/file/d/ai/view");
    expect(receiving.order.files[1]!.file_name).toBe("発注検証パウチ.pdf");
    await expect(runFilmOrderAction(orderId, "register-proof", { fileName: "bad.ai", fileUrl: "ftp://example.com/a.ai" }, "kanei@kanei-trade.co.jp"))
      .rejects.toThrow("invalid_file_url");
    await expect(runFilmOrderAction(orderId, "register-receiving", { aiFileName: "再度.ai" }, "seven@727.co.jp"))
      .rejects.toThrow("invalid_status_transition");

    const notice = await runFilmOrderAction(orderId, "send-proof-notice", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    expect(notice.mails?.[0]?.to).toBe("supplier@example.co.kr");

    const receivingOrder = await getFilmOrder(orderId);
    expect(receivingOrder?.proof_upload_token).toBeTruthy();
    const supplierUpload = await registerProofFromUploadToken({
      token: receivingOrder!.proof_upload_token!,
      fileName: `発注検証パウチ_${receivingOrder!.order_number}_校正_20261008.ai`,
      fileUrl: "https://drive.google.com/file/d/supplier1/view",
      uploader: "韓国メーカー担当",
    });
    expect(supplierUpload.status).toBe("proof_registered");
    expect(supplierUpload.files.some((file) => file.file_name.includes("韓国") === false && file.file_name.includes(orderNumberSafe(supplierUpload)))).toBe(true);
    await expect(registerProofFromUploadToken({
      token: receivingOrder!.proof_upload_token!,
      fileName: `x_${receivingOrder!.order_number}.ai`,
      fileUrl: "https://drive.google.com/file/d/supplier2/view",
    })).rejects.toThrow("invalid_status_transition");
    await expect(getFilmOrderForProofUpload("1.123.bad")).rejects.toThrow("invalid_proof_token");

    await runFilmOrderAction(orderId, "request-re-proof", { comment: "メーカー初回分の再校正" }, "seven@727.co.jp");
    const proof1 = await runFilmOrderAction(orderId, "register-proof", { fileName: "校正データ_v2.ai", fileUrl: "https://drive.google.com/file/d/proof1/view" }, "kanei@kanei-trade.co.jp");
    expect(proof1.order.status).toBe("proof_registered");
    expect(proof1.order.files.find((file) => file.category === "proof")?.version).toBe(1);
    expect(proof1.order.files.filter((file) => file.category === "proof").map((file) => file.url)).toContain("https://drive.google.com/file/d/proof1/view");

    const reProof = await runFilmOrderAction(orderId, "request-re-proof", { comment: "ロゴ位置を修正" }, "seven@727.co.jp");
    expect(reProof.order.status).toBe("re_proof_requested");
    expect(reProof.order.re_proof_count).toBe(2);

    const proof2 = await runFilmOrderAction(orderId, "register-proof", { fileName: "校正データ_v3.ai" }, "kanei@kanei-trade.co.jp");
    expect(proof2.order.status).toBe("proof_registered");
    expect(proof2.order.files.filter((file) => file.category === "proof")).toHaveLength(3);

    const approved = await runFilmOrderAction(orderId, "approve", { fileName: "最終承認データ.pdf" }, "seven@727.co.jp");
    expect(approved.order.status).toBe("final_approved");
    expect(approved.order.files.find((file) => file.category === "final")).toBeDefined();
    expect(approved.mails?.every((mail) => mail.dryRun)).toBe(true);

    const final = await getFilmOrder(orderId);
    expect(final?.events.filter((event) => event.type === "email").length).toBeGreaterThanOrEqual(6);

    const po = await runFilmOrderAction(orderId, "send-po", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    expect(po.order.po_sent_at).toBeTruthy();
    expect(po.order.eta_token).toBeTruthy();
    expect(po.mails?.map((mail) => mail.to)).toContain("supplier@example.co.kr");

    const etaToken = po.order.eta_token!;
    const etaView = await getFilmOrderForEta(etaToken);
    expect(etaView?.quotation_number).toBe("S7-FILM-STORE-001");
    const updatedEta = await updateEtaFromToken(etaToken, "2026-10-31", "銅版込み");
    expect(updatedEta?.eta_date).toBe("2026-10-31");
    expect(updatedEta?.eta_note).toBe("銅版込み");
    await expect(updateEtaFromToken(etaToken, "2026/10/31", "")).rejects.toThrow("invalid_eta_date");
    await expect(updateEtaFromToken("1.123.bad", "2026-10-31", "")).rejects.toThrow("invalid_eta_token");
    const afterEta = await getFilmOrder(orderId);
    expect(afterEta?.events.some((event) => event.type === "eta")).toBe(true);
    expect(final?.events.filter((event) => event.type === "email").length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("routes proof requests by procurement route and skips unconfigured Y suppliers", async () => {
    delete process.env.FILM_SUPPLIER_B_EMAIL;
    const kQuotation = await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-STORE-002",
      status: "approved",
      payload: { purchaseOrder: { ...purchaseOrder, procurementRoute: "K" as const } },
    }, 1, "admin");
    const yQuotation = await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-STORE-003",
      status: "approved",
      payload: { purchaseOrder: { ...purchaseOrder, procurementRoute: "Y" as const } },
    }, 1, "admin");
    void kQuotation; void yQuotation;
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders();
    const kOrder = orders.find((order) => order.quotation_number === "S7-FILM-STORE-002")!;
    const yOrder = orders.find((order) => order.quotation_number === "S7-FILM-STORE-003")!;
    await runFilmOrderAction(kOrder.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(yOrder.id, "mark-ordered", {}, "seven@727.co.jp");

    const kResult = await runFilmOrderAction(kOrder.id, "register-receiving", { aiFileName: "K用.ai" }, "seven@727.co.jp");
    expect(kResult.mails?.map((mail) => mail.to)).toContain("arwg22@gmail.com");

    const yResult = await runFilmOrderAction(yOrder.id, "register-receiving", { aiFileName: "Y用.ai" }, "seven@727.co.jp");
    expect(yResult.mails?.map((mail) => mail.to)).toEqual(["design@package-lab.com"]);
    expect((await getFilmOrder(yOrder.id))?.events.some((event) => event.detail.includes("校正データ返却のお願い"))).toBe(false);
  });

  it("builds human-readable file names containing the order number", () => {
    const order = { product_name: "あかちゃんバーム 50ml", order_number: "F-202610-001" };
    expect(buildFilmOrderFileName(order, "receiving", 1)).toMatch(/^あかちゃんバーム_50ml_F-202610-001_入稿_\d{8}$/u);
    expect(buildFilmOrderFileName(order, "proof", 2)).toMatch(/_校正_\d{8}_v2$/u);
    expect(buildFilmOrderFileName({ product_name: "a/b\\c:d", order_number: "F-1" }, "final", 1)).not.toMatch(/[\\/]/u);
  });
});

function orderNumberSafe(order: { order_number: string }): string {
  return order.order_number;
}
