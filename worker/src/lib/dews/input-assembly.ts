import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates } from "@shared/lib/peg-rates";
import { throwIfAborted } from "../abort";
import { getCache, setCache } from "../db-cache";
import { loadStablecoinsCache } from "../stablecoins-cache";
import type { PersistedJsonDecodeReason } from "./contracts";
import { loadDewsSourceState } from "./source-state";

const DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY = "dews:bootstrap-complete";

export interface DewsInputAssemblyOptions {
  db: D1Database;
  nowSec?: number;
  signal?: AbortSignal;
  registerSourceFailure: (
    source: string,
    error: unknown,
    options?: { bootstrapAllowed?: boolean },
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
  if (stablecoinsCache.kind !== "ok") {
    return { kind: "unavailable" as const, reason: stablecoinsCache.reason };
  }

  const { peggedAssets: assets, fxFallbackRates } = stablecoinsCache.payload;
  const eligibleAssets = assets.filter((asset) => PSI_ELIGIBLE_META_BY_ID.has(asset.id));
  const assetById = new Map(eligibleAssets.map((asset) => [asset.id, asset]));
  await options.onStablecoinsLoaded?.(eligibleAssets.length);
  throwIfAborted(options.signal);

  const bootstrapPending = (await getCache(options.db, DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY)) == null;
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
    bootstrapPending,
    registerSourceFailure: options.registerSourceFailure,
    registerMalformedPersistedInput: options.registerMalformedPersistedInput,
  });
  throwIfAborted(options.signal);
  await options.onSourceHydrationLoaded?.();

  return {
    kind: "ok" as const,
    nowSec,
    assets,
    eligibleAssets,
    assetById,
    bootstrapPending,
    pegRates,
    pegRateSources,
    pegRateContributorCounts,
    sourceState,
  };
}

export async function markDewsBootstrapComplete(db: D1Database, nowSec: number): Promise<void> {
  await setCache(db, DEWS_BOOTSTRAP_SENTINEL_CACHE_KEY, JSON.stringify({ completedAt: nowSec }));
}
