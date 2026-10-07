import { describe, expect, it } from "vitest";
import { calculatePouchCost } from "@/lib/calculation";
import { D } from "@/lib/decimal";
import { buildCalculationChecklistSnapshot, buildChecklistItems, readCalculationChecklistSnapshot } from "@/lib/calculation-checklist";

describe("calculation checklist snapshot", () => {
  it("stores a volume-weighted bulk unit price for multi-liquid chamber compositions", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "tube-35x80",
        fillMlPerChamber: "7.5",
        connectedChambers: 2,
        chambers: [
          { liquidName: "A", fillMl: "10", bulkUnitPrice: "0.37" },
          { liquidName: "B", fillMl: "5", bulkUnitPrice: "0.8" },
        ],
        fillingMethod: "hopper",
        fillingLanes: 4,
        isCustom: false,
        colorCount: 2,
        bulkUnitPrice: "0",
        skuCount: 1,
      },
      quantity: "10000",
      printingMethod: "digital",
    });
    const snapshot = buildCalculationChecklistSnapshot(result, {
      quotationNumber: "保存前",
      printingMethod: "digital",
      sourceHash: "source",
      resultHash: "result",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      widthMm: "35",
      lengthMm: "80",
      pitchMm: "88",
      pitchAddMm: "8",
      webWidthMm: 356,
      bulkUnitPrice: "0",
      skus: [{ name: "テスト", quantity: "10000", fillMl: "7.5", colorCount: "2" }],
    });
    // 단가×사용량＝비용이 성립하도록 가중평균 단가 저장: 102,440엔 ÷ 199,000ml.
    expect(snapshot.liquids).toHaveLength(2);
    expect(D(snapshot.bulkUnitPrice).times(snapshot.bulkUsageMl).toDecimalPlaces(0, 4).toString()).toBe(snapshot.bulkCost);
    expect(D(snapshot.bulkUnitPrice).gt("0.51")).toBe(true);
  });

  it("keeps pouch dimensions, web width, and pitch separate", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "round-50x80",
        customWidthMm: "50",
        customLengthMm: "80",
        fillMlPerChamber: "3",
        connectedChambers: 1,
        fillingMethod: "hopper",
        fillingLanes: 4,
        isCustom: false,
        colorCount: 2,
        bulkUnitPrice: "0",
        skuCount: 1,
      },
      quantity: "10000",
      printingMethod: "digital",
    });
    const snapshot = buildCalculationChecklistSnapshot(result, {
      quotationNumber: "保存前",
      printingMethod: "digital",
      sourceHash: "source",
      resultHash: "result",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      widthMm: "50",
      lengthMm: "80",
      pitchMm: "88",
      pitchAddMm: "8",
      webWidthMm: 999,
      skus: [{ name: "テスト", quantity: "10000", fillMl: "3", colorCount: "2" }],
    });

    expect(snapshot.pouchWidthMm).toBe("50");
    expect(snapshot.pouchLengthMm).toBe("80");
    expect(snapshot.materialWidthMm).toBe(String(result.film.skuCosts[0]?.webWidthMm));
    expect(snapshot.materialWidthMm).not.toBe("999");
    expect(snapshot.pitchMm).toBe("88");

    const items = buildChecklistItems(snapshot);
    expect([...new Set(items.map((item) => item.category))]).toEqual([
      "基本条件",
      "生産条件",
      "充填・加工費",
      "バルク費用",
      "フィルム費用",
      "原価・販売価格",
    ]);
    const size = items.find((item) => item.id === "basic.size")!;
    const pitch = items.find((item) => item.id === "basic.pitch")!;
    expect(size.result).toBe("50 × 80");
    expect(pitch.inputs).toContain("ピッチ加算 = 8 mm");
    expect(pitch.result).toBe("88");
    expect(readCalculationChecklistSnapshot(snapshot)).not.toBeNull();
  });

  it("uses the selected gravure result width instead of generic context width", () => {
    const input = {
      spec: {
        sizeKey: "tube-50x90" as const,
        fillMlPerChamber: "3",
        connectedChambers: 1 as const,
        fillingMethod: "hopper" as const,
        fillingLanes: 4,
        isCustom: false,
        colorCount: 4,
        bulkUnitPrice: "0",
        skuCount: 1,
      },
      quantity: "50000",
      printingMethod: "digital" as const,
    };
    const original = calculatePouchCost({ ...input, recommendationMode: true });
    const candidate = original.recommendationCandidates?.find((item) => item.route === "Y");
    expect(candidate).toBeDefined();
    const selected = calculatePouchCost({
      ...input,
      recommendationMode: true,
      selectedCandidateId: candidate!.id,
    });
    expect(selected.gravure).toBeDefined();

    const snapshot = buildCalculationChecklistSnapshot(selected, {
      quotationNumber: "selected",
      printingMethod: "gravure",
      sourceHash: "source",
      resultHash: "selected-result",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      webWidthMm: 999,
    });

    expect(snapshot.materialWidthMm).toBe(selected.gravure?.materialWidthMm);
    expect(snapshot.materialWidthMm).not.toBe("999");
  });

  it("shows mixed large-lot digital film formulas that reconcile to the saved result", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "tube-35x60",
        fillMlPerChamber: "3",
        connectedChambers: 1,
        fillingMethod: "hopper",
        fillingLanes: 4,
        isCustom: false,
        colorCount: 4,
        bulkUnitPrice: "0",
        skuCount: 2,
        skuQuantities: ["60000", "30000"],
        skuFillMlPerChamber: ["3", "3"],
        skuColorCounts: ["4", "4"],
      },
      quantity: "90000",
      printingMethod: "digital",
    });
    const snapshot = buildCalculationChecklistSnapshot(result, {
      quotationNumber: "mixed",
      printingMethod: "digital",
      sourceHash: "source",
      resultHash: "result",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      widthMm: "35",
      lengthMm: "60",
      pitchMm: "66",
      pitchAddMm: "6",
      webWidthMm: 356,
    });
    const items = buildChecklistItems(snapshot);
    const loss = items.find((item) => item.id === "film.loss")!;
    const effective = items.find((item) => item.id === "film.effective-length")!;
    const unitPrice = items.find((item) => item.id === "film.unit-price")!;
    const shipping = items.find((item) => item.id === "film.shipping-trips")!;
    const baseCost = items.find((item) => item.id === "film.base-cost")!;

    expect(loss.substitution).toContain("MAX(80, 1,200×0.10)=120");
    expect(loss.substitution).toContain("MAX(80, 600×0.10)=80");
    expect(loss.result).toBe("200");
    expect(effective.substitution).toContain("1,800 − 200 = 1,600");
    expect(unitPrice.explanation).toContain("加重平均");
    expect(unitPrice.result).toBe("346.5");
    expect(baseCost.substitution).toContain("600×365");
    expect(baseCost.substitution).toContain("600×328");
    expect(shipping.inputs).toContain("生産換算長 = 1,800m");
  });

  it("rejects stale checklist snapshots with missing separated dimensions", () => {
    expect(readCalculationChecklistSnapshot({ checklistVersion: "2026-09.1", quantity: "1" })).toBeNull();
  });

  it("hides gravure film cost components and shows the confirmed supply price", () => {
    const result = calculatePouchCost({
      spec: {
        sizeKey: "round-50x60",
        customWidthMm: "50",
        customLengthMm: "60",
        fillMlPerChamber: "3",
        connectedChambers: 1,
        fillingMethod: "hopper",
        fillingLanes: 4,
        isCustom: false,
        colorCount: 2,
        bulkUnitPrice: "0",
        skuCount: 1,
      },
      quantity: "10000",
      printingMethod: "gravure",
    });
    const snapshot = buildCalculationChecklistSnapshot(result, {
      quotationNumber: "保存前",
      printingMethod: "gravure",
      sourceHash: "source",
      resultHash: "result",
      filmComposition: "PET12+AL7+PET12+LLDPE50",
      widthMm: "50",
      lengthMm: "60",
      pitchMm: "66",
      pitchAddMm: "6",
      webWidthMm: 500,
      skus: [{ name: "テスト", quantity: "10000", fillMl: "3", colorCount: "2" }],
    });
    const items = buildChecklistItems(snapshot);
    const gravureItems = items.filter((item) => item.id.startsWith("gravure."));
    const serialized = gravureItems.map((item) => [
      item.variable, item.explanation, item.inputs, item.formula, item.substitution,
    ].join("\n")).join("\n");

    expect(gravureItems.map((item) => item.id)).toEqual([
      "gravure.pattern-count",
      "gravure.production-length",
      "gravure.sale-meter-price",
      "gravure.film-total",
      "gravure.copper-plate-unit",
      "gravure.copper-plate",
    ]);
    expect(serialized).not.toContain("原材料費");
    expect(serialized).not.toContain("印刷費");
    expect(serialized).not.toContain("ラミネート費");
    expect(serialized).not.toContain("製造マージン");
    expect(serialized).not.toContain("通関料");
    expect(serialized).not.toContain("海外配送費");
    expect(serialized).not.toContain("供給価格調整");
    expect(items.find((item) => item.id === "gravure.sale-meter-price")!.unit).toBe("円/m");
  });
});
