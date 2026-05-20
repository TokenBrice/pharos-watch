import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import type { CronResult } from "./shared";
import { buildSyncMetadata } from "./shared";
import { reportStablecoinsStage } from "./runtime";
import type { PeggedAsset } from "./enrich-prices";
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

    const pKey = `pegged${meta.flags.pegCurrency}`;
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
    console.error(
      `[sync-stablecoins] CG fallback only got ${assets.length} assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
    return buildInsufficientFallbackResult(assets.length);
  }

  return { assets };
}
