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
    expect(orders[0]!.supplier_email).toBe("design@package-lab.com");
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

    await runFilmOrderAction(orderId, "set-supplier", { supplierName: "韓国メーカー", supplierEmail: "supplier@example.co.kr" }, "kanei@kanei-trade.co.jp");
    const receiving = await runFilmOrderAction(orderId, "register-receiving", {
      aiFileName: "発注検証パウチ.ai",
      guideAcknowledged: true,
      aiFileUrl: "https://drive.google.com/file/d/ai/view",
      pdfFileName: "発注検証パウチ.pdf",
      pdfFileUrl: "https://drive.google.com/file/d/pdf/view",
      note: "1回目",
    }, "seven@727.co.jp");
    expect(receiving.order.status).toBe("receiving_registered");
    expect(receiving.mails?.map((mail) => mail.to)).toEqual(["design@package-lab.com", "supplier@example.co.kr"]);
    expect(receiving.mails?.at(-1)?.subject).toContain("校正データ返却のお願い");
    expect(receiving.mails?.at(-1)?.text).toContain("発注番号");
    expect(receiving.mails?.at(-1)?.text).toContain("校正データは必ず下記アップロードページから返却してください。");
    expect(receiving.mails?.at(-1)?.text).toContain("/api/film-orders/proof-download/");
    expect(receiving.mails?.at(-1)?.text).toContain("/film-orders/upload/");
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
    expect(notice.mails?.[0]?.subject).toContain("【校正データ返却のお願い】");

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

    await runFilmOrderAction(orderId, "request-re-proof", { comment: "メーカー初回分の再校正", supplierMessage: "初回校正を修正してください。" }, "seven@727.co.jp");
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
    expect(proof2.mails?.at(-1)?.to).toBe("kanei-approvals@example.test");
    expect(proof2.mails?.at(-1)?.subject).toContain("【承認依頼】金井貿易校正承認をお願いします");
    expect(proof2.order.files.filter((file) => file.category === "proof")).toHaveLength(5);

    const sellerApproved = await runFilmOrderAction(orderId, "record-customer-proof-approval", {
      approverName: "顧客担当",
      evidence: "電話承認（回帰テスト）",
    }, "kanei@kanei-trade.co.jp");
    expect(sellerApproved.mails).toHaveLength(1);
    expect(sellerApproved.mails?.[0]?.to).toBe("seven@727.co.jp");
    expect(sellerApproved.mails?.[0]?.subject).toContain("【最終承認待ち】セブン化学の承認のみ残っています");
    expect(sellerApproved.mails?.[0]?.text).toContain("② セブン化学最終承認：待ち");
    const approved = await runFilmOrderAction(orderId, "approve", { fileName: "最終承認データ.pdf" }, "seven@727.co.jp");
    expect(approved.order.status).toBe("final_approved");
    expect(approved.order.shipTo.requestedAt).toBeTruthy();
    expect(approved.mails?.some((mail) => mail.to === "film-customer@example.test" && mail.subject.includes("【納品先ご登録のお願い】"))).toBe(true);
    expect(approved.order.customerProof.supplierApprovalStatus).toBe("approved");
    expect(approved.order.customerProof.supplierApprovalBy).toBe("kanei@kanei-trade.co.jp");
    expect(approved.order.customerProof.buyerApprovalStatus).toBe("approved");
    expect(approved.order.customerProof.buyerApprovalBy).toBe("seven@727.co.jp");
    expect(approved.order.events.some((event) => event.detail.includes("金井貿易校正承認") && event.actor_email === "kanei@kanei-trade.co.jp")).toBe(true);
    expect(approved.order.files.find((file) => file.category === "final")).toBeDefined();
    expect(approved.mails?.every((mail) => mail.dryRun)).toBe(true);

    const final = await getFilmOrder(orderId);
    expect(final?.events.filter((event) => event.type === "email").length).toBeGreaterThanOrEqual(6);

    const supplierNote = "用材：既指定のまま\n1ロール：500m × 3本\n発注長：SKU-1を優先";
    await runFilmOrderAction(orderId, "update-supplier-order-note", { supplierOrderNote: supplierNote }, "kanei@kanei-trade.co.jp");
    const previewed = await runFilmOrderAction(orderId, "preview-supplier-po", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    expect(previewed.preview?.to).toBe("supplier@example.co.kr");
    expect(previewed.preview?.body).toContain("【発注時の追加指示】");
    expect(previewed.preview?.body).toContain("1ロール：500m × 3本");
    const po = await runFilmOrderAction(orderId, "send-po", {
      origin: "http://localhost:3000",
      supplierOrderNote: supplierNote,
    }, "kanei@kanei-trade.co.jp");
    expect(po.order.po_sent_at).toBeTruthy();
    expect(po.order.eta_token).toBeTruthy();
    expect(po.mails?.map((mail) => mail.to)).toContain("supplier@example.co.kr");
    expect(po.mails?.find((mail) => mail.to === "supplier@example.co.kr")?.text).toContain("1ロール：500m × 3本");
    const supplierPoMail = po.mails?.find((mail) => mail.to === "supplier@example.co.kr");
    const poToken = supplierPoMail?.text?.match(/\/film-orders\/purchase-order\/([^\s"]+)/u)?.[1] ?? "";
    expect(poToken).not.toBe("");
    expect(supplierPoMail?.text).not.toContain("【발주서 URL(인쇄용)】");
    expect(supplierPoMail?.text).not.toContain(`${"http://localhost:3000"}/film-orders\n`);
    const poView = await getFilmOrderForSupplierPurchaseOrder(poToken);
    expect(poView?.id).toBe(orderId);
    expect(poView?.purchaseOrder?.orderLengthM).toBe("1700");
    expect(poView?.events.some((event) => event.type === "token_access" && event.detail.includes("supplier_po"))).toBe(true);
    await expect(getFilmOrderForSupplierPurchaseOrder("1.supplier_po.1.bad.bad")).rejects.toThrow("invalid_supplier_po_token");

    const etaToken = po.order.eta_token!;
    const etaView = await getFilmOrderForEta(etaToken);
    expect(etaView?.quotation_number).toBe("S7-FILM-STORE-001");
    const updatedEta = await updateEtaFromToken(etaToken, "2026-10-31", "銅版込み", "http://localhost:3000");
    expect(updatedEta?.eta_date).toBe("2026-10-31");
    expect(updatedEta?.eta_note).toBe("銅版込み");
    const supplierEtaMail = updatedEta?.mails?.find((mail) => mail.to === "supplier@example.co.kr");
    const sevenEtaMail = updatedEta?.mails?.find((mail) => mail.to === "seven@727.co.jp");
    expect(supplierEtaMail?.subject).toContain("納期見込み登録");
    expect(supplierEtaMail?.text).toContain("納期見込み：2026-10-31");
    expect(sevenEtaMail?.subject).toContain("【フィルム入荷予定】");
    expect(sevenEtaMail?.text).toContain("フィルム入荷予定として充填スケジュール・受領準備にご共有ください");
    expect(sevenEtaMail?.text).toContain("納期見込み：2026-10-31");
    expect(sevenEtaMail?.text).toContain("管理画面：http://localhost:3000/film-orders");
    await expect(updateEtaFromToken(etaToken, "2026/10/31", "")).rejects.toThrow("invalid_eta_date");
    await expect(updateEtaFromToken("1.123.bad", "2026-10-31", "")).rejects.toThrow("invalid_eta_token");
    const afterEta = await getFilmOrder(orderId);
    expect(afterEta?.events.some((event) => event.type === "eta")).toBe(true);
    await expect(updateFilmDeliveryFromToken(etaToken, { kind: "shipment", date: "2026-10-30" }))
      .rejects.toThrow("ship_to_confirmation_required");
    await expect(runFilmOrderAction(orderId, "register-ship-to", {
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
    }, "kanei@kanei-trade.co.jp")).resolves.toMatchObject({
      order: {
        shipTo: {
          status: "registered",
          companyName: "テスト物流株式会社",
          savedToMaster: true,
          registeredBy: "kanei@kanei-trade.co.jp",
        },
      },
    });
    const savedDestinations = await listDeliveryDestinations("seven", "FILM-CUSTOMER-001");
    expect(savedDestinations).toHaveLength(1);
    expect(savedDestinations[0]?.companyName).toBe("テスト物流株式会社");
    await runFilmOrderAction(orderId, "confirm-ship-to", {}, "seven@727.co.jp");
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
    expect(planRequest.mails?.[0]?.subject).toContain("충진 생산 예정 확인 요청");
    expect(planRequest.mails?.[0]?.text).toContain("充填生産予定（開始日・終了日）");
    await expect(updateFilmDeliveryFromToken(etaToken, { kind: "shipment", date: "2026/10/30" }))
      .rejects.toThrow("invalid_delivery_date");
    await expect(updateFilmDeliveryFromToken(etaToken, { kind: "delivery", date: "2026-10-31" }))
      .rejects.toThrow("shipment_report_required");

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
    const resent = await runFilmOrderAction(orderId, "resend-supplier-links", {
      origin: "http://localhost:3000",
    }, "kanei@kanei-trade.co.jp");
    expect(resent.mails).toHaveLength(1);
    expect(resent.mails?.[0]?.to).toBe("supplier@example.co.kr");
    expect(resent.mails?.[0]?.subject).toContain("【再送】");
    expect(resent.mails?.[0]?.text).toContain("新しい発注ではありません");
    expect(resent.mails?.some((mail) => mail.to === "seven@727.co.jp")).toBe(false);
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
    const orders = await listFilmOrders("seven@727.co.jp");
    const kOrder = orders.find((order) => order.quotation_number === "S7-FILM-STORE-002")!;
    const yOrder = orders.find((order) => order.quotation_number === "S7-FILM-STORE-003")!;
    await runFilmOrderAction(kOrder.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(yOrder.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(kOrder.id, "set-customer-design-not-required", { reason: "K regression" }, "seven@727.co.jp");
    await runFilmOrderAction(yOrder.id, "set-customer-design-not-required", { reason: "Y regression" }, "seven@727.co.jp");

    const kResult = await runFilmOrderAction(kOrder.id, "register-receiving", { aiFileName: "K用.ai", aiFileUrl: "https://drive.google.com/file/d/k-ai/view", guideAcknowledged: true }, "seven@727.co.jp");
    expect(kResult.mails?.every((mail) => !mail.text?.includes("発注番号"))).toBe(true);
    expect(kResult.mails?.at(-1)?.text).toContain("발주번호");
    expect(kResult.mails?.at(-1)?.text).toContain("원문:");
    expect(kResult.mails?.at(-1)?.subject).toContain("교정 데이터 제출 요청");
    expect(kResult.mails?.at(-1)?.text).toContain("발주번호");
    expect(kResult.mails?.at(-1)?.text).toContain("교정 데이터는 반드시 아래 업로드 페이지로 제출해 주십시오.");

    const yResult = await runFilmOrderAction(yOrder.id, "register-receiving", { aiFileName: "Y用.ai", aiFileUrl: "https://drive.google.com/file/d/y-ai/view", guideAcknowledged: true }, "seven@727.co.jp");
    console.log("Y-MAILS:", JSON.stringify(yResult.mails?.map((m) => ({ to: m.to, error: m.error }))));
    expect(yResult.mails?.[0]?.subject).toContain("校正データ返却のお願い");
    expect(yResult.mails?.[0]?.text).toContain("発注番号");
    expect(yResult.mails?.[0]?.text).not.toContain("발주번호");
    expect((await getFilmOrder(yOrder.id))?.events.some((event) => event.detail.includes("校正データ返却のお願い"))).toBe(false);

    const previousB = process.env.FILM_SUPPLIER_B_EMAIL;
    process.env.FILM_SUPPLIER_B_EMAIL = "y-supplier@example.jp";
    try {
      await runFilmOrderAction(yOrder.id, "set-supplier", { supplierName: "国内メーカー", supplierEmail: "y-supplier@example.jp" }, "kanei@kanei-trade.co.jp");
    const yNotice = await runFilmOrderAction(yOrder.id, "resend-receiving-notice", { origin: "http://localhost:3000" }, "seven@727.co.jp");
      expect(yNotice.mails?.at(-1)?.to).toBe("y-supplier@example.jp");
      expect(yNotice.mails?.at(-1)?.subject).toContain("校正データ返却のお願い");
      expect(yNotice.mails?.at(-1)?.text).toContain("発注番号");
      expect(yNotice.mails?.at(-1)?.text).toContain("/api/film-orders/proof-download/");
      expect(yNotice.mails?.at(-1)?.text).toContain("/film-orders/upload/");
      expect(yNotice.mails?.at(-1)?.text).not.toContain("교정 데이터 제출 요청");
      expect(yNotice.mails?.at(-1)?.text).not.toContain("https://drive.google.com/file/d/");
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
      payload: { purchaseOrder: { ...purchaseOrder, procurementRoute: "K" as const } },
    }, 1, "admin");
    void record;
    await syncFilmOrdersFromQuotations("seven@727.co.jp");
    const orders = await listFilmOrders("seven@727.co.jp");
    const order = orders.find((item) => item.quotation_number === "S7-FILM-STORE-PO-K")!;
    await runFilmOrderAction(order.id, "mark-ordered", {}, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "set-customer-design-not-required", { reason: "PO page test" }, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "set-supplier", { supplierName: "K 필름메이커", supplierEmail: "k-po@example.co.kr" }, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "register-receiving", {
      aiFileName: "K_PO.ai",
      guideAcknowledged: true,
      aiFileUrl: "https://drive.google.com/file/d/k-po-ai/view",
    }, "seven@727.co.jp");
    await runFilmOrderAction(order.id, "register-proof", {
      aiFileName: "K_PO_proof.ai",
      aiFileUrl: "https://drive.google.com/file/d/k-po-proof/view",
    }, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "record-customer-proof-approval", {
      approverName: "K 발주 고객",
      evidence: "메일 승인 회신",
    }, "kanei@kanei-trade.co.jp");
    await runFilmOrderAction(order.id, "approve", { fileName: "K_PO_final.pdf" }, "seven@727.co.jp");
    const result = await runFilmOrderAction(order.id, "send-po", { origin: "http://localhost:3000" }, "kanei@kanei-trade.co.jp");
    const mail = result.mails?.find((item) => item.to === "k-po@example.co.kr");
    expect(mail?.subject).toContain("【필름 발주 요청】");
    expect(mail?.text).toContain("【발주서 열람·인쇄 페이지】");
    const token = mail?.text?.match(/\/film-orders\/purchase-order\/([^\s"]+)/u)?.[1] ?? "";
    const view = await getFilmOrderForSupplierPurchaseOrder(token);
    expect(view.id).toBe(order.id);
    expect(view.procurement_route).toBe("K");
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
    const requestMail = requested.mails?.at(-1);
    expect(requestMail?.to).toBe("film-customer@example.test");
    expect(requestMail?.subject).toContain("【納品先ご登録のお願い】");
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
