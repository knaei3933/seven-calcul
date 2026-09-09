import { describe, expect, it } from "vitest";
import { calculatePouchCost } from "@/lib/calculation";
import { buildCalculationChecklistSnapshot, buildChecklistItems, readCalculationChecklistSnapshot } from "@/lib/calculation-checklist";

describe("calculation checklist snapshot", () => {
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
      webWidthMm: 556,
      skus: [{ name: "テスト", quantity: "10000", fillMl: "3", colorCount: "2" }],
    });

    expect(snapshot.pouchWidthMm).toBe("50");
    expect(snapshot.pouchLengthMm).toBe("80");
    expect(snapshot.materialWidthMm).toBe("556");
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

  it("rejects stale checklist snapshots with missing separated dimensions", () => {
    expect(readCalculationChecklistSnapshot({ checklistVersion: "2026-09.1", quantity: "1" })).toBeNull();
  });
});
