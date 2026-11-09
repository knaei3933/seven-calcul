// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "canonical-issuance-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.ADMIN_EMAIL = "admin@canonical-issuance.test";
process.env.ADMIN_PASSWORD = "canonical-issuance-admin-password";
process.env.ADMIN_NAME = "Canonical Issuance Admin";

const { closeDatabaseForTest, createSession, createUser } = await import("@/lib/auth-store");
const { POST } = await import("@/app/api/quotations/route");
const { getQuotationPdf, saveIssuedQuotation, saveQuotation, getDatabaseForTest } = await import("@/lib/quotation-store");
const { CanonicalQuotationPdfAssetError } = await import("@/lib/standard-quote-pdf");

const author = await createUser({
  email: "author@kanei-trade.co.jp",
  name: "Canonical Author",
  password: "canonical-author-password",
  role: "user",
});
const sevenAuthor = await createUser({
  email: "legacy-author@727.co.jp",
  name: "Legacy Author",
  password: "legacy-author-password",
  role: "user",
});
const authorSession = await createSession(author.id);
const sevenSession = await createSession(sevenAuthor.id);

afterAll(async () => {
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

function input(quotationNumber = "", customerName = "Canonical Customer"): QuotationRecordInput {
  return {
    quotationNumber,
    status: "draft",
    issueDate: "2026-11-09",
    validUntil: "2026-12-09",
    customerName,
    customerContact: "Buyer Contact",
    productName: "Canonical Pouch",
    sizeSummary: "50×90mm / 1連",
    quantity: "10000",
    fillingCostPerPiece: "10",
    filmCostPerPiece: "8",
    filmMeterPrice: "410",
    filmOrderLengthM: "500",
    targetMargin: "0.35",
    taxRatePercent: "10",
    pricePerPiece: "42",
    subtotal: "420000",
    tax: "42000",
    grandTotal: "462000",
    deliveryDate: "別途相談",
    paymentTerms: "月末締め翌月末払い",
    notes: "",
    calculationVersion: "manual-entry",
    resultHash: "",
    payload: {
      customerPostalCode: "650-0000",
      customerTelephone: "050-0000-0000",
      customerAddress: "神戸市テスト1-1",
      customerEmail: "buyer@example.test",
      customerCode: "C-CANONICAL",
      skuNames: ["Canonical Pouch"],
      fillingItemName: "充填・加工",
      fillingUnitDisplay: "42",
      fillingAmountDisplay: "420000",
      filmItemName: "フィルム",
      filmComposition: "PET12+AL7+PET12+LLDPE50μ",
      filmUnitDisplay: "82",
      filmPouchUnitDisplay: "4.1",
      filmAmountDisplay: "41000",
      printingMethod: "digital",
      footerContact: {
        companyName: "金井貿易株式会社",
        contactName: "Canonical Author",
        email: author.email,
        telephone: "TEL 050-3613-9673",
      },
      targetMargin: "0.35",
      profitAudit: { profitPerPiece: "internal-only" },
    },
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/quotations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `pouch_session=${authorSession.token}`,
    },
    body: JSON.stringify(body),
  });
}

function multipartRequest(
  body: unknown,
  pdf: Blob,
  token: string = authorSession.token,
): Request {
  const form = new FormData();
  form.set("payload", JSON.stringify(body));
  form.set("pdf", pdf, "client.pdf");
  return new Request("http://localhost/api/quotations", {
    method: "POST",
    headers: { cookie: `pouch_session=${token}` },
    body: form,
  });
}

async function quotationCount(): Promise<number> {
  const db = await getDatabaseForTest();
  const row = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM quotations");
  return Number(row?.count ?? 0);
}

describe("canonical quotation issuance boundary", () => {
  it("renders and atomically stores a server PDF for a new Kanei record without an uploaded PDF", async () => {
    const before = await quotationCount();
    const response = await POST(jsonRequest(input()));
    expect(response.status).toBe(201);
    const payload = await response.json() as {
      created: boolean;
      record: { id: number; ownerDomain: string; quotationNumber: string; payload: Record<string, unknown> };
      pdf: { saved: boolean };
    };
    expect(payload.created).toBe(true);
    expect(payload.record.ownerDomain).toBe("kanei");
    expect(payload.record.quotationNumber).toMatch(/^KT-\d{6}-\d{3}$/u);
    expect(payload.pdf.saved).toBe(true);

    const stored = await getQuotationPdf(payload.record.id);
    expect(stored?.data.subarray(0, 5).toString()).toBe("%PDF-");
    expect(stored?.fileName.endsWith(".pdf")).toBe(true);
    expect(payload.record.payload.canonicalPdfProvenance).toMatchObject({
      rendererVersion: expect.stringMatching(/^standard-quotation-pdf\//u),
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(await quotationCount()).toBe(before + 1);
    expect(JSON.stringify(payload.record.payload.canonicalPdfProvenance)).not.toContain("internal-only");
  });

  it("rejects a client-uploaded PDF at the new Kanei boundary without creating a record", async () => {
    const before = await quotationCount();
    const response = await POST(multipartRequest(
      input("", "Upload Attempt"),
      new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], { type: "application/pdf" }),
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "client_pdf_not_accepted" });
    expect(await quotationCount()).toBe(before);
  });

  it("keeps the legacy Seven multipart workflow compatible", async () => {
    const provisional = await saveQuotation(input("", "Legacy Seven Customer"), sevenAuthor.id);
    const db = await getDatabaseForTest();
    await db.run(
      "UPDATE quotations SET owner_domain = 'seven', quotation_number = ? WHERE id = ?",
      ["S7-CANONICAL-LEGACY-001", provisional.id],
    );
    const legacyPdf = Buffer.concat([Buffer.from("%PDF-"), Buffer.from([0x01, 0x02, 0x03])]);
    const response = await POST(multipartRequest(
      { ...input("S7-CANONICAL-LEGACY-001", "Legacy Seven Customer"), customerName: "Legacy Seven Customer" },
      new Blob([new Uint8Array(legacyPdf)], { type: "application/pdf" }),
      sevenSession.token,
    ));
    expect(response.status).toBe(201);
    const payload = await response.json() as { record: { ownerDomain: string }; pdf: { size: number } };
    expect(payload.record.ownerDomain).toBe("seven");
    expect(payload.pdf.size).toBe(legacyPdf.byteLength);
    await expect(getQuotationPdf(provisional.id)).resolves.toMatchObject({ data: legacyPdf });
  });

  it("rolls back a new record when pinned canonical assets fail closed", async () => {
    const before = await quotationCount();
    await expect(saveIssuedQuotation(
      input("", "Asset Failure"),
      author.id,
      "user",
      null,
      "asset-failure.pdf",
      null,
      {
        canonicalPdfFactory: async () => {
          throw new CanonicalQuotationPdfAssetError("brand:logo", "assets/brand/kanei-trade-logo.png", "expected");
        },
      },
    )).rejects.toBeInstanceOf(CanonicalQuotationPdfAssetError);
    expect(await quotationCount()).toBe(before);
  });
});
