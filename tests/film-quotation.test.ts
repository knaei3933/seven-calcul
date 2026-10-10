import { describe, expect, it } from "vitest";
import { buildFilmQuotationFromRecord } from "@/lib/film-quotation";

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
    expect(quotation?.subtotal).toBe("141001");
    expect(quotation?.grandTotal).toBe("155102");
  });
});
