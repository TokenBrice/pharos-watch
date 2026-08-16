import { logWorkerEventArgs } from "../../../lib/structured-log";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../../lib/stablecoins-cache";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
} from "../../../lib/depeg-trust-policy";

export interface TrackedStablecoinMaps {
  stablecoinPriceById: Map<string, number>;
  stablecoinMcapById: Map<string, number>;
}

/** Load the tracked price and market-cap maps from a single stablecoins-cache
 *  read. The dex-liquidity cron needs both, so loading the (several-hundred-KB)
 *  cache row once avoids a redundant D1 read and deserialisation. */
export async function loadTrackedStablecoinMaps(
  db: D1Database,
  syncStartSec: number,
): Promise<TrackedStablecoinMaps> {
  const stablecoinPriceById = new Map<string, number>();
  const stablecoinMcapById = new Map<string, number>();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient" });
  if (hasUsableStablecoinsPayload(stablecoinsCache)) {
    let skippedWeakTrackedPrices = 0;
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      if (
        asset.price != null &&
        Number.isFinite(asset.price) &&
        asset.price > 0 &&
        (
          classifyPrimaryDepegTrust(asset, syncStartSec) === "authoritative" ||
          hasFreshMultiSourcePrimaryAgreement(asset, syncStartSec)
        )
      ) {
        stablecoinPriceById.set(asset.id, asset.price);
      } else {
        skippedWeakTrackedPrices++;
      }
      const mcap = getCirculatingRaw(asset);
      if (mcap > 0) {
        stablecoinMcapById.set(asset.id, mcap);
      }
    }
    if (skippedWeakTrackedPrices > 0) {
      logWorkerEventArgs("handler", "info",
        `[dex-liquidity] Ignoring ${skippedWeakTrackedPrices} tracked stablecoin price(s) as weak/stale quote legs`,
      );
    }
  } else {
    logWorkerEventArgs("handler", "warn",
      "[dex-liquidity] Stablecoins cache unavailable for tracked quote pricing and market cap data; using reference-only / absolute fallback",
    );
  }

  return { stablecoinPriceById, stablecoinMcapById };
}
