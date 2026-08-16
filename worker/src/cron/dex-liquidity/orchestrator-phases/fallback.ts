import { logWorkerEventArgs } from "../../../lib/structured-log";
import { rethrowIfAborted } from "../../../lib/abort";
import {
  fetchMajorStablecoinOrderbookDepthSummary,
  type DirectCexOrderbookDepthSummary,
} from "../../../lib/cex-orderbooks";
import { getFallbackTargets } from "../fetch-fallbacks";
import type { DexPriceObs, LiquidityMetrics } from "../types";

export interface FallbackCrawlerPhaseResult {
  weakCoverageCoinsBeforeFallback: number;
  directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null;
}

export async function fetchDirectCexOrderbookDepthTelemetry(params: {
  signal?: AbortSignal;
  failedSources: string[];
}): Promise<DirectCexOrderbookDepthSummary | null> {
  try {
    return await fetchMajorStablecoinOrderbookDepthSummary(params.signal);
  } catch (err) {
    rethrowIfAborted(err, params.signal);
    logWorkerEventArgs("handler", "warn", "[dex-liquidity] Direct CEX orderbook depth telemetry failed (non-fatal):", err);
    params.failedSources.push("direct-cex-orderbook-depth");
    return null;
  }
}

export async function runFallbackCrawlerPhase(params: {
  metrics: Map<string, LiquidityMetrics>;
  priceObservations: Map<string, DexPriceObs[]>;
  directCexOrderbookDepth: DirectCexOrderbookDepthSummary | null;
}): Promise<FallbackCrawlerPhaseResult> {
  const weakCoverageTargetIdsBeforeFallback = new Set(
    getFallbackTargets(params.metrics, params.priceObservations, { requireTrackedContracts: true }).map(
      (meta) => meta.id,
    ),
  );
  logWorkerEventArgs("handler", "info",
    `[dex-liquidity] Discovery staging supplied ${params.priceObservations.size} coins with price observations; ` +
      "inline discovery is disabled in the scoring lane",
  );

  return {
    weakCoverageCoinsBeforeFallback: weakCoverageTargetIdsBeforeFallback.size,
    directCexOrderbookDepth: params.directCexOrderbookDepth,
  };
}
