import { getCache } from "../../lib/db-cache";
import { decodeJsonString } from "../../lib/cache-json";
import { sanitizeFxRates } from "../../lib/fx-rate-state";
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
    const decoded = decodeJsonString<Record<string, number>, "missing" | "json-parse-failed" | "invalid-payload">(
      fxCache?.value,
      {
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => {
          const rates = sanitizeFxRates(parsed);
          if (
            !parsed
            || typeof parsed !== "object"
            || Array.isArray(parsed)
            || Object.keys(parsed).length === 0
            || Object.keys(parsed).length !== Object.keys(rates).length
          ) {
            return { ok: false, reason: "invalid-payload" };
          }
          return { ok: true, payload: rates };
        },
        onParseFailure: ({ message }) => {
          logWorkerEvent({
            scope: "lib",
            level: "warn",
            event: "stablecoin-price-enrichment.fx-rates-load-failed",
            job: "sync-stablecoins",
            message: "Failed to load FX rates for stablecoin price bounds",
            error: message,
          });
        },
      },
    );
    return decoded.ok ? decoded.payload : undefined;
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
