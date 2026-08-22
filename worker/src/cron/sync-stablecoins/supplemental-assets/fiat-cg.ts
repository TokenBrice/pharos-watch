import { logWorkerEventArgs } from "../../../lib/structured-log";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { throwIfAborted } from "../../../lib/abort";
import type { ChainRpcConfig } from "../../../lib/chain-registry";
import { mapWithConcurrency } from "../../../lib/concurrency";
import type { PeggedAsset } from "../enrich-prices";
import { buildZephyrProtocolPeggedAsset, fetchZephyrProtocolStats, isZephyrScannerAssetId } from "../zephyr-zsd";
import { fetchCuratedAggregateOnChainMcap, fetchOnChainMcap, prefersOnChainSupplyMcap } from "./onchain-supply";
import {
  fetchSupplementalPriceData,
  getSupplementalChainLabels,
  pegTypeKey,
  resolveLowVolumeCoinGeckoPrice,
  resolveSupplementalContractPrice,
  resolveSupplementalPrice,
  toPositiveFiniteNumber,
  type CoinGeckoMcapData,
} from "./shared";

export const FIAT_CG_METAS = ACTIVE_STABLECOINS.filter((stablecoin) => stablecoin.detailProvider === "coingecko");
const FIAT_CG_TOKEN_CONCURRENCY = 2;

export async function fetchFiatCoinGeckoTokens(
  cgData: CoinGeckoMcapData,
  signal?: AbortSignal,
  chainRpcs?: Map<string, ChainRpcConfig>,
  fxFallbackRates?: Record<string, number>,
  db?: D1Database,
): Promise<PeggedAsset[]> {
  if (FIAT_CG_METAS.length === 0) return [];
  throwIfAborted(signal);

  try {
    const hasZephyrScannerAsset = FIAT_CG_METAS.some((meta) => isZephyrScannerAssetId(meta.id));
    const [priceData, zephyrProtocolStats] = await Promise.all([
      fetchSupplementalPriceData(FIAT_CG_METAS, "fiat-cg", signal, db),
      hasZephyrScannerAsset ? fetchZephyrProtocolStats(signal) : Promise.resolve(null),
    ]);

    const mcapMap: Record<string, number> = {};
    for (const token of FIAT_CG_METAS) {
      const mcap = token.geckoId ? toPositiveFiniteNumber(cgData[token.geckoId]?.usd_market_cap) : undefined;
      if (mcap && mcap > 0) mcapMap[token.id] = mcap;
    }

    const results = await mapWithConcurrency(
      FIAT_CG_METAS,
      FIAT_CG_TOKEN_CONCURRENCY,
      async (meta) => {
        const nowSec = Math.floor(Date.now() / 1000);
        const pKey = pegTypeKey(meta);
        // Strict path first (15-min freshness gate). If that rejects but CG returned
        // a valid price, fall back to the relaxed `coingecko-low-volume` lane so
        // CG-only stablecoins with slow upstream tickers don't surface as
        // `priceSource: missing`. Diagnosis pattern: detailProvider="coingecko"
        // with llamaId=null + low volume → upstream last_updated_at exceeds 15min.
        let priceResolution = resolveSupplementalPrice(priceData, cgData, meta.geckoId);
        if (!priceResolution) {
          priceResolution = resolveSupplementalContractPrice(priceData, meta, fxFallbackRates);
        }
        if (!priceResolution) {
          priceResolution = resolveLowVolumeCoinGeckoPrice(cgData, meta.geckoId);
        }
        const pegReferencePrice = toPositiveFiniteNumber(fxFallbackRates?.[pKey]);
        // USD is the base currency; fxFallbackRates omits peggedUSD. Default to 1.0 for
        // plain USD-pegged coins with no CG/DL price source so the on-chain fallback can compute mcap.
        // NAV/yield-bearing assets need an observed market price; do not par-value them or use an FX reference.
        const navLikeAsset = meta.flags.navToken || meta.flags.yieldBearing;
        const usdPegDefault = !navLikeAsset && meta.flags.pegCurrency === "USD" ? 1.0 : undefined;
        const priceForSupply = navLikeAsset
          ? priceResolution?.price
          : priceResolution?.price ?? pegReferencePrice ?? usdPegDefault;

        if (isZephyrScannerAssetId(meta.id)) {
          if (!zephyrProtocolStats) {
            logWorkerEventArgs("handler", "info", `[fiat-cg] No Zephyr scanner supply for ${meta.symbol}, skipping`);
            return null;
          }
          return buildZephyrProtocolPeggedAsset(meta, zephyrProtocolStats, priceResolution, nowSec);
        }

        const preferOnChainMcap = prefersOnChainSupplyMcap(meta);
        let mcap = preferOnChainMcap ? undefined : mcapMap[meta.id];
        let supplySource: string = "coingecko-fallback";
        let chainCirculating: PeggedAsset["chainCirculating"] = {};

        // Fallback: on-chain totalSupply × market/peg-reference price when CG has no market cap.
        // This keeps preview-only plain-par fiat assets in supply coverage without inventing a live market quote.
        if (priceForSupply != null) {
          const aggregateOnChainMcap = await fetchCuratedAggregateOnChainMcap(meta, priceForSupply, chainRpcs, signal);
          if (aggregateOnChainMcap) {
            mcap = aggregateOnChainMcap.mcap;
            supplySource = aggregateOnChainMcap.supplySource;
            chainCirculating = Object.fromEntries(
              Object.entries(aggregateOnChainMcap.chainCirculating ?? {}).map(([chainLabel, current]) => [
                chainLabel,
                {
                  current,
                  circulatingPrevDay: 0,
                  circulatingPrevWeek: 0,
                  circulatingPrevMonth: 0,
                },
              ]),
            );
          }
        }

        if ((preferOnChainMcap || !mcap) && priceForSupply != null) {
          const onChainMcap = await fetchOnChainMcap(meta, priceForSupply, chainRpcs, signal);
          if (onChainMcap) {
            mcap = onChainMcap.mcap;
            supplySource = onChainMcap.supplySource;
          }
        }

        if (!mcap) {
          logWorkerEventArgs("handler", "info", `[fiat-cg] No mcap for ${meta.symbol}, skipping`);
          return null;
        }

        const priceConfidence: PeggedAsset["priceConfidence"] = priceResolution
          ? priceResolution.source === "coingecko-low-volume"
            ? "fallback"
            : "single-source"
          : null;
        return {
          id: meta.id,
          name: meta.name,
          symbol: meta.symbol,
          geckoId: meta.geckoId,
          pegType: pKey,
          pegMechanism: meta.flags.backing,
          price: priceResolution?.price ?? null,
          priceSource: priceResolution?.source,
          priceConfidence,
          priceUpdatedAt: priceResolution ? (priceResolution.observedAt ?? nowSec) : null,
          priceObservedAt: priceResolution ? (priceResolution.observedAt ?? nowSec) : null,
          priceObservedAtMode: priceResolution ? (priceResolution.observedAtMode ?? "local_fetch") : null,
          priceSyncedAt: priceResolution ? nowSec : null,
          supplySource,
          circulating: { [pKey]: mcap },
          circulatingPrevDay: null,
          circulatingPrevWeek: null,
          circulatingPrevMonth: null,
          chainCirculating,
          chains: getSupplementalChainLabels(meta),
        } as PeggedAsset;
      },
      { signal },
    );

    return results.filter((token): token is PeggedAsset => token !== null);
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("handler", "error", "[fiat-cg] fetchFiatCoinGeckoTokens failed:", err);
    return [];
  }
}
