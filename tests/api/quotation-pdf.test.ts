// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecord, QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-pdf-api-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.ADMIN_EMAIL = "admin@pdf-api.test";
process.env.ADMIN_PASSWORD = "admin-pdf-api-password";
process.env.ADMIN_NAME = "PDF Admin";

const { POST: savePdfRoute } = await import("@/app/api/quotations/[id]/pdf/route");
const { GET: getPdfRoute } = await import("@/app/api/quotations/[id]/pdf/route");
const { POST: issueQuotationRoute } = await import("@/app/api/quotations/route");
const { createSession, createUser } = await import("@/lib/auth-store");
const { saveQuotation } = await import("@/lib/quotation-store");

const baseInput: QuotationRecordInput = {
  quotationNumber: "S7-PDF-STORE-001",
  status: "draft",
  issueDate: "2026-10-15",
  validUntil: "2026-11-15",
  customerName: "PDF Customer",
  customerContact: "PDF Contact",
  productName: "PDF Pouch",
  sizeSummary: "50×90mm / 1連",
  quantity: "1000",
  fillingCostPerPiece: "4",
  filmCostPerPiece: "1",
  filmMeterPrice: "200",
  filmOrderLengthM: "500",
  targetMargin: "0.4",
  taxRatePercent: "10",
  pricePerPiece: "10",
  subtotal: "10000",
  tax: "1000",
  grandTotal: "11000",
  deliveryDate: "",
  paymentTerms: "",
  notes: "",
  calculationVersion: "manual-entry",
  resultHash: "",
  payload: {
    revision: 1,
    customerPostalCode: "100-0001",
    customerTelephone: "03-0000-0000",
    customerAddress: "Test Address",
    customerEmail: "customer@pdf-api.test",
  },
};

let ownerToken: string;
let otherToken: string;
let quotation: QuotationRecord;

function request(path: string, init: RequestInit = {}, token?: string): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { cookie: `pouch_session=${token}` } : {}) },
  });
}

function context(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

beforeAll(async () => {
  const owner = await createUser({
    email: "owner@pdf-api.test",
    name: "PDF Owner",
    password: "owner-pdf-password",
    role: "user",
  });
  const other = await createUser({
    email: "other@pdf-api.test",
    name: "PDF Other",
    password: "other-pdf-password",
    role: "user",
  });
  ownerToken = (await createSession(owner.id)).token;
  otherToken = (await createSession(other.id)).token;
  quotation = await saveQuotation(baseInput, owner.id, "user");
});

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation PDF API", () => {
  it("requires authentication and enforces ownership for saves", async () => {
    const unauthenticated = await savePdfRoute(request("/api/quotations/1/pdf", { method: "POST" }), context(1));
    expect(unauthenticated.status).toBe(401);

    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const formData = new FormData();
    formData.set("pdf", new Blob([bytes], { type: "application/pdf" }), "S7-PDF-STORE-001.pdf");
    const forbidden = await savePdfRoute(
      request("/api/quotations/1/pdf", { method: "POST", body: formData }, otherToken),
      context(quotation.id),
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("rejects non-file PDF form values with a clear Japanese validation error", async () => {
    const stringForm = new FormData();
    stringForm.set("pdf", "not-a-file");
    const stringResponse = await savePdfRoute(
      request("/api/quotations/1/pdf", { method: "POST", body: stringForm }, ownerToken),
      context(quotation.id),
    );
    expect(stringResponse.status).toBe(400);
    await expect(stringResponse.json()).resolves.toMatchObject({
      error: "pdf_required",
      message: expect.stringContaining("有効なファイル形式"),
    });

    const missingForm = new FormData();
    const missingResponse = await savePdfRoute(
      request("/api/quotations/1/pdf", { method: "POST", body: missingForm }, ownerToken),
      context(quotation.id),
    );
    expect(missingResponse.status).toBe(400);
    await expect(missingResponse.json()).resolves.toMatchObject({
      error: "pdf_required",
      message: expect.stringContaining("有効なファイル形式"),
    });
  });

  it("rejects malformed signatures and preserves the first canonical upload", async () => {
    const malformed = new FormData();
    malformed.set("pdf", new Blob([new Uint8Array([0x50, 0x44, 0x46, 0x2d])], { type: "application/pdf" }));
    const invalid = await savePdfRoute(
      request("/api/quotations/1/pdf", { method: "POST", body: malformed }, ownerToken),
      context(quotation.id),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: "invalid_pdf", message: expect.stringContaining("PDFが不正") });

    const bytes = Uint8Array.from([
      ...Buffer.from("%PDF-"),
      ...Array.from({ length: 251 }, (_, index) => index % 256),
    ]);
    const formData = new FormData();
    formData.set("pdf", new Blob([bytes], { type: "application/pdf" }), "uploaded.pdf");
    const saved = await savePdfRoute(
      request("/api/quotations/1/pdf", { method: "POST", body: formData }, ownerToken),
      context(quotation.id),
    );
    expect(saved.status).toBe(200);

    const replacement = Buffer.concat([Buffer.from("%PDF-"), Buffer.from([0x99])]);
    const replacementForm = new FormData();
    replacementForm.set("pdf", new Blob([replacement], { type: "application/pdf" }));
    const rejected = await savePdfRoute(
      request("/api/quotations/1/pdf", { method: "POST", body: replacementForm }, ownerToken),
      context(quotation.id),
    );
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toMatchObject({ error: "canonical_pdf_already_exists" });
    await expect(getPdfRoute(request("/api/quotations/1/pdf", {}, ownerToken), context(quotation.id)).then((response) => response.arrayBuffer()))
      .resolves.toEqual(bytes.buffer);
  });

  it("round-trips exact bytes through the shared quotation store", async () => {
    const bytes = new Uint8Array(Array.from({ length: 257 }, (_, index) => index % 256));
    const retrieved = await getPdfRoute(
      request("/api/quotations/1/pdf", {}, otherToken),
      context(quotation.id),
    );

    expect(retrieved.status).toBe(200);
    expect(retrieved.headers.get("content-type")).toBe("application/pdf");
    expect(retrieved.headers.get("cache-control")).toBe("private, no-store");
    expect(retrieved.headers.get("content-disposition")).toContain(
      encodeURIComponent("S7-PDF-STORE-001.pdf"),
    );
    await expect(retrieved.arrayBuffer()).resolves.toEqual(bytes.buffer);
  });

  it("rejects empty uploads without changing persistence", async () => {
    const formData = new FormData();
    formData.set("pdf", new Blob([new Uint8Array(0)], { type: "application/pdf" }), "empty.pdf");
    const response = await savePdfRoute(
      request("/api/quotations/1/pdf", { method: "POST", body: formData }, ownerToken),
      context(quotation.id),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_pdf" });
  });

  it("requires authenticated multipart issuance and commits PDF in one API request", async () => {
    const unauthenticated = await issueQuotationRoute(new Request("http://localhost/api/quotations", { method: "POST" }));
    expect(unauthenticated.status).toBe(401);
    const jsonOnly = await issueQuotationRoute(request("/api/quotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseInput),
    }, ownerToken));
    expect(jsonOnly.status).toBe(400);
    await expect(jsonOnly.json()).resolves.toMatchObject({ error: "canonical_pdf_required" });

    const bytes = Buffer.concat([Buffer.from("%PDF-"), Buffer.from([0x41, 0x42])]);
    const formData = new FormData();
    formData.set("payload", JSON.stringify({ ...baseInput, quotationNumber: "S7-PDF-STORE-002" }));
    formData.set("pdf", new Blob([bytes], { type: "application/pdf" }), "S7-PDF-STORE-002.pdf");
    const issued = await issueQuotationRoute(
      request("/api/quotations", { method: "POST", body: formData }, ownerToken),
    );
    expect(issued.status).toBe(201);
    const issuedPayload = await issued.json();
    expect(issuedPayload.created).toBe(true);
    expect(issuedPayload.pdf.saved).toBe(true);
    expect(issuedPayload.pdf.size).toBe(bytes.byteLength);

    const correctionForm = new FormData();
    correctionForm.set("payload", JSON.stringify({
      ...baseInput,
      quotationNumber: "S7-PDF-STORE-002",
      customerName: "Corrected",
    }));
    correctionForm.set("pdf", new Blob([Buffer.concat([Buffer.from("%PDF-"), Buffer.from([0x99])])], { type: "application/pdf" }));
    const rejectedCorrection = await issueQuotationRoute(
      request("/api/quotations", { method: "POST", body: correctionForm }, ownerToken),
    );
    expect(rejectedCorrection.status).toBe(409);
    await expect(rejectedCorrection.json()).resolves.toMatchObject({
      error: "canonical_pdf_already_exists",
      message: expect.stringContaining("別の見積番号"),
    });
    const stored = await getPdfRoute(
      request("/api/quotations/2/pdf", {}, ownerToken),
      context(issuedPayload.record.id),
    );
    await expect(stored.arrayBuffer()).resolves.toEqual(bytes.buffer);
  });
});
