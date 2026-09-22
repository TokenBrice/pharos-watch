import { logWorkerEventArgs } from "../../../lib/structured-log";
import { rethrowIfAborted } from "../../../lib/abort";
import {
  fetchMajorStablecoinOrderbookDepthSummary,
  type DirectCexOrderbookDepthSummary,
} from "../../../lib/cex-orderbooks";

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

