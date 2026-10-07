"use client";

export interface LiquidMasterItem {
  id: string;
  name: string;
  unitPriceYen: string;
  memo?: string;
}

export const LIQUID_MASTER_KEY = "pouch-liquid-master-v1";

export function parseLiquidMaster(value: unknown): LiquidMasterItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<LiquidMasterItem>;
    if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
    if (typeof candidate.unitPriceYen !== "string" || !/^\d+(?:\.\d+)?$/.test(candidate.unitPriceYen)) return [];
    return [{
      id: candidate.id,
      name: candidate.name.trim(),
      unitPriceYen: candidate.unitPriceYen,
      memo: typeof candidate.memo === "string" ? candidate.memo : "",
    }].filter((liquid) => liquid.name !== "");
  });
}

export function loadLiquidMaster(): LiquidMasterItem[] {
  if (typeof window === "undefined") return [];
  try {
    return parseLiquidMaster(JSON.parse(window.localStorage.getItem(LIQUID_MASTER_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveLiquidMaster(items: LiquidMasterItem[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LIQUID_MASTER_KEY, JSON.stringify(items));
}

export function upsertLiquidMaster(item: LiquidMasterItem): LiquidMasterItem[] {
  const items = loadLiquidMaster();
  const index = items.findIndex((existing) => existing.id === item.id);
  const next = index >= 0
    ? items.map((existing, i) => (i === index ? item : existing))
    : [...items, item];
  saveLiquidMaster(next);
  return next;
}

export function removeLiquidMaster(id: string): LiquidMasterItem[] {
  const next = loadLiquidMaster().filter((item) => item.id !== id);
  saveLiquidMaster(next);
  return next;
}

export function newLiquidMasterId(): string {
  return `liquid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
