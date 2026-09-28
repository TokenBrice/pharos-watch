import { logWorkerEventArgs } from "./structured-log";
import { z } from "zod";
import {
  invertUnitsPerUsd,
  isValidFxRate,
  REALTIME_FX_CURRENCY_TO_PEG,
} from "./fx-config";
import { fetchJsonWithRetry } from "./fetch-retry";

/**
 * Real-time FX rate provider using Open Exchange Rates.
 * Free tier: 1,000 requests/month. At 1/hour = ~720/month, safely within free tier.
 * Basic plan ($12/mo, 10K/month) allows 15-min polling if needed later.
 */

const OpenExchangeRatesSchema = z.object({
  // Unix seconds of the provider's own rate snapshot. Optional here so a payload
  // without it is rejected with a reason instead of failing as a schema error.
  timestamp: z.number().optional(),
  rates: z.record(z.string(), z.number()),
});

const OPEN_EXCHANGE_RATES_REQUEST_TIMEOUT_MS = 5_000;
const OPEN_EXCHANGE_RATES_MAX_RETRIES = 1;
/**
 * OXR publishes hourly snapshots on the plan Pharos uses. One missed hourly update
 * is tolerated; an older snapshot is a stale upstream response, not a live rate.
 */
const OPEN_EXCHANGE_RATES_MAX_OBSERVATION_AGE_SEC = 2 * 3600;
const OPEN_EXCHANGE_RATES_MAX_FUTURE_SKEW_SEC = 5 * 60;

export type RealtimeFxObservationRejection = "timestamp-missing" | "timestamp-stale" | "timestamp-future";

/** One OXR snapshot: every rate carries the provider's observation time, never the fetch time. */
export interface RealtimeFxObservation {
  observedAt: number;
  rates: Map<string, number>;
}

export interface RealtimeFxFetchResult {
  /** Present only when the snapshot's upstream timestamp is admissible. */
  observation: RealtimeFxObservation | null;
  /** Set when a successful response was rejected for its upstream timestamp. */
  rejection: { reason: RealtimeFxObservationRejection; upstreamTimestamp: number | null } | null;
  completed: boolean;
}

/**
 * Fetch real-time FX rates from Open Exchange Rates.
 * Rates are USD-per-unit keyed by peg — same format as the sync-fx-rates cache —
 * and are returned only with the provider's validated snapshot timestamp.
 */
export async function fetchRealtimeFxRates(
  apiKey: string,
  signal?: AbortSignal,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<RealtimeFxFetchResult> {
  if (!apiKey) {
    return { observation: null, rejection: null, completed: false };
  }

  try {
    const symbols = Object.keys(REALTIME_FX_CURRENCY_TO_PEG).join(",");
    const fetchResult = await fetchJsonWithRetry<unknown>(
      `https://openexchangerates.org/api/latest.json?app_id=${apiKey}&symbols=${symbols}&base=USD`,
      { signal, headers: { Accept: "application/json" } },
      OPEN_EXCHANGE_RATES_MAX_RETRIES,
      { timeoutMs: OPEN_EXCHANGE_RATES_REQUEST_TIMEOUT_MS },
    );
    if (!fetchResult) {
      logWorkerEventArgs("lib", "warn", "[fx-realtime] Open Exchange Rates returned no response");
      return { observation: null, rejection: null, completed: false };
    }
    if (!fetchResult.response.ok) {
      logWorkerEventArgs("lib", "warn", `[fx-realtime] Open Exchange Rates returned ${fetchResult.response.status}`);
      return { observation: null, rejection: null, completed: true };
    }
    const data = OpenExchangeRatesSchema.parse(fetchResult.body);

    const upstreamTimestamp =
      typeof data.timestamp === "number" && Number.isFinite(data.timestamp) && data.timestamp > 0
        ? Math.floor(data.timestamp)
        : null;
    const rejectionReason: RealtimeFxObservationRejection | null =
      upstreamTimestamp == null
        ? "timestamp-missing"
        : upstreamTimestamp - nowSec > OPEN_EXCHANGE_RATES_MAX_FUTURE_SKEW_SEC
          ? "timestamp-future"
          : nowSec - upstreamTimestamp > OPEN_EXCHANGE_RATES_MAX_OBSERVATION_AGE_SEC
            ? "timestamp-stale"
            : null;
    if (rejectionReason != null || upstreamTimestamp == null) {
      logWorkerEventArgs(
        "lib",
        "warn",
        `[fx-realtime] Rejected Open Exchange Rates snapshot (${rejectionReason}, upstream timestamp ${upstreamTimestamp ?? "none"})`,
      );
      return {
        observation: null,
        rejection: { reason: rejectionReason ?? "timestamp-missing", upstreamTimestamp },
        completed: true,
      };
    }

    const rates = new Map<string, number>();
    for (const [currency, unitsPerUsd] of Object.entries(data.rates)) {
      const pegKey = REALTIME_FX_CURRENCY_TO_PEG[currency];
      if (!pegKey || !Number.isFinite(unitsPerUsd) || unitsPerUsd <= 0) continue;
      const rate = invertUnitsPerUsd(unitsPerUsd);
      if (!isValidFxRate(pegKey, rate, undefined, "[fx-realtime]")) {
        continue;
      }
      rates.set(pegKey, rate);
    }
    return { observation: { observedAt: upstreamTimestamp, rates }, rejection: null, completed: true };
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("lib", "warn", "[fx-realtime] Fetch failed:", err);
    return { observation: null, rejection: null, completed: false };
  }
}
