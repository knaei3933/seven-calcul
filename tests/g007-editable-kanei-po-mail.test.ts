import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "g007-editable-po-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.MAIL_DRY_RUN = "true";
process.env.FILM_DESIGN_TO = "film-workflow@kanei-trade.co.jp";
process.env.FILM_EXTERNAL_LINK_ORIGINS = "http://localhost:3000";
process.env.SEVEN_CHEMICAL_CONTACT_EMAIL = "seven-order@727.co.jp";

const { createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const { runFilmOrderAction, syncFilmOrdersFromQuotations, getDatabaseForFilmMakerStore, decideCustomerProofReview, saveDeliveryNoteDraft } = await import("@/lib/film-orders");
const { generateFilmDeliveryNotePdf } = await import("@/lib/film-delivery-note-pdf");
const { saveQuotation, getDatabaseForTest } = await import("@/lib/quotation-store");
const { createFilmMaker } = await import("@/lib/film-maker-store");
const { saveCustomer } = await import("@/lib/customer-store");
await getDatabaseForTest();
await saveCustomer("seven", {
  customerCode: "G007-APPROVAL",
  customerName: "G006 Approval Order Customer",
  customerPostalCode: "650-0001",
  customerAddress: "Kobe G006 0-0-0",
  customerContact: "Approver",
  customerTelephone: "078-000-0000",
  customerEmail: "approval-order-customer@example.test",
});

const SEVEN = "seven-approval-order@727.co.jp";
const KANEI = "kanei-approval-order@kanei-trade.co.jp";

const sevenUser = await createUser({
  email: SEVEN,
  name: "Seven Approver",
  password: "seven-approval-order-password",
  role: "user",
});
const kaneiUser = await createUser({
  email: KANEI,
  name: "Kanei Approver",
  password: "kanei-approval-order-password",
  role: "user",
});
await createFilmMaker({
  makerCode: "G007-K-DIG",
  companyName: "G007 Korea Maker",
  email: "g007-korea-maker@example.test",
  language: "ko",
  printMethod: "digital",
  procurementRoute: "K",
}, KANEI);

function input(number: string): QuotationRecordInput {
  return {
    quotationNumber: number,
    status: "approved",
    issueDate: "2026-11-06",
    validUntil: "2026-12-31",
    customerName: "G007 Approval Order Customer",
    customerContact: "Approver",
    productName: "Approval Order Pouch",
    sizeSummary: "60×80mm / 1連",
    quantity: "10000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "5",
    filmMeterPrice: "180",
    filmOrderLengthM: "500",
    targetMargin: "0.3",
    taxRatePercent: "10",
    pricePerPiece: "20",
    subtotal: "200000",
    tax: "20000",
    grandTotal: "220000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "g007-editable-po",
    resultHash: `g007-${number}`,
    payload: {
      customerCode: "G007-APPROVAL",
      customerEmail: "approval-order-customer@example.test",
      purchaseOrder: {
        printingMethod: "digital",
        pouchQuantity: "10000",
        filmComposition: "PET12+AL7+PET12+LLDPE50",
        requiredLengthM: "400",
        orderLengthM: "500",
        effectiveLengthM: "500",
        lossM: "100",
        lossRate: "0.2",
        webWidthMm: 476,
        webWidthsMm: [476],
        lanes: 4,
        pitchMm: "96",
        prodMultiplier: 1,
        colorCount: 4,
        skuColorCounts: ["4"],
        skuOrderDetails: [{
          skuCode: "SKU-G007-ORDER", name: "Approval Order", quantity: "10000", colorCount: "4",
          requiredLengthM: "400", orderLengthM: "500", webWidthMm: 476, multiplier: 1,
        }],
        procurementRoute: "K",
      },
    },
  };
}

async function proofReadyOrder(number: string): Promise<number> {
  const quote = await saveQuotation(input(number), sevenUser.id, sevenUser.role);
  await syncFilmOrdersFromQuotations("system");
  const orders = await (await import("@/lib/film-orders")).listFilmOrders(SEVEN);
  const order = orders.find((item) => item.quotation_number === number)!;
  await runFilmOrderAction(order.id, "mark-ordered", {}, SEVEN);
  await runFilmOrderAction(order.id, "set-customer-design-not-required", { reason: "G007 approval order test" }, SEVEN);
  await runFilmOrderAction(order.id, "register-receiving", {
    aiFileName: `${number}.ai`,
    aiFileUrl: "https://drive.google.com/file/d/g007-order-ai/view",
    pdfFileName: `${number}.pdf`,
    pdfFileUrl: "https://drive.google.com/file/d/g007-order-pdf/view",
    guideAcknowledged: true,
    origin: "http://localhost:3000",
  }, SEVEN);
  const proof = await runFilmOrderAction(order.id, "register-proof", {
    aiFileName: `${number}-proof.ai`,
    aiFileUrl: "https://drive.google.com/file/d/g007-proof-ai/view",
    pdfFileName: `${number}-proof.pdf`,
    pdfFileUrl: "https://drive.google.com/file/d/g007-proof-pdf/view",
    origin: "http://localhost:3000",
  }, KANEI);
  expect(proof.order.status).toBe("proof_registered");
  await runFilmOrderAction(order.id, "send-customer-proof-review", { origin: "http://localhost:3000" }, SEVEN);
  const db = await getDatabaseForFilmMakerStore();
  const rows = await db.all<{ links_json: string }>(
    "SELECT links_json FROM film_order_mail_outbox WHERE order_id=? AND audience='customer' ORDER BY id DESC",
    [order.id],
  );
  const token = rows.flatMap((row) => JSON.parse(row.links_json) as Array<{ key: string; url: string }>)
    .map((link) => link.url.split("/proof-review/")[1]?.split(/[?\s]/u)[0])
    .find(Boolean);
  if (!token) throw new Error("missing proof review token");
  const accepted = await decideCustomerProofReview({
    token: decodeURIComponent(token),
    decision: "approve",
    origin: "http://localhost:3000",
  });
  expect(accepted.customerProof.status).toBe("approved");
  return order.id;
}

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("G007 editable Kanei PO mail", () => {
  it("keeps preview/edit/send Kanei-only and applies edited maker mail while preserving links", async () => {
    const id = await proofReadyOrder("S7-G007-PO-A");
    await runFilmOrderAction(id, "record-customer-proof-approval", {
      approverName: "Kanei Approver",
      evidence: "mail reply hash g007",
      offlineReason: "Recorded customer approval",
      origin: "http://localhost:3000",
    }, KANEI);
    await runFilmOrderAction(id, "approve", {
      finalFileName: "S7-G007-PO-final.pdf",
      finalFileUrl: "https://drive.google.com/file/d/g007-final/view",
      origin: "http://localhost:3000",
    }, SEVEN);
    await runFilmOrderAction(id, "register-ship-to", { destinations: [{ customerBasic: true }] }, SEVEN);
    await runFilmOrderAction(id, "confirm-ship-to", {}, SEVEN);

    await expect(runFilmOrderAction(id, "preview-supplier-po", { origin: "http://localhost:3000" }, SEVEN))
      .rejects.toThrow("film_order_actor_forbidden");
    await expect(runFilmOrderAction(id, "send-po", { origin: "http://localhost:3000" }, SEVEN))
      .rejects.toThrow("film_order_actor_forbidden");

    const customSubject = "[편집된 필름 발주] S7-G007-PO-A";
    const customBody = [
      "G007 Korea Maker 담당자님",
      "",
      "아래 내용으로 제작 요청드립니다.",
      "발주 번호: S7-G007-PO-A",
      "발주서: http://localhost:3000/film-orders/purchase-order/{issued-after-send}",
      "납기 전망: http://localhost:3000/film-orders/eta/{issued-after-send}",
    ].join("\n");
    const preview = await runFilmOrderAction(id, "preview-supplier-po", {
      origin: "http://localhost:3000",
      supplierOrderNote: "500m 단위 권감",
      mailSubject: customSubject,
      mailBody: customBody,
    }, KANEI);
    expect(preview.preview).toMatchObject({ editableSubject: customSubject, editableBody: customBody });

    const sent = await runFilmOrderAction(id, "send-po", {
      origin: "http://localhost:3000",
      supplierOrderNote: "500m 단위 권감",
      mailSubject: customSubject,
      mailBody: customBody,
    }, KANEI);
    expect(sent.order.po_sent_at).toBeTruthy();
    const makerMail = sent.mails?.find((mail) => mail.to === "g007-korea-maker@example.test");
    expect(makerMail?.subject).toContain(customSubject);
    expect(makerMail?.text).toContain("500m 단위 권감");
    expect(makerMail?.text).not.toContain("{issued-after-send}");
    expect(makerMail?.text).toMatch(/\/film-orders\/purchase-order\//u);
    expect(makerMail?.text).toMatch(/\/film-orders\/eta\//u);

    const draft = await saveDeliveryNoteDraft(id, {
      recipientName: "株式会社セブン化学",
      senderName: "金井貿易株式会社",
      issueDate: "2026-11-07",
      arrivalEstimateDate: "2026-11-20",
      productName: "G007 Pouch",
      specification: "PET12+AL7+PET12+LLDPE50 / 476mm",
      quantity: "10000",
      filmLength: "500",
      remarks: "到着後は充填工程へ引き継ぎます。",
    }, KANEI);
    expect(draft.deliveryNoteDraft).toMatchObject({ recipientName: "株式会社セブン化学", arrivalEstimateDate: "2026-11-20" });
    await expect(saveDeliveryNoteDraft(id, { recipientName: "禁止" }, SEVEN))
      .rejects.toThrow("film_order_actor_forbidden");
    const notePdf = await generateFilmDeliveryNotePdf(draft.deliveryNoteDraft, "S7-G007-PO-A");
    expect(Buffer.from(notePdf).subarray(0, 5).toString()).toBe("%PDF-");
    expect(notePdf.byteLength).toBeGreaterThan(1000);
  });
});
