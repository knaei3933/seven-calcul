import { describe, expect, it } from "vitest";
import { analyzeQuotation, filmCompositionOf } from "@/lib/quotation-history";
import { DEFAULT_FILM_COMPOSITION, type QuotationRecord } from "@/lib/quotation-shared";

const baseRecord = {
  id: 1,
  quotationNumber: "Q-TEST",
  status: "draft",
  issueDate: "2026-09-05",
  validUntil: "2026-09-30",
  customerName: "テスト株式会社",
  customerContact: "田中様",
  productName: "テストパウチ",
  sizeSummary: "50×60mm / 1連",
  quantity: "10000",
  fillingCostPerPiece: "3",
  filmCostPerPiece: "2",
  filmMeterPrice: "226",
  filmOrderLengthM: "500",
  targetMargin: "0.4",
  taxRatePercent: "10",
  pricePerPiece: "8.333333333333334",
  subtotal: "83333",
  tax: "8333",
  grandTotal: "91666",
  deliveryDate: "別途相談",
  paymentTerms: "別途相談",
  notes: "",
  calculationVersion: "simulator-linked",
  resultHash: "hash",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  payload: {},
} as unknown as QuotationRecord;

describe("quotation history analysis", () => {
  it("recalculates profit from an edited selling price", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: { ...baseRecord.payload, pricePerPieceDisplay: "6" },
    });

    expect(analysis.costUnit.toNumber()).toBe(5);
    expect(analysis.sellingUnit.toNumber()).toBe(6);
    expect(analysis.profitUnit.toNumber()).toBe(1);
    expect(analysis.profitRate.toFixed(2)).toBe("16.67");
    expect(analysis.totalProfit.toNumber()).toBe(10000);
  });

  it("keeps the film composition backward compatible for older records", () => {
    expect(filmCompositionOf(baseRecord)).toBe(DEFAULT_FILM_COMPOSITION);
    expect(filmCompositionOf({
      ...baseRecord,
      payload: { ...baseRecord.payload, filmComposition: "PET12/AL7" },
    })).toBe("PET12/AL7");
  });
});
