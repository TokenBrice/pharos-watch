import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS } from "@shared/lib/stablecoins/frozen-snapshots";
import { getOnchainSupplyHoldReason, isOnchainSupplyPartitionExcluded, prefersOnChainSupplyMcap, selectCuratedAggregateOnchainSupplyProbeContracts, SFRAX_STOCK_PERIMETER } from "@shared/lib/onchain-supply-probe";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { MIN_VALID_ASSET_COUNT } from "../../lib/market-supply/stablecoin-intake-policy";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { CronProgressReporter } from "../../lib/cron-logger";
import type { DwellirNativeCapability } from "../../lib/dwellir-native";
import { throwIfAborted } from "../../lib/abort";
import { validatePricingSourceFreshness } from "../../lib/pricing/pricing-source-freshness";
import type { CronResult } from "./shared";
import { buildSyncMetadata, hydrateGeckoIdAliases, restorePreferredNativeSupply } from "./shared";
import { filterStructurallyValidAssets, normalizeChainCirculating } from "./phase-helpers";
import { reportStablecoinsStage } from "./runtime";
import type { PeggedAsset } from "./enrich-prices";
import { mergeFrozenSnapshots } from "./intake";
import { NAV_PARENT_ONLY_GECKO_IDS } from "./supplemental-assets";
import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap, toPublicChainCirculating } from "./supplemental-assets/onchain-supply";
import type { OnChainMcapResult } from "./supplemental-assets/onchain-supply";
import { buildSupplementalAsset, pegTypeKey, toPositiveFiniteNumber, type CoinGeckoMcapData } from "./supplemental-assets/shared";

interface FallbackStablecoinMetadata {
  id: string;
  name: string;
  symbol: string;
  geckoId?: string;
  flags: {
    pegCurrency: string;
    backing: string;
  };
}

interface FallbackIntakeInput {
  cgData: CoinGeckoMcapData;
  syncStartSec: number;
  reportProgress?: CronProgressReporter;
  stablecoins?: readonly FallbackStablecoinMetadata[];
}

export function buildInsufficientFallbackResult(assetCount: number): CronResult {
  return {
    metadata: buildSyncMetadata({
      rowsRead: assetCount,
      rowsWritten: 0,
      rowsDropped: 0,
      sourceCoverage: { defillama: false, coingeckoFallbackAssets: assetCount },
      fallbackMode: "coingecko-supply-fallback",
      validationFailures: 1,
    }, {
      capabilities: {
        stablecoinsCache: false,
        depegPipeline: false,
      },
    }),
  };
}

export function resolveFreshCoinGeckoFallbackEntry(entry: CoinGeckoMcapData[string] | undefined, nowSec: number): { mcap: number; price: number | null; observedAt: number } | null {
  const mcap = toPositiveFiniteNumber(entry?.usd_market_cap);
  const observedAt = toPositiveFiniteNumber(entry?.last_updated_at);
  if (mcap == null || observedAt == null) return null;
  const freshness = validatePricingSourceFreshness({
    source: "coingecko", observedAt, observedAtMode: "upstream", nowSec, requireObservedAt: true,
  });
  if (!freshness.accepted || freshness.observedAt == null) return null;

  return { mcap, price: toPositiveFiniteNumber(entry?.usd), observedAt: freshness.observedAt };
}

export function buildFallbackAssetsFromCoinGecko(
  input: Pick<FallbackIntakeInput, "cgData" | "syncStartSec"> & {
    stablecoins?: readonly FallbackStablecoinMetadata[];
  },
): PeggedAsset[] {
  const stablecoins = input.stablecoins ?? ACTIVE_STABLECOINS;
  const assets: PeggedAsset[] = [];

  for (const meta of stablecoins) {
    // Parent-only price quotes and native Hive supply cannot admit CoinGecko supply.
    if (!meta.geckoId || NAV_PARENT_ONLY_GECKO_IDS.has(meta.geckoId) || meta.id === "hbd-hive") continue;
    const entry = resolveFreshCoinGeckoFallbackEntry(input.cgData[meta.geckoId], input.syncStartSec);
    if (!entry) continue;

    assets.push(buildSupplementalAsset({
      meta,
      priceResolution: entry.price != null
        ? { price: entry.price, source: "coingecko", observedAt: entry.observedAt, observedAtMode: "upstream" }
        : null,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceUpdatedAt: entry.observedAt,
      priceObservedAt: entry.observedAt,
      priceObservedAtMode: "upstream",
      priceSyncedAt: input.syncStartSec,
      nowSec: input.syncStartSec,
      mcap: entry.mcap,
      supplyObservedAt: entry.observedAt,
      supplySource: "coingecko-fallback",
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
      chainCirculating: {},
      chainLabels: [],
    }));
  }

  return assets;
}

export async function runFallbackIntakePhase(
  input: FallbackIntakeInput,
): Promise<{ assets: PeggedAsset[] } | CronResult> {
  await reportStablecoinsStage(input.reportProgress, "fallback-intake", "Building CoinGecko fallback intake");
  const coingeckoAssets = buildFallbackAssetsFromCoinGecko(input);
  // The floor grades the CoinGecko-served cohort; archived frozen rows must not
  // make a collapsed feed look sufficient.
  if (coingeckoAssets.length < MIN_VALID_ASSET_COUNT) {
    logWorkerEventArgs("handler", "error",
      `[sync-stablecoins] CG fallback only got ${coingeckoAssets.length} assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
    return buildInsufficientFallbackResult(coingeckoAssets.length);
  }
  // Frozen coins are absent from every upstream list, so the outage publication
  // injects their captured DefiLlama rows exactly as the primary intake does:
  // merge before structural admission, then normalize the provider buckets.
  const { validAssets } = filterStructurallyValidAssets(
    mergeFrozenSnapshots(coingeckoAssets, FROZEN_SNAPSHOTS),
  );
  hydrateGeckoIdAliases(validAssets);
  normalizeChainCirculating(validAssets);
  const assets = validAssets;

  return { assets };
}

/**
 * Overlays fresh curated-aggregate on-chain per-chain circulating supply onto
 * fallback assets whose upstream market row carries no chain breakdown (Sky
 * savings NAV wrappers such as sUSDS/sDAI have a null DefiLlama id, so the
 * CoinGecko intake hardcodes an empty `chainCirculating`). Run this after the
 * previous-cache load. Failed/skipped preferred probes restore eligible native
 * packets or publish unavailable supply while retaining price. Partition-excluded
 * fresh CoinGecko caps and nonpreferred totals remain. Native units use the
 * admitted price, never a par substitute when observed valuation is missing.
 * The probe reads each contract sequentially, so the added calls stay within
 * Cloudflare's 6-connection per-trigger pool.
 */
export async function overlayFallbackCuratedAggregateSupply(
  assets: PeggedAsset[],
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  dwellirNative?: DwellirNativeCapability,
  previousAssetsById?: ReadonlyMap<string, PeggedAsset>,
): Promise<void> {
  for (const asset of assets) {
    throwIfAborted(signal);
    const meta = ACTIVE_META_BY_ID.get(String(asset.id));
    if (!meta || (!prefersOnChainSupplyMcap(meta) && !selectCuratedAggregateOnchainSupplyProbeContracts(meta))) continue;
    if (isOnchainSupplyPartitionExcluded(meta.id) && asset.supplySource === "coingecko-fallback"
      && getCirculatingRawOrNull(asset) !== null) continue;

    const priceUsd = toPositiveFiniteNumber(asset.price);
    let onChainMcap: OnChainMcapResult | null = null;
    if (priceUsd != null) {
      onChainMcap = await fetchCuratedAggregateOnChainMcap(meta, priceUsd, chainRpcs, signal, dwellirNative);
      // A preferred single-register asset has no curated roster but still owns
      // a readable native stock; withholding it would publish unavailable
      // supply the one deployment can prove. `fetchOnChainMcap` refuses every
      // multi-contract footprint, so no ambiguous perimeter is summed here.
      if (!onChainMcap && prefersOnChainSupplyMcap(meta) && !getOnchainSupplyHoldReason(meta.id)) {
        onChainMcap = await fetchOnChainMcap(meta, priceUsd, chainRpcs, signal, dwellirNative);
      }
    }
    if (!onChainMcap?.chainCirculating) {
      if (prefersOnChainSupplyMcap(meta) && !getOnchainSupplyHoldReason(meta.id)) {
        Object.assign(asset, restorePreferredNativeSupply(asset, previousAssetsById?.get(meta.id), Math.floor(Date.now() / 1000)));
      }
      continue;
    }

    const pegKey = pegTypeKey(meta);
    asset.circulating = { [pegKey]: onChainMcap.mcap };
    asset.supplySource = onChainMcap.supplySource;
    asset.supplyObservedAt = onChainMcap.observedAt ?? null;
    asset.chainCirculating = toPublicChainCirculating(onChainMcap.chainCirculating);
    asset.chains = Object.keys(onChainMcap.chainCirculating);
    if (meta.id === SFRAX_STOCK_PERIMETER.assetId) {
      asset.supplyPerimeter = onChainMcap.supplyPerimeter;
    }
    if (prefersOnChainSupplyMcap(meta)) {
      asset.circulatingPrevDay = null;
      asset.circulatingPrevWeek = null;
      asset.circulatingPrevMonth = null;
      delete asset.supplyUnavailableReason;
      delete asset.supplyRestored;
      delete asset.supplyGapFill;
      delete asset.supplyChainGuard;
      delete asset.chainPartition;
    }
  }
}
