import { logWorkerEventArgs } from "../../../lib/structured-log";
import { hasUsableStablecoinsPayload, loadStablecoinsCache } from "../../../lib/stablecoins-cache";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { CURVE_POOL_CONFIGS } from "@shared/lib/curve-pool-configs";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { getPricingSourceRegistryEntry, isPricingSourceProtocolOverride } from "@shared/lib/pricing-source-registry";
import { isObservedPrice } from "@shared/lib/pricing-source-policy";
import { normalizePricingSourceKeys } from "@shared/lib/pricing-sources";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { configuredPrimaryUpstreamKeys, readDexPriceLineage } from "../price-lineage";
import type { DexAmmExecutionToken } from "@shared/types/dex-execution";
import type { StablecoinData } from "@shared/types/supply";
import type { DexMarketMark, DexValuationPrices } from "../../../lib/dex-api-token-pricing";
import {
  classifyPrimaryDepegTrust,
  hasFreshMultiSourcePrimaryAgreement,
} from "../../../lib/depeg-trust-policy";

export interface TrackedStablecoinMaps {
  stablecoinPriceById: Map<string, number> & DexValuationPrices;
  primaryPriceById: Map<string, number>;
  stablecoinMcapById: Map<string, number>;
  stablecoinPriceProvenanceById: Map<string, Required<Pick<DexAmmExecutionToken, "referencePriceSourceId" | "referencePriceObservedAt">>>;
}

function marketMarkSourceScope(asset: StablecoinData): "market" | "curve-pools" | null {
  if (WORKER_TRACKED_META_BY_ID.get(asset.id)?.flags.navToken || asset.priceObservedAtMode === "unknown") return null;
  const sources = normalizePricingSourceKeys([asset.priceSource, ...(asset.agreeSources ?? [])]);
  const eligible = sources.length > 0 && sources.every((source) => {
    if (source === "curve-onchain") return CURVE_POOL_CONFIGS.some((config) => config.stablecoinId === asset.id);
    const entry = getPricingSourceRegistryEntry(source);
    return entry != null && !entry.isRetired &&
      (entry.trustTier === "hard_market" || entry.trustTier === "soft_aggregator") &&
      !entry.depegSourceFamily.startsWith("dex:");
  });
  if (!eligible) return null;
  return sources.includes("curve-onchain") ? "curve-pools" : "market";
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
  if (WORKER_TRACKED_META_BY_ID.get(asset.id)?.flags.navToken !== true) return false;
  if (asset.priceConfidence !== "high") return false;
  if (!isPricingSourceProtocolOverride(asset.priceSource ?? null)) return false;
  const observedAt = asset.priceObservedAt ?? asset.priceUpdatedAt ?? null;
  return (
    typeof observedAt === "number" &&
    Number.isFinite(observedAt) &&
    observedAt > 0 &&
    // An observation clock ahead of this stage's clock is not freshness.
    observedAt <= nowSec &&
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
  const marketMarks = new Map<string, DexMarketMark>();
  const curveExecutionMarks = new Map<string, DexMarketMark>();
  const stablecoinPriceById = Object.assign(new Map<string, number>(), { marketMarks, curveExecutionMarks });
  const primaryPriceById = new Map<string, number>();
  const stablecoinMcapById = new Map<string, number>();
  const stablecoinPriceProvenanceById: TrackedStablecoinMaps["stablecoinPriceProvenanceById"] = new Map();
  const stablecoinsCache = await loadStablecoinsCache(db, { mode: "lenient" });
  if (hasUsableStablecoinsPayload(stablecoinsCache)) {
    let skippedWeakTrackedPrices = 0;
    for (const asset of stablecoinsCache.payload.peggedAssets) {
      const observedAt = asset.priceObservedAt === undefined ? asset.priceUpdatedAt : asset.priceObservedAt;
      // A comparison anchor never values a quote token or supplies corroboration.
      if (isObservedPrice(asset) && asset.price != null && Number.isFinite(asset.price) && asset.price > 0 &&
        asset.priceSource && asset.priceSource !== "cached" &&
        (asset.priceConfidence === "single-source" || asset.priceConfidence === "high") &&
        Number.isSafeInteger(observedAt) && observedAt! > 0 && observedAt! <= syncStartSec &&
        syncStartSec - observedAt! <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) {
        primaryPriceById.set(asset.id, asset.price);
      }
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
        if (asset.priceSource && Number.isSafeInteger(observedAt) && observedAt! > 0 &&
          observedAt! <= syncStartSec && syncStartSec - observedAt! <= DEPEG_PRIMARY_PRICE_MAX_AGE_SEC) {
          stablecoinPriceProvenanceById.set(asset.id, {
            referencePriceSourceId: asset.priceSource,
            referencePriceObservedAt: observedAt!,
          });
          const scope = observedAt === asset.priceObservedAt ? marketMarkSourceScope(asset) : null;
          if (scope) {
            const lineage = readDexPriceLineage(asset);
            const mark: DexMarketMark = { priceUsd: asset.price, observedAtSec: observedAt!, source: asset.priceSource,
              ...(asset.priceObservedAtMode === "upstream" ? { observedAtMode: asset.priceObservedAtMode } : {}),
              ...(hasFreshMultiSourcePrimaryAgreement(asset, syncStartSec) ? { corroboration: "multi-source" as const } : {}),
              ...lineage };
            if (scope === "market") {
              marketMarks.set(asset.id, mark);
            } else if (lineage.upstreamKeys?.length !== 0 && (lineage.pricePoolKeys?.length !== 0 || lineage.upstreamKeys)) {
              // A configured Curve quote is independent only outside its complete physical pool/hop set.
              const upstreamKeys = [...new Set([...configuredPrimaryUpstreamKeys(asset.id), ...(lineage.upstreamKeys ?? []), ...(lineage.pricePoolKeys ?? [])])];
              curveExecutionMarks.set(asset.id, { ...mark, upstreamKeys });
            }
          }
        }
      } else {
        skippedWeakTrackedPrices++;
      }
      const mcap = getCirculatingRawOrNull(asset);
      if (mcap !== null && mcap > 0) {
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

  return { stablecoinPriceById, primaryPriceById, stablecoinMcapById, stablecoinPriceProvenanceById };
}
