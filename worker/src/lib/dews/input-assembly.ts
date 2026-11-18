import { getPublishedLegacyPegReference } from "@shared/lib/current-peg-observations";
import { PSI_ELIGIBLE_META_BY_ID } from "@shared/lib/psi-eligible";
import { derivePegRates } from "@shared/lib/peg-rates";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { buildSupplyObservationProvenance, classifySupplyCoverage } from "@shared/lib/supply-provenance";
import { hasComparableSupplyPerimeter, hasNativeSupplyEvidence, isMissingNativeSupplyColumn, isComparableNativeSupplySource, readNativeSupplyCheckpoint, type NativeSupplyHistoryRow } from "./native-quantity";
import type { StablecoinData } from "@shared/types/supply";
import { assessFreshnessTimestamp } from "../api-freshness-age";
import { CRON_TIMEOUT_MS } from "../cron-timeouts";
import { throwIfAborted } from "../abort";
import { loadStablecoinsCache } from "../stablecoins-cache";
import type { PersistedJsonDecodeReason } from "./contracts";
import { loadDewsSourceState } from "./source-state";
import { getPublishedReferenceEvidence } from "../psi-reference";

export async function loadDewsNativeHistory(db: D1Database, assets: StablecoinData[], nowSec: number) {
  const byId = new Map<string, { day?: number | null; week?: number | null }>();
  const clocks = new Map<string, number>();
  const dayOf = (clock: number) => Math.floor(clock / DAY_SECONDS) * DAY_SECONDS;
  for (const asset of assets) {
    const clock = asset.supplyObservedAt;
    if (clock == null || asset.circulatingNative === undefined) continue;
    if (asset.circulatingNative === null || asset.supplyRestored || !isComparableNativeSupplySource(asset.id, asset.supplySource)
      || classifySupplyCoverage(buildSupplyObservationProvenance(asset)) !== "complete"
      || !Number.isSafeInteger(clock) || clock <= 0 || clock > nowSec) {
      byId.set(asset.id, { day: null, week: null });
      continue;
    }
    clocks.set(asset.id, clock);
    const date = dayOf(clock);
    const dayComparable = hasComparableSupplyPerimeter(asset.id, date, date - DAY_SECONDS);
    const weekComparable = hasComparableSupplyPerimeter(asset.id, date, date - 7 * DAY_SECONDS);
    if (!dayComparable || !weekComparable) {
      byId.set(asset.id, { day: dayComparable ? undefined : null, week: weekComparable ? undefined : null });
    }
  }
  if (clocks.size === 0) return byId;
  const dates = new Set([...clocks.values()].flatMap((clock) => [dayOf(clock) - DAY_SECONDS, dayOf(clock) - 7 * DAY_SECONDS]));
  const historyRead = await db.prepare(`SELECT /* pharos:dews:native-supply-history */
      stablecoin_id, snapshot_date, circulating_native, supply_provenance FROM supply_history
      WHERE snapshot_date IN (SELECT value FROM json_each(?)) AND circulating_native IS NOT NULL`)
    .bind(JSON.stringify([...dates])).all<NativeSupplyHistoryRow>().catch((error: unknown) => {
      if (!isMissingNativeSupplyColumn(error)) throw error;
      return null;
    });
  for (const row of historyRead?.results ?? []) {
    const { stablecoin_id: id, snapshot_date: date } = row;
    const clock = clocks.get(id);
    if (clock == null || !hasNativeSupplyEvidence(row)) continue;
    const elapsedDays = (dayOf(clock) - date) / DAY_SECONDS;
    if (elapsedDays !== 1 && elapsedDays !== 7) continue;
    const checkpoint = hasComparableSupplyPerimeter(id, dayOf(clock), date)
      ? readNativeSupplyCheckpoint(row, clock - elapsedDays * DAY_SECONDS) : null;
    const history = byId.get(id) ?? {};
    if (elapsedDays === 1) history.day = checkpoint?.quantity ?? null;
    else history.week = checkpoint?.quantity ?? null;
    byId.set(id, history);
  }
  return byId;
}

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
  const generation = `stablecoins:${stablecoinsCache.updatedAt}`;
  const references = stablecoinsCache.payload.fxReferenceObservations === undefined ? undefined
    : new Map(Object.entries(stablecoinsCache.payload.selectedPegReferences ?? {}).flatMap(([key, row]) => {
      const reference = getPublishedReferenceEvidence(row, generation, nowSec);
      return reference ? [[key, reference] as const] : [];
    }));
  const eligibleAssets = assets.filter((asset) => PSI_ELIGIBLE_META_BY_ID.has(asset.id));
  const legacyFxReferenceIds = references && new Set(eligibleAssets.filter((asset) =>
    getPublishedLegacyPegReference(asset, stablecoinsCache.payload, stablecoinsCache.updatedAt)).map((asset) => asset.id));
  const assetById = new Map(eligibleAssets.map((asset) => [asset.id, asset]));
  await options.onStablecoinsLoaded?.(eligibleAssets.length);
  throwIfAborted(options.signal);

  const pegs = derivePegRates(eligibleAssets, PSI_ELIGIBLE_META_BY_ID, fxFallbackRates);
  const {
    rates: pegRates,
    sources: pegRateSources,
    counts: pegRateContributorCounts,
  } = pegs;

  await options.onBeforeSourceHydration?.();
  throwIfAborted(options.signal);
  const [sourceState, nativeHistory] = await Promise.all([loadDewsSourceState({
    db: options.db,
    nowSec,
    registerSourceFailure: options.registerSourceFailure,
    registerMalformedPersistedInput: options.registerMalformedPersistedInput,
  }),
  loadDewsNativeHistory(options.db, eligibleAssets, nowSec).catch((error) => {
    options.registerSourceFailure("dews-native-supply-history", error);
  })]);
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
    sourceState: { ...sourceState, references, legacyFxReferenceIds, nativeHistory: nativeHistory ?? null },
  };
}
