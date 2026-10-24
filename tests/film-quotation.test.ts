import { describe, expect, it } from "vitest";
import { buildFilmQuotationFromRecord, filmQuotationNumberFor } from "@/lib/film-quotation";

describe("film quotation linkage", () => {
  it("creates a paired film number and shows the product and film printing specification", () => {
    const quotation = buildFilmQuotationFromRecord({
      quotationNumber: "S7-202610-073",
      customerName: "美容研究所テスト株式会社",
      issueDate: "2026-10-10",
      validUntil: "2026-11-09",
      productName: "保湿美容液ミニパウチ",
      quantity: "20000",
      payload: {
        filmOrderLengthM: "900",
        calculationFilmTotal: "141000.4",
        filmUnitDisplay: "156.7",
        purchaseOrder: {
          webWidthMm: 500,
          filmComposition: "PET12+AL7+PET12+LLDPE50μ",
          printingMethod: "gravure",
          colorCount: 4,
        },
      },
    });

    expect(quotation?.quotationNumber).toBe("K-202610-073-F");
    expect(quotation?.pouchQuotationNumber).toBe("S7-202610-073");
    expect(quotation?.endCustomerName).toBe("美容研究所テスト株式会社");
    expect(quotation?.items[0]?.description).toBe("異形パウチ専用フィルム");
    expect(quotation?.items[0]?.specification).toContain("商品名：美容研究所テスト株式会社／保湿美容液ミニパウチ");
    expect(quotation?.items[0]?.specification).toContain("フィルム構成：PET12+AL7+PET12+LLDPE50μ");
    expect(quotation?.items[0]?.specification).toContain("印刷方式：グラビア印刷（ロール）");
    expect(quotation?.items[0]?.specification).toContain("印刷色数：4色");
    expect(quotation?.printingMethodLabel).toBe("グラビア印刷（ロール）");
    expect(quotation?.colorCountLabel).toBe("4色");
    expect(quotation?.items[0]?.specification).toContain("単価条件：フィルム製作・国内輸送・海外輸送・通関費込み");
    expect(quotation?.subtotal).toBe("141001");
    expect(quotation?.grandTotal).toBe("155102");
  });

  it("shows the film unit price including shipping and customs costs", () => {
    const quotation = buildFilmQuotationFromRecord({
      quotationNumber: "KT-202610-003",
      customerName: "株式会社フォーライフ",
      issueDate: "2026-10-22",
      validUntil: "2026-11-21",
      productName: "レディエイドルプリカント",
      quantity: "50000",
      payload: {
        filmOrderLengthM: "1200",
        calculationFilmTotal: "363000",
        filmUnitDisplay: "252",
        calculationChecklistSnapshot: {
          printingMethod: "digital",
          film: {
            requiredLengthM: "1194.4444444444445",
            orderLengthM: "1200",
            unitPrice: "252",
            filmTotal: "363000",
          },
          materialWidthMm: "556",
        },
      },
    });

    // 252×1200=302,400＋国内配送6,000＋海外配送48,000＋通関6,600＝363,000
    expect(quotation?.items[0]?.orderLengthM).toBe("1200");
    expect(quotation?.items[0]?.unitPriceYenPerM).toBe("302.5");
    expect(quotation?.items[0]?.amountYen).toBe("363000");
    expect(quotation?.subtotal).toBe("363000");
    expect(quotation?.grandTotal).toBe("399300");
  });

  it("handles repeating landed unit prices safely", () => {
    const quotation = buildFilmQuotationFromRecord({
      quotationNumber: "S7-EDGE-REPEAT",
      issueDate: "2026-10-24",
      validUntil: "2026-11-23",
      productName: "Edge Product",
      quantity: "10000",
      payload: { filmOrderLengthM: "900", calculationFilmTotal: "100000" },
    });
    expect(quotation?.items[0]?.unitPriceYenPerM).toBe("111.1111");
    expect(quotation?.items[0]?.amountYen).toBe("100000");
  });

  it("falls back safely when a stored total is corrupt", () => {
    const quotation = buildFilmQuotationFromRecord({
      quotationNumber: "S7-EDGE-CORRUPT",
      issueDate: "2026-10-24",
      validUntil: "2026-11-23",
      productName: "Edge Product",
      quantity: "10000",
      payload: {
        filmOrderLengthM: "1200",
        calculationChecklistSnapshot: {
          film: { orderLengthM: "1200", unitPrice: "252", filmTotal: "not-a-number" },
        },
      },
    });
    expect(quotation?.items[0]?.unitPriceYenPerM).toBe("252");
    expect(quotation?.items[0]?.amountYen).toBe("302400");
  });

  it("rejects invalid and negative money data without throwing", () => {
    expect(buildFilmQuotationFromRecord({
      quotationNumber: "S7-EDGE-LENGTH",
      issueDate: "2026-10-24",
      validUntil: "2026-11-23",
      productName: "Edge Product",
      quantity: "10000",
      filmOrderLengthM: "not-a-number",
      payload: { calculationFilmTotal: "100000" },
    })).toBeNull();
    const negative = buildFilmQuotationFromRecord({
      quotationNumber: "S7-EDGE-NEGATIVE",
      issueDate: "2026-10-24",
      validUntil: "2026-11-23",
      productName: "Edge Product",
      quantity: "10000",
      filmOrderLengthM: "1200",
      payload: { calculationFilmTotal: "-100" },
    });
    expect(Number(negative?.items[0]?.amountYen)).toBe(0);
    expect(Number(negative?.subtotal)).toBe(0);
  });
});

describe("film quotation numbering", () => {
  it("keeps legacy sequential numbers paired", () => {
    expect(filmQuotationNumberFor("S7-202610-073", "2026-10-10")).toBe("K-202610-073-F");
  });

  it("derives random-source numbers deterministically from the pouch quotation", () => {
    expect(filmQuotationNumberFor("S7-MVDJSIND", "2026-10-18")).toBe("K-MVDJSIND-F");
    expect(filmQuotationNumberFor("S7-MVDJSIND", "2027-03-01")).toBe("K-MVDJSIND-F");
  });
});
