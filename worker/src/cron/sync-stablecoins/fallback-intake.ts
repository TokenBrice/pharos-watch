import { logWorkerEventArgs } from "../../lib/structured-log";
import { ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { selectCuratedAggregateOnchainSupplyProbeContracts } from "@shared/lib/onchain-supply-probe";
import { MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import { throwIfAborted } from "../../lib/abort";
import type { CronResult } from "./shared";
import { buildSyncMetadata } from "./shared";
import { reportStablecoinsStage } from "./runtime";
import type { PeggedAsset } from "./enrich-prices";
import { fetchCuratedAggregateOnChainMcap } from "./supplemental-assets/onchain-supply";
import { pegTypeKey, toPositiveFiniteNumber } from "./supplemental-assets/shared";
import type {
  FallbackIntakeInput,
  FallbackIntakeOutput,
  FallbackStablecoinMetadata,
} from "./fallback-types";

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

export function buildFallbackAssetsFromCoinGecko(
  input: Pick<FallbackIntakeInput, "cgData" | "syncStartSec"> & {
    stablecoins?: readonly FallbackStablecoinMetadata[];
  },
): PeggedAsset[] {
  const stablecoins = input.stablecoins ?? ACTIVE_STABLECOINS;
  const assets: PeggedAsset[] = [];

  for (const meta of stablecoins) {
    if (!meta.geckoId) continue;
    const mcap = input.cgData[meta.geckoId]?.usd_market_cap;
    if (!mcap || mcap <= 0) continue;

    const pKey = pegTypeKey(meta);
    const price = input.cgData[meta.geckoId]?.usd ?? null;

    assets.push({
      id: meta.id,
      name: meta.name,
      symbol: meta.symbol,
      geckoId: meta.geckoId,
      pegType: pKey,
      pegMechanism: meta.flags.backing,
      price,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceUpdatedAt: input.syncStartSec,
      priceObservedAt: input.syncStartSec,
      priceObservedAtMode: "local_fetch",
      priceSyncedAt: input.syncStartSec,
      supplySource: "coingecko-fallback",
      circulating: { [pKey]: mcap },
      circulatingPrevDay: null,
      circulatingPrevWeek: null,
      circulatingPrevMonth: null,
      chainCirculating: {},
      chains: [],
    });
  }

  return assets;
}

export async function runFallbackIntakePhase(
  input: FallbackIntakeInput,
): Promise<FallbackIntakeOutput | CronResult> {
  await reportStablecoinsStage(input.reportProgress, "fallback-intake", "Building CoinGecko fallback intake");
  const assets = buildFallbackAssetsFromCoinGecko(input);

  if (assets.length < MIN_VALID_ASSET_COUNT) {
    logWorkerEventArgs("handler", "error",
      `[sync-stablecoins] CG fallback only got ${assets.length} assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
    return buildInsufficientFallbackResult(assets.length);
  }

  return { assets };
}

/**
 * Overlays fresh curated-aggregate on-chain per-chain circulating supply onto
 * fallback assets whose upstream market row carries no chain breakdown (Sky
 * savings NAV wrappers such as sUSDS/sDAI have a null DefiLlama id, so the
 * CoinGecko intake hardcodes an empty `chainCirculating`). Run this after the
 * previous-cache restore so a successful probe supersedes the carried row. If
 * any configured chain read fails the probe returns null and the asset keeps its
 * restored carry — fail closed per asset, never a partial map. Both curated
 * assets are USD NAV tokens, so the per-chain supply shares the V9 review derives
 * are price-invariant and the aggregate reuses the same on-chain-units x price
 * basis as `circulating`; a missing observed price is not replaced with par.
 * The probe reads each contract sequentially, so the added calls stay within
 * Cloudflare's 6-connection per-trigger pool.
 */
export async function overlayFallbackCuratedAggregateSupply(
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<void> {
  for (const asset of assets) {
    throwIfAborted(signal);
    const meta = ACTIVE_META_BY_ID.get(String(asset.id));
    if (!meta || !selectCuratedAggregateOnchainSupplyProbeContracts(meta)) continue;

    const navLikeAsset = meta.flags.navToken || meta.flags.yieldBearing;
    const priceUsd = toPositiveFiniteNumber(asset.price)
      ?? (!navLikeAsset && meta.flags.pegCurrency === "USD" ? 1 : null);
    if (priceUsd == null) continue;

    const onChainMcap = await fetchCuratedAggregateOnChainMcap(meta, priceUsd, undefined, signal);
    if (!onChainMcap?.chainCirculating) continue;

    const pegKey = pegTypeKey(meta);
    asset.circulating = { [pegKey]: onChainMcap.mcap };
    asset.supplySource = onChainMcap.supplySource;
    asset.chainCirculating = Object.fromEntries(
      Object.entries(onChainMcap.chainCirculating).map(([chainLabel, current]) => [
        chainLabel,
        { current, circulatingPrevDay: 0, circulatingPrevWeek: 0, circulatingPrevMonth: 0 },
      ]),
    );
    asset.chains = Object.keys(onChainMcap.chainCirculating);
  }
}
