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

  it("uses the displayed-value snapshot without recomputing rounded quote lines", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      payload: {
        ...baseRecord.payload,
        quantity: "10000",
        fillingCostPerPiece: "3",
        filmCostPerPiece: "2",
        pricePerPieceDisplay: "38.8",
        fillingUnitDisplay: "16.3",
        fillingAmountDisplay: "163000",
        filmUnitDisplay: "450",
        filmPouchUnitDisplay: "22.5",
        filmAmountDisplay: "225000",
        adjustmentDisplay: "-",
        subtotalDisplay: "388000",
        taxDisplay: "38800",
        grandTotalDisplay: "426800",
      },
    });

    expect(analysis.sellingUnit.toNumber()).toBe(38.8);
    expect(analysis.fillingUnit.toNumber()).toBe(16.3);
    expect(analysis.fillingAmount.toNumber()).toBe(163000);
    expect(analysis.displayedFilmMeterUnit?.toNumber()).toBe(450);
    expect(analysis.filmUnit.toNumber()).toBe(22.5);
    expect(analysis.filmAmount.toNumber()).toBe(225000);
    expect(analysis.adjustment.toNumber()).toBe(0);
    expect(analysis.subtotal.toNumber()).toBe(388000);
    expect(analysis.tax.toNumber()).toBe(38800);
    expect(analysis.grandTotal.toNumber()).toBe(426800);
  });

  it("uses record totals as the display fallback for legacy payloads", () => {
    const analysis = analyzeQuotation(baseRecord);

    expect(analysis.sellingUnit.toNumber()).toBe(Number(baseRecord.pricePerPiece));
    expect(analysis.subtotal.toNumber()).toBe(Number(baseRecord.subtotal));
    expect(analysis.tax.toNumber()).toBe(Number(baseRecord.tax));
    expect(analysis.grandTotal.toNumber()).toBe(Number(baseRecord.grandTotal));
  });

  it("restores legacy quote lines from the record total and film order", () => {
    const analysis = analyzeQuotation({
      ...baseRecord,
      fillingCostPerPiece: "5.055864785420340975896531452087007642563",
      filmCostPerPiece: "18.22",
      filmMeterPrice: "328",
      pricePerPiece: "38.8",
      payload: {},
    });

    expect(analysis.displayedFilmMeterUnit?.toNumber()).toBe(450);
    expect(analysis.fillingUnit.toFixed(2)).toBe("16.30");
    expect(analysis.fillingAmount.toNumber()).toBe(163000);
    expect(analysis.filmUnit.toFixed(2)).toBe("22.50");
    expect(analysis.filmAmount.toNumber()).toBe(225000);
    expect(analysis.profitRate.toFixed(4)).toBe("40.0107");
  });
});
