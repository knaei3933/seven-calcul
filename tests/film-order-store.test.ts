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
  listFilmOrders,
  runFilmOrderAction,
  syncFilmOrdersFromQuotations,
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
    expect(orders[0]!.supplier_email).toBe("arwg22@gmail.com");
    expect(orders[0]!.events.some((event) => event.type === "created")).toBe(true);
  });

  it("walks the full workflow with mails recorded in dry-run mode", async () => {
    const marked = await runFilmOrderAction(orderId, "mark-ordered", {}, "kanei@kanei-trade.co.jp");
    expect(marked.order.status).toBe("ordered");
    await expect(runFilmOrderAction(orderId, "register-proof", { fileName: "x" }, "kanei@kanei-trade.co.jp"))
      .rejects.toThrow("invalid_status_transition");

    await runFilmOrderAction(orderId, "set-supplier", { supplierName: "韓国メーカー", supplierEmail: "supplier@example.co.kr" }, "kanei@kanei-trade.co.jp");
    const receiving = await runFilmOrderAction(orderId, "register-receiving", { fileName: "入荷データ.pdf", fileUrl: "https://drive.google.com/file/d/xxx/view", note: "1回目" }, "seven@727.co.jp");
    expect(receiving.order.status).toBe("receiving_registered");
    expect(receiving.mails?.map((mail) => mail.to)).toEqual(["design@package-lab.com", "supplier@example.co.kr"]);
    expect(receiving.mails?.every((mail) => mail.dryRun)).toBe(true);
    expect(receiving.order.files).toHaveLength(1);
    expect(receiving.order.files[0]!.url).toBe("https://drive.google.com/file/d/xxx/view");
    await expect(runFilmOrderAction(orderId, "register-proof", { fileName: "bad.ai", fileUrl: "ftp://example.com/a.ai" }, "kanei@kanei-trade.co.jp"))
      .rejects.toThrow("invalid_file_url");

    const notice = await runFilmOrderAction(orderId, "send-proof-notice", {}, "kanei@kanei-trade.co.jp");
    expect(notice.mails?.[0]?.to).toBe("supplier@example.co.kr");

    const proof1 = await runFilmOrderAction(orderId, "register-proof", { fileName: "校正データ_v1.ai", fileUrl: "https://drive.google.com/file/d/proof1/view" }, "kanei@kanei-trade.co.jp");
    expect(proof1.order.status).toBe("proof_registered");
    expect(proof1.order.files.find((file) => file.category === "proof")?.version).toBe(1);
    expect(proof1.order.files.find((file) => file.category === "proof")?.url).toContain("proof1");

    const reProof = await runFilmOrderAction(orderId, "request-re-proof", { comment: "ロゴ位置を修正" }, "seven@727.co.jp");
    expect(reProof.order.status).toBe("re_proof_requested");
    expect(reProof.order.re_proof_count).toBe(1);

    const proof2 = await runFilmOrderAction(orderId, "register-proof", { fileName: "校正データ_v2.ai" }, "kanei@kanei-trade.co.jp");
    expect(proof2.order.status).toBe("proof_registered");
    expect(proof2.order.files.filter((file) => file.category === "proof")).toHaveLength(2);

    const approved = await runFilmOrderAction(orderId, "approve", { fileName: "最終承認データ.pdf" }, "seven@727.co.jp");
    expect(approved.order.status).toBe("final_approved");
    expect(approved.order.files.find((file) => file.category === "final")).toBeDefined();
    expect(approved.mails?.every((mail) => mail.dryRun)).toBe(true);

    const final = await getFilmOrder(orderId);
    expect(final?.events.filter((event) => event.type === "email").length).toBeGreaterThanOrEqual(6);
  });

  it("builds human-readable file names containing the order number", () => {
    const order = { product_name: "あかちゃんバーム 50ml", order_number: "F-202610-001" };
    expect(buildFilmOrderFileName(order, "receiving", 1)).toMatch(/^あかちゃんバーム_50ml_F-202610-001_入荷_\d{8}$/u);
    expect(buildFilmOrderFileName(order, "proof", 2)).toMatch(/_校正_\d{8}_v2$/u);
    expect(buildFilmOrderFileName({ product_name: "a/b\\c:d", order_number: "F-1" }, "final", 1)).not.toMatch(/[\\/]/u);
  });
});
