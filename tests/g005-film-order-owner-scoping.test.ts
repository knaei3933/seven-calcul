import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "g005-film-owner-scoping-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.MAIL_DRY_RUN = "true";
process.env.FILM_DESIGN_TO = "film-workflow@kanei-trade.co.jp";
process.env.FILM_EXTERNAL_LINK_ORIGINS = "http://localhost:3000";
process.env.SEVEN_CHEMICAL_CONTACT_EMAIL = "seven-buyer@727.co.jp";

const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { POST: filmOrderActionRoute } = await import("@/app/api/film-orders/[id]/route");
const { createUser } = await import("@/lib/auth-store");
const { createFilmMaker } = await import("@/lib/film-maker-store");
const {
  getDatabaseForFilmMakerStore,
  registerProofFromUploadToken,
  runFilmOrderAction,
  syncFilmOrdersFromQuotations,
  updateEtaFromToken,
} = await import("@/lib/film-orders");
const { getDatabaseForTest, saveQuotation } = await import("@/lib/quotation-store");

const KANEI = "kanei-owner@kanei-trade.co.jp";
const SEVEN = "seven-owner@727.co.jp";

function request(url: string, init: RequestInit = {}, token?: string): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { cookie: `pouch_session=${token}` } : {}),
    },
  });
}

function quotationInput(number: string): QuotationRecordInput {
  return {
    quotationNumber: number,
    status: "approved",
    issueDate: "2026-11-01",
    validUntil: "2026-12-01",
    customerName: "G005 得意先株式会社",
    customerContact: "G005 得意先担当",
    productName: `G005 ${number} パウチ`,
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
    calculationVersion: "g005-owner-scoping",
    resultHash: `g005-${number}`,
    payload: {
      customerCode: "G005-CUSTOMER",
      customerEmail: "g005-customer@example.test",
      purchaseOrder: {
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
          skuCode: "SKU-G005", name: "テスト充填物", quantity: "50000", colorCount: "4",
          requiredLengthM: "1333.34", orderLengthM: "1700", webWidthMm: 476, multiplier: 1,
        }],
        procurementRoute: "K",
      },
    },
  };
}

async function login(email: string): Promise<string> {
  const response = await loginRoute(request("http://localhost:3000/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: `${email.split("@")[0]}-password` }),
  }));
  expect(response.status).toBe(200);
  const token = response.headers.get("set-cookie")?.match(/pouch_session=([^;]+)/u)?.[1];
  expect(token).toBeTruthy();
  return token!;
}

async function routeAction(email: string, orderId: number, action: string): Promise<Response> {
  return filmOrderActionRoute(
    request(`http://localhost:3000/api/film-orders/${orderId}`, {
      method: "POST",
      body: JSON.stringify({ action, origin: "http://localhost:3000" }),
    }, await login(email)),
    { params: Promise.resolve({ id: String(orderId) }) } as never,
  );
}

async function outbox(orderId: number) {
  const db = await getDatabaseForFilmMakerStore();
  return (await db.all<Record<string, unknown>>(
    "SELECT * FROM film_order_mail_outbox WHERE order_id=? AND envelope_status='composed' ORDER BY id",
    [orderId],
  )).map((row) => ({
    audience: String(row.audience),
    intendedTo: String(row.intended_to),
    language: String(row.language),
    senderIdentity: String(row.sender_identity),
    subject: String(row.subject),
    linksJson: String(row.links_json),
  }));
}

async function buyerTokenFromMails(orderId: number): Promise<string> {
  const db = await getDatabaseForFilmMakerStore();
  const row = await db.get<{ links_json: string }>(
    "SELECT links_json FROM film_order_mail_outbox WHERE order_id=? AND audience='maker' ORDER BY id DESC LIMIT 1",
    [orderId],
  );
  const links = JSON.parse(row?.links_json ?? "[]") as Array<{ key: string; url: string }>;
  const token = links.find((link) => link.key === "maker_proof_upload")?.url.split("/upload/")[1]?.split(/[?\s]/u)[0];
  if (!token) throw new Error("missing supplier proof token");
  return decodeURIComponent(token);
}

beforeAll(async () => {
  await createUser({ email: KANEI, name: "Kanei Owner", password: "kanei-owner-password", role: "user" });
  await createUser({ email: SEVEN, name: "Seven Owner", password: "seven-owner-password", role: "user" });
  const { listUsers } = await import("@/lib/auth-store");
  const users = await listUsers();
  const kaneiId = users.find((user) => user.email === KANEI)!.id;
  const sevenId = users.find((user) => user.email === SEVEN)!.id;
  const sevenQuote = await saveQuotation(quotationInput("S7-G005-001"), sevenId, "user");
  const kaneiQuote = await saveQuotation(quotationInput("KT-G005-001"), kaneiId, "user");
  await (await getDatabaseForTest()).run("UPDATE quotations SET owner_domain='kanei', quotation_number='KT-G005-001' WHERE id=?", [kaneiQuote.id]);
  const { saveCustomer } = await import("@/lib/customer-store");
  await saveCustomer("seven", {
    customerCode: "G005-CUSTOMER",
    customerName: "G005 得意先株式会社",
    customerPostalCode: "650-0001",
    customerAddress: "神戸市G005 0-0-0",
    customerContact: "G005 得意先担当",
    customerTelephone: "078-000-0000",
    customerEmail: "g005-customer@example.test",
  });
  await saveCustomer("kanei", {
    customerCode: "G005-CUSTOMER",
    customerName: "G005 得意先株式会社",
    customerPostalCode: "650-0001",
    customerAddress: "神戸市G005 0-0-0",
    customerContact: "G005 得意先担当",
    customerTelephone: "078-000-0000",
    customerEmail: "g005-customer@example.test",
  });
  await createFilmMaker({
    makerCode: "G005-K-MAKER",
    companyName: "G005 Korean Film Maker",
    contactName: "G005 Maker Contact",
    email: "g005-maker@example.test",
    language: "ko",
    printMethod: "gravure",
    procurementRoute: "K",
  }, KANEI);
  await syncFilmOrdersFromQuotations("system");
});

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("G005 owner-scoped film workflow", () => {
  it.each([
    ["Seven-origin", "S7-G005-001", SEVEN, "727.co.jp"],
    ["Kanei-origin", "KT-G005-001", KANEI, "kanei-trade.co.jp"],
  ])("derives %s buyer, denies cross-owner API mutation, and completes its chain", async (_label, quoteNumber, buyer, buyerDomain) => {
    const crossOwner = buyer === SEVEN ? KANEI : SEVEN;
    const orders = await (await import("@/lib/film-orders")).listFilmOrders(buyer);
    const order = orders.find((item) => item.quotation_number === quoteNumber)!;
    expect(order.buyer_domain).toBe(buyerDomain);
    expect(order.seven_contact_email).toBe(buyer);

    expect((await routeAction(crossOwner, order.id, "mark-ordered")).status).toBe(403);
    const allowedMark = await routeAction(buyer, order.id, "mark-ordered");
    expect(allowedMark.status).toBe(200);
    expect(((await allowedMark.json()) as { order: { status: string } }).order.status).toBe("ordered");

    await runFilmOrderAction(order.id, "set-customer-design-not-required", { reason: "G005 自社製作データ" }, buyer);
    const receiving = await runFilmOrderAction(order.id, "register-receiving", {
      aiFileName: `${order.order_number}.ai`,
      aiFileUrl: "https://drive.google.com/file/d/g005-ai/view",
      pdfFileName: `${order.order_number}.pdf`,
      pdfFileUrl: "https://drive.google.com/file/d/g005-pdf/view",
      guideAcknowledged: true,
      origin: "http://localhost:3000",
    }, buyer);
    expect(receiving.order.status).toBe("receiving_registered");
    let envelopes = await outbox(order.id);
    const maker = envelopes.find((envelope) => envelope.audience === "maker");
    const buyerMail = envelopes.find((envelope) => envelope.audience === "seven");
    const kaneiMail = envelopes.find((envelope) => envelope.audience === "kanei");
    expect(maker).toMatchObject({ intendedTo: "g005-maker@example.test", language: "ko" });
    expect(buyerMail).toMatchObject({ intendedTo: buyer, senderIdentity: buyer === SEVEN ? "Seven Chemical Film Workflow" : "Kanei Trade Film Workflow" });
    expect(kaneiMail).toMatchObject({ intendedTo: "film-workflow@kanei-trade.co.jp" });

    const proof = await registerProofFromUploadToken({
      token: await buyerTokenFromMails(order.id),
      fileName: `${order.order_number}_proof.ai`,
      fileUrl: "https://drive.google.com/file/d/g005-proof-ai/view",
      pdfFileName: `${order.order_number}_proof.pdf`,
      pdfFileUrl: "https://drive.google.com/file/d/g005-proof-pdf/view",
    });
    expect(proof.status).toBe("proof_registered");

    await runFilmOrderAction(order.id, "record-customer-proof-approval", {
      approverName: "Kanei Approver",
      evidence: "G005 token decision hash",
      offlineReason: "専用トークン承認のオフライン記録",
      origin: "http://localhost:3000",
    }, KANEI);
    const finalApprover = SEVEN;
    const approved = await runFilmOrderAction(order.id, "approve", { origin: "http://localhost:3000" }, finalApprover);
    expect(approved.order.status).toBe("final_approved");
    expect(approved.order.customerProof.supplierApprovalBy).toBe(KANEI);
    expect(approved.order.customerProof.buyerApprovalBy).toBe(SEVEN);

    await runFilmOrderAction(order.id, "register-ship-to", {
      shipToCompanyName: "G005 Logistics",
      shipToPostalCode: "650-0001",
      shipToAddress: "神戸市G005 1-1-1",
      shipToPhone: "078-000-0000",
      saveShipToMaster: false,
    }, buyer);
    const confirmed = await runFilmOrderAction(order.id, "confirm-ship-to", {}, buyer);
    expect(confirmed.order.shipTo.status).toBe("confirmed");
    const po = await runFilmOrderAction(order.id, "send-po", {
      supplierOrderNote: "G005 supplier note",
      origin: "http://localhost:3000",
    }, KANEI);
    expect(po.order.po_sent_at).toBeTruthy();
    envelopes = await outbox(order.id);
    const poMail = envelopes.filter((envelope) => envelope.subject.includes("フィルム発注依頼") || envelope.subject.includes("필름 발주 요청"));
    expect(poMail.map((envelope) => envelope.audience).sort()).toEqual(["kanei", "maker", "seven"]);
    const poMaker = poMail.find((envelope) => envelope.audience === "maker")!;
    const etaToken = poMaker.linksJson.match(/\/film-orders\/eta\/([^"\\]+)/u)?.[1];
    expect(etaToken).toBeTruthy();
    const eta = await updateEtaFromToken(decodeURIComponent(etaToken!), "2026-12-10", undefined, "http://localhost:3000");
    expect(eta?.status).toBe("final_approved");
    expect(eta?.eta_date).toBe("2026-12-10");
    expect((await routeAction(crossOwner, order.id, "confirm-film-receipt")).status).toBe(403);
  });
});
