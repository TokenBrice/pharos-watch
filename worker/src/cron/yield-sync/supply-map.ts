import { getCirculatingRaw } from "@shared/lib/supply";

export type StablecoinSupplyMapState = "ok" | "missing" | "malformed";

export interface StablecoinSupplyMapLoadResult {
  state: StablecoinSupplyMapState;
  supplyById: Map<string, number>;
}

export function buildStablecoinSupplyMapFromCacheValue(value: string): Map<string, number> {
  const parsed = JSON.parse(value) as unknown;
  const rawAssets = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "peggedAssets" in parsed && Array.isArray(parsed.peggedAssets)
      ? parsed.peggedAssets
      : null;
  if (!rawAssets) {
    throw new Error("Stablecoins cache payload must be an array or contain peggedAssets");
  }
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

export function loadStablecoinSupplyMapFromCacheValue(
  value: string | null | undefined,
): StablecoinSupplyMapLoadResult {
  if (value == null) {
    return { state: "missing", supplyById: new Map() };
  }
  try {
    return { state: "ok", supplyById: buildStablecoinSupplyMapFromCacheValue(value) };
  } catch {
    return { state: "malformed", supplyById: new Map() };
  }
}
