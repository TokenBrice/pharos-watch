import { logWorkerEventArgs } from "./structured-log";
import type { PriceObservedAtMode } from "@shared/types/price";
import { relativeBps } from "@shared/lib/depeg-signals";
import {
  COINGECKO_MICRO_VOLUME_MIN_USD,
  COINGECKO_MICRO_VOLUME_OUTLIER_MAX_DEVIATION_BPS,
  COINGECKO_MICRO_VOLUME_OUTLIER_REASON,
} from "@shared/lib/pricing-source-policy";
import { getPricingSourceRegistryEntry } from "@shared/lib/pricing-source-registry";
import type { FetcherOutcome } from "./fetcher-result";
import { cgHeaders, cgSimplePricePath, cgUrl } from "./coingecko";
import { USER_AGENT } from "./constants";
import { fetchJsonWithRetry } from "./fetch-retry";
import { throwIfAborted } from "./abort";
import {
  getReferencePriceForContext,
  isFixedPegContext,
  type PriceValidationContext,
  type PriceValidationReferences,
} from "./price-validation";
import { CoinGeckoSimplePriceEntrySchema, CoinGeckoSimplePriceSchema } from "./upstream-schemas";
import { toErrorMessage } from "@shared/lib/error-utils";

const PRIMARY_CG_BATCH_SIZE = 250;

export interface CoingeckoSimplePriceEntry {
  price: number;
  observedAt: number | null;
  observedAtMode: PriceObservedAtMode | null;
  volume24hUsd?: number | null;
}

export type CoingeckoMicroVolumeCheckResult =
  | { status: "ok" }
  | { status: "volume_unavailable" }
  | {
      status: "rejected";
      reason: typeof COINGECKO_MICRO_VOLUME_OUTLIER_REASON;
      volume24hUsd: number;
      referencePrice: number;
      deviationBps: number;
    };

/**
 * Evaluates a CoinGecko quote against the micro-volume outlier quarantine:
 * rejects only when observed 24h volume is strictly below `$1,000` AND the
 * quote deviates strictly more than 500 bps from its fixed peg/FX reference.
 *
 * - R1: absent/unknown volume is never treated as zero; callers record
 *   `volume_unavailable` in diagnostics and do not reject.
 * - NAV tokens and variable/unknown pegs without a fixed reference are exempt.
 */
export function evaluateCoingeckoMicroVolumeOutlier(input: {
  price: number;
  volume24hUsd: number | null | undefined;
  context: PriceValidationContext;
  references?: PriceValidationReferences;
}): CoingeckoMicroVolumeCheckResult {
  if (
    typeof input.volume24hUsd !== "number" ||
    !Number.isFinite(input.volume24hUsd) ||
    input.volume24hUsd < 0
  ) {
    return { status: "volume_unavailable" };
  }
  if (input.volume24hUsd >= COINGECKO_MICRO_VOLUME_MIN_USD) {
    return { status: "ok" };
  }
  const outlier = measureCoingeckoMicroVolumeDeviation(input);
  return outlier
    ? { status: "rejected", reason: COINGECKO_MICRO_VOLUME_OUTLIER_REASON, volume24hUsd: input.volume24hUsd, ...outlier }
    : { status: "ok" };
}

/**
 * The deviation half of the micro-volume quarantine: a fixed-peg quote more
 * than 500 bps from its peg/FX reference. NAV and variable pegs never qualify.
 * Callers apply it only once a same-run CoinGecko read established volume
 * below the floor; it never infers volume.
 */
export function measureCoingeckoMicroVolumeDeviation(input: {
  price: number;
  context: PriceValidationContext;
  references?: PriceValidationReferences;
}): { referencePrice: number; deviationBps: number } | null {
  if (!isFixedPegContext(input.context)) return null;
  const referencePrice = getReferencePriceForContext(input.context, input.references);
  if (referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0) return null;
  const deviation = relativeBps(input.price, referencePrice);
  return deviation != null && deviation.absRawBps > COINGECKO_MICRO_VOLUME_OUTLIER_MAX_DEVIATION_BPS
    ? { referencePrice, deviationBps: deviation.absRawBps }
    : null;
}

export async function fetchCoingeckoSimplePrices(
  geckoIds: string[],
  coingeckoApiKey: string | null,
  signal: AbortSignal | undefined,
  nowSec: number,
  options?: { sourceKey?: string },
): Promise<FetcherOutcome<Map<string, CoingeckoSimplePriceEntry>>> {
  const prices = new Map<string, CoingeckoSimplePriceEntry>();
  const coingeckoMaxTrustedAgeSec =
    getPricingSourceRegistryEntry(options?.sourceKey ?? "coingecko")?.maxTrustedAgeSec ?? 15 * 60;
  let staleCount = 0;
  let hadBatchFailure = false;

  try {
    for (let i = 0; i < geckoIds.length; i += PRIMARY_CG_BATCH_SIZE) {
      throwIfAborted(signal);
      const batch = geckoIds.slice(i, i + PRIMARY_CG_BATCH_SIZE);
      const ids = batch.join(",");
      const result = await fetchJsonWithRetry<unknown>(
        cgUrl(cgSimplePricePath(`ids=${ids}&vs_currencies=usd&include_24hr_vol=true&include_last_updated_at=true`), coingeckoApiKey),
        {
          headers: cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT }, coingeckoApiKey),
          signal,
        },
      );
      if (!result?.response.ok) {
        hadBatchFailure = true;
        logWorkerEventArgs("lib", "warn", `[primary-prices] CG price API returned ${result?.response.status ?? "no response"}`);
        continue;
      }

      const parsed = CoinGeckoSimplePriceSchema.safeParse(result.body);
      if (!parsed.success) {
        hadBatchFailure = true;
        logWorkerEventArgs("lib", "warn", `[primary-prices] CG price API payload invalid: ${parsed.error.message}`);
        continue;
      }
      let invalidEntries = 0;
      let validEntries = 0;
      for (const [gId, rawValue] of Object.entries(parsed.data)) {
        const entry = CoinGeckoSimplePriceEntrySchema.safeParse(rawValue);
        if (!entry.success) {
          // R8: a malformed quote blocks only its own key; siblings continue.
          invalidEntries++;
          continue;
        }
        validEntries++;
        const val = entry.data;
        if (!(val.usd > 0)) continue;
        if (val.last_updated_at != null && (
          !Number.isFinite(val.last_updated_at) || val.last_updated_at <= 0
        )) continue;
        const upstreamObservedAt =
          typeof val.last_updated_at === "number" &&
          Number.isFinite(val.last_updated_at) &&
          val.last_updated_at > 0
            ? val.last_updated_at
            : null;
        if (
          upstreamObservedAt != null &&
          nowSec - upstreamObservedAt > coingeckoMaxTrustedAgeSec
        ) {
          staleCount++;
          continue;
        }
        const volume24hUsd =
          typeof val.usd_24h_vol === "number" &&
          Number.isFinite(val.usd_24h_vol) &&
          val.usd_24h_vol >= 0
            ? val.usd_24h_vol
            : null;
        prices.set(gId, {
          price: val.usd,
          observedAt: upstreamObservedAt,
          observedAtMode: upstreamObservedAt != null ? "upstream" : null,
          volume24hUsd,
        });
      }
      if (invalidEntries > 0) {
        // A nonempty batch with no valid row is a provider failure, not an
        // observed empty cohort.
        if (validEntries === 0) hadBatchFailure = true;
        logWorkerEventArgs("lib", "warn",
          `[primary-prices] Quarantined ${invalidEntries} malformed CoinGecko simple-price row(s), ${validEntries} valid`);
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
    logWorkerEventArgs("lib", "warn", "[primary-prices] CG price API failed:", err);
    return {
      kind: "upstream-error",
      value: prices,
      reason: toErrorMessage(err),
    };
  }

  if (staleCount > 0) {
    logWorkerEventArgs("lib", "warn",
      `[primary-prices] Dropped ${staleCount} stale CoinGecko simple-price row(s) older than ${coingeckoMaxTrustedAgeSec}s`,
    );
  }

  if (hadBatchFailure) {
    return { kind: "upstream-error", value: prices, reason: "one or more CG batches failed" };
  }
  if (prices.size === 0) {
    return { kind: "no-data", value: prices };
  }
  return { kind: "ok", value: prices };
}
