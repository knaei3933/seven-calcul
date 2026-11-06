// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "g003-intake-upload-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "seven@727.co.jp";
process.env.ADMIN_PASSWORD = "seven-g003-password";
process.env.ADMIN_NAME = "Seven G003";

const driveMocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getConfirmedUpload: vi.fn(),
  findFiles: vi.fn(),
}));
vi.mock("@/lib/google-drive", () => ({
  browserOriginOf: () => "http://localhost:3000",
  createResumableSession: driveMocks.createSession,
  customerDesignFolderId: () => "customer-design-folder",
  deliveryDocumentFolderId: () => "delivery-folder",
  driveConfigured: () => true,
  findDriveFiles: driveMocks.findFiles,
  getConfirmedDriveUpload: driveMocks.getConfirmedUpload,
  proofFolderId: () => "proof-folder",
  receivingFolderId: () => "receiving-folder",
}));

const { POST: sessionRoute } = await import("@/app/api/data-intake/[quotationId]/upload-session/route");
const { POST: completeRoute } = await import("@/app/api/data-intake/[quotationId]/upload-complete/route");
const { POST: externalDesignRoute } = await import("@/app/api/film-orders/design-upload/[token]/route");
const { createSession, createUser, closeDatabaseForTest } = await import("@/lib/auth-store");
const { getDatabaseForTest, saveQuotation } = await import("@/lib/quotation-store");
const {
  getFilmOrder,
  getFilmOrderForCustomerDesign,
  nextCustomerDesignFileName,
  runFilmOrderAction,
  syncFilmOrdersFromQuotations,
} = await import("@/lib/film-orders");

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
    customerName: `G003 ${quotationNumber}`,
    customerContact: "",
    productName: "直接受入パウチ",
    sizeSummary: "",
    quantity: "15000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "5",
    filmMeterPrice: "180",
    filmOrderLengthM: "1700",
    targetMargin: "0.3",
    taxRatePercent: "10",
    pricePerPiece: "20",
    subtotal: "300000",
    tax: "30000",
    grandTotal: "330000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "g003-upload",
    resultHash: "",
    payload: { customerEmail: "g003-customer@example.test" },
  };
}

const outsideUser = await createUser({
  email: "outside@example.test",
  name: "Outside User",
  password: "outside-g003-password",
  role: "user",
});
const sevenOwner = await createUser({
  email: "seven-owner@727.co.jp",
  name: "Seven Owner",
  password: "seven-g003-owner-password",
  role: "user",
});
const sevenAdmin = await createUser({
  email: "seven-admin@727.co.jp",
  name: "Seven Admin",
  password: "seven-g003-admin-password",
  role: "admin",
});
const kaneiUser = await createUser({
  email: "kanei-owner@kanei-trade.co.jp",
  name: "Kanei Owner",
  password: "kanei-g003-owner-password",
  role: "user",
});
const neutralAdmin = await createUser({
  email: "neutral-admin@example.test",
  name: "Neutral Admin",
  password: "neutral-admin-g003-password",
  role: "admin",
});
const quote = await saveQuotation(input("S7-G003-UPLOAD"), sevenOwner.id, "user");
const unresolvedQuote = await saveQuotation(input("UNRESOLVED-G003"), outsideUser.id, "user");
await syncFilmOrdersFromQuotations("seven-owner@727.co.jp");
const db = await getDatabaseForTest();
await db.run("UPDATE quotations SET owner_domain='unresolved' WHERE id=?", [unresolvedQuote.id]);
const linked = await db.get<{ id: number }>(
  "SELECT id FROM film_orders WHERE quotation_id = ?",
  [quote.id],
);
const orderId = linked!.id;
await runFilmOrderAction(orderId, "mark-ordered", {}, "seven-owner@727.co.jp");
const { createFilmMaker, selectFilmMakerForOrder } = await import("@/lib/film-maker-store");
const maker = await createFilmMaker({
  makerCode: "G003-KOR-DIG-001",
  companyName: "G003 Maker",
  email: "g003-maker@example.test",
  language: "ko",
  printMethod: "digital",
  procurementRoute: "K",
}, "kanei-owner@kanei-trade.co.jp");
await db.run("UPDATE film_orders SET procurement_route='K', printing_method='digital' WHERE id=?", [orderId]);
await selectFilmMakerForOrder(orderId, maker.id, "kanei-owner@kanei-trade.co.jp");
const requestMail = await runFilmOrderAction(orderId, "request-customer-design-upload", {
  note: "顧客AI/PDFをご入稿ください",
  origin: "http://localhost:3000",
}, "seven-owner@727.co.jp");
let customerToken = String(requestMail.mails?.[0]?.text ?? "")
  .match(/\/film-orders\/design-upload\/([^\s"]+)/u)?.[1] ?? "";

const sessions = new Map<string, string>();
function sessionFor(name: string) {
  const uri = `http://drive.test/upload/${encodeURIComponent(name)}`;
  sessions.set(name, uri);
  return uri;
}
function candidateFor(name: string, fileId: string) {
  return {
    id: fileId,
    name,
    mimeType: name.endsWith(".pdf") ? "application/pdf" : "application/postscript",
    checksum: `checksum-${fileId}`,
    sizeBytes: 1024,
    parentFolderIds: ["customer-design-folder"],
  };
}
function request(url: string, token?: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "G003 test agent",
      ...(token ? { cookie: `pouch_session=${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function uploadDirect(token: string, originalName: string, driveId: string) {
  const sessionResponse = await sessionRoute(
    request(`http://localhost/api/data-intake/${quote.id}/upload-session`, token, {
      originalFileName: originalName,
      sizeBytes: 1024,
      contentType: originalName.endsWith(".pdf") ? "application/pdf" : "application/postscript",
    }),
    { params: Promise.resolve({ quotationId: String(quote.id) }) },
  );
  if (!sessionResponse.ok) return sessionResponse;
  const session = await sessionResponse.json();
  driveMocks.getConfirmedUpload.mockImplementationOnce(async (params: {
    fileId: string;
    fileName: string;
    folderId: string;
  }) => params.fileId === driveId && params.fileName === session.fileName && params.folderId === "customer-design-folder"
    ? candidateFor(session.fileName, driveId)
    : null);
  return completeRoute(
    request(`http://localhost/api/data-intake/${quote.id}/upload-complete`, token, {
      originalFileName: originalName,
      expectedFileName: session.fileName,
      fileId: driveId,
      note: "direct intake",
      guideAcknowledged: true,
    }),
    { params: Promise.resolve({ quotationId: String(quote.id) }) },
  );
}

beforeAll(() => {
  driveMocks.createSession.mockImplementation(async (params: { fileName: string }) => sessionFor(params.fileName));
});

describe("G003 direct data intake upload", () => {
  it("fails closed for missing, cross-company, neutral-admin, and unresolved owners", async () => {
    const unauthorized = await sessionRoute(
      request(`http://localhost/api/data-intake/${quote.id}/upload-session`, undefined, {
        originalFileName: "customer.ai",
        sizeBytes: 1024,
      }),
      { params: Promise.resolve({ quotationId: String(quote.id) }) },
    );
    expect(unauthorized.status).toBe(401);
    for (const user of [outsideUser, kaneiUser, neutralAdmin]) {
      const session = await createSession(user.id);
      const response = await sessionRoute(
        request(`http://localhost/api/data-intake/${quote.id}/upload-session`, session.token, {
          originalFileName: "customer.ai",
          sizeBytes: 1024,
        }),
        { params: Promise.resolve({ quotationId: String(quote.id) }) },
      );
      expect(response.status).toBe(403);
    }
    const outsideSession = await createSession(outsideUser.id);
    const unresolved = await sessionRoute(
      request(`http://localhost/api/data-intake/${unresolvedQuote.id}/upload-session`, outsideSession.token, {
        originalFileName: "customer.ai",
        sizeBytes: 1024,
      }),
      { params: Promise.resolve({ quotationId: String(unresolvedQuote.id) }) },
    );
    expect(unresolved.status).toBe(404);
  });

  it("enforces AI-first policy and exact Drive binding, then persists durable metadata", async () => {
    const ownerSession = (await createSession(sevenOwner.id)).token;
    const pdfFirst = await sessionRoute(
      request(`http://localhost/api/data-intake/${quote.id}/upload-session`, ownerSession, {
        originalFileName: "customer.pdf",
        sizeBytes: 1024,
      }),
      { params: Promise.resolve({ quotationId: String(quote.id) }) },
    );
    expect(pdfFirst.status).toBe(409);
    await expect(pdfFirst.json()).resolves.toEqual({ error: "ai_file_required" });

    const tooLarge = await sessionRoute(
      request(`http://localhost/api/data-intake/${quote.id}/upload-session`, ownerSession, {
        originalFileName: "customer.ai",
        sizeBytes: 101 * 1024 * 1024,
      }),
      { params: Promise.resolve({ quotationId: String(quote.id) }) },
    );
    expect(tooLarge.status).toBe(413);

    const aiSession = await sessionRoute(
      request(`http://localhost/api/data-intake/${quote.id}/upload-session`, ownerSession, {
        originalFileName: "Customer Artwork.ai",
        sizeBytes: 1024,
        contentType: "application/postscript",
      }),
      { params: Promise.resolve({ quotationId: String(quote.id) }) },
    );
    expect(aiSession.status).toBe(200);
    const ai = await aiSession.json();
    expect(ai.sessionUri).toBe(sessions.get(ai.fileName));
    expect(driveMocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      fileName: ai.fileName,
      folderId: "customer-design-folder",
      sizeBytes: 1024,
    }));

    driveMocks.getConfirmedUpload.mockImplementationOnce(async () => candidateFor("wrong-name.ai", "drive-ai-1"));
    const wrongName = await completeRoute(
      request(`http://localhost/api/data-intake/${quote.id}/upload-complete`, ownerSession, {
        originalFileName: "Customer Artwork.ai",
        expectedFileName: ai.fileName,
        fileId: "drive-ai-1",
        guideAcknowledged: true,
      }),
      { params: Promise.resolve({ quotationId: String(quote.id) }) },
    );
    expect(wrongName.status).toBe(400);

    const completed = await uploadDirect(ownerSession, "Customer Artwork.ai", "drive-ai-1");
    expect(completed.status).toBe(200);
    const aiPayload = await completed.json();
    expect(aiPayload.order.designStatus).toBe("received");
    expect(aiPayload.files[0]).toMatchObject({
      version: 1,
      driveFileId: "drive-ai-1",
      uploadedVia: "internal_customer_design",
      contentType: "application/postscript",
      checksum: "checksum-drive-ai-1",
      checksumAlgorithm: "md5",
    });

    const adminSession = (await createSession(sevenAdmin.id)).token;
    const pdfCompleted = await uploadDirect(adminSession, "Customer Artwork.pdf", "drive-pdf-1");
    expect(pdfCompleted.status).toBe(200);
    const pdfPayload = await pdfCompleted.json();
    expect(pdfPayload.files).toHaveLength(2);
    expect(pdfPayload.files.at(-1)).toMatchObject({
      version: 2,
      driveFileId: "drive-pdf-1",
      uploadedVia: "internal_customer_design",
    });
    const persisted = await getFilmOrder(orderId);
    expect(persisted?.files.filter((file) => file.category === "customer_design").map((file) => file.drive_file_id))
      .toEqual(["drive-ai-1", "drive-pdf-1"]);
    expect(persisted?.customerDesign.status).toBe("received");
  });

  it("keeps the no-login token page/API path and durable customer-design metadata unchanged", async () => {
    const correction = await runFilmOrderAction(orderId, "request-customer-design-correction", {
      reason: "token compatibility",
      customerMessage: "修正版をトークンからアップロードしてください。",
      origin: "http://localhost:3000",
    }, "seven-owner@727.co.jp");
    expect(correction.order.customerDesign.status).toBe("correction_requested");
    customerToken = String(correction.mails?.[0]?.text ?? "")
      .match(/\/film-orders\/design-upload\/([^\s"]+)/u)?.[1] ?? customerToken;
    const order = await getFilmOrder(orderId);
    const original = "Token Correction.ai";
    const fileName = nextCustomerDesignFileName(order!, original);
    driveMocks.getConfirmedUpload.mockImplementationOnce(async (params: {
      fileId: string;
      fileName: string;
      folderId: string;
    }) => params.fileId === "token-ai-000001" && params.fileName === fileName && params.folderId === "customer-design-folder"
      ? candidateFor(fileName, "token-ai-000001")
      : null);
    const response = await externalDesignRoute(
      request(`http://localhost/api/film-orders/design-upload/${customerToken}`, undefined, {
        action: "complete",
        originalFileName: original,
        fileId: "token-ai-000001",
        guideAcknowledged: true,
        uploader: "token customer",
      }),
      { params: Promise.resolve({ token: customerToken }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.files).toHaveLength(3);
    expect(payload.files.at(-1)).toMatchObject({ version: 3, fileName });
    const persisted = await getFilmOrder(orderId);
    expect(persisted?.files.at(-1)).toMatchObject({
      drive_file_id: "token-ai-000001",
      uploaded_via: "customer_design",
    });
    expect(await getFilmOrderForCustomerDesign(customerToken)).toBeDefined();
  });
});
