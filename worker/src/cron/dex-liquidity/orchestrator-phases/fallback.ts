import { rethrowIfAborted } from "../../../lib/abort";
import {
  fetchMajorStablecoinOrderbookDepthSummary,
  type DirectCexOrderbookDepthSummary,
} from "../../../lib/cex-orderbooks";
import { getFallbackTargets } from "../fetch-fallbacks";
import type { DexPriceObs, LiquidityMetrics } from "../types";

export interface FallbackCrawlerPhaseResult {
  dsFallbackCoins: number;
  cgTickerFallbackCoins: number;
  coverageRecoveredCoins: number;
  weakCoverageCoinsBeforeFallback: number;
  directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null;
}

export async function runFallbackCrawlerPhase(params: {
  metrics: Map<string, LiquidityMetrics>;
  priceObservations: Map<string, DexPriceObs[]>;
  signal?: AbortSignal;
  failedSources: string[];
}): Promise<FallbackCrawlerPhaseResult> {
  const weakCoverageTargetIdsBeforeFallback = new Set(
    getFallbackTargets(params.metrics, params.priceObservations, { requireTrackedContracts: true }).map(
      (meta) => meta.id,
    ),
  );
  let directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null = null;

  console.log(
    `[dex-liquidity] Discovery staging supplied ${params.priceObservations.size} coins with price observations; ` +
      "inline discovery is disabled in the scoring lane",
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
    dsFallbackCoins: 0,
    cgTickerFallbackCoins: 0,
    coverageRecoveredCoins,
    weakCoverageCoinsBeforeFallback: weakCoverageTargetIdsBeforeFallback.size,
    directCexOrderbookDepth,
  };
}
