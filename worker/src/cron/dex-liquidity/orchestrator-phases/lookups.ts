import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../../lib/stablecoins-cache";
import { getCirculatingRaw } from "@shared/lib/supply";
import { classifyPrimaryDepegTrust } from "../../../lib/depeg-trust-policy";

export async function loadTrackedStablecoinPriceMap(
  db: D1Database,
  syncStartSec: number,
): Promise<Map<string, number>> {
  const stablecoinPriceById = new Map<string, number>();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (hasUsableStablecoinsPayload(stablecoinsCache)) {
    let skippedWeakTrackedPrices = 0;
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      if (
        asset.price != null &&
        Number.isFinite(asset.price) &&
        asset.price > 0 &&
        classifyPrimaryDepegTrust(asset, syncStartSec) === "authoritative"
      ) {
        stablecoinPriceById.set(asset.id, asset.price);
      } else {
        skippedWeakTrackedPrices++;
      }
    }
    if (skippedWeakTrackedPrices > 0) {
      console.log(
        `[dex-liquidity] Ignoring ${skippedWeakTrackedPrices} tracked stablecoin price(s) as weak/stale quote legs`,
      );
    }
  } else {
    console.warn(
      "[dex-liquidity] Stablecoins cache unavailable for tracked quote pricing; using reference-only fallback",
    );
  }

  return stablecoinPriceById;
}

export async function loadTrackedStablecoinMcapMap(
  db: D1Database,
): Promise<Map<string, number>> {
  const mcapById = new Map<string, number>();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  if (hasUsableStablecoinsPayload(stablecoinsCache)) {
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      const mcap = getCirculatingRaw(asset);
      if (mcap > 0) {
        mcapById.set(asset.id, mcap);
      }
    }
  } else {
    console.warn("[dex-liquidity] Stablecoins cache unavailable for market cap data; TVL depth will use absolute fallback");
  }
  return mcapById;
}
