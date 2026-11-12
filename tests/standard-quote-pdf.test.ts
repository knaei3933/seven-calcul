// @vitest-environment node
import { readFile } from "node:fs/promises";
import { extractText } from "unpdf";
import { describe, expect, it } from "vitest";
import {
  generateStandardQuotationPdf,
  type StandardQuotePdfModel,
} from "@/lib/standard-quote-pdf";

const model: StandardQuotePdfModel = {
  issuerName: "株式会社セブン化学",
  issuerEnglishName: "SEVEN CHEMICAL CO., LTD.",
  issuerPostalCode: "〒582-0017",
  issuerAddress: "大阪府柏原市太平寺1丁目12番1号",
  issuerTelephone: "TEL 072-971-0726",
  issuerWebsite: "https://7chemical.co.jp/",
  documentEnglish: "QUOTATION",
  documentHeading: "お見積書",
  quotationNumber: "S7-SUBSET-001",
  issueDate: "2026-11-12",
  customerPostalCode: "〒650-0001",
  customerAddress: "兵庫県神戸市テスト1-2-3",
  customerName: "テスト得意先株式会社",
  customerContact: "テスト担当",
  customerCode: "C-001",
  customerEmail: "test@example.co.jp",
  greeting: "平素より格別のお引き立てを賜り、厚く御礼申し上げます。",
  productName: "パウチ製品",
  sizeSummary: "ラウンド型50×60mm / 1連",
  quantity: "10,000",
  fillingSpec: "3ml/室 × 1室 ＝ 3ml/枚（ホッパ充填）",
  bulkUsage: "41,000g（貴社ご支給ください）",
  filmComposition: "PET12+AL7+PET12+LLDPE50μ",
  skuSummary: "充填物1 ／ 10,000枚",
  priceUnitLabel: "パウチ単価（金型・銅版除く／税抜）",
  priceUnit: "￥44.8",
  taxIncludedLabel: "総費用込単価（金型・銅版含む／税抜）",
  taxIncluded: "￥74.8",
  rows: [{
    name: "フィルム費用",
    description: "印刷方式：デジタル印刷",
    unit: "￥450 /m",
    quantity: "500 m",
    amount: "￥225,000",
  }],
  subtotalLabel: "小計（税抜）",
  subtotal: "￥914,067",
  taxLabel: "消費税（10%）",
  tax: "￥91,407",
  grandTotalLabel: "合計（税込）",
  grandTotal: "￥1,005,474",
  deliveryDate: "データ校了後約２か月",
  paymentTerms: "従来通り",
  validUntil: "2026-12-11",
  notes: "バルクサンプルは株式会社セブン化学へご送付ください。",
  footerNote: "データ入稿後に正式受注処理となります。",
  footerCompanyName: "株式会社セブン化学",
  footerEmail: "gotou@727.co.jp",
  footerTelephone: "072-971-0726",
  approverName: "吾藤",
  sealText: "セブン",
};

describe("standard quotation PDF", () => {
  it("embeds used Japanese glyphs and keeps the generated PDF small", async () => {
    const [regular, bold] = await Promise.all([
      readFile("src/fonts/NotoSansJP-Quotation-Regular.ttf"),
      readFile("src/fonts/NotoSansJP-Quotation-Bold.ttf"),
    ]);
    const blob = await generateStandardQuotationPdf(model, regular.buffer as ArrayBuffer, bold.buffer as ArrayBuffer, null);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(bytes.byteLength).toBeLessThan(250_000);
    const result = await extractText(bytes, { mergePages: true });
    expect(result.totalPages).toBeLessThanOrEqual(2);
    expect(result.text).toContain("株式会社セブン化学");
    expect(result.text).toContain("テスト得意先株式会社");
    expect(result.text).toContain("フィルム費用");
  });
});
