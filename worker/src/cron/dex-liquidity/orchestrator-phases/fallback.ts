import { CRAWL_BUDGETS } from "../../../lib/rate-limit";
import { rethrowIfAborted } from "../../../lib/abort";
import type { PriceValidationReferences } from "../../../lib/price-validation";
import { fetchMajorStablecoinOrderbookDepthSummary, type DirectCexOrderbookDepthSummary } from "../../../lib/cex-orderbooks";
import { mergeGtPools } from "../fetch-crawlers";
import { fetchDsFallbackPools, fetchCgTickersFallback, getFallbackTargets } from "../fetch-fallbacks";
import type { KnownPoolIdentityIndex } from "../pool-identity";
import type { DexPriceObs, LiquidityMetrics } from "../types";
import { mergeDexPriceObservationMap } from "./price-obs";

export interface FallbackCrawlerPhaseResult {
  dsFallbackCoins: number;
  cgTickerFallbackCoins: number;
  coverageRecoveredCoins: number;
  weakCoverageCoinsBeforeFallback: number;
  directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null;
}

export async function runFallbackCrawlerPhase(params: {
  db: D1Database;
  metrics: Map<string, LiquidityMetrics>;
  priceObservations: Map<string, DexPriceObs[]>;
  knownPoolIndex: KnownPoolIdentityIndex;
  signal?: AbortSignal;
  validationReferences: PriceValidationReferences;
  failedSources: string[];
  coingeckoApiKey?: string | null;
}): Promise<FallbackCrawlerPhaseResult> {
  const weakCoverageTargetIdsBeforeFallback = new Set(
    getFallbackTargets(params.metrics, params.priceObservations, { requireTrackedContracts: true }).map(
      (meta) => meta.id,
    ),
  );
  const fallbackDeadlineMs = Date.now() + CRAWL_BUDGETS.FALLBACK_MS;
  let dsFallbackCoins = 0;
  let cgTickerFallbackCoins = 0;
  let directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null = null;

  try {
    const dsFallback = await fetchDsFallbackPools(
      params.db,
      params.metrics,
      params.priceObservations,
      params.knownPoolIndex,
      params.signal,
      fallbackDeadlineMs,
      params.validationReferences,
    );
    dsFallbackCoins = dsFallback.newPools.size;
    if (dsFallback.newPools.size > 0) {
      mergeGtPools(params.metrics, dsFallback.newPools);
    }
    mergeDexPriceObservationMap(params.priceObservations, dsFallback.priceObs);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] DexScreener fallback failed (non-fatal):", err);
    params.failedSources.push("dexscreener-fallback");
  }

  try {
    const cgFallback = await fetchCgTickersFallback(
      params.metrics,
      params.priceObservations,
      params.knownPoolIndex,
      params.signal,
      fallbackDeadlineMs,
      params.validationReferences,
      params.coingeckoApiKey,
    );
    cgTickerFallbackCoins = cgFallback.newPools.size;
    if (cgFallback.newPools.size > 0) {
      mergeGtPools(params.metrics, cgFallback.newPools);
    }
    mergeDexPriceObservationMap(params.priceObservations, cgFallback.priceObs);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] CG tickers fallback failed (non-fatal):", err);
    params.failedSources.push("cg-tickers-fallback");
  }

  console.log(
    `[dex-liquidity] After fallbacks: ${params.priceObservations.size} coins with price observations ` +
      `(DS fallback: ${dsFallbackCoins} coins, CG tickers: ${cgTickerFallbackCoins} coins)`,
  );

  try {
    directCexOrderbookDepth = await fetchMajorStablecoinOrderbookDepthSummary(params.signal);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    console.warn("[dex-liquidity] Direct CEX orderbook depth telemetry failed (non-fatal):", err);
    params.failedSources.push("direct-cex-orderbook-depth");
  }

  const weakCoverageTargetIdsAfterFallback = new Set(
    getFallbackTargets(params.metrics, params.priceObservations, { requireTrackedContracts: true }).map(
      (meta) => meta.id,
    ),
  );
  let coverageRecoveredCoins = 0;
  for (const stablecoinId of weakCoverageTargetIdsBeforeFallback) {
    if (!weakCoverageTargetIdsAfterFallback.has(stablecoinId)) {
      coverageRecoveredCoins++;
    }
  }

  return {
    dsFallbackCoins,
    cgTickerFallbackCoins,
    coverageRecoveredCoins,
    weakCoverageCoinsBeforeFallback: weakCoverageTargetIdsBeforeFallback.size,
    directCexOrderbookDepth,
  };
}
