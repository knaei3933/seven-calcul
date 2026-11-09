import { withLegacySevenQuotationSave } from "./helpers/legacy-quotation-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";


const databaseDirectory = await mkdtemp(join(tmpdir(), "g006-approval-order-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.MAIL_DRY_RUN = "true";
process.env.FILM_DESIGN_TO = "film-workflow@kanei-trade.co.jp";
process.env.FILM_EXTERNAL_LINK_ORIGINS = "http://localhost:3000";
process.env.SEVEN_CHEMICAL_CONTACT_EMAIL = "seven-order@727.co.jp";

const { createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const { runFilmOrderAction, syncFilmOrdersFromQuotations, getDatabaseForFilmMakerStore, decideCustomerProofReview } = await import("@/lib/film-orders");
const { saveQuotation: directSaveQuotation, getDatabaseForTest } = await import("@/lib/quotation-store");
const saveQuotation = withLegacySevenQuotationSave(directSaveQuotation);
const { createFilmMaker } = await import("@/lib/film-maker-store");
await getDatabaseForTest();

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
  makerCode: "G006-K-DIG",
  companyName: "G006 Korea Maker",
  email: "g006-korea-maker@example.test",
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
    customerName: "G006 Approval Order Customer",
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
    calculationVersion: "g006-approval-order",
    resultHash: `g006-${number}`,
    payload: {
      customerCode: "G006-APPROVAL",
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
          skuCode: "SKU-G006-ORDER", name: "Approval Order", quantity: "10000", colorCount: "4",
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
  await runFilmOrderAction(order.id, "set-customer-design-not-required", { reason: "G006 approval order test" }, SEVEN);
  await runFilmOrderAction(order.id, "register-receiving", {
    aiFileName: `${number}.ai`,
    aiFileUrl: "https://drive.google.com/file/d/g006-order-ai/view",
    pdfFileName: `${number}.pdf`,
    pdfFileUrl: "https://drive.google.com/file/d/g006-order-pdf/view",
    guideAcknowledged: true,
    origin: "http://localhost:3000",
  }, SEVEN);
  const proof = await runFilmOrderAction(order.id, "register-proof", {
    aiFileName: `${number}-proof.ai`,
    aiFileUrl: "https://drive.google.com/file/d/g006-proof-ai/view",
    pdfFileName: `${number}-proof.pdf`,
    pdfFileUrl: "https://drive.google.com/file/d/g006-proof-pdf/view",
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

describe("G006 Seven/Kanei proof approval order independence", () => {
  it("completes when Kanei approves first and Seven approves second", async () => {
    const id = await proofReadyOrder("S7-G006-ORDER-A");
    const kaneiApproved = await runFilmOrderAction(id, "record-customer-proof-approval", {
      approverName: "Kanei First",
      evidence: "mail reply hash g006-a",
      offlineReason: "Recorded customer approval",
      origin: "http://localhost:3000",
    }, KANEI);
    expect(kaneiApproved.order.status).toBe("proof_registered");
    expect(kaneiApproved.order.customerProof.supplierApprovalStatus).toBe("approved");
    expect(kaneiApproved.order.customerProof.buyerApprovalStatus).toBe("pending");
    const sevenApproved = await runFilmOrderAction(id, "approve", {
      fileName: "S7-G006-ORDER-A-final.pdf",
      fileUrl: "https://drive.google.com/file/d/g006-final-a/view",
      origin: "http://localhost:3000",
    }, SEVEN);
    expect(sevenApproved.order.status).toBe("final_approved");
    expect(sevenApproved.order.customerProof.buyerApprovalStatus).toBe("approved");
    await expect(runFilmOrderAction(id, "send-po", { origin: "http://localhost:3000" }, KANEI))
      .rejects.toThrow("ship_to_confirmation_required");
  });

  it("completes when Seven approves first and Kanei approves second", async () => {
    const id = await proofReadyOrder("S7-G006-ORDER-B");
    const sevenApproved = await runFilmOrderAction(id, "approve", {
      fileName: "S7-G006-ORDER-B-final.pdf",
      fileUrl: "https://drive.google.com/file/d/g006-final-b/view",
      origin: "http://localhost:3000",
    }, SEVEN);
    expect(sevenApproved.order.status).toBe("proof_registered");
    expect(sevenApproved.order.customerProof.supplierApprovalStatus).toBe("pending");
    expect(sevenApproved.order.customerProof.buyerApprovalStatus).toBe("approved");
    const kaneiApproved = await runFilmOrderAction(id, "record-customer-proof-approval", {
      approverName: "Kanei Second",
      evidence: "mail reply hash g006-b",
      offlineReason: "Recorded customer approval",
      origin: "http://localhost:3000",
    }, KANEI);
    expect(kaneiApproved.order.status).toBe("final_approved");
    expect(kaneiApproved.order.customerProof.supplierApprovalStatus).toBe("approved");
    await expect(runFilmOrderAction(id, "send-po", { origin: "http://localhost:3000" }, SEVEN))
      .rejects.toThrow("film_order_actor_forbidden");
  });
});
