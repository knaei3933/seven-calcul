// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "g004-maker-handoff-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.MAIL_RECIPIENT_OVERRIDE = "safe-test-inbox@example.test";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-g004-password";
process.env.ADMIN_NAME = "Seven G004";
process.env.FILM_EXTERNAL_TOKEN_SECRET = "g004-film-external-token-secret-32-bytes!";

const driveMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getConfirmedUpload: vi.fn(),
  downloadFile: vi.fn(),
}));
vi.mock("@/lib/google-drive", () => ({
  browserOriginOf: () => "http://localhost:3000",
  createResumableSession: driveMocks.createSession,
  customerDesignFolderId: () => "customer-design-folder",
  deliveryDocumentFolderId: () => "delivery-folder",
  driveConfigured: () => true,
  getConfirmedDriveUpload: driveMocks.getConfirmedUpload,
  downloadFile: driveMocks.downloadFile,
  proofFolderId: () => "proof-folder",
  receivingFolderId: () => "receiving-folder",
}));

const { POST: internalSession } = await import("@/app/api/data-intake/[quotationId]/upload-session/route");
const { POST: internalComplete } = await import("@/app/api/data-intake/[quotationId]/upload-complete/route");
const { GET: makerDownload } = await import("@/app/api/film-orders/design-download/[token]/route");
const { POST: tokenDesignUpload } = await import("@/app/api/film-orders/design-upload/[token]/route");
const { createSession, createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const { getDatabaseForTest, saveQuotation } = await import("@/lib/quotation-store");
const {
  filmExternalTokenHashForTest,
  getFilmOrder,
  nextCustomerDesignFileName,
  runFilmOrderAction,
  syncFilmOrdersFromQuotations,
} = await import("@/lib/film-orders");
const { createFilmMaker, selectFilmMakerForOrder } = await import("@/lib/film-maker-store");

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function input(quotationNumber: string): QuotationRecordInput {
  return {
    quotationNumber,
    status: "approved",
    issueDate: "2026-11-06",
    validUntil: "2099-12-31",
    customerName: `G004 ${quotationNumber}`,
    customerContact: "",
    productName: "自動メーカー引継パウチ",
    sizeSummary: "",
    quantity: "18000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "5",
    filmMeterPrice: "180",
    filmOrderLengthM: "1700",
    targetMargin: "0.3",
    taxRatePercent: "10",
    pricePerPiece: "20",
    subtotal: "360000",
    tax: "36000",
    grandTotal: "396000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "g004-handoff",
    resultHash: "",
    payload: { customerEmail: "g004-customer@example.test" },
  };
}

const sevenOwner = await createUser({
  email: "seven-owner@727.co.jp",
  name: "Seven Owner",
  password: "seven-g004-owner-password",
  role: "user",
});
const seedQuote = await saveQuotation(input("S7-G004-SEED"), sevenOwner.id, "user");
void seedQuote;
await syncFilmOrdersFromQuotations("seven-owner@727.co.jp");
const koreanMaker = await createFilmMaker({
  makerCode: "G004-KO-001",
  companyName: "G004 Korean Maker",
  email: "g004-korean-maker@example.test",
  language: "ko",
  printMethod: "digital",
  procurementRoute: "K",
}, "kanei@kanei-trade.co.jp");
const japaneseMaker = await createFilmMaker({
  makerCode: "G004-JA-001",
  companyName: "G004 Japanese Maker",
  email: "g004-japanese-maker@example.test",
  language: "ja",
  printMethod: "digital",
  procurementRoute: "K",
}, "kanei@kanei-trade.co.jp");

const koQuote = await saveQuotation(input("S7-G004-KO"), sevenOwner.id, "user");
const jaQuote = await saveQuotation(input("S7-G004-JA"), sevenOwner.id, "user");
const failureQuote = await saveQuotation(input("S7-G004-FAIL"), sevenOwner.id, "user");
await syncFilmOrdersFromQuotations("seven-owner@727.co.jp");
const db = await getDatabaseForTest();
async function orderFor(quotationId: number) {
  const row = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE quotation_id=?", [quotationId]);
  return row!.id;
}
const koOrderId = await orderFor(koQuote.id);
const jaOrderId = await orderFor(jaQuote.id);
const failureOrderId = await orderFor(failureQuote.id);
for (const orderId of [koOrderId, jaOrderId, failureOrderId]) {
  await db.run("UPDATE film_orders SET procurement_route='K', printing_method='digital' WHERE id=?", [orderId]);
  await runFilmOrderAction(orderId, "mark-ordered", {}, "seven-owner@727.co.jp");
}
await selectFilmMakerForOrder(koOrderId, koreanMaker.id, "kanei@kanei-trade.co.jp");
await selectFilmMakerForOrder(jaOrderId, japaneseMaker.id, "kanei@kanei-trade.co.jp");
await selectFilmMakerForOrder(failureOrderId, koreanMaker.id, "kanei@kanei-trade.co.jp");
await runFilmOrderAction(failureOrderId, "request-customer-design-upload", {
  note: "maker guard probe",
  origin: "http://localhost:3000",
}, "seven-owner@727.co.jp");

const ownerSession = (await createSession(sevenOwner.id)).token;
const requestedKo = await runFilmOrderAction(koOrderId, "request-customer-design-upload", {
  note: "AIを入稿してください",
  origin: "http://localhost:3000",
}, "seven-owner@727.co.jp");
void requestedKo;

const sessions = new Map<string, string>();
function candidateFor(name: string, fileId: string) {
  return {
    id: fileId,
    name,
    mimeType: name.endsWith(".pdf") ? "application/pdf" : "application/postscript",
    checksum: `checksum-${fileId}`,
    sizeBytes: 4096,
    parentFolderIds: ["customer-design-folder"],
  };
}
function request(url: string, token?: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "G004 test",
      ...(token ? { cookie: `pouch_session=${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function directUpload(
  quotationId: number,
  token: string,
  originalName: string,
  fileId: string,
) {
  const sessionResponse = await internalSession(
    request(`http://localhost/api/data-intake/${quotationId}/upload-session`, token, {
      originalFileName: originalName,
      sizeBytes: 4096,
      contentType: originalName.endsWith(".pdf") ? "application/pdf" : "application/postscript",
    }),
    { params: Promise.resolve({ quotationId: String(quotationId) }) },
  );
  if (!sessionResponse.ok) return sessionResponse;
  const session = await sessionResponse.json();
  driveMocks.getConfirmedUpload.mockImplementationOnce(async (params: {
    fileId: string;
    fileName: string;
    folderId: string;
  }) => params.fileId === fileId && params.fileName === session.fileName && params.folderId === "customer-design-folder"
    ? candidateFor(session.fileName, fileId)
    : null);
  return internalComplete(
    request(`http://localhost/api/data-intake/${quotationId}/upload-complete`, token, {
      originalFileName: originalName,
      expectedFileName: session.fileName,
      fileId,
      guideAcknowledged: true,
    }),
    { params: Promise.resolve({ quotationId: String(quotationId) }) },
  );
}

async function makerHandoffs(): Promise<Array<Record<string, any>>> {
  return db.all(`
    SELECT * FROM film_order_mail_outbox
    WHERE audience='maker' AND workflow_key='customer_design_received'
    ORDER BY created_at, id
  `);
}
function linksOf(row: Record<string, any>): Array<{ key: string; url: string }> {
  return JSON.parse(row.links_json);
}
function attachmentsOf(row: Record<string, any>) {
  return JSON.parse(row.attachments_json);
}

beforeAll(() => {
  driveMocks.createSession.mockImplementation(async (params: { fileName: string }) => {
    const uri = `http://drive.test/${encodeURIComponent(params.fileName)}`;
    sessions.set(params.fileName, uri);
    return uri;
  });
  driveMocks.downloadFile.mockResolvedValue(new Response("AI-bytes", {
    headers: { "content-type": "application/postscript" },
  }));
});

describe("G004 automatic maker handoff", () => {
  it("hands off internal AI immediately with Korean snapshot language and both maker links", async () => {
    const response = await directUpload(koQuote.id, ownerSession, "Customer AI KO.ai", "ko-ai-file-000001");
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("g004-korean-maker@example.test");
    const order = await getFilmOrder(koOrderId);
    const orderNumber = order!.order_number;
    expect(order?.customerDesign.status).toBe("received");
    expect(order?.files.at(-1)).toMatchObject({
      drive_file_id: "ko-ai-file-000001",
      uploaded_via: "internal_customer_design",
    });

    const handoffs = await makerHandoffs();
    const handoff = handoffs.find((row) => row.intended_to === "g004-korean-maker@example.test")!;
    expect(handoff).toBeDefined();
    expect(handoff.language).toBe("ko");
    expect(handoff.subject).toContain("제작 데이터 수령·교정 데이터 제출 요청");
    expect(handoff.subject).toContain(orderNumber);
    expect(handoff.body).toContain("고객에게 수령한 AI 제작 데이터를 전용 링크에서 받고");
    expect(handoff.body).toContain(orderNumber);
    expect(handoff.body).toContain("自動メーカー引継パウチ");
    expect(handoff.body).toContain("【첨부 데이터】");
    const links = linksOf(handoff);
    expect(links.find((link) => link.key === "maker_customer_design_file")?.url)
      .toContain("/api/film-orders/design-download/");
    expect(links.find((link) => link.key === "maker_proof_upload")?.url)
      .toContain("/film-orders/upload/");
    expect(attachmentsOf(handoff)).toEqual([
      expect.objectContaining({
        fileName: expect.stringContaining("Customer_AI_KO.ai"),
        category: "customer_design",
        version: 1,
        contentType: "application/postscript",
      }),
    ]);
    expect(handoff.attachments_json).not.toContain("ko-ai-file-000001");
    const makerAttempt = await db.get<Record<string, any>>(
      `SELECT a.*, o.intended_to, o.audience
       FROM film_order_mail_attempts a
       JOIN film_order_mail_outbox o ON o.id=a.outbox_id
       WHERE o.id=?
       ORDER BY a.attempt_count DESC LIMIT 1`,
      [handoff.id],
    );
    expect(makerAttempt).toMatchObject({
      audience: "maker",
      intended_to: "g004-korean-maker@example.test",
      actual_to: "safe-test-inbox@example.test",
      recipient_overridden: 1,
      status: "skipped",
    });
    const mailAudit = await db.get<{ type: string; detail: string }>(
      "SELECT type,detail FROM film_order_events WHERE order_id=? AND type='mail_audit' ORDER BY id DESC LIMIT 1",
      [koOrderId],
    );
    expect(mailAudit?.type).toBe("mail_audit");
    expect(mailAudit?.detail).toContain("dispatch intent");
  });

  it("hands off no-login token AI immediately with Japanese snapshot language", async () => {
    const requestMail = await runFilmOrderAction(jaOrderId, "request-customer-design-upload", {
      note: "AIを専用リンクから入稿してください。",
      origin: "http://localhost:3000",
    }, "seven-owner@727.co.jp");
    expect(requestMail.order.customerDesign.status).toBe("requested");
    const customerToken = String(requestMail.mails?.[0]?.text ?? "")
      .match(/\/film-orders\/design-upload\/([^\s"]+)/u)?.[1] ?? "";
    const order = await getFilmOrder(jaOrderId);
    const fileName = nextCustomerDesignFileName(order!, "Customer AI JA.ai");
    driveMocks.getConfirmedUpload.mockImplementationOnce(async (params: {
      fileId: string;
      fileName: string;
      folderId: string;
    }) => params.fileId === "ja-ai-file-000001" && params.fileName === fileName && params.folderId === "customer-design-folder"
      ? candidateFor(fileName, "ja-ai-file-000001")
      : null);
    const response = await tokenDesignUpload(
      request(`http://localhost/api/film-orders/design-upload/${customerToken}`, undefined, {
        action: "complete",
        originalFileName: "Customer AI JA.ai",
        fileId: "ja-ai-file-000001",
        guideAcknowledged: true,
        uploader: "token customer",
      }),
      { params: Promise.resolve({ token: customerToken }) },
    );
    expect(response.status).toBe(200);

    const handoffs = await makerHandoffs();
    const handoff = handoffs.find((row) => row.intended_to === "g004-japanese-maker@example.test")!;
    expect(handoff).toBeDefined();
    expect(handoff.language).toBe("ja");
    expect(handoff.subject).toContain("制作データ受領・校正データ提出依頼");
    expect(handoff.body).toContain("顧客から受領したAI制作データを専用リンクから取得し");
    const links = linksOf(handoff);
    expect(links.map((link) => link.key)).toEqual(expect.arrayContaining(["maker_customer_design_file", "maker_proof_upload"]));
    expect(attachmentsOf(handoff)).toEqual([
      expect.objectContaining({
        fileName: fileName,
        category: "customer_design",
        version: 1,
        contentType: "application/postscript",
      }),
    ]);
    const tokenOrder = await getFilmOrder(jaOrderId);
    expect(tokenOrder?.files.at(-1)).toMatchObject({
      drive_file_id: "ja-ai-file-000001",
      uploaded_via: "customer_design",
    });
  });

  it("protects AI download tokens by purpose, expiry, revocation, order file binding, and audit", async () => {
    const [handoff] = (await makerHandoffs()).filter((row) => row.intended_to === "g004-korean-maker@example.test");
    const link = linksOf(handoff).find((item) => item.key === "maker_customer_design_file")!;
    const url = new URL(link.url);
    const rawToken = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const tokenHash = filmExternalTokenHashForTest(rawToken);
    const tokenRow = await db.get<Record<string, any>>(
      "SELECT * FROM film_order_external_tokens WHERE token_hash=? AND purpose='maker_customer_design'",
      [tokenHash],
    );
    expect(tokenRow).toMatchObject({
      film_order_id: koOrderId,
      token_state: "active",
      audience_email: "g004-korean-maker@example.test",
    });
    expect(new Date(tokenRow!.expires_at).getTime()).toBeGreaterThan(Date.now());

    const context = { params: Promise.resolve({ token: rawToken }) };
    const valid = await makerDownload(
      request(`http://localhost${url.pathname}?fileId=ko-ai-file-000001`),
      context,
    );
    expect(valid.status).toBe(200);
    const wrongFile = await makerDownload(
      request(`http://localhost${url.pathname}?fileId=other-file-000001`),
      context,
    );
    expect(wrongFile.status).toBe(403);
    const events = await db.all<{ type: string; detail: string }>(
      "SELECT type,detail FROM film_order_events WHERE order_id=? AND type='token_access' ORDER BY id",
      [koOrderId],
    );
    expect(events.at(-2)?.detail).toContain("allowed: ko-ai-file-000001");
    expect(events.at(-1)?.detail).toContain("denied: other-file-000001");

    await db.run("UPDATE film_order_external_tokens SET expires_at=? WHERE token_hash=?", [
      new Date(Date.now() - 1000).toISOString(),
      tokenHash,
    ]);
    await expect(makerDownload(request(`http://localhost${url.pathname}?fileId=ko-ai-file-000001`), context))
      .resolves.toMatchObject({ status: 502 });
    await db.run("UPDATE film_order_external_tokens SET expires_at=?, token_state='revoked', revoked_at=? WHERE token_hash=?", [
      new Date(Date.now() + 86400000).toISOString(),
      new Date().toISOString(),
      tokenHash,
    ]);
    await expect(makerDownload(request(`http://localhost${url.pathname}?fileId=ko-ai-file-000001`), context))
      .resolves.toMatchObject({ status: 502 });
    expect((await db.get<{ token_state: string }>("SELECT token_state FROM film_order_external_tokens WHERE token_hash=?", [tokenHash]))?.token_state)
      .toBe("revoked");
  });

  it("does not duplicate maker handoff for direct or no-login supplemental PDF uploads", async () => {
    const before = await makerHandoffs();
    expect(before).toHaveLength(2);

    const directPdf = await directUpload(koQuote.id, ownerSession, "Supplement KO.pdf", "ko-pdf-file-000001");
    expect(directPdf.status).toBe(200);
    const koOrder = await getFilmOrder(koOrderId);
    expect(koOrder?.files.filter((file) => file.category === "customer_design")).toHaveLength(2);
    expect(koOrder?.customerDesign.status).toBe("received");

    const [customerMail] = (await runFilmOrderAction(jaOrderId, "request-customer-design-correction", {
      reason: "PDF supplement token",
      customerMessage: "確認用PDFをアップロードしてください。",
      origin: "http://localhost:3000",
    }, "seven-owner@727.co.jp")).mails ?? [];
    const customerToken = String(customerMail?.text ?? "")
      .match(/\/film-orders\/design-upload\/([^\s"]+)/u)?.[1] ?? "";
    const jaOrderBefore = await getFilmOrder(jaOrderId);
    const pdfName = nextCustomerDesignFileName(jaOrderBefore!, "Supplement JA.pdf");
    driveMocks.getConfirmedUpload.mockImplementationOnce(async (params: {
      fileId: string;
      fileName: string;
      folderId: string;
    }) => params.fileId === "ja-pdf-file-000001" && params.fileName === pdfName && params.folderId === "customer-design-folder"
      ? candidateFor(pdfName, "ja-pdf-file-000001")
      : null);
    const tokenPdf = await tokenDesignUpload(
      request(`http://localhost/api/film-orders/design-upload/${customerToken}`, undefined, {
        action: "complete",
        originalFileName: "Supplement JA.pdf",
        fileId: "ja-pdf-file-000001",
        guideAcknowledged: true,
      }),
      { params: Promise.resolve({ token: customerToken }) },
    );
    expect(tokenPdf.status).toBe(200);
    const jaOrder = await getFilmOrder(jaOrderId);
    expect(jaOrder?.files.filter((file) => file.category === "customer_design")).toHaveLength(2);

    const after = await makerHandoffs();
    expect(after).toHaveLength(2);
    const mailAudit = await db.all<{ type: string }>(
      "SELECT type FROM film_order_events WHERE order_id IN (?,?) AND type='mail_audit'",
      [koOrderId, jaOrderId],
    );
    expect(mailAudit.length).toBeGreaterThan(0);
  });

  it("fails closed for unresolved and mismatched selected maker snapshots without file or mail", async () => {
    const makerOutboxesBefore = await makerHandoffs();
    await db.run(
      "UPDATE film_orders SET film_maker_id=NULL, film_maker_snapshot_json=NULL, supplier_resolution='legacy_unresolved' WHERE id=?",
      [failureOrderId],
    );
    const unresolved = await directUpload(failureQuote.id, ownerSession, "Unresolved Maker.ai", "unresolved-ai-file-000001");
    expect(unresolved.status).toBe(502);
    await expect(unresolved.json()).resolves.toEqual({ error: "film_maker_resolution_required" });

    await db.run(`
      UPDATE film_orders
      SET film_maker_id=?, film_maker_snapshot_json=?, supplier_resolution='master_selected', procurement_route='Y'
      WHERE id=?
    `, [koreanMaker.id, JSON.stringify({
      id: koreanMaker.id,
      companyName: koreanMaker.companyName,
      contactName: koreanMaker.contactName,
      email: koreanMaker.email,
      language: "ko",
      isActive: true,
      procurementRoute: "K",
      printMethod: "digital",
    }), failureOrderId]);
    const mismatched = await directUpload(failureQuote.id, ownerSession, "Mismatched Maker.ai", "mismatched-ai-file-000001");
    expect(mismatched.status).toBe(502);
    await expect(mismatched.json()).resolves.toEqual({ error: "film_maker_route_mismatch" });

    const fileCount = await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM film_order_files WHERE order_id=? AND category='customer_design'",
      [failureOrderId],
    );
    const makerOutboxesAfter = await makerHandoffs();
    expect(Number(fileCount?.n)).toBe(0);
    expect(makerOutboxesAfter).toHaveLength(makerOutboxesBefore.length);
  });
});
