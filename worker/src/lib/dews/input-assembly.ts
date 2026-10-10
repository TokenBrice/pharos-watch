import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates } from "@shared/lib/peg-rates";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { assessFreshnessTimestamp } from "../api-freshness-age";
import { CRON_TIMEOUT_MS } from "../cron-timeouts";
import { throwIfAborted } from "../abort";
import { loadStablecoinsCache } from "../stablecoins-cache";
import type { PersistedJsonDecodeReason } from "./contracts";
import { loadDewsSourceState } from "./source-state";

export const DEWS_STABLECOINS_FRESHNESS_BUDGET_SEC =
  CRON_INTERVALS["sync-stablecoins"] + CRON_TIMEOUT_MS["sync-stablecoins"] / 1000;


export interface DewsInputAssemblyOptions {
  db: D1Database;
  nowSec?: number;
  signal?: AbortSignal;
  registerSourceFailure: (
    source: string,
    error: unknown,
  ) => void;
  registerMalformedPersistedInput: (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }) => void;
  onStablecoinsLoaded?: (eligibleAssetCount: number) => void | Promise<void>;
  onBeforeSourceHydration?: () => void | Promise<void>;
  onSourceHydrationLoaded?: () => void | Promise<void>;
}

/**
 * Assemble the exact stablecoin, peg-reference, and hydrated source state used
 * by production DEWS scoring. Delivery layers may add diagnostics around this
 * service, but must not reconstruct its input universe independently.
 */
export async function assembleDewsScoringInput(options: DewsInputAssemblyOptions) {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  throwIfAborted(options.signal);
  const stablecoinsCache = await loadStablecoinsCache(options.db, { mode: "strict" });
  throwIfAborted(options.signal);
  const updatedAt = stablecoinsCache.updatedAt === 0 ? null : stablecoinsCache.updatedAt;
  const timestamp = assessFreshnessTimestamp(nowSec, updatedAt);
  const stablecoinsDependency = {
    generationId: updatedAt != null && Number.isFinite(updatedAt) ? `stablecoins:${updatedAt}` : null,
    updatedAt,
    ageSeconds: timestamp.ageSeconds,
    freshnessBudgetSec: DEWS_STABLECOINS_FRESHNESS_BUDGET_SEC,
    reason: timestamp.reason === null
      ? timestamp.ageSeconds > DEWS_STABLECOINS_FRESHNESS_BUDGET_SEC ? "stale" : null
      : timestamp.reason,
  };
  if (stablecoinsCache.kind !== "ok") {
    return { kind: "unavailable" as const, reason: stablecoinsCache.reason, stablecoinsDependency };
  }
  if (stablecoinsDependency.reason !== null) {
    return {
      kind: "unavailable" as const,
      reason: `stablecoins-cache-${stablecoinsDependency.reason}`,
      stablecoinsDependency,
    };
  }

  const { peggedAssets: assets, fxFallbackRates } = stablecoinsCache.payload;
  const eligibleAssets = assets.filter((asset) => PSI_ELIGIBLE_META_BY_ID.has(asset.id));
  const assetById = new Map(eligibleAssets.map((asset) => [asset.id, asset]));
  await options.onStablecoinsLoaded?.(eligibleAssets.length);
  throwIfAborted(options.signal);

  const {
    rates: pegRates,
    sources: pegRateSources,
    counts: pegRateContributorCounts,
  } = derivePegRates(eligibleAssets, PSI_ELIGIBLE_META_BY_ID, fxFallbackRates);

  await options.onBeforeSourceHydration?.();
  throwIfAborted(options.signal);
  const sourceState = await loadDewsSourceState({
    db: options.db,
    nowSec,
    registerSourceFailure: options.registerSourceFailure,
    registerMalformedPersistedInput: options.registerMalformedPersistedInput,
  });
  throwIfAborted(options.signal);
  await options.onSourceHydrationLoaded?.();

  return {
    kind: "ok" as const,
    nowSec,
    stablecoinsDependency,
    assets,
    eligibleAssets,
    assetById,
    pegRates,
    pegRateSources,
    pegRateContributorCounts,
    sourceState,
  };
}
