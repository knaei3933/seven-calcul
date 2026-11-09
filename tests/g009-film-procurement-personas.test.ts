import { withLegacySevenQuotationSave } from "./helpers/legacy-quotation-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";


const databaseDirectory = await mkdtemp(join(tmpdir(), "g009-film-procurement-personas-"));
const previousEnv = {
  adminEmail: process.env.ADMIN_EMAIL,
  adminName: process.env.ADMIN_NAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  filmDesignTo: process.env.FILM_DESIGN_TO,
  mailDryRun: process.env.MAIL_DRY_RUN,
  smtpHost: process.env.SMTP_HOST,
  smtpPassword: process.env.SMTP_PASSWORD,
  smtpPort: process.env.SMTP_PORT,
  smtpUser: process.env.SMTP_USER,
};
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_NAME = "Seven Chemical G009";
process.env.ADMIN_PASSWORD = "seven-g009-password";
process.env.FILM_DESIGN_TO = "kanei@kanei-trade.co.jp";
delete process.env.SMTP_HOST;
delete process.env.SMTP_PASSWORD;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;

const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { GET: filmOrderListRoute } = await import("@/app/api/film-orders/route");
const { GET: orderRoute, POST: filmOrderActionRoute } = await import("@/app/api/film-orders/[id]/route");
const { GET: outboxRoute } = await import("@/app/api/film-orders/[id]/mail-outbox/route");
const { POST: mailDispatchRoute } = await import("@/app/api/film-orders/[id]/mail-dispatch/route");
const { GET: proofReviewRoute, POST: proofReviewPostRoute } = await import(
  "@/app/api/film-orders/proof-review/[token]/route"
);
const { POST: etaRoute } = await import("@/app/api/film-orders/eta/[token]/route");
const { POST: shipToRoute } = await import("@/app/api/film-orders/ship-to/[token]/route");
const { createUser } = await import("@/lib/auth-store");
const { saveCustomer } = await import("@/lib/customer-store");
const { createFilmMaker } = await import("@/lib/film-maker-store");
const {
  getDatabaseForFilmMakerStore,
  getFilmOrder,
  getFilmOrderForSupplierPurchaseOrder,
  registerProofFromUploadToken,
} = await import("@/lib/film-orders");
const { saveMailSettings } = await import("@/lib/mail-settings");
const { filmOrderStageOf } = await import("@/lib/film-order-stage");
const { saveQuotation: directSaveQuotation } = await import("@/lib/quotation-store");
const saveQuotation = withLegacySevenQuotationSave(directSaveQuotation);

const SMTP_INBOX = "smtp-inbox@example.test";
const KANEI = "kanei@kanei-trade.co.jp";
const SEVEN = "seven@727.co.jp";

interface Session {
  id: number;
  token?: string;
}

interface OutboxRecord {
  id: number;
  audience: "maker" | "seven" | "kanei" | "customer";
  intendedTo: string;
  cc: string[];
  language: "ja" | "ko";
  subject: string;
  body: string;
  links: Array<{ key: string; url: string }>;
  envelopeStatus: string;
  attempts: Array<{ status: string; attemptCount: number }>;
}

function today(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function request(url: string, init: RequestInit = {}, sessionToken?: string): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(sessionToken ? { cookie: `pouch_session=${sessionToken}` } : {}),
    },
  });
}

async function login(email: string, password: string): Promise<string | undefined> {
  const response = await loginRoute(request("http://localhost/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }));
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.match(/pouch_session=([^;]+)/u)?.[1];
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function expectRoute(
  response: Response,
  expectedStatus: number,
  label: string,
): Promise<Record<string, unknown>> {
  const body = await json(response);
  expect(body, label).not.toHaveProperty("error");
  expect(response.status, `${label}: ${JSON.stringify(body)}`).toBe(expectedStatus);
  return body;
}

async function actorAction(
  sessionToken: string | undefined,
  orderId: number,
  action: string,
  params: Record<string, unknown> = {},
  expectedStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await filmOrderActionRoute(
    request(`http://localhost/api/film-orders/${orderId}`, {
      method: "POST",
      body: JSON.stringify({ action, mailMode: "confirm", ...params }),
    }, sessionToken),
    { params: Promise.resolve({ id: String(orderId) }) } as never,
  );
  return await expectRoute(response, expectedStatus, `${action} as ${sessionToken === KANEI ? "Kanei" : "Seven"}`);
}

async function expectForbiddenRoute(response: Response, expectedStatus: number, label: string): Promise<void> {
  const body = await json(response);
  expect(body.error, label).toBeTruthy();
  expect(response.status, `${label}: ${JSON.stringify(body)}`).toBe(expectedStatus);
}

async function seedScenario(label: string, procurementRoute: "K" | "Y") {
  const makerEmail = `${label.toLowerCase()}-maker@example.test`;
  const customerEmail = `${label.toLowerCase()}-customer@example.test`;
  await saveCustomer("seven", {
    customerCode: `G009-${label}`,
    customerName: `G009 ${label}株式会社`,
    customerPostalCode: "650-0001",
    customerAddress: "兵庫県神戸市テスト1-2-3",
    customerContact: "G009顧客担当",
    customerTelephone: "078-000-0000",
    customerEmail,
  });
  const quotation = await saveQuotation({
    quotationNumber: `S7-G009-${label}-001`,
    status: "approved",
    issueDate: today(),
    validUntil: today(30),
    customerName: `G009 ${label}株式会社`,
    customerContact: "G009顧客担当",
    productName: `G009 ${label}パウチ`,
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
    calculationVersion: "g009-persona",
    resultHash: "g009-hash",
    payload: {
      customerCode: `G009-${label}`,
      customerEmail,
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
          skuCode: `SKU-${label}`, name: "テスト充填物", quantity: "50000", colorCount: "4",
          requiredLengthM: "1333.34", orderLengthM: "1700", webWidthMm: 476, multiplier: 1,
        }],
        procurementRoute,
      },
    },
  } satisfies QuotationRecordInput, 1, "admin");
  const maker = await createFilmMaker({
    makerCode: `G009-${procurementRoute}-${label}`,
    companyName: `G009 ${label} Film Maker`,
    contactName: `${label} Maker Contact`,
    email: makerEmail,
    language: procurementRoute === "K" ? "ko" : "ja",
    printMethod: "gravure",
    procurementRoute,
  }, KANEI);
  return { orderId: quotation.id, makerEmail, customerEmail, makerId: maker.id };
}

async function latestAudienceToken(
  orderId: number,
  pathSegment: string,
  audience: "maker" | "customer" = "customer",
): Promise<string> {
  const db = await getDatabaseForFilmMakerStore();
  const rows = await db.all<{ links_json: string }>(
    "SELECT links_json FROM film_order_mail_outbox WHERE order_id=? AND audience=? ORDER BY id DESC",
    [orderId, audience],
  );
  const token = rows.flatMap((row) => JSON.parse(row.links_json) as Array<{ key: string; url: string }>)
    .map((link) => link.url.split(`/${pathSegment}/`)[1]?.split(/[?\s]/u)[0])
    .find(Boolean);
  if (!token) throw new Error(`missing ${pathSegment} token`);
  return decodeURIComponent(token);
}

function tokenFromMail(body: Record<string, unknown>, path: string): string {
  const mails = body.mails as Array<{ text?: string }> | undefined;
  const token = mails?.map((mail) => String(mail.text ?? ""))
    .map((text) => text.match(new RegExp(`/film-orders/${path}/([^\\s"]+)`, "u"))?.[1])
    .find(Boolean);
  if (!token) throw new Error(`missing ${path} token`);
  return decodeURIComponent(token);
}

async function outboxGroup(orderId: number, dispatchGroupId: string): Promise<OutboxRecord[]> {
  const db = await getDatabaseForFilmMakerStore();
  const rows = await db.all<Record<string, unknown>>(
    "SELECT * FROM film_order_mail_outbox WHERE order_id=? AND dispatch_group_id=? ORDER BY id",
    [orderId, dispatchGroupId],
  );
  const attempts = await db.all<Record<string, unknown>>(
    `SELECT a.outbox_id, a.status, a.attempt_count
     FROM film_order_mail_attempts a
     INNER JOIN film_order_mail_outbox o ON o.id=a.outbox_id
     WHERE o.order_id=? AND o.dispatch_group_id=? ORDER BY a.id`,
    [orderId, dispatchGroupId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    audience: row.audience as OutboxRecord["audience"],
    intendedTo: String(row.intended_to),
    cc: JSON.parse(String(row.cc_json)) as string[],
    language: row.language as OutboxRecord["language"],
    subject: String(row.subject),
    body: String(row.body),
    links: JSON.parse(String(row.links_json)) as OutboxRecord["links"],
    envelopeStatus: String(row.envelope_status),
    attempts: attempts
      .filter((attempt) => Number(attempt.outbox_id) === Number(row.id))
      .map((attempt) => ({
        status: String(attempt.status),
        attemptCount: Number(attempt.attempt_count),
      })),
  }));
}

async function assertReceivingEnvelope(
  orderId: number,
  lifecycle: Record<string, unknown>,
  route: "K" | "Y",
  makerEmail: string,
  customerEmail: string,
) {
  const dispatchGroupId = String(lifecycle.dispatchGroupId).split(",")[0];
  const envelopes = await outboxGroup(orderId, dispatchGroupId);
  const byAudience = Object.fromEntries(envelopes.map((envelope) => [envelope.audience, envelope]));
  expect(envelopes.map((envelope) => envelope.audience).sort()).toEqual(["kanei", "maker", "seven"]);
  expect(envelopes.some((envelope) => envelope.intendedTo === customerEmail)).toBe(false);
  expect(byAudience.maker?.language).toBe(route === "K" ? "ko" : "ja");
  expect(byAudience.maker?.subject).toContain(route === "K" ? "제작 데이터 수령 요청" : "制作データ受領依頼");
  expect(byAudience.maker?.body).toContain("G009");
  expect(byAudience.maker?.body).toContain(route === "K" ? "발주 번호" : "発注番号");
  expect(byAudience.maker?.links.map((link) => link.key)).toEqual(["maker_proof_upload", "maker_receiving_packet"]);

  const seven = byAudience.seven!;
  expect(seven.language).toBe("ja");
  expect(seven.intendedTo).toBe(SEVEN);
  expect(seven.body).toContain("現在のワークフロー段階");
  expect(seven.body).not.toContain(makerEmail);
  expect(seven.body).not.toContain("G009 Film Maker");
  expect(seven.body).not.toContain("internal-cost");
  expect(seven.links.map((link) => link.key)).toEqual(["seven_order_summary"]);

  const kanei = byAudience.kanei!;
  expect(kanei.intendedTo).toBe(KANEI);
  expect(kanei.cc).toEqual([]);
  for (const envelope of envelopes) {
    expect(envelope.envelopeStatus).toBe("composed");
    expect(envelope.attempts).toHaveLength(1);
    expect(envelope.attempts[0]?.status).toBe("skipped");
  }
  return envelopes;
}

async function assertOutboxAttemptsRoutedToTestInbox(orderId: number, dispatchGroupId: string) {
  const db = await getDatabaseForFilmMakerStore();
  const attempts = await db.all<Record<string, unknown>>(`
    SELECT a.intended_to, a.actual_to, a.recipient_overridden, a.status, a.smtp_message_id
    FROM film_order_mail_attempts a
    INNER JOIN film_order_mail_outbox o ON o.id=a.outbox_id
    WHERE o.order_id=? AND o.dispatch_group_id=?
  `, [orderId, dispatchGroupId]);
  expect(attempts.length).toBeGreaterThan(0);
  for (const attempt of attempts) {
    expect(attempt.intended_to).not.toBe(SMTP_INBOX);
    expect(attempt.actual_to).toBe(SMTP_INBOX);
    expect(Number(attempt.recipient_overridden)).toBe(1);
    expect(attempt.status).toBe("skipped");
    expect(attempt.smtp_message_id).toBeNull();
  }
}

async function completeChain(route: "K" | "Y") {
  const label = route === "K" ? "Korean" : "Japanese";
  const seven = await login(SEVEN, "seven-g009-password") as string;
  const kanei = await login(KANEI, "kanei-g009-password") as string;
  const seed = await seedScenario(label, route);
  const orderId = seed.orderId;

  const outsider = await login("outsider-g009@example.com", "outsider-g009-password");
  const outsiderList = await filmOrderListRoute(request("http://localhost/api/film-orders", {}, outsider));
  expect(outsiderList.status).toBe(403);
  const list = await expectRoute(
    await filmOrderListRoute(request("http://localhost/api/film-orders", {}, seven)),
    200,
    "Seven order list",
  );
  const projectedOrder = (list.orders as Array<Record<string, unknown>>).find((item) => item.id === orderId)!;
  expect(projectedOrder.status).toBe("pending");
  expect(projectedOrder).not.toHaveProperty("film_maker_id");
  expect(projectedOrder).not.toHaveProperty("supplier_email");

  await expectRoute(await orderRoute(request(`http://localhost/api/film-orders/${orderId}`, {}, seven), {
    params: Promise.resolve({ id: String(orderId) }),
  } as never), 200, "Seven order read");

  await actorAction(seven, orderId, "mark-ordered");
  await expectForbiddenRoute(await filmOrderActionRoute(
    request(`http://localhost/api/film-orders/${orderId}`, {
      method: "POST",
      body: JSON.stringify({ action: "mark-ordered" }),
    }, kanei),
    { params: Promise.resolve({ id: String(orderId) }) } as never,
  ), 403, "Kanei forbidden buyer action");
  await actorAction(seven, orderId, "set-customer-design-not-required", { reason: "G009 data already received" });

  const selected = await actorAction(kanei, orderId, "select-film-maker", { makerId: seed.makerId });
  expect(selected.order).toMatchObject({ status: "ordered" });
  await expectForbiddenRoute(await filmOrderActionRoute(
    request(`http://localhost/api/film-orders/${orderId}`, {
      method: "POST",
      body: JSON.stringify({ action: "select-film-maker", makerId: seed.makerId }),
    }, seven),
    { params: Promise.resolve({ id: String(orderId) }) } as never,
  ), 403, "Seven forbidden maker selection");

  const receiving = await actorAction(seven, orderId, "register-receiving", {
    aiFileName: `${orderId}_packet.ai`,
    aiFileUrl: "https://drive.google.com/file/d/g009-ai/view",
    pdfFileName: `${orderId}_packet.pdf`,
    pdfFileUrl: "https://drive.google.com/file/d/g009-pdf/view",
    guideAcknowledged: true,
  });
  const orderNumber = String((receiving.order as Record<string, unknown>).order_number);
  expect((receiving.order as Record<string, unknown>).status).toBe("receiving_registered");
  expect(receiving).not.toHaveProperty("mails");
  await assertReceivingEnvelope(orderId, receiving.lifecycle as Record<string, unknown>, route, seed.makerEmail, seed.customerEmail);
  await assertOutboxAttemptsRoutedToTestInbox(orderId, String((receiving.lifecycle as Record<string, unknown>).dispatchGroupId).split(",")[0]);

  const makerOutbox = await outboxGroup(orderId, String((receiving.lifecycle as Record<string, unknown>).dispatchGroupId).split(",")[0]);
  const receivingMakerEnvelope = makerOutbox.find((envelope) => envelope.audience === "maker")!;
  const makerToken = receivingMakerEnvelope.links.find((link) => link.key === "maker_proof_upload")!.url
    .split("/upload/")[1]!.split(/[?\s]/u)[0];
  const proof = await registerProofFromUploadToken({
    token: await latestAudienceToken(orderId, "upload", "maker"),
    fileName: `${orderNumber}_proof_v1.ai`,
    fileUrl: "https://drive.google.com/file/d/g009-proof1-ai/view",
    pdfFileName: `${orderNumber}_proof_v1.pdf`,
    pdfFileUrl: "https://drive.google.com/file/d/g009-proof1-pdf/view",
    uploader: route === "K" ? "한국 메이커 담당" : "日本メーカー担当",
    origin: "http://localhost:3000",
  });
  expect(proof.status).toBe("proof_registered");

  const review = await actorAction(seven, orderId, "send-customer-proof-review", { origin: "http://localhost:3000" });
  const reviewToken = await latestAudienceToken(orderId, "proof-review");
  const reviewEnvelopes = await outboxGroup(
    orderId,
    String((review.lifecycle as Record<string, unknown>).dispatchGroupId).split(",")[0],
  );
  const customerReview = reviewEnvelopes.find((envelope) => envelope.audience === "customer")!;
  expect(reviewEnvelopes.map((envelope) => envelope.audience).sort()).toEqual(["customer", "kanei", "seven"]);
  expect(customerReview.intendedTo).toBe(seed.customerEmail);
  expect(customerReview.language).toBe("ja");
  expect(customerReview.subject).toContain("校正データご確認のお願い");
  expect(customerReview.links.map((link) => link.key)).toEqual(["customer_proof_review"]);
  expect(customerReview.body).not.toContain(seed.makerEmail);
  expect(customerReview.body).not.toContain("G009 Film Maker");
  expect(customerReview.body).not.toContain("internal-cost");
  const reviewPage = await expectRoute(await proofReviewRoute(
    request(`http://localhost/api/film-orders/proof-review/${reviewToken}`),
    { params: Promise.resolve({ token: reviewToken }) } as never,
  ), 200, "Customer proof review GET");
  expect(reviewPage.canDecide).toBe(true);
  const corrected = await expectRoute(await proofReviewPostRoute(
    request(`http://localhost/api/film-orders/proof-review/${reviewToken}`, {
      method: "POST",
      body: JSON.stringify({ decision: "correction", reason: "ロゴ位置を修正してください" }),
    }),
    { params: Promise.resolve({ token: reviewToken }) } as never,
  ), 200, "Customer correction");
  expect(corrected.decision).toBe("correction_requested");
  await expectForbiddenRoute(await proofReviewRoute(
    request(`http://localhost/api/film-orders/proof-review/${makerToken}`),
    { params: Promise.resolve({ token: makerToken }) } as never,
  ), 403, "Cross-purpose customer token");
  const reProof = await actorAction(seven, orderId, "request-re-proof", {
    comment: "Correct customer-reported logo position",
    supplierMessage: route === "K" ? "로고 위치를 수정해 주세요." : "ロゴ位置を修正してください。",
    origin: "http://localhost:3000",
  });
  expect((reProof.order as Record<string, unknown>).status).toBe("re_proof_requested");

  const correctedMakerToken = await latestAudienceToken(orderId, "upload", "maker");
  await registerProofFromUploadToken({
    token: correctedMakerToken,
    fileName: `${orderNumber}_proof_v2.ai`,
    fileUrl: "https://drive.google.com/file/d/g009-proof2-ai/view",
    pdfFileName: `${orderNumber}_proof_v2.pdf`,
    pdfFileUrl: "https://drive.google.com/file/d/g009-proof2-pdf/view",
    uploader: "maker",
    origin: "http://localhost:3000",
  });
  await actorAction(seven, orderId, "send-customer-proof-review", { origin: "http://localhost:3000" });
  const finalReviewToken = await latestAudienceToken(orderId, "proof-review");
  const approved = await expectRoute(await proofReviewPostRoute(
    request(`http://localhost/api/film-orders/proof-review/${finalReviewToken}`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    }),
    { params: Promise.resolve({ token: finalReviewToken }) } as never,
  ), 200, "Customer approval");
  expect(approved.decision).toBe("approved");

  const sellerApproved = await actorAction(kanei, orderId, "record-customer-proof-approval", {
    approverName: "Kanei G009 Approver",
    evidence: "Customer approval reviewed",
    offlineReason: "記録された顧客承認のオフライン確認",
  });
  expect((sellerApproved.order as Record<string, unknown>).status).toBe("proof_registered");
  const buyerApproved = await actorAction(seven, orderId, "approve", {
    fileName: `${orderId}_final.pdf`,
    fileUrl: "https://drive.google.com/file/d/g009-final/view",
  });
  expect((buyerApproved.order as Record<string, unknown>).status).toBe("final_approved");
  const shipToToken = await latestAudienceToken(orderId, "ship-to");
  const shipToPage = await expectRoute(await (await import("@/app/api/film-orders/ship-to/[token]/route")).GET(
    request(`http://localhost/api/film-orders/ship-to/${shipToToken}`),
    { params: Promise.resolve({ token: shipToToken }) } as never,
  ), 200, "Customer ship-to GET");
  expect(shipToPage.status).toBe("not_provided");
  await expectRoute(await shipToRoute(request(`http://localhost/api/film-orders/ship-to/${shipToToken}`, {
    method: "POST",
    body: JSON.stringify({
      values: {
        label: "G009倉庫",
        companyName: "G009物流株式会社",
        postalCode: "550-0001",
        address: "大阪府大阪市テスト1-1-1",
        phone: "06-0000-0000",
      },
    }),
  }), { params: Promise.resolve({ token: shipToToken }) } as never), 200, "Customer ship-to registration");
  await actorAction(seven, orderId, "confirm-ship-to");

  await actorAction(kanei, orderId, "update-supplier-order-note", {
    supplierOrderNote: route === "K" ? "한국 발주 지시" : "国内発注指示",
  });
  const po = await actorAction(kanei, orderId, "send-po", { origin: "http://localhost:3000" });
  expect((po.order as Record<string, unknown>).po_sent_at).toBeTruthy();
  const poMakerToken = tokenFromMail(po, "purchase-order");
  const poView = await getFilmOrderForSupplierPurchaseOrder(poMakerToken);
  expect(poView.id).toBe(orderId);
  expect(poView.events.some((event) => event.type === "token_access" && event.detail.includes("supplier_po"))).toBe(true);

  const etaToken = tokenFromMail(po, "eta");
  const eta = await expectRoute(await etaRoute(
    request(`http://localhost/api/film-orders/eta/${etaToken}`, {
      method: "POST",
      body: JSON.stringify({ etaDate: today(7), note: route === "K" ? "제작 완료 후 출하" : "制作後に出荷" }),
    }),
    { params: Promise.resolve({ token: etaToken }) } as never,
  ), 200, "Maker ETA");
  expect((eta.order as Record<string, unknown>).eta_date).toBe(today(7));
  const shipmentEtaToken = await latestAudienceToken(orderId, "eta", "maker");
  await expectForbiddenRoute(await etaRoute(
    request(`http://localhost/api/film-orders/eta/${shipmentEtaToken}`, {
      method: "POST",
      body: JSON.stringify({ etaDate: today(8), note: "invalid signature attempt" }),
    }),
    { params: Promise.resolve({ token: `${shipmentEtaToken}x` }) } as never,
  ), 403, "Invalid maker token");

  const shipment = await expectRoute(await etaRoute(
    request(`http://localhost/api/film-orders/eta/${shipmentEtaToken}`, {
      method: "POST",
      body: JSON.stringify({
        kind: "shipment",
        date: today(9),
        note: route === "K" ? "출하 완료" : "出荷完了",
        carrier: "G009 Freight",
        trackingNumber: `G009-${route}-001`,
        documents: [{ name: "g009-delivery.pdf", url: "https://drive.google.com/file/d/g009-delivery/view" }],
      }),
    }),
    { params: Promise.resolve({ token: shipmentEtaToken }) } as never,
  ), 200, "Maker shipment");
  expect((shipment.order as Record<string, unknown>).delivery).toMatchObject({ shippedOn: today(9), carrier: "G009 Freight" });

  const delivery = await expectRoute(await etaRoute(
    request(`http://localhost/api/film-orders/eta/${shipmentEtaToken}`, {
      method: "POST",
      body: JSON.stringify({ kind: "delivery", date: today(11), note: route === "K" ? "현장 도착" : "現場到着" }),
    }),
    { params: Promise.resolve({ token: shipmentEtaToken }) } as never,
  ), 200, "Maker delivery");
  expect((delivery.order as Record<string, unknown>).delivery).toMatchObject({ deliveredOn: today(11) });

  await expectForbiddenRoute(await filmOrderActionRoute(
    request(`http://localhost/api/film-orders/${orderId}`, {
      method: "POST",
      body: JSON.stringify({ action: "confirm-film-receipt" }),
    }, kanei),
    { params: Promise.resolve({ id: String(orderId) }) } as never,
  ), 403, "Kanei forbidden receipt");
  const receipt = await actorAction(seven, orderId, "confirm-film-receipt", { note: "数量・外観確認済み" });
  expect((receipt.order as Record<string, unknown>).status).toBe("final_approved");

  const finalOrder = await getFilmOrder(orderId);
  expect(filmOrderStageOf({
    status: finalOrder!.status,
    orderedAt: finalOrder!.ordered_at,
    receivingRegisteredAt: finalOrder!.receiving_registered_at,
    proofRegisteredAt: finalOrder!.proof_registered_at,
    reProofRequestedAt: finalOrder!.re_proof_requested_at,
    finalApprovedAt: finalOrder!.final_approved_at,
    customerDesignStatus: finalOrder!.customer_design_status,
    customerProofStatus: finalOrder!.customerProof.status,
    supplierApprovalStatus: finalOrder!.customerProof.supplierApprovalStatus,
    supplierApprovalAt: finalOrder!.customerProof.supplierApprovalAt,
    buyerApprovalStatus: finalOrder!.customerProof.buyerApprovalStatus,
    buyerApprovalAt: finalOrder!.customerProof.buyerApprovalAt,
    poSentAt: finalOrder!.po_sent_at,
    etaUpdatedAt: finalOrder!.eta_updated_at,
    shippedAt: finalOrder!.delivery.shippedAt,
    deliveredAt: finalOrder!.delivery.deliveredAt,
    receivedAt: finalOrder!.delivery.receivedAt,
  })).toBe("complete");
  expect(finalOrder?.customerProof).toMatchObject({ status: "approved", correctionCount: 1 });
  expect(finalOrder?.shipTo.status).toBe("confirmed");
  expect(finalOrder?.delivery).toMatchObject({ shippedOn: today(9), deliveredOn: today(11) });
  expect(finalOrder?.events.some((event) => event.type === "mail_audit" || event.type === "email")).toBe(true);
  expect(finalOrder?.events.some((event) => event.detail.includes("セブン化学校正承認"))).toBe(true);
  expect(finalOrder?.events.some((event) => event.detail.includes("顧客が校正を承認"))).toBe(true);
  expect(finalOrder?.events.some((event) => event.type === "token_access")).toBe(true);

  const sevenOutbox = await expectRoute(await outboxRoute(
    request(`http://localhost/api/film-orders/${orderId}/mail-outbox`, {}, seven),
    { params: Promise.resolve({ id: String(orderId) }) } as never,
  ), 200, "Seven outbox");
  for (const envelope of sevenOutbox.envelopes as Array<Record<string, unknown>>) {
    expect(envelope.audience).toBe("seven");
    expect(envelope).not.toHaveProperty("body");
    expect(envelope).not.toHaveProperty("intendedTo");
  }
  const kaneiOutbox = await expectRoute(await outboxRoute(
    request(`http://localhost/api/film-orders/${orderId}/mail-outbox`, {}, kanei),
    { params: Promise.resolve({ id: String(orderId) }) } as never,
  ), 200, "Kanei outbox");
  expect((kaneiOutbox.envelopes as Array<Record<string, unknown>>).length).toBeGreaterThan(10);
}

describe("G009 film procurement persona chains", () => {
  it("completes the independent Korean maker chain with Korean maker mail and persona guards", async () => {
    await completeChain("K");
  });

  it("completes the independent Japanese maker chain with Japanese maker mail and persona guards", async () => {
    await completeChain("Y");
  });

  it("keeps SMTP failure explicit and preserves retry without claiming notification success", async () => {
    const seven = await login(SEVEN, "seven-g009-password") as string;
    const kanei = await login(KANEI, "kanei-g009-password") as string;
    const seed = await seedScenario("Failure", "K");
    const failureList = await expectRoute(
      await filmOrderListRoute(request("http://localhost/api/film-orders", {}, seven)),
      200,
      "Failure order sync",
    );
    expect((failureList.orders as Array<Record<string, unknown>>).some((order) => order.id === seed.orderId)).toBe(true);
    await actorAction(seven, seed.orderId, "mark-ordered");
    await actorAction(seven, seed.orderId, "set-customer-design-not-required", { reason: "failure path" });
    await actorAction(kanei, seed.orderId, "select-film-maker", { makerId: seed.makerId });

    process.env.MAIL_DRY_RUN = "false";
    try {
      const failed = await actorAction(seven, seed.orderId, "register-receiving", {
        aiFileName: `${seed.orderId}_failure.ai`,
        aiFileUrl: "https://drive.google.com/file/d/g009-failure-ai/view",
        pdfFileName: `${seed.orderId}_failure.pdf`,
        pdfFileUrl: "https://drive.google.com/file/d/g009-failure-pdf/view",
        guideAcknowledged: true,
      });
      const lifecycle = failed.lifecycle as { dispatchGroupId: string; notificationCompleted: boolean; workflowCompleted: boolean };
      expect(lifecycle.workflowCompleted).toBe(true);
      expect(lifecycle.notificationCompleted).toBe(false);
      const envelopes = await outboxGroup(seed.orderId, lifecycle.dispatchGroupId.split(",")[0]);
      expect(envelopes.length).toBeGreaterThan(0);
      expect(envelopes.every((envelope) => envelope.envelopeStatus === "composed")).toBe(true);
      const db = await getDatabaseForFilmMakerStore();
      const attempts = await db.all<Record<string, unknown>>(`
        SELECT a.status, a.error_code, a.intended_to, a.actual_to
        FROM film_order_mail_attempts a
        INNER JOIN film_order_mail_outbox o ON o.id=a.outbox_id
        WHERE o.order_id=? AND o.dispatch_group_id=?
      `, [seed.orderId, lifecycle.dispatchGroupId.split(",")[0]]);
      expect(attempts.length).toBe(envelopes.length);
      expect(attempts.every((attempt) => attempt.status === "retry_required")).toBe(true);
      expect(attempts.every((attempt) => attempt.error_code === "smtp_credentials_missing")).toBe(true);
      expect(attempts.every((attempt) => attempt.intended_to !== SMTP_INBOX)).toBe(true);
      expect(attempts.every((attempt) => attempt.actual_to === SMTP_INBOX)).toBe(true);

      await expectForbiddenRoute(await mailDispatchRoute(
        request(`http://localhost/api/film-orders/${seed.orderId}/mail-dispatch`, {
          method: "POST",
          body: JSON.stringify({ operation: "retry", dispatchGroupId: lifecycle.dispatchGroupId.split(",")[0] }),
        }, seven),
        { params: Promise.resolve({ id: String(seed.orderId) }) } as never,
      ), 403, "Seven forbidden retry");
      process.env.MAIL_DRY_RUN = "true";
      const retried = await expectRoute(await mailDispatchRoute(
        request(`http://localhost/api/film-orders/${seed.orderId}/mail-dispatch`, {
          method: "POST",
          body: JSON.stringify({ operation: "retry", dispatchGroupId: lifecycle.dispatchGroupId.split(",")[0] }),
        }, kanei),
        { params: Promise.resolve({ id: String(seed.orderId) }) } as never,
      ), 200, "Kanei retry");
      expect(retried.notificationCompleted).toBe(false);
      expect((retried.outcomes as Array<Record<string, unknown>>).every((outcome) => outcome.status === "skipped")).toBe(true);
    } finally {
      process.env.MAIL_DRY_RUN = previousEnv.mailDryRun ?? "true";
    }
  });
});

beforeAll(async () => {
  await createUser({ email: KANEI, name: "Kanei G009", password: "kanei-g009-password", role: "user" });
  await createUser({ email: "outsider-g009@example.com", name: "Outsider", password: "outsider-g009-password", role: "user" });
  await saveMailSettings({
    version: 1,
    testMode: { enabled: true, recipient: SMTP_INBOX },
    sender: { name: "G009 Test", email: "workflow-sender@example.test" },
    globalCc: [],
    recipients: {
      design: "",
      seven: "",
      kaneiApprovals: "",
      supplierKorean: "",
      supplierJapanese: "",
    },
    templates: {},
  }, "test");
});

afterAll(async () => {
  if (previousEnv.adminEmail === undefined) delete process.env.ADMIN_EMAIL; else process.env.ADMIN_EMAIL = previousEnv.adminEmail;
  if (previousEnv.adminName === undefined) delete process.env.ADMIN_NAME; else process.env.ADMIN_NAME = previousEnv.adminName;
  if (previousEnv.adminPassword === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = previousEnv.adminPassword;
  if (previousEnv.filmDesignTo === undefined) delete process.env.FILM_DESIGN_TO; else process.env.FILM_DESIGN_TO = previousEnv.filmDesignTo;
  if (previousEnv.mailDryRun === undefined) delete process.env.MAIL_DRY_RUN; else process.env.MAIL_DRY_RUN = previousEnv.mailDryRun;
  if (previousEnv.smtpHost === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = previousEnv.smtpHost;
  if (previousEnv.smtpPassword === undefined) delete process.env.SMTP_PASSWORD; else process.env.SMTP_PASSWORD = previousEnv.smtpPassword;
  if (previousEnv.smtpPort === undefined) delete process.env.SMTP_PORT; else process.env.SMTP_PORT = previousEnv.smtpPort;
  if (previousEnv.smtpUser === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = previousEnv.smtpUser;
  await rm(databaseDirectory, { recursive: true, force: true });
});
