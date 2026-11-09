// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { extractText } from "unpdf";
import {
  buildCanonicalQuotationPdfModel,
  CANONICAL_QUOTATION_PDF_RENDERER_VERSION,
  CanonicalQuotationPdfAssetError,
  renderCanonicalQuotationPdf,
} from "@/lib/standard-quote-pdf";
import type { QuotationRecordInput } from "@/lib/quotation-shared";

function input(): QuotationRecordInput {
  return {
    quotationNumber: "",
    status: "draft",
    issueDate: "2026-11-09",
    validUntil: "2026-12-09",
    customerName: "株式会社顧客",
    customerContact: "営業 ご担当",
    productName: "テストパウチ",
    sizeSummary: "50×90mm / 1連",
    quantity: "10000",
    fillingCostPerPiece: "12.3456",
    filmCostPerPiece: "8.9101",
    filmMeterPrice: "410",
    filmOrderLengthM: "500",
    targetMargin: "0.42",
    taxRatePercent: "10",
    pricePerPiece: "42",
    subtotal: "420000",
    tax: "42000",
    grandTotal: "462000",
    deliveryDate: "別途相談",
    paymentTerms: "月末締め翌月末払い",
    notes: "顧客向け備考",
    calculationVersion: "simulator-linked",
    resultHash: "internal-result-hash",
    payload: {
      customerPostalCode: "650-0000",
      customerAddress: "神戸市テスト1-1",
      customerCode: "C-001",
      customerEmail: "buyer@example.test",
      greeting: "平素よりお世話になっております。",
      skuNames: ["テストパウチ"],
      fillingItemName: "充填・加工",
      fillingItemDescription: "顧客向け加工説明",
      fillingUnitDisplay: "21",
      fillingAmountDisplay: "210000",
      bulkItemName: "バルク液体",
      bulkItemDescription: "バルク液体",
      bulkUnitDisplay: "35",
      bulkAmountDisplay: "35000",
      bulkCostPerPiece: "2.2",
      filmItemName: "フィルム",
      filmComposition: "PET12+AL7+PET12+LLDPE50μ",
      filmUnitDisplay: "82",
      filmPouchUnitDisplay: "4.1",
      filmAmountDisplay: "41000",
      copperItemName: "銅版",
      copperUnitDisplay: "3.4",
      copperColorCount: "2",
      copperAmountDisplay: "68000",
      setupItemName: "セットアップ",
      setupUnitDisplay: "10.6",
      setupQuantity: "1",
      setupAmountDisplay: "10600",
      customItemName: "金型",
      customUnitDisplay: "8.2",
      customQuantity: "1",
      customAmountDisplay: "8200",
      printingMethod: "gravure",
      approverName: "承認 太郎",
      sealText: "検討済",
      footerContact: {
        companyName: "金井貿易株式会社",
        contactName: "承認 太郎",
        email: "issuer@kanei-trade.co.jp",
        telephone: "TEL 050-3613-9673",
      },
      targetMargin: "0.42",
      filmCostPerPiece: "8.9101",
      profitAudit: {
        profitPerPiece: "secret-profit",
        profitMarginRate: "0.42",
        totalProfit: "secret-total-profit",
      },
      pricingSnapshot: { costTotal: "secret-cost-total" },
      calculationRequest: { parameters: { lossRate: "secret-loss" } },
      supplierName: "secret-supplier",
      commissionRate: "0.03",
      payloadHash: "secret-payload-hash",
      internalAudit: { decision: "secret" },
    },
  };
}

const workerScript = join(tmpdir(), `canonical-pdf-worker-${randomUUID()}.ts`);
afterAll(async () => {
  await rm(workerScript, { force: true });
});

describe("deterministic canonical quotation PDF", () => {
  it("renders pinned Kanei branding with business-time metadata and object streams", async () => {
    const model = buildCanonicalQuotationPdfModel(input(), "KT-202611-001", "kanei");
    const first = await renderCanonicalQuotationPdf(model, "kanei");
    const second = await renderCanonicalQuotationPdf(model, "kanei");

    expect(first.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(first.provenance.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.provenance).toEqual(second.provenance);
    expect(first.provenance.rendererVersion).toBe(CANONICAL_QUOTATION_PDF_RENDERER_VERSION);
    expect(first.provenance.saveOptions).toEqual({
      useObjectStreams: true,
      addDefaultPage: false,
      updateFieldAppearances: false,
    });
    expect(first.provenance.fonts.regular.sha256).toBe("3ca8c2d4d31ad7d19b53e96f6c8454ba0fe160861efd8aee4fe942f4a5b538d4");
    expect(first.provenance.fonts.bold.sha256).toBe("f4c37b6c907599a31df90cc532e40b6f9233c5b744dfdcbe35de61fc677819b2");
    expect(first.provenance.assets.logo?.sha256).toBe("d16e0d426493556dad733776a6e7094c73a828b0f764eed7036c3517d44341b5");
    expect(first.provenance.assets.seal?.sha256).toBe("2fda5252f42b562fa8ca25c3366e09df4110b22bbbc7cef12060a1fc4d0fa29d");
    expect(first.bytes.length).toBeLessThan(10 * 1024 * 1024);

    const document = (await import("pdf-lib")).PDFDocument;
    const loaded = await document.load(first.bytes, { ignoreEncryption: true, updateMetadata: false });
    const businessTime = new Date("2026-11-09T00:00:00+09:00");
    expect(loaded.getCreationDate()?.toISOString()).toBe(businessTime.toISOString());
    expect(loaded.getModificationDate()?.toISOString()).toBe(businessTime.toISOString());
    expect(loaded.getTitle()).toBe("お見積書 KT-202611-001");
    expect(loaded.getAuthor()).toBe("金井貿易株式会社");
    expect(loaded.getSubject()).toBe("お見積書");
    const objects = loaded.context.enumerateIndirectObjects().map(([, object]) => object.toString());
    expect(first.bytes.toString("latin1")).toContain("/ObjStm");
    expect(objects.join("\n")).toContain("/FontFile2");
    expect(objects.join("\n")).not.toContain("secret-profit");
  });

  it("extracts only customer-safe selling content and omits forbidden internal fields", async () => {
    const model = buildCanonicalQuotationPdfModel(input(), "KT-202611-002", "kanei");
    const canonical = await renderCanonicalQuotationPdf(model, "kanei");
    const extracted = await extractText(new Uint8Array(canonical.bytes), { mergePages: true });
    const text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
    expect(text).toContain("金井貿易株式会社");
    expect(text).toContain("株式会社顧客");
    expect(text).toContain("¥462000");
    expect(text).toContain("PET12+AL7+PET12+LLDPE50μ");
    for (const forbidden of [
      "secret-profit", "profitPerPiece", "profitMarginRate", "secret-cost-total",
      "pricingSnapshot", "costTotal", "secret-loss", "secret-supplier", "supplierName",
      "commissionRate", "payloadHash", "resultHash", "internalAudit", "targetMargin",
      "filmCostPerPiece", "fillingCostPerPiece",
    ]) {
      expect(text).not.toContain(forbidden);
      expect(JSON.stringify(canonical.provenance)).not.toContain(forbidden);
    }
  });

  it("uses Seven branding when a caller explicitly requests the separate Seven renderer model", async () => {
    const canonical = await renderCanonicalQuotationPdf(
      buildCanonicalQuotationPdfModel(input(), "S7-LEGACY-001", "seven"),
      "seven",
    );
    const extracted = await extractText(new Uint8Array(canonical.bytes), { mergePages: true });
    const text = Array.isArray(extracted.text) ? extracted.text.join("\n") : extracted.text;
    expect(text).toContain("株式会社セブン化学");
    expect(canonical.provenance.assets.seal).toBeNull();
  });

  it("fails closed without partial bytes when a pinned font is missing", async () => {
    const model = buildCanonicalQuotationPdfModel(input(), "KT-202611-003", "kanei");
    const missingFont = async (): Promise<Uint8Array> => {
      throw new Error("missing");
    };
    await expect(renderCanonicalQuotationPdf(model, "kanei", missingFont)).rejects.toMatchObject({
      name: "CanonicalQuotationPdfAssetError",
      role: "font:regular",
      expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("fails closed without partial bytes when a pinned brand asset is mismatched", async () => {
    const model = buildCanonicalQuotationPdfModel(input(), "KT-202611-004", "kanei");
    const [regularFontBytes, boldFontBytes] = await Promise.all([
      readFile("src/fonts/NotoSansJP-Quotation-Regular.ttf"),
      readFile("src/fonts/NotoSansJP-Quotation-Bold.ttf"),
    ]);
    const mismatchedLogo = async (assetPath: string): Promise<Uint8Array> => {
      if (assetPath === "assets/brand/kanei-trade-logo.png") return new TextEncoder().encode("not-the-logo");
      if (assetPath === "src/fonts/NotoSansJP-Quotation-Regular.ttf") return regularFontBytes;
      if (assetPath === "src/fonts/NotoSansJP-Quotation-Bold.ttf") return boldFontBytes;
      throw new Error(`unexpected test asset: ${assetPath}`);
    };
    const error = await renderCanonicalQuotationPdf(model, "kanei", mismatchedLogo).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanonicalQuotationPdfAssetError);
    expect(error).toMatchObject({ role: "brand:logo" });
    const actualSha256 = error instanceof CanonicalQuotationPdfAssetError ? error.actualSha256 : undefined;
    expect(actualSha256).toBeDefined();
    expect(actualSha256).not.toBe("d16e0d426493556dad733776a6e7094c73a828b0f764eed7036c3517d44341b5");
  });

  it("produces the same hash in an independent renderer process", async () => {
    const model = buildCanonicalQuotationPdfModel(input(), "KT-202611-005", "kanei");
    const local = await renderCanonicalQuotationPdf(model, "kanei");
    await writeFile(workerScript, `
      import { renderCanonicalQuotationPdf } from "@/lib/standard-quote-pdf";
      import { buildCanonicalQuotationPdfModel } from "@/lib/standard-quote-pdf";
      import type { QuotationRecordInput } from "@/lib/quotation-shared";
      const source = ${JSON.stringify(input())} as QuotationRecordInput;
      const model = buildCanonicalQuotationPdfModel(source, "KT-202611-005", "kanei");
      const canonical = await renderCanonicalQuotationPdf(model, "kanei");
      console.log(JSON.stringify({
        outputSha256: canonical.provenance.outputSha256,
        byteLength: canonical.bytes.byteLength,
      }));
    `);
    const output = execFileSync(process.execPath, [
      "node_modules/vite-node/vite-node.mjs",
      "--config", "vitest.config.ts",
      workerScript,
    ], { encoding: "utf8", cwd: process.cwd() });
    const remote = JSON.parse(output.trim().split("\n").at(-1)!) as {
      outputSha256: string;
      byteLength: number;
    };
    expect(remote.outputSha256).toBe(local.provenance.outputSha256);
    expect(remote.byteLength).toBe(local.bytes.byteLength);
  });
});
