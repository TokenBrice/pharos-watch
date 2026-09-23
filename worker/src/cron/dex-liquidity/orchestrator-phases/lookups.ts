import { logWorkerEventArgs } from "../../../lib/structured-log";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../../lib/stablecoins-cache";
import { getCirculatingRaw } from "@shared/lib/supply";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinData } from "@shared/types/market";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
} from "../../../lib/depeg-trust-policy";

export interface TrackedStablecoinMaps {
  stablecoinPriceById: Map<string, number>;
  stablecoinMcapById: Map<string, number>;
}

/** A navToken's guarded NAV reference for measured-execution input legs: the
 *  protocol-redeem override the price pipeline already trust-gated (parent
 *  trust, live ERC-4626 convertToAssets read, publication validation). A
 *  navToken has no fixed peg, so its CoinGecko print is never a trusted quote
 *  leg — without this lane an sUSN pool leg stays unpriced and the Uniswap
 *  USN/sUSN exit route is never built. The cached-rate degradation lane
 *  ("low" confidence) and market prints never qualify; a missing or stale NAV
 *  fails closed. */
function isGuardedNavReferencePrice(asset: StablecoinData, nowSec: number): boolean {
  if (TRACKED_META_BY_ID.get(asset.id)?.flags.navToken !== true) return false;
  if (asset.priceConfidence !== "high") return false;
  if (!isPricingSourceProtocolOverride(asset.priceSource ?? null)) return false;
  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  return (
    typeof observedAt === "number" &&
    Number.isFinite(observedAt) &&
    observedAt > 0 &&
    nowSec - observedAt <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC
  );
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
          hasFreshMultiSourcePrimaryAgreement(asset, syncStartSec) ||
          isGuardedNavReferencePrice(asset, syncStartSec)
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
