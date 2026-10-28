// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-external-token-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@external-token.test";
process.env.ADMIN_PASSWORD = "admin-external-token-password";
process.env.ADMIN_NAME = "External Token Admin";
process.env.FILM_EXTERNAL_TOKEN_SECRET = "film-external-token-test-secret-32-bytes!";
process.env.MAIL_DRY_RUN = "true";

const { saveQuotation } = await import("@/lib/quotation-store");
const { ensureAdministratorSeed } = await import("@/lib/auth-store");
const {
  assertSupplierProofUploadPolicy,
  getFilmOrder,
  getFilmOrderForProofUpload,
  listFilmOrders,
  recordSupplierProofDownload,
  getFilmOrderForCustomerDesign,
  nextCustomerDesignFileName,
  registerCustomerDesignFromUploadToken,
  decideCustomerProofReview,
  getFilmOrderForCustomerProofReview,
  runFilmOrderAction,
  syncFilmOrdersFromQuotations,
} = await import("@/lib/film-orders");
const { getDatabaseForTest } = await import("@/lib/quotation-store");

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

const input: QuotationRecordInput = {
  quotationNumber: "S7-EXTERNAL-TOKEN-001",
  status: "approved",
  issueDate: "2026-10-18",
  validUntil: "2026-11-18",
  customerName: "外部トークン検証株式会社",
  customerContact: "担当",
  productName: "トークン検証パウチ",
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
  calculationVersion: "external-token-test",
  resultHash: "external-token-hash",
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
        name: "トークン検証",
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

function requestHeaders(ip = "203.0.113.8"): { headers: { get(name: string): string | null } } {
  return { headers: { get: (name) => name.toLowerCase() === "x-forwarded-for" ? ip : null } };
}

describe("film order external token hardening", () => {
  let orderId = 0;
  let supplierToken = "";

  beforeAll(async () => {
    const adminId = await ensureAdministratorSeed();
    await saveQuotation(input, adminId, "admin");
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const order = (await listFilmOrders("kanei@kanei-trade.co.jp")).find((item) => item.quotation_number === input.quotationNumber)!;
    orderId = order.id;
    await runFilmOrderAction(orderId, "mark-ordered", {}, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(orderId, "set-customer-design-not-required", { reason: "既存フロー回帰テスト" }, "seven@727.co.jp");
    const receiving = await runFilmOrderAction(orderId, "register-receiving", {
      aiFileName: "トークン検証パウチ.ai",
      guideAcknowledged: true,
      aiFileUrl: "https://drive.google.com/file/d/receivingfile1/view",
      note: "initial",
    }, "seven@727.co.jp");
    const noticeText = String(receiving.mails?.at(-1)?.text ?? "");
    supplierToken = noticeText.match(/\/film-orders\/upload\/([^\s"]+)/u)?.[1] ?? "";
    expect(supplierToken).not.toBe("");
  });

  it("stores only the token hash and clears the legacy plaintext token", async () => {
    const db = await getDatabaseForTest();
    const order = await getFilmOrder(orderId);
    expect(order?.proof_upload_token).toBeNull();
    const tokenRow = await db.get<{ token_hash: string; purpose: string; revoked_at: string | null }>(
      "SELECT token_hash,purpose,revoked_at FROM film_order_external_tokens WHERE film_order_id = ? AND purpose = 'supplier_proof' AND revoked_at IS NULL",
      [orderId],
    );
    expect(tokenRow?.purpose).toBe("supplier_proof");
    expect(tokenRow?.revoked_at).toBeNull();
    expect(tokenRow?.token_hash).toBe(createHash("sha256").update(supplierToken).digest("hex"));
    expect(tokenRow?.token_hash).not.toContain(supplierToken);
  });

  it("resolves a valid supplier token and rejects malformed tokens", async () => {
    await expect(getFilmOrderForProofUpload(supplierToken)).resolves.toMatchObject({ id: orderId });
    await expect(getFilmOrderForProofUpload("1.supplier_proof.999.bad")).rejects.toThrow("invalid_proof_token");
  });

  it("allows supplier download only for receiving files", async () => {
    const order = await getFilmOrder(orderId);
    expect(order!.files.some((file) => file.category === "receiving")).toBe(true);
    const allowed = await recordSupplierProofDownload({
      request: requestHeaders(),
      token: supplierToken,
      fileId: "receivingfile1",
      order: {
        ...order!,
        files: [
          { ...order!.files[0]!, category: "receiving", url: "https://drive.google.com/file/d/receivingfile1/view" },
          { ...order!.files[0]!, category: "proof", url: "https://drive.google.com/file/d/proofonlyfile1/view" },
        ],
      },
    });
    expect(allowed).toBe(true);

    const denied = await recordSupplierProofDownload({
      request: requestHeaders(),
      token: supplierToken,
      fileId: "proofonlyfile1",
      order: {
        ...order!,
        files: [
          { ...order!.files[0]!, category: "receiving", url: "https://drive.google.com/file/d/receivingfile1/view" },
          { ...order!.files[0]!, category: "proof", url: "https://drive.google.com/file/d/proofonlyfile1/view" },
        ],
      },
    });
    expect(denied).toBe(false);
    const refreshed = await getFilmOrder(orderId);
    expect(refreshed!.events.filter((event) => event.type === "token_access")).toHaveLength(2);
  });

  it("enforces supplier proof status, filename, type, and size policy", () => {
    const order = { id: orderId, status: "proof_registered", order_number: input.quotationNumber } as unknown as Parameters<typeof assertSupplierProofUploadPolicy>[0];
    expect(() => assertSupplierProofUploadPolicy(order, `${input.quotationNumber}_v2.ai`)).toThrow("invalid_status_transition");

    const ordered = { ...order, status: "receiving_registered" } as typeof order;
    expect(() => assertSupplierProofUploadPolicy(ordered, "wrong-order.ai")).toThrow("invalid_file_name");
    expect(() => assertSupplierProofUploadPolicy(ordered, `${input.quotationNumber}.exe`)).toThrow("unsupported_file_type");
    expect(() => assertSupplierProofUploadPolicy(ordered, `${input.quotationNumber}.ai`, 16 * 1024 * 1024)).toThrow("file_too_large");
    expect(() => assertSupplierProofUploadPolicy(ordered, `${input.quotationNumber}.pdf`, 15 * 1024 * 1024)).not.toThrow();
  });

  it("reuses the stable supplier token when a new notice is issued", async () => {
    const notice = await runFilmOrderAction(orderId, "send-proof-notice", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    const nextToken = String(notice.mails?.[0]?.text ?? "").match(/\/film-orders\/upload\/([^\s"]+)/u)?.[1] ?? "";
    expect(nextToken).not.toBe("");
    await expect(getFilmOrderForProofUpload(supplierToken)).resolves.toMatchObject({ id: orderId });
    await expect(getFilmOrderForProofUpload(nextToken)).resolves.toMatchObject({ id: orderId });
    expect(nextToken).toBe(supplierToken);
    supplierToken = nextToken;
  });
});

describe("customer design upload gate", () => {
  let designOrderId = 0;
  let designToken = "";

  it("requests, receives, corrects, receives again, and confirms customer design", async () => {
    const {
      approveQuotationGate,
    } = await import("@/lib/quotation-store");
    const { registerCustomerDesignFromUploadToken } = await import("@/lib/film-orders");
    const adminId = await ensureAdministratorSeed();
    const quotation = await saveQuotation({
      ...input,
      quotationNumber: "S7-EXTERNAL-TOKEN-002",
      payload: {
        ...input.payload,
        customerEmail: "design-customer@example.test",
        skuNames: ["充填物1", "充填物2", "充填物3"],
        skuQuantities: ["3334", "3333", "3333"],
        calculationChecklistSnapshot: {
          connectedChambers: 1,
          fillMlPerChamber: "1",
          totalFillMlPerPouch: "1",
          fillingMethod: "hopper",
          bulkUsageMl: "15000",
          bulkUnitPrice: "0",
          skus: [
            { name: "充填物1", quantity: "3334", fillMlPerChamber: "1", colorCount: "4" },
            { name: "充填物2", quantity: "3333", fillMlPerChamber: "1", colorCount: "4" },
            { name: "充填物3", quantity: "3333", fillMlPerChamber: "1", colorCount: "4" },
          ],
        },
      },
    }, adminId, "admin");
    void quotation;
    await syncFilmOrdersFromQuotations("kanei@kanei-trade.co.jp");
    const orders = await listFilmOrders("kanei@kanei-trade.co.jp");
    const order = orders.find((item) => item.quotation_number === "S7-EXTERNAL-TOKEN-002")!;
    designOrderId = order.id;
    await runFilmOrderAction(designOrderId, "mark-ordered", {}, "kanei@kanei-trade.co.jp");
    await expect(runFilmOrderAction(designOrderId, "register-receiving", { aiFileName: "early.ai" }, "seven@727.co.jp"))
      .rejects.toThrow("customer_design_confirmation_required");

    const requested = await runFilmOrderAction(designOrderId, "request-customer-design-upload", {
      note: "元デザインをご入稿ください",
      origin: "http://localhost:3000",
    }, "kanei@kanei-trade.co.jp");
    expect(requested.order.customerDesign.status).toBe("requested");
    expect(requested.mails?.[0]?.to).toBe("design-customer@example.test");
    expect(requested.mails?.[0]?.subject).toContain("デザイン原稿ご入稿のお願い");
    expect(requested.mails?.[0]?.text).toContain("【お見積製品仕様・ご確認用】");
    expect(requested.mails?.[0]?.text).toContain("パウチ仕様：50×90mm / 1連");
    expect(requested.mails?.[0]?.text).toContain("充填仕様：1ml/室 × 1室 ＝ 1ml/枚（ホッパ充填）");
    expect(requested.mails?.[0]?.text).toContain("バルク量：15,000g（貴社ご支給ください）");
    expect(requested.mails?.[0]?.text).toContain("・充填物1 ／ 3,334枚");
    expect(requested.mails?.[0]?.text).toContain("・充填物2 ／ 3,333枚");
    expect(requested.mails?.[0]?.text).toContain("・充填物3 ／ 3,333枚");
    const firstToken = requested.mails?.[0]?.text?.match(/\/film-orders\/design-upload\/([^\s"]+)/u)?.[1] ?? "";
    expect(firstToken).not.toBe("");

    const before = await getFilmOrderForCustomerDesign(firstToken);
    const firstFileName = nextCustomerDesignFileName(before!, "original design.ai");
    const uploaded = await registerCustomerDesignFromUploadToken({
      token: firstToken,
      fileName: firstFileName,
      fileUrl: "https://drive.google.com/file/d/customerdesign1/view",
      uploader: "design customer",
      note: "v1",
      guideAcknowledged: true,
      metadata: { fileSizeBytes: 1000, contentType: "application/postscript", driveFileId: "customerdesign1" },
    });
    expect(uploaded.customerDesign.status).toBe("received");
    expect(uploaded.files.filter((file) => file.category === "customer_design")).toHaveLength(1);
    expect(uploaded.files.at(-1)?.file_name).toContain("_design_v1_");

    const corrected = await runFilmOrderAction(designOrderId, "request-customer-design-correction", {
      reason: "内部確認: 解像度と抜き幅",
      customerMessage: "解像度と抜き幅を修正してください。",
      origin: "http://localhost:3000",
    }, "kanei@kanei-trade.co.jp");
    expect(corrected.order.customerDesign.status).toBe("correction_requested");
    expect(corrected.order.customerDesign.correctionCount).toBe(1);
    expect(corrected.mails?.[0]?.text).toContain("解像度と抜き幅を修正してください。");
    const secondToken = corrected.mails?.[0]?.text?.match(/\/film-orders\/design-upload\/([^\s"]+)/u)?.[1] ?? "";
    expect(secondToken).not.toBe(firstToken);

    const before2 = await getFilmOrderForCustomerDesign(secondToken);
    const secondFileName = nextCustomerDesignFileName(before2!, "original design fixed.pdf");
    const uploaded2 = await registerCustomerDesignFromUploadToken({
      token: secondToken,
      fileName: secondFileName,
      fileUrl: "https://drive.google.com/file/d/customerdesign2/view",
      guideAcknowledged: true,
      metadata: { fileSizeBytes: 1200, contentType: "application/pdf", driveFileId: "customerdesign2" },
    });
    expect(uploaded2.customerDesign.status).toBe("received");
    expect(uploaded2.files.filter((file) => file.category === "customer_design")).toHaveLength(2);
    expect(uploaded2.files.at(-1)?.file_name).toContain("_design_v2_");

    const confirmed = await runFilmOrderAction(designOrderId, "confirm-customer-design", {}, "kanei@kanei-trade.co.jp");
    expect(confirmed.order.customerDesign.status).toBe("confirmed");
    const receiving = await runFilmOrderAction(designOrderId, "register-receiving", {
      aiFileName: "confirmed.ai",
      guideAcknowledged: true,
      aiFileUrl: "https://drive.google.com/file/d/confirmedai/view",
    }, "seven@727.co.jp");
    expect(receiving.order.status).toBe("receiving_registered");

    const proof = await runFilmOrderAction(designOrderId, "register-proof", {
      aiFileName: `${designOrderId}_proof_v1.ai`,
      aiFileUrl: "https://drive.google.com/file/d/customerproof1/view",
      pdfFileName: `${designOrderId}_proof_v1.pdf`,
      pdfFileUrl: "https://drive.google.com/file/d/customerproofpdf1/view",
    }, "kanei@kanei-trade.co.jp");
    expect(proof.order.status).toBe("proof_registered");
    expect(proof.order.customerProof.status).toBe("pending");
    await expect(runFilmOrderAction(designOrderId, "approve", {}, "seven@727.co.jp"))
      .rejects.toThrow("customer_proof_release_required");

    const review = await runFilmOrderAction(designOrderId, "send-customer-proof-review", {
      origin: "http://localhost:3000",
    }, "kanei@kanei-trade.co.jp");
    expect(review.order.customerProof.status).toBe("requested");
    expect(review.mails?.[0]?.subject).toContain("校正ご確認のお願い");
    expect(review.mails?.[0]?.text).toContain("ロゴ・商品名・表記に誤字・脱字がないか");
    const reviewToken = review.mails?.[0]?.text?.match(/\/film-orders\/proof-review\/([^\s"]+)/u)?.[1] ?? "";
    expect(reviewToken).not.toBe("");
    const reviewPage = await getFilmOrderForCustomerProofReview(reviewToken);
    expect(reviewPage.files.filter((file) => file.category === "proof" && file.file_name.toLowerCase().endsWith(".pdf")).at(-1)?.version).toBe(2);

    const approvedReview = await decideCustomerProofReview({
      token: reviewToken,
      decision: "approve",
      request: requestHeaders("198.51.100.9"),
    });
    expect(approvedReview.customerProof.status).toBe("approved");
    expect(approvedReview.customerProof.supplierApprovalStatus).toBe("pending");
    const sellerApproved = await runFilmOrderAction(designOrderId, "record-customer-proof-approval", {
      approverName: "金井貿易責任者",
      evidence: "顧客レビュー結果確認",
    }, "kanei@kanei-trade.co.jp");
    expect(sellerApproved.order.customerProof.supplierApprovalStatus).toBe("approved");
    expect(sellerApproved.order.customerProof.supplierApprovalBy).toBe("kanei@kanei-trade.co.jp");
    const finalApproved = await runFilmOrderAction(designOrderId, "approve", { fileName: "final.pdf", fileUrl: "https://drive.google.com/file/d/finalproof/view" }, "seven@727.co.jp");
    expect(finalApproved.order.status).toBe("final_approved");
  });
});
