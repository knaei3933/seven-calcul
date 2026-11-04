import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-order-store-test-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-store-password";
process.env.ADMIN_NAME = "Seven Store";
process.env.FILM_DELIVERY_DOCUMENT_FOLDER_ID = "delivery-folder-test";
process.env.KANEI_APPROVAL_NOTICE_EMAIL = "kanei-approvals@example.test";

const driveMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  findFiles: vi.fn(),
  getConfirmedUpload: vi.fn(),
}));

vi.mock("@/lib/google-drive", () => ({
  customerDesignFolderId: () => "customer-design-folder",
  deliveryDocumentFolderId: () => "delivery-folder-test",
  receivingFolderId: () => "receiving-folder",
  proofFolderId: () => "proof-folder",
  driveConfigured: () => true,
  findDriveFiles: driveMocks.findFiles,
  createResumableSession: driveMocks.createSession,
  browserOriginOf: () => "http://localhost:3000",
  getConfirmedDriveUpload: driveMocks.getConfirmedUpload,
}));

const { saveQuotation } = await import("@/lib/quotation-store");
const { saveCustomer, listDeliveryDestinations } = await import("@/lib/customer-store");
const { canPerformFilmOrderAction } = await import("@/lib/film-order-access");
const { createFilmMaker, deactivateFilmMaker, selectFilmMakerForOrder } = await import("@/lib/film-maker-store");
const { POST: deliveryUpload } = await import("@/app/api/film-orders/delivery-upload/[token]/route");
const { POST: etaPost } = await import("@/app/api/film-orders/eta/[token]/route");
const { createUser, ensureAdministratorSeed } = await import("@/lib/auth-store");
const {
  buildFilmOrderFileName,
  getFilmOrder,
  getFilmOrderForShipToRequest,
  getFilmOrderForSupplierPurchaseOrder,
  getFilmOrderForEta,
  getFilmOrderForProofUpload,
  registerProofFromUploadToken,
  registerShipToFromCustomerToken,
  listFilmOrders,
  listFilmOrderSummaries,
  runFilmOrderAction,
  syncFilmOrdersFromQuotations,
  updateFilmDeliveryFromToken,
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
  payload: { customerCode: "FILM-CUSTOMER-001", customerEmail: "film-customer@example.test", purchaseOrder },
};

describe("film order store", () => {
  let orderId = 0;

beforeAll(async () => {
  const adminId = await ensureAdministratorSeed();
  await saveCustomer("seven", {
    customerCode: "FILM-CUSTOMER-001",
    customerName: "フィルム発注検証株式会社",
    customerPostalCode: "650-0001",
    customerAddress: "兵庫県神戸市テスト1-2-3",
    customerContact: "担当",
    customerTelephone: "078-000-0000",
    customerEmail: "film-customer@example.test",
  });
  const record = await saveQuotation(input, adminId, "admin");
    orderId = record.id;
  });

  it("imports approved quotations once and numbers them per month", async () => {
    expect(await syncFilmOrdersFromQuotations("seven@727.co.jp")).toBe(1);
    expect(await syncFilmOrdersFromQuotations("seven@727.co.jp")).toBe(0);
    const orders = await listFilmOrders("seven@727.co.jp");
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("pending");
    expect(orders[0]!.order_number).toMatch(/^F-\d{6}-001$/u);
    expect(orders[0]!.purchaseOrder?.procurementRoute).toBe("Y");
    expect(orders[0]!.supplier_email).toBe("");
    expect(orders[0]!.seven_contact_email).toBe("seven@727.co.jp");
    expect(orders[0]!.events.some((event) => event.type === "created")).toBe(true);
  });

  it("creates a Seven-owned film order even for a Kanei sales-channel quotation", async () => {
    const kaneiUser = await createUser({
      email: "sales-kanei-store@example.kanei-trade.co.jp",
      name: "Kanei Sales Channel",
      password: "kanei-store-password",
      role: "user",
    });
    await saveQuotation({
      ...input,
      quotationNumber: "KT-FILM-CHANNEL-001",
      status: "approved",
    }, kaneiUser.id, "user");
    expect(await syncFilmOrdersFromQuotations("kanei@kanei-trade.co.jp")).toBe(1);

    const sevenView = await listFilmOrders("seven@727.co.jp");
    const kaneiView = await listFilmOrders("kanei@kanei-trade.co.jp");
    const sevenSummaries = await listFilmOrderSummaries("gotou@727.co.jp");
    const kaneiSummaries = await listFilmOrderSummaries("kim@kanei-trade.co.jp");
    const order = sevenView.find((item) => item.quotation_number === "KT-FILM-CHANNEL-001")!;
    expect(order.buyer_domain).toBe("727.co.jp");
    expect(order.created_by_email).toBe("sales-kanei-store@example.kanei-trade.co.jp");
    expect(order.seven_contact_email).toBe("gotou@727.co.jp");
    expect(sevenView.some((item) => item.id === order.id)).toBe(true);
    expect(kaneiView.some((item) => item.id === order.id)).toBe(true);
    expect(sevenSummaries.some((item) => item.id === order.id)).toBe(true);
    expect(kaneiSummaries.some((item) => item.id === order.id)).toBe(true);
  });

  it("walks the full workflow with mails recorded in dry-run mode", async () => {
    const marked = await runFilmOrderAction(orderId, "mark-ordered", {}, "kanei@kanei-trade.co.jp");
    expect(marked.order.status).toBe("ordered");
    await runFilmOrderAction(orderId, "set-customer-design-not-required", { reason: "既存フロー回帰テスト" }, "seven@727.co.jp");
    await expect(runFilmOrderAction(orderId, "register-proof", { fileName: "x" }, "kanei@kanei-trade.co.jp"))
      .rejects.toThrow("invalid_status_transition");

    const { createFilmMaker, selectFilmMakerForOrder } = await import("./../src/lib/film-maker-store");
    const workflowMaker = await createFilmMaker({
      makerCode: "STORE-KOR-FULL-001",
      companyName: "Store Korean Maker",
      email: "supplier@example.co.kr",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "kanei@kanei-trade.co.jp");
    const storeDb = await (await import("@/lib/db")).getSqlClient("quotations");
    await storeDb.run("UPDATE film_orders SET procurement_route='K' WHERE id=?", [orderId]);
    await selectFilmMakerForOrder(orderId, workflowMaker.id, "kanei@kanei-trade.co.jp");
    const receiving = await runFilmOrderAction(orderId, "register-receiving", {
      aiFileName: "発注検証パウチ.ai",
      guideAcknowledged: true,
      aiFileUrl: "https://drive.google.com/file/d/ai/view",
      pdfFileName: "発注検証パウチ.pdf",
      pdfFileUrl: "https://drive.google.com/file/d/pdf/view",
      note: "1回目",
    }, "seven@727.co.jp");
    expect(receiving.order.status).toBe("receiving_registered");
    expect(receiving.mails?.map((mail) => mail.to)).toEqual(["supplier@example.co.kr", "seven@727.co.jp", "design@package-lab.com"]);
    const makerNotice = receiving.mails?.[0];
    expect(makerNotice?.subject).toContain("제작 데이터 수령 요청");
    expect(makerNotice?.text).toContain("발주 번호");
    expect(makerNotice?.text).toContain("/film-orders/upload/");
    expect(makerNotice?.text).not.toContain("/api/film-orders/proof-download/");
    expect(receiving.mails?.at(-1)?.text).not.toContain("https://drive.google.com/file/d/");
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
    expect(notice.mails?.[0]?.subject).toContain("교정 데이터 제출 요청");

    const proofNoticeText = String(notice.mails?.[0]?.text ?? "");
    const supplierToken = proofNoticeText.match(/\/film-orders\/upload\/([^\s"]+)/u)?.[1];
    expect(supplierToken).toBeTruthy();
    const receivingOrder = await getFilmOrder(orderId);
    expect(receivingOrder?.proof_upload_token).toBeNull();
    const supplierUpload = await registerProofFromUploadToken({
      token: supplierToken!,
      fileName: `発注検証パウチ_${receivingOrder!.order_number}_校正_20261008.ai`,
      fileUrl: "https://drive.google.com/file/d/supplier1/view",
      pdfFileName: `発注検証パウチ_${receivingOrder!.order_number}_校正_20261008.pdf`,
      pdfFileUrl: "https://drive.google.com/file/d/supplierpdf1/view",
      uploader: "韓国メーカー担当",
      origin: "http://localhost:3000",
    });
    expect(supplierUpload.status).toBe("proof_registered");
    expect(supplierUpload.files.some((file) => file.file_name.includes("韓国") === false && file.file_name.includes(orderNumberSafe(supplierUpload)))).toBe(true);
    expect(supplierUpload.files.filter((file) => file.category === "proof").map((file) => file.file_name))
      .toEqual(expect.arrayContaining([
        expect.stringContaining("校正_20261008.ai"),
        expect.stringContaining("校正_20261008.pdf"),
      ]));
    await expect(registerProofFromUploadToken({
      token: supplierToken!,
      fileName: `x_${receivingOrder!.order_number}.ai`,
      fileUrl: "https://drive.google.com/file/d/supplier2/view",
    })).rejects.toThrow("invalid_status_transition");
    await expect(getFilmOrderForProofUpload("1.123.bad")).rejects.toThrow("invalid_proof_token");

    await runFilmOrderAction(orderId, "request-re-proof", { comment: "メーカー初回分の再校正", supplierMessage: "初回校正を修正してください。" }, "buyer@727.co.jp");
    const proof1 = await runFilmOrderAction(orderId, "register-proof", {
      aiFileName: "校正データ_v2.ai",
      aiFileUrl: "https://drive.google.com/file/d/proof1/view",
      pdfFileName: "校正データ_v2.pdf",
      pdfFileUrl: "https://drive.google.com/file/d/proof1pdf/view",
    }, "kanei@kanei-trade.co.jp");
    expect(proof1.order.status).toBe("proof_registered");
    expect(proof1.order.files.find((file) => file.category === "proof")?.version).toBe(1);
    expect(proof1.order.files.filter((file) => file.category === "proof").map((file) => file.url)).toContain("https://drive.google.com/file/d/proof1/view");
    expect(proof1.order.files.filter((file) => file.category === "proof").map((file) => file.url)).toContain("https://drive.google.com/file/d/proof1pdf/view");

    const reProof = await runFilmOrderAction(orderId, "request-re-proof", { comment: "ロゴ位置を修正", supplierMessage: "ロゴ位置を修正してください。" }, "seven@727.co.jp");
    expect(reProof.order.status).toBe("re_proof_requested");
    expect(reProof.order.re_proof_count).toBe(2);

    const proof2 = await runFilmOrderAction(orderId, "register-proof", { fileName: "校正データ_v3.ai" }, "kanei@kanei-trade.co.jp");
    expect(proof2.order.status).toBe("proof_registered");
    expect(proof2.mails?.at(-1)?.to).toBe("design@package-lab.com");
    expect(proof2.mails?.at(-1)?.subject).toContain("校正データ受領");
    expect(proof2.order.files.filter((file) => file.category === "proof")).toHaveLength(5);

    const sellerApproved = await runFilmOrderAction(orderId, "record-customer-proof-approval", {
      approverName: "顧客担当",
      evidence: "電話承認（回帰テスト）",
      offlineReason: "記録された顧客承認のオフライン確認",
    }, "kanei@kanei-trade.co.jp");
    expect(sellerApproved.mails).toHaveLength(3);
    expect(sellerApproved.mails?.some((mail) => mail.to === "seven@727.co.jp")).toBe(true);
    expect(sellerApproved.mails?.some((mail) => mail.subject.includes("최종 승인 완료"))).toBe(true);
    expect(sellerApproved.mails?.[0]?.text).toContain("교정 데이터가 최종 승인되었습니다");
    const approved = await runFilmOrderAction(orderId, "approve", { fileName: "最終承認データ.pdf" }, "seven@727.co.jp");
    expect(approved.order.status).toBe("final_approved");
    expect(approved.order.shipTo.requestedAt).toBeTruthy();
        expect(approved.mails?.some((mail) => mail.to === "film-customer@example.test" && mail.subject.includes("納品先登録依頼"))).toBe(true);
    expect(approved.order.customerProof.supplierApprovalStatus).toBe("approved");
    expect(approved.order.customerProof.supplierApprovalBy).toBe("kanei@kanei-trade.co.jp");
    expect(approved.order.customerProof.buyerApprovalStatus).toBe("approved");
    expect(approved.order.customerProof.buyerApprovalBy).toBe("seven@727.co.jp");
    expect(approved.order.events.some((event) => event.detail.includes("金井貿易校正承認") && event.actor_email === "kanei@kanei-trade.co.jp")).toBe(true);
    expect(approved.order.files.find((file) => file.category === "final")).toBeDefined();
    expect(approved.mails?.every((mail) => mail.dryRun)).toBe(true);

    const final = await getFilmOrder(orderId);
    expect(final?.events.filter((event) => event.type === "mail_audit").length).toBeGreaterThanOrEqual(6);

    await expect(runFilmOrderAction(orderId, "send-po", {
      origin: "http://localhost:3000",
    }, "kanei@kanei-trade.co.jp")).rejects.toThrow("ship_to_confirmation_required");
    await runFilmOrderAction(orderId, "register-ship-to", {
      shipToCompanyName: "テスト物流株式会社",
      shipToDepartment: "大阪倉庫",
      shipToContactName: "納品担当",
      shipToPostalCode: "550-0001",
      shipToAddress: "大阪府大阪市テスト1-1-1",
      shipToBuilding: "物流センター2F",
      shipToPhone: "06-0000-0000",
      shipToEmail: "warehouse@example.test",
      shipToNote: "大型車不可",
      saveShipToMaster: true,
    }, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(orderId, "confirm-ship-to", {}, "seven@727.co.jp");

    const supplierNote = "用材：既指定のまま\n1ロール：500m × 3本\n発注長：SKU-1を優先";
    await runFilmOrderAction(orderId, "update-supplier-order-note", { supplierOrderNote: supplierNote }, "kanei@kanei-trade.co.jp");
    const previewed = await runFilmOrderAction(orderId, "preview-supplier-po", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    expect((previewed.preview as { to?: string })?.to).toBe("supplier@example.co.kr");
    expect((previewed.preview as { body?: string })?.body).toContain("【추가 발주 지시】");
    expect((previewed.preview as { body?: string })?.body).toContain("1ロール：500m × 3本");
    const po = await runFilmOrderAction(orderId, "send-po", {
      origin: "http://localhost:3000",
      supplierOrderNote: supplierNote,
    }, "kanei@kanei-trade.co.jp");
    expect(po.order.po_sent_at).toBeTruthy();
    expect(po.order.eta_token).toBeNull();
    expect(po.mails?.map((mail) => mail.to)).toContain("supplier@example.co.kr");
    const supplierPoMail = po.mails?.find((mail) => mail.to === "supplier@example.co.kr");
    expect(supplierPoMail?.text).toContain("1ロール：500m × 3本");
    expect(supplierPoMail?.text?.split("1ロール：500m × 3本")).toHaveLength(2);
    expect(supplierPoMail?.text).toContain("품목：発注検証パウチ");
    expect(supplierPoMail?.text).not.toContain("원문:");
    const poToken = supplierPoMail?.text?.match(/\/film-orders\/purchase-order\/([^\s"]+)/u)?.[1] ?? "";
    expect(poToken).not.toBe("");
    expect(supplierPoMail?.text).not.toContain("【발주서 URL(인쇄용)】");
    expect(supplierPoMail?.text).not.toContain(`${"http://localhost:3000"}/film-orders\n`);
    const poView = await getFilmOrderForSupplierPurchaseOrder(poToken);
    expect(poView?.id).toBe(orderId);
    expect(poView?.purchaseOrder?.orderLengthM).toBe("1700");
    expect(poView?.events.some((event) => event.type === "token_access" && event.detail.includes("supplier_po"))).toBe(true);
    await expect(getFilmOrderForSupplierPurchaseOrder("1.supplier_po.1.bad.bad")).rejects.toThrow("invalid_supplier_po_token");

    const poEtaToken = supplierPoMail?.text?.match(/\/film-orders\/eta\/([^\s"]+)/u)?.[1] ?? "";
    let etaToken = poEtaToken;
    expect(etaToken).not.toBe("");
    expect(etaToken.split(".")).toHaveLength(5);
    const etaView = await getFilmOrderForEta(etaToken);
    expect(etaView?.quotation_number).toBe("S7-FILM-STORE-001");
    const updatedEta = await updateEtaFromToken(etaToken, "2026-10-31", "銅版込み", "http://localhost:3000");
    expect(updatedEta?.eta_date).toBe("2026-10-31");
    expect(updatedEta?.eta_note).toBe("銅版込み");
    const supplierEtaMail = updatedEta?.mails?.find((mail) => mail.to === "supplier@example.co.kr");
    const sevenEtaMail = updatedEta?.mails?.find((mail) => mail.to === "seven@727.co.jp");
    expect(supplierEtaMail?.subject).toContain("납기 전망 업데이트");
    expect(supplierEtaMail?.text).toContain("maker_eta_report");
    expect(sevenEtaMail?.subject).toContain("納期見込み更新");
    expect(sevenEtaMail?.text).toContain("納期見込みを共有します");
    expect(sevenEtaMail?.text).toContain("seven_order_summary");
    expect(sevenEtaMail?.text).toContain("現在のワークフロー段階");
    await expect(updateEtaFromToken(etaToken, "2026/10/31", "")).rejects.toThrow("invalid_eta_date");
    etaToken = supplierEtaMail?.text?.match(/\/film-orders\/eta\/([^\s"]+)/u)?.[1] ?? "";
    expect(etaToken.split(".")).toHaveLength(5);
    await expect(updateEtaFromToken("1.maker_eta.9999999999999.bad.bad", "2026-10-31", ""))
      .rejects.toThrow("invalid_eta_token");
    await expect(updateEtaFromToken("1.123.bad", "2026-10-31", "")).rejects.toThrow("invalid_eta_token");
    const afterEta = await getFilmOrder(orderId);
    expect(afterEta?.events.some((event) => event.type === "eta")).toBe(true);
    await expect(getFilmOrderForEta(poEtaToken)).resolves.toBeNull();
    await runFilmOrderAction(orderId, "save-production-plan", {
      productionPlanStartDate: "2026-11-02",
      productionPlanEndDate: "2026-11-06",
      productionPlanNote: "フィルムリードタイム前提の暫定ライン確保",
    }, "seven@727.co.jp");
    await runFilmOrderAction(orderId, "confirm-production-plan", {
      productionPlanStartDate: "2026-11-02",
      productionPlanEndDate: "2026-11-06",
      productionPlanNote: "メーカー納期前の暫定計画",
    }, "seven@727.co.jp");
    const planRequest = await runFilmOrderAction(orderId, "request-production-plan", {
      origin: "http://localhost:3000",
    }, "kanei@kanei-trade.co.jp");
    expect(planRequest.mails).toHaveLength(1);
    expect(planRequest.mails?.[0]?.to).toBe("seven@727.co.jp");
    expect(planRequest.mails?.[0]?.subject).toContain("生産予定確認のお願い");
    expect(planRequest.mails?.[0]?.text).toContain("seven_order_summary");
    await expect(updateFilmDeliveryFromToken(etaToken, { kind: "shipment", date: "2026/10/30" }))
      .rejects.toThrow("invalid_delivery_date");
    await expect(updateFilmDeliveryFromToken(etaToken, { kind: "delivery", date: "2026-10-31" }))
      .rejects.toThrow("shipment_report_required");
    await expect(runFilmOrderAction(orderId, "confirm-film-receipt", {}, "seven@727.co.jp"))
      .rejects.toThrow("delivery_report_required");

    driveMocks.createSession.mockResolvedValueOnce("https://drive.example/upload-session");
    const sessionResponse = await deliveryUpload(new Request(`http://localhost/api/film-orders/delivery-upload/${etaToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "session",
        originalFileName: "delivery note.pdf",
        shipmentDate: "2026-10-30",
        uploadId: "upload12345678",
        sizeBytes: 1000,
        contentType: "application/pdf",
      }),
    }), { params: Promise.resolve({ token: etaToken }) });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json();
    expect(session.fileName).toContain("_delivery_2026-10-30_upload12345678_");
    expect(driveMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      folderId: "delivery-folder-test",
      fileName: session.fileName,
    }));

    driveMocks.findFiles.mockResolvedValueOnce([{
      id: "delivery-drive-file",
      name: session.fileName,
      mimeType: "application/pdf",
      checksum: "checksum",
      sizeBytes: 1000,
      parentFolderIds: ["delivery-folder-test"],
    }]);
    const completeResponse = await deliveryUpload(new Request(`http://localhost/api/film-orders/delivery-upload/${etaToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "complete",
        fileName: session.fileName,
        originalFileName: "delivery note.pdf",
        shipmentDate: "2026-10-30",
        uploadId: "upload12345678",
        carrier: "Test Freight",
        trackingNumber: "TRACK-001",
        note: "銅版込みで出荷",
      }),
    }), { params: Promise.resolve({ token: etaToken }) });
    expect(completeResponse.status).toBe(200);
    const shipped = (await completeResponse.json()).order;
    expect(shipped.delivery.shippedOn).toBe("2026-10-30");
    expect(shipped.delivery.carrier).toBe("Test Freight");
    expect(shipped.delivery.deliveryDocumentUrl).toBe("https://drive.google.com/file/d/delivery-drive-file/view");
    const shippedStored = await getFilmOrder(orderId);
    expect(shippedStored?.events.some((event) => event.type === "delivery" && event.detail.includes("メーカー出荷報告"))).toBe(true);
    const deliveredResponse = await etaPost(new Request(`http://localhost/api/film-orders/eta/${etaToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "delivery", date: "2026-10-31", note: "現場受領" }),
    }), { params: Promise.resolve({ token: etaToken }) });
    expect(deliveredResponse.status).toBe(200);
    const deliveredPayload = await deliveredResponse.json();
    expect(deliveredPayload.order.delivery.deliveredOn).toBe("2026-10-31");
    const delivered = await getFilmOrder(orderId);
    expect(delivered?.delivery.deliveredOn).toBe("2026-10-31");
    expect(delivered?.events.some((event) => event.type === "delivery" && event.detail.includes("メーカー納品報告"))).toBe(true);
    const receipt = await runFilmOrderAction(orderId, "confirm-film-receipt", {
      note: "数量・外観確認済み",
    }, "seven@727.co.jp");
    expect(receipt.order.delivery.receivedAt).toBeTruthy();
    expect(receipt.order.delivery.receivedNote).toBe("数量・外観確認済み");
    expect(receipt.mails?.map((mail) => mail.to)).toContain("supplier@example.co.kr");
    await expect(runFilmOrderAction(orderId, "confirm-film-receipt", {}, "seven@727.co.jp"))
      .rejects.toThrow("invalid_status_transition");
    const lateUploadResponse = await deliveryUpload(new Request(`http://localhost/api/film-orders/delivery-upload/${etaToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "session",
        originalFileName: "late delivery note.pdf",
        shipmentDate: "2026-10-30",
        uploadId: "lateUpload12345",
        sizeBytes: 1000,
        contentType: "application/pdf",
      }),
    }), { params: Promise.resolve({ token: etaToken }) });
    expect(lateUploadResponse.status).toBe(409);
    expect(await lateUploadResponse.json()).toEqual({ error: "invalid_delivery_transition" });
    const resent = await runFilmOrderAction(orderId, "resend-supplier-links", {
      origin: "http://localhost:3000",
    }, "kanei@kanei-trade.co.jp");
    expect(resent.mails).toHaveLength(3);
    expect(resent.mails?.[0]?.to).toBe("supplier@example.co.kr");
    expect(resent.mails?.[0]?.subject).toContain("재전송");
    expect(resent.mails?.[0]?.text).toContain("maker_proof_upload");
    expect(resent.mails?.some((mail) => mail.to === "seven@727.co.jp")).toBe(true);
    expect(final?.events.filter((event) => event.type === "mail_audit").length ?? 0).toBeGreaterThanOrEqual(1);
    const afterResend = await listFilmOrders("seven@727.co.jp");
    expect(afterResend.filter((order) => order.quotation_number === "S7-FILM-STORE-001")).toHaveLength(1);
    expect(afterResend.find((order) => order.quotation_number === "S7-FILM-STORE-001")?.id).toBe(orderId);
  });

  it("routes proof requests by procurement route and skips unconfigured Y suppliers", async () => {
    delete process.env.FILM_SUPPLIER_B_EMAIL;
    const kQuotation = await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-STORE-002",
      status: "approved",
      payload: { customerCode: "FILM-CUSTOMER-001", purchaseOrder: { ...purchaseOrder, procurementRoute: "K" as const } },
    }, 1, "admin");
    const yQuotation = await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-STORE-003",
      status: "approved",
      payload: { purchaseOrder: { ...purchaseOrder, procurementRoute: "Y" as const } },
    }, 1, "admin");
    void kQuotation; void yQuotation;
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const kOrder = orders.find((order) => order.quotation_number === "S7-FILM-STORE-002")!;
    const yOrder = orders.find((order) => order.quotation_number === "S7-FILM-STORE-003")!;
    await runFilmOrderAction(kOrder.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(yOrder.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(kOrder.id, "set-customer-design-not-required", { reason: "K regression" }, "seven@727.co.jp");
    await runFilmOrderAction(yOrder.id, "set-customer-design-not-required", { reason: "Y regression" }, "seven@727.co.jp");
    const kMaker = await createFilmMaker({
      makerCode: "STORE-KOR-GRA-001",
      companyName: "Store Korean Maker",
      email: "store-korean@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "kanei@kanei-trade.co.jp");
    await selectFilmMakerForOrder(kOrder.id, kMaker.id, "kanei@kanei-trade.co.jp");
    const yMaker = await createFilmMaker({
      makerCode: "STORE-JPN-GRA-001",
      companyName: "Store Japanese Maker",
      email: "store-japanese@example.test",
      language: "ja",
      printMethod: "gravure",
      procurementRoute: "Y",
    }, "kanei@kanei-trade.co.jp");
    await selectFilmMakerForOrder(yOrder.id, yMaker.id, "kanei@kanei-trade.co.jp");

    const kResult = await runFilmOrderAction(kOrder.id, "register-receiving", {
      aiFileName: "K用.ai",
      pdfFileName: "K用.pdf",
      aiFileUrl: "https://drive.google.com/file/d/k-ai/view",
      pdfFileUrl: "https://drive.google.com/file/d/k-pdf/view",
      guideAcknowledged: true,
    }, "seven@727.co.jp");
    const koreanNotice = kResult.mails?.find((mail) => mail.to === "store-korean@example.test");
    expect(koreanNotice?.text).toContain("발주 번호");
    expect(koreanNotice?.subject).toContain("제작 데이터 수령 요청");
    expect(koreanNotice?.text).toContain("【전용 링크】");
    expect(kResult.mails?.filter((mail) => mail.to !== "store-korean@example.test").every((mail) => !mail.text?.includes("발주번호"))).toBe(true);

    const yResult = await runFilmOrderAction(yOrder.id, "register-receiving", {
      aiFileName: "Y用.ai",
      pdfFileName: "Y用.pdf",
      aiFileUrl: "https://drive.google.com/file/d/y-ai/view",
      pdfFileUrl: "https://drive.google.com/file/d/y-pdf/view",
      guideAcknowledged: true,
    }, "seven@727.co.jp");
    console.log("Y-MAILS:", JSON.stringify(yResult.mails?.map((m) => ({ to: m.to, error: m.error }))));
    expect(yResult.mails?.[0]?.subject).toContain("制作データ受領依頼");
    expect(yResult.mails?.[0]?.text).toContain("発注番号");
    expect(yResult.mails?.[0]?.text).not.toContain("발주 번호");
    expect((await getFilmOrder(yOrder.id))?.events.some((event) => event.detail.includes("校正データ返却のお願い"))).toBe(false);

    const previousB = process.env.FILM_SUPPLIER_B_EMAIL;
    process.env.FILM_SUPPLIER_B_EMAIL = "y-supplier@example.jp";
    try {
      await expect(runFilmOrderAction(yOrder.id, "set-supplier", {
        supplierName: "Kanei Trade",
        supplierEmail: "ops@kanei-trade.co.jp",
        reason: "internal candidates are non-contactable",
      }, "kanei@kanei-trade.co.jp")).rejects.toThrow("internal_film_maker_rejected");
      const yNotice = await runFilmOrderAction(yOrder.id, "resend-receiving-notice", { origin: "http://localhost:3000" }, "seven@727.co.jp");
      expect(yNotice.mails?.find((mail) => mail.to === "store-japanese@example.test")?.to).toBe("store-japanese@example.test");
      expect(yNotice.mails?.find((mail) => mail.to === "store-japanese@example.test")?.subject).toContain("制作データ受領依頼");
      expect(yNotice.mails?.find((mail) => mail.to === "store-japanese@example.test")?.text).toContain("発注番号");

      expect(yNotice.mails?.find((mail) => mail.to === "store-japanese@example.test")?.text).toContain("/film-orders/upload/");
      expect(yNotice.mails?.find((mail) => mail.to === "store-japanese@example.test")?.text).not.toContain("교정 데이터 제출 요청");
      expect(yNotice.mails?.find((mail) => mail.to === "store-japanese@example.test")?.text).not.toContain("https://drive.google.com/file/d/");
    } finally {
      if (previousB === undefined) delete process.env.FILM_SUPPLIER_B_EMAIL;
      else process.env.FILM_SUPPLIER_B_EMAIL = previousB;
    }
  });

  it("issues a Korean purchase-order page for K procurement", async () => {
    const record = await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-STORE-PO-K",
      status: "approved",
      payload: { customerCode: "FILM-CUSTOMER-001", purchaseOrder: { ...purchaseOrder, procurementRoute: "K" as const } },
    }, 1, "admin");
    void record;
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const order = orders.find((item) => item.quotation_number === "S7-FILM-STORE-PO-K")!;
    await runFilmOrderAction(order.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "set-customer-design-not-required", { reason: "PO page test" }, "seven@727.co.jp");
    const kMaker = await createFilmMaker({
      makerCode: "STORE-KOR-PO-001",
      companyName: "Store Korean PO Maker",
      email: "store-korean-po@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "kanei@kanei-trade.co.jp");
    await selectFilmMakerForOrder(order.id, kMaker.id, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "set-supplier", {
      supplierName: "K 필름메이커",
      supplierEmail: "k-po@example.co.kr",
      reason: "既存フローの明示対象外",
    }, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "register-receiving", {
      aiFileName: "K_PO.ai",
      pdfFileName: "K_PO.pdf",
      guideAcknowledged: true,
      aiFileUrl: "https://drive.google.com/file/d/k-po-ai/view",
      pdfFileUrl: "https://drive.google.com/file/d/k-po-pdf/view",
    }, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "register-proof", {
      aiFileName: "K_PO_proof.ai",
      aiFileUrl: "https://drive.google.com/file/d/k-po-proof/view",
    }, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "record-customer-proof-approval", {
      approverName: "K 발주 고객",
      evidence: "메일 승인 회신",
      offlineReason: "記録された顧客承認のオフライン確認",
    }, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "approve", { fileName: "K_PO_final.pdf" }, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "register-ship-to", { destinations: [{ customerBasic: true }] }, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "confirm-ship-to", {}, "seven@727.co.jp");
    const result = await runFilmOrderAction(order.id, "send-po", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    const mail = result.mails?.find((item) => item.to === "store-korean-po@example.test");
    expect(mail?.subject).toContain("필름 발주 요청");
    expect(mail?.text).toContain("maker_purchase_order");
    const token = mail?.text?.match(/purchase-order\/([^\s"]+)/u)?.[1] ?? "";
    const view = await getFilmOrderForSupplierPurchaseOrder(token);
    expect(view.id).toBe(order.id);
    expect(view.procurement_route).toBe("K");
  });

  it("blocks maker actions for unresolved and deactivated makers without changing the order ID", async () => {
    await saveQuotation({
      ...input,
      quotationNumber: "S7-G003-MAKER-GATE-001",
      status: "approved",
      payload: { customerCode: "FILM-CUSTOMER-001", purchaseOrder: { ...purchaseOrder, procurementRoute: "K" as const } },
    }, 1, "admin");
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const order = orders.find((item) => item.quotation_number === "S7-G003-MAKER-GATE-001")!;
    const before = await getFilmOrder(order.id);
    await runFilmOrderAction(order.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "set-customer-design-not-required", { reason: "maker gate" }, "seven@727.co.jp");
    await expect(runFilmOrderAction(order.id, "register-receiving", {
      aiFileName: "gate.ai",
      pdfFileName: "gate.pdf",
      aiFileUrl: "https://drive.google.com/file/d/gate-ai/view",
      pdfFileUrl: "https://drive.google.com/file/d/gate-pdf/view",
      guideAcknowledged: true,
    }, "seven@727.co.jp")).rejects.toThrow("film_maker_resolution_required");

    const maker = await createFilmMaker({
      makerCode: "G003-KOR-GRA-001",
      companyName: "G003 Korean Maker",
      email: "g003-maker@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "kanei@kanei-trade.co.jp");
    await selectFilmMakerForOrder(order.id, maker.id, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "register-receiving", {
      aiFileName: "gate.ai",
      pdfFileName: "gate.pdf",
      aiFileUrl: "https://drive.google.com/file/d/gate-ai/view",
      pdfFileUrl: "https://drive.google.com/file/d/gate-pdf/view",
      guideAcknowledged: true,
    }, "seven@727.co.jp");
    await deactivateFilmMaker(maker.id, "admin@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "send-proof-notice", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    const after = await getFilmOrder(order.id);
    expect(after?.id).toBe(before?.id);
    expect(after?.order_number).toBe(before?.order_number);
    expect(after?.files.filter((file) => file.category === "receiving")).toHaveLength(2);
  });

  it("keeps order-stage sample bulk actions retired after moving the gate to quotations", async () => {
    const sampleRecord = await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-STORE-004",
      payload: {
        ...input.payload,
        customerEmail: "customer@example.test",
        calculationChecklistSnapshot: { bulkUsageMl: "7000" },
      },
    }, 1, "admin");
    void sampleRecord;
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const sampleBulkOrderId = (await listFilmOrders("seven@727.co.jp")).find((order) => order.quotation_number === "S7-FILM-STORE-004")!.id;
    const created = await getFilmOrder(sampleBulkOrderId);
    expect(created?.sampleBulk.status).toBe("pending");
    expect(created?.sampleBulk.productionBulkUsageMl).toBe("7000");
    expect(canPerformFilmOrderAction("request-sample-bulk", "kanei@kanei-trade.co.jp", created!.buyer_domain)).toBe(false);
    expect(canPerformFilmOrderAction("register-sample-bulk", "seven@727.co.jp", created!.buyer_domain)).toBe(false);
    expect(canPerformFilmOrderAction("confirm-sample-bulk", "kanei@kanei-trade.co.jp", created!.buyer_domain)).toBe(false);
    expect(canPerformFilmOrderAction("request-sample-bulk-adjustment", "kanei@kanei-trade.co.jp", created!.buyer_domain)).toBe(false);
  });

  it("lets the customer register a delivery destination from a signed link", async () => {
    await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-SHIP-001",
      status: "approved",
      payload: { customerCode: "FILM-CUSTOMER-001", customerEmail: "film-customer@example.test", purchaseOrder },
    }, 1, "admin");
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const shipOrderId = orders.find((item) => item.quotation_number === "S7-FILM-SHIP-001")!.id;
    await runFilmOrderAction(shipOrderId, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(shipOrderId, "set-customer-design-not-required", { reason: "ship-to request test" }, "seven@727.co.jp");
    const requested = await runFilmOrderAction(shipOrderId, "request-ship-to-registration", {
      origin: "http://localhost:3000",
    }, "seven@727.co.jp");
    expect(requested.order.shipTo.requestedAt).toBeTruthy();
    const requestMail = requested.mails?.[0];
    expect(requestMail?.to).toBe("film-customer@example.test");
    expect(requestMail?.subject).toContain("納品先登録依頼");
    const token = requestMail?.text?.match(/\/film-orders\/ship-to\/([^\s"]+)/u)?.[1] ?? "";
    expect(token).not.toBe("");

    const requestView = await getFilmOrderForShipToRequest(token);
    expect(requestView.orderNumber).toBeTruthy();
    expect(requestView.defaultDestination?.companyName).toBe("フィルム発注検証株式会社");
    expect(requestView.defaultDestination?.postalCode).toBe("650-0001");

    const saved = await registerShipToFromCustomerToken({
      token,
      values: {
        ...(requestView.defaultDestination ?? {}),
        label: "既定倉庫",
      },
      saveAsDefault: true,
      request: { headers: { get: (name) => name.toLowerCase() === "x-forwarded-for" ? "198.51.100.20" : null } },
      origin: "http://localhost:3000",
    });
    expect(saved.order.shipTo.status).toBe("registered");
    expect(saved.order.shipTo.registeredBy).toContain("customer:");
    expect(saved.order.shipTo.companyName).toBe("フィルム発注検証株式会社");
    expect(saved.order.shipTo.label).toBe("既定倉庫");

    const destinations = await listDeliveryDestinations("seven", "FILM-CUSTOMER-001");
    expect(destinations).toHaveLength(2);
    const savedDefault = destinations.find((item) => item.companyName === "フィルム発注検証株式会社");
    expect(savedDefault?.isDefault).toBe(true);
    expect(savedDefault?.label).toBe("既定倉庫");

    // 複数納品先: 顧客の2件目登録は追加（代表納品先は1件目のまま）
    const second = await registerShipToFromCustomerToken({
      token,
      values: {
        label: "第二倉庫",
        companyName: "追加物流株式会社",
        postalCode: "550-0002",
        address: "大阪府大阪市テスト2-2-2",
        phone: "06-1111-1111",
      },
      request: { headers: { get: (name) => name.toLowerCase() === "x-forwarded-for" ? "198.51.100.21" : null } },
      origin: "http://localhost:3000",
    });
    expect(second.order.shipTo.destinations).toHaveLength(2);
    expect(second.order.shipTo.destinations[0]?.companyName).toBe("フィルム発注検証株式会社");
    expect(second.order.shipTo.destinations[1]?.companyName).toBe("追加物流株式会社");
    expect(second.order.shipTo.companyName).toBe("フィルム発注検証株式会社");
  });

  it("registers, replaces, removes and confirms multiple delivery destinations", async () => {
    await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-SHIP-MULTI-001",
      status: "approved",
      payload: { customerCode: "FILM-CUSTOMER-001", customerEmail: "film-customer@example.test", purchaseOrder },
    }, 1, "admin");
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const orderId = orders.find((item) => item.quotation_number === "S7-FILM-SHIP-MULTI-001")!.id;

    const registered = await runFilmOrderAction(orderId, "register-ship-to", {
      destinations: [
        {
          shipToLabel: "本社倉庫",
          shipToCompanyName: "マルチ物流株式会社",
          shipToPostalCode: "550-0010",
          shipToAddress: "大阪府大阪市マルチ1-1-1",
          shipToPhone: "06-0000-0010",
          saveShipToMaster: false,
        },
        {
          shipToCompanyName: "第二倉庫株式会社",
          shipToPostalCode: "550-0020",
          shipToAddress: "大阪府大阪市マルチ2-2-2",
          shipToPhone: "06-0000-0020",
          saveShipToMaster: false,
        },
        {
          shipToCompanyName: "九州倉庫株式会社",
          shipToPostalCode: "812-0000",
          shipToAddress: "福岡県福岡市マルチ3-3-3",
          shipToPhone: "092-000-0003",
          saveShipToMaster: false,
        },
      ],
    }, "seven@727.co.jp");
    expect(registered.order.shipTo.status).toBe("registered");
    expect(registered.order.shipTo.destinations).toHaveLength(3);
    expect(registered.order.shipTo.destinations.map((destination) => destination.companyName)).toEqual([
      "マルチ物流株式会社",
      "第二倉庫株式会社",
      "九州倉庫株式会社",
    ]);
    // 1件目が代表納品先として旧 scalar カラムへ同期される
    expect(registered.order.shipTo.companyName).toBe("マルチ物流株式会社");
    expect(registered.order.shipTo.postalCode).toBe("550-0010");

    // 空配列・上限超過は拒否される
    await expect(runFilmOrderAction(orderId, "register-ship-to", { destinations: [] }, "seven@727.co.jp"))
      .rejects.toThrow("invalid_ship_to");

    // 再登録で差し替え（3件 → 2件）
    const replaced = await runFilmOrderAction(orderId, "register-ship-to", {
      destinations: [
        { destinationId: registered.order.shipTo.destinations[0]!.destinationId! },
        {
          shipToCompanyName: "差し替え倉庫株式会社",
          shipToPostalCode: "550-0030",
          shipToAddress: "大阪府大阪市マルチ4-4-4",
          shipToPhone: "06-0000-0030",
        },
      ],
    }, "seven@727.co.jp");
    expect(replaced.order.shipTo.destinations).toHaveLength(2);
    expect(replaced.order.shipTo.destinations[0]?.companyName).toBe("マルチ物流株式会社");
    expect(replaced.order.shipTo.destinations[1]?.companyName).toBe("差し替え倉庫株式会社");

    // 1件削除 → 残1件が代表納品先になる
    const removed = await runFilmOrderAction(orderId, "remove-ship-to-destination", {
      destinationRowId: replaced.order.shipTo.destinations[0]!.id,
    }, "seven@727.co.jp");
    expect(removed.order.shipTo.destinations).toHaveLength(1);
    expect(removed.order.shipTo.companyName).toBe("差し替え倉庫株式会社");
    expect(removed.order.shipTo.status).toBe("registered");

    // 確認で全件確定
    const confirmationAttempts = await Promise.allSettled([
      runFilmOrderAction(orderId, "confirm-ship-to", {}, "seven@727.co.jp"),
      runFilmOrderAction(orderId, "confirm-ship-to", {}, "kanei@kanei-trade.co.jp"),
    ]);
    const successfulConfirmations = confirmationAttempts.filter((attempt) => attempt.status === "fulfilled");
    const failedConfirmations = confirmationAttempts.filter((attempt) => attempt.status === "rejected");
    expect(successfulConfirmations).toHaveLength(1);
    expect(failedConfirmations).toHaveLength(1);
    expect((failedConfirmations[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringContaining("invalid_status_transition"),
    });
    const confirmed = await getFilmOrder(orderId);
    if (!confirmed) throw new Error("film_order_update_failed");
    expect(confirmed.shipTo.status).toBe("confirmed");
    expect(confirmed.shipTo.destinations.every((destination) => destination.confirmedAt)).toBe(true);
    await expect(runFilmOrderAction(orderId, "remove-ship-to-destination", {
      destinationRowId: confirmed.shipTo.destinations[0]!.id,
    }, "seven@727.co.jp")).rejects.toThrow("invalid_status_transition");
  });

  it("defaults to the customer basic address when registering a ship-to", async () => {
    await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-SHIP-BASIC-001",
      status: "approved",
      payload: { customerCode: "FILM-CUSTOMER-001", customerEmail: "film-customer@example.test", purchaseOrder },
    }, 1, "admin");
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const orderId = orders.find((item) => item.quotation_number === "S7-FILM-SHIP-BASIC-001")!.id;

    const registered = await runFilmOrderAction(orderId, "register-ship-to", {
      destinations: [{ customerBasic: true }],
    }, "seven@727.co.jp");
    expect(registered.order.shipTo.status).toBe("registered");
    expect(registered.order.shipTo.destinations).toHaveLength(1);
    // 顧客基本情報は住所録マスタに紐付かない
    expect(registered.order.shipTo.destinations[0]?.destinationId).toBeNull();
    // 顧客基本情報（初回登録時の住所）が代表納品先になる
    expect(registered.order.shipTo.companyName).toBe("フィルム発注検証株式会社");
    expect(registered.order.shipTo.postalCode).toBe("650-0001");
    expect(registered.order.shipTo.address).toBe("兵庫県神戸市テスト1-2-3");
    expect(registered.order.shipTo.phone).toBe("078-000-0000");
  });

  it("resolves customer basic address owned by kanei for a seven-buyer order", async () => {
    await saveCustomer("kanei", {
      customerCode: "K-TEST-KANEI-001",
      customerName: "金井所有テスト株式会社",
      customerPostalCode: "194-0037",
      customerAddress: "東京都町田市テスト2-6-19",
      customerContact: "吉田",
      customerTelephone: "070-0000-0279",
      customerEmail: "k-test@example.test",
    });
    await saveQuotation({
      ...input,
      quotationNumber: "S7-FILM-SHIP-BASIC-KANEI-001",
      status: "approved",
      payload: { customerCode: "K-TEST-KANEI-001", customerEmail: "k-test@example.test", purchaseOrder },
    }, 1, "admin");
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const orderId = orders.find((item) => item.quotation_number === "S7-FILM-SHIP-BASIC-KANEI-001")!.id;

    const registered = await runFilmOrderAction(orderId, "register-ship-to", {
      destinations: [{ customerBasic: true }],
    }, "seven@727.co.jp");
    expect(registered.order.shipTo.status).toBe("registered");
    expect(registered.order.shipTo.companyName).toBe("金井所有テスト株式会社");
    expect(registered.order.shipTo.postalCode).toBe("194-0037");
    expect(registered.order.shipTo.address).toBe("東京都町田市テスト2-6-19");
    expect(registered.order.shipTo.phone).toBe("070-0000-0279");
    expect(registered.order.shipTo.destinations[0]?.destinationId).toBeNull();
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
