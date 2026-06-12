import { getCache } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import type { EnrichmentPassCounts, EnrichmentPassProgress } from "./enrich-prices-fallback";

export interface EnrichmentProgress {
  phase: "start" | "fx-rates-loaded" | "pass-start" | "pass-complete" | "pass-failed" | "complete";
  totalMissing: number;
  finalMissing?: number;
  pass?: EnrichmentPassProgress;
  failedPasses?: string[];
}

export type EnrichmentProgressReporter = (progress: EnrichmentProgress) => void | Promise<void>;

export async function loadFxRatesForPriceBounds(db?: D1Database): Promise<Record<string, number> | undefined> {
  if (!db) return undefined;
  try {
    const fxCache = await getCache(db, "fx-rates");
    return fxCache ? JSON.parse(fxCache.value) : undefined;
  } catch (e) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "stablecoin-price-enrichment.fx-rates-load-failed",
      job: "sync-stablecoins",
      message: "Failed to load FX rates for stablecoin price bounds",
      error: e,
    });
    return undefined;
  }
}

export function logEnrichmentSummary(
  totalMissing: number,
  counts: EnrichmentPassCounts,
  finalMissing: number,
): void {
  const totalEnriched = Object.values(counts).reduce((sum, count) => sum + count, 0);
  logWorkerEvent({
    scope: "lib",
    level: "info",
    event: "stablecoin-price-enrichment.summary",
    job: "sync-stablecoins",
    message: "Completed stablecoin fallback price enrichment",
    metadata: { totalMissing, finalMissing, totalEnriched, ...counts },
  });
}
