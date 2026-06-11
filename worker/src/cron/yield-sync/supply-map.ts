import { getCirculatingRaw } from "@shared/lib/supply";

export function buildStablecoinSupplyMapFromCacheValue(value: string): Map<string, number> {
  const parsed = JSON.parse(value) as unknown;
  const rawAssets =
    Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === "object" && Array.isArray((parsed as { peggedAssets?: unknown }).peggedAssets)
        ? (parsed as { peggedAssets: unknown[] }).peggedAssets
        : []);
  const supplyById = new Map<string, number>();

  for (const asset of rawAssets) {
    if (!asset || typeof asset !== "object") continue;
    const id = (asset as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const supplyUsd = getCirculatingRaw(asset as Parameters<typeof getCirculatingRaw>[0]);
    if (supplyUsd > 0) {
      supplyById.set(id, supplyUsd);
    }
  }

  return supplyById;
}
