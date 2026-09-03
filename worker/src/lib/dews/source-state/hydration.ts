/**
 * DEWS source-state hydration loaders.
 *
 * One async function per D1 table (or cache key). Each loader is responsible
 * for a single slice of `DewsSourceState`, registers its own failures via the
 * shared callback, and reports per-source coverage counts back to the
 * orchestrator. Loaders are intentionally narrow: no cross-loader reasoning
 * happens here; that belongs in the orchestrator.
 */

import { DAY_SECONDS } from "@shared/lib/time-constants";
import { decodeJsonString } from "../../cache-json";
import type { BlacklistPersistedRow } from "../../blacklist/shared";
import { toErrorMessage } from "@shared/lib/error-utils";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../dex-liquidity";
import {
  CONTRACT_CONFIGS,
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
} from "../../blacklist-contracts";
import { getDexTrustPolicy, isTrustedDexPriceRow } from "../../depeg-trust-policy";
import { isCanonicalMintBurnPair } from "../../mint-burn-canonical-chain";
import type {
  BlacklistCountByStablecoinId,
  DexLiquidityDependencyDiagnostics,
  DexLiquidityRow,
  DexPriceSnapshot,
  LiquidityHistorySnapshot,
  MintBurnSnapshot,
  PersistedJsonDecodeReason,
} from "../contracts";
import type { YieldRankChangeAttribution, YieldSourceRisk } from "@shared/types/yield";
import {
  decodeLegacyStressSignals,
  getObject,
  getString,
  normalizeYieldRankChangeAttribution,
  normalizeYieldSourceRisk,
} from "./legacy-bridge";
import {
  loadPreviousStressSignalCurrentRows,
  type PreviousStressSignalCurrentRow,
} from "../../stress-signals-current-rows";
import { classifyFreshness } from "../../status/freshness-oracle";

export const DEWS_STALE_DEX_LIQUIDITY_SEC = 2 * 3600;
export const DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC = 2 * 3600;
const DEWS_STALE_MINT_BURN_SEC = DAY_SECONDS;
const DEWS_DEX_PRICE_TRUST_POLICY = getDexTrustPolicy("depeg");

type PreviousStressSignalRow = PreviousStressSignalCurrentRow;

export interface HydrationCallbacks {
  registerSourceFailure: (source: string, error: unknown, options?: { bootstrapAllowed?: boolean }) => void;
  registerMalformedPersistedInput: (options: {
    source: string;
    context: string;
    stablecoinId: string;
    updatedAt?: number | null;
    reason: PersistedJsonDecodeReason;
    degradesRun: boolean;
  }) => void;
}

export interface HydrationContext extends HydrationCallbacks {
  db: D1Database;
  nowSec: number;
  bootstrapPending: boolean;
}

function getRowAgeSec(updatedAt: number | null | undefined, nowSec: number): number | null {
  return typeof updatedAt === "number" && Number.isFinite(updatedAt) ? Math.max(0, nowSec - updatedAt) : null;
}

function isFreshAt(updatedAt: number | null | undefined, nowSec: number, maxAgeSec: number): boolean {
  const timestamp = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : null;
  return classifyFreshness(
    {
      job: "dews-source",
      lastSuccessAt: timestamp,
      lastRunAt: timestamp,
      expectedIntervalSec: maxAgeSec,
      lastStatus: timestamp == null ? null : "ok",
    },
    {
      watchAt: { absoluteSec: maxAgeSec },
      staleAt: { absoluteSec: maxAgeSec },
    },
    nowSec,
  ).state === "fresh";
}

async function loadPreviousStressSignalRows(ctx: HydrationContext): Promise<PreviousStressSignalRow[]> {
  return loadPreviousStressSignalCurrentRows(ctx.db, ctx.nowSec, {
    staleAfterSec: DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC,
    onLatestReadError: (error) => {
      ctx.registerSourceFailure("stress-signals-latest", error);
    },
  });
}

export interface DexLiquidityHydration {
  dexLiqRows: { results: DexLiquidityRow[] };
  dexLiqMap: Map<string, DexLiquidityRow>;
  dexLiqAgeSecById: Map<string, number>;
  dexLiqStaleIds: Set<string>;
  freshCount: number;
  staleCount: number;
  totalRows: number;
  freshnessAgeSec: number | null;
  dependencyDiagnostics: DexLiquidityDependencyDiagnostics;
}

interface DexLiquidityPublicationGenerationRow {
  generation_id: string;
  state: string;
  started_at: number | null;
  published_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
}

async function loadDexLiquidityPublicationDiagnostics(
  ctx: HydrationContext,
  summary: Pick<DexLiquidityDependencyDiagnostics, "totalRows" | "freshRows" | "staleRows" | "freshnessAgeSec" | "staleThresholdSec">,
): Promise<DexLiquidityDependencyDiagnostics> {
  try {
    const [latestGeneration, latestPublished] = await Promise.all([
      ctx.db
        .prepare(
          `SELECT generation_id, state, started_at, published_at, failed_at, failure_reason
             FROM dex_liquidity_publication_generations
             ORDER BY started_at DESC
             LIMIT 1`,
        )
        .first<DexLiquidityPublicationGenerationRow>(),
      ctx.db
        .prepare(
          `SELECT generation_id, state, started_at, published_at, failed_at, failure_reason
             FROM dex_liquidity_publication_generations
             WHERE state = 'published'
             ORDER BY COALESCE(published_at, started_at) DESC
             LIMIT 1`,
        )
        .first<DexLiquidityPublicationGenerationRow>(),
    ]);

    const latestPublishedAt = latestPublished?.published_at ?? null;
    return {
      ...summary,
      latestGenerationId: latestGeneration?.generation_id ?? null,
      latestGenerationState: latestGeneration?.state ?? null,
      latestGenerationStartedAt: latestGeneration?.started_at ?? null,
      latestGenerationPublishedAt: latestGeneration?.published_at ?? null,
      latestGenerationFailedAt: latestGeneration?.failed_at ?? null,
      latestGenerationFailureReason: latestGeneration?.failure_reason ?? null,
      latestPublishedGenerationId: latestPublished?.generation_id ?? null,
      latestPublishedAt,
      latestPublishedAgeSec: latestPublishedAt == null ? null : Math.max(0, ctx.nowSec - latestPublishedAt),
    };
  } catch (error) {
    return {
      ...summary,
      latestGenerationId: null,
      latestGenerationState: null,
      latestGenerationStartedAt: null,
      latestGenerationPublishedAt: null,
      latestGenerationFailedAt: null,
      latestGenerationFailureReason: null,
      latestPublishedGenerationId: null,
      latestPublishedAt: null,
      latestPublishedAgeSec: null,
      diagnosticsError: toErrorMessage(error),
    };
  }
}

export async function hydrateDexLiquidity(ctx: HydrationContext): Promise<DexLiquidityHydration> {
  let dexLiqRows = { results: [] } as { results: DexLiquidityRow[] };
  try {
    dexLiqRows = await ctx.db
      .prepare(
        `SELECT stablecoin_id, weighted_balance_ratio, avg_pool_stress, top_pools_json, liquidity_score, total_tvl_usd, updated_at
         FROM dex_liquidity
         WHERE ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
      )
      .all<DexLiquidityRow>();
  } catch (error) {
    ctx.registerSourceFailure("dex-liquidity", error);
  }
  const dexLiqMap = new Map<string, DexLiquidityRow>();
  const dexLiqAgeSecById = new Map<string, number>();
  const dexLiqStaleIds = new Set<string>();
  for (const row of dexLiqRows.results) {
    const ageSec = getRowAgeSec(row.updated_at, ctx.nowSec);
    if (ageSec != null) {
      dexLiqAgeSecById.set(row.stablecoin_id, ageSec);
    }
    if (!isFreshAt(row.updated_at, ctx.nowSec, DEWS_STALE_DEX_LIQUIDITY_SEC)) {
      dexLiqStaleIds.add(row.stablecoin_id);
      continue;
    }
    dexLiqMap.set(row.stablecoin_id, row);
  }
  const dexLiquidityUpdatedAt = dexLiqRows.results.reduce<number | null>((latest, row) => {
    if (row.updated_at == null || !Number.isFinite(row.updated_at)) return latest;
    if (latest == null || row.updated_at > latest) return row.updated_at;
    return latest;
  }, null);
  const dexLiquidityAgeSec = dexLiquidityUpdatedAt != null ? Math.max(0, ctx.nowSec - dexLiquidityUpdatedAt) : null;
  if (dexLiquidityUpdatedAt != null && !isFreshAt(
    dexLiquidityUpdatedAt,
    ctx.nowSec,
    DEWS_STALE_DEX_LIQUIDITY_SEC,
  )) {
    ctx.registerSourceFailure(
      "dex-liquidity-freshness",
      `dex_liquidity age ${dexLiquidityAgeSec}s exceeds ${DEWS_STALE_DEX_LIQUIDITY_SEC}s`,
    );
  }
  const dependencyDiagnostics = await loadDexLiquidityPublicationDiagnostics(ctx, {
    totalRows: dexLiqRows.results.length,
    freshRows: dexLiqMap.size,
    staleRows: dexLiqStaleIds.size,
    freshnessAgeSec: dexLiquidityAgeSec,
    staleThresholdSec: DEWS_STALE_DEX_LIQUIDITY_SEC,
  });
  return {
    dexLiqRows,
    dexLiqMap,
    dexLiqAgeSecById,
    dexLiqStaleIds,
    freshCount: dexLiqMap.size,
    staleCount: dexLiqStaleIds.size,
    totalRows: dexLiqRows.results.length,
    freshnessAgeSec: dexLiquidityAgeSec,
    dependencyDiagnostics,
  };
}

export interface DexPriceHydration {
  dexPriceMap: Map<string, DexPriceSnapshot>;
  dexPriceAgeSecById: Map<string, number>;
  dexPriceStaleIds: Set<string>;
  trustedCount: number;
  /**
   * Null when the underlying load failed; the orchestrator omits the
   * `dexPricesStaleRows` coverage key in that case to preserve the legacy
   * source-coverage shape.
   */
  staleCount: number | null;
}

export async function hydrateDexPrices(ctx: HydrationContext): Promise<DexPriceHydration> {
  const dexPriceMap = new Map<string, DexPriceSnapshot>();
  const dexPriceAgeSecById = new Map<string, number>();
  const dexPriceStaleIds = new Set<string>();
  let succeeded = false;
  try {
    const dexPriceRows = await ctx.db
      .prepare("SELECT stablecoin_id, dex_price_usd, source_total_tvl, updated_at FROM dex_prices")
      .all<{ stablecoin_id: string; dex_price_usd: number; source_total_tvl: number; updated_at: number }>();
    for (const row of dexPriceRows.results ?? []) {
      const ageSec = getRowAgeSec(row.updated_at, ctx.nowSec);
      if (ageSec != null) dexPriceAgeSecById.set(row.stablecoin_id, ageSec);
      if (ageSec == null || ageSec >= DEWS_DEX_PRICE_TRUST_POLICY.maxAgeSec) {
        dexPriceStaleIds.add(row.stablecoin_id);
      }
      if (!isTrustedDexPriceRow(row, ctx.nowSec, "depeg")) continue;
      dexPriceMap.set(row.stablecoin_id, {
        dexPriceUsd: row.dex_price_usd,
        sourceTotalTvl: row.source_total_tvl,
        updatedAt: row.updated_at,
      });
    }
    succeeded = true;
  } catch (error) {
    ctx.registerSourceFailure("dex-prices", error);
  }
  return {
    dexPriceMap,
    dexPriceAgeSecById,
    dexPriceStaleIds,
    trustedCount: dexPriceMap.size,
    staleCount: succeeded ? dexPriceStaleIds.size : null,
  };
}

export interface DexLiquidityHistoryHydration {
  liqHist7dMap: Map<string, LiquidityHistorySnapshot>;
  liqHistRowsRead: number;
}

export async function hydrateDexLiquidityHistory(ctx: HydrationContext): Promise<DexLiquidityHistoryHydration> {
  const liqHistCutoff = ctx.nowSec - 8 * DAY_SECONDS;
  const target7d = ctx.nowSec - 7 * DAY_SECONDS;
  const liqHist7dMap = new Map<string, LiquidityHistorySnapshot>();
  let liqHistRowsRead = 0;
  try {
    const liqHistRows = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:dex-liquidity-history */
           stablecoin_id, snapshot_date, liquidity_score, total_tvl_usd
         FROM dex_liquidity_history
         WHERE snapshot_date >= ?
         ORDER BY snapshot_date ASC`,
      )
      .bind(liqHistCutoff)
      .all<{
        stablecoin_id: string;
        snapshot_date: number;
        liquidity_score: number | null;
        total_tvl_usd: number | null;
      }>();
    liqHistRowsRead = liqHistRows.results.length;

    for (const row of liqHistRows.results) {
      const existing = liqHist7dMap.get(row.stablecoin_id);
      if (!existing || Math.abs(row.snapshot_date - target7d) < Math.abs(existing.date - target7d)) {
        liqHist7dMap.set(row.stablecoin_id, {
          score: row.liquidity_score ?? null,
          tvl: row.total_tvl_usd ?? null,
          date: row.snapshot_date,
        });
      }
    }
  } catch (error) {
    ctx.registerSourceFailure("dex-liquidity-history", error);
  }
  return { liqHist7dMap, liqHistRowsRead };
}

export interface BlacklistHydration {
  blacklistCounts: BlacklistCountByStablecoinId;
  rowsRead: number;
}

type BlacklistEventHydrationRow = Pick<BlacklistPersistedRow,
  "stablecoin" | "chain_id" | "config_key" | "contract_address" | "timestamp"
>;

const BLACKLIST_SYMBOL_TO_TRACKED_ID = (() => {
  const bySymbol = new Map<string, Set<string>>();
  for (const config of CONTRACT_CONFIGS) {
    const symbol = config.stablecoin.toUpperCase();
    const ids = bySymbol.get(symbol) ?? new Set<string>();
    ids.add(config.stablecoinId);
    bySymbol.set(symbol, ids);
  }

  const unique = new Map<string, string>();
  for (const [symbol, ids] of bySymbol) {
    if (ids.size === 1) unique.set(symbol, [...ids][0]!);
  }
  return unique;
})();

function resolveBlacklistEventStablecoinId(row: BlacklistEventHydrationRow): string | null {
  if (row.config_key) {
    const config = getBlacklistConfigByKey(row.config_key);
    if (config) return config.stablecoinId;
  }
  if (row.contract_address) {
    const config = getBlacklistConfigByContract(row.chain_id, row.contract_address);
    if (config) return config.stablecoinId;
  }
  return BLACKLIST_SYMBOL_TO_TRACKED_ID.get(row.stablecoin.toUpperCase()) ?? null;
}

export async function hydrateBlacklistEvents(ctx: HydrationContext): Promise<BlacklistHydration> {
  const blacklistCounts: BlacklistCountByStablecoinId = new Map();
  let blacklistRowsRead = 0;
  try {
    const rows = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:blacklist-events-7d */
           stablecoin, chain_id, config_key, contract_address, timestamp
         FROM blacklist_events
         WHERE timestamp >= ?`,
      )
      .bind(ctx.nowSec - 7 * DAY_SECONDS)
      .all<BlacklistEventHydrationRow>();
    blacklistRowsRead = rows.results?.length ?? 0;

    const cutoff24h = ctx.nowSec - DAY_SECONDS;
    for (const row of rows.results ?? []) {
      const stablecoinId = resolveBlacklistEventStablecoinId(row);
      if (!stablecoinId) continue;
      const counts = blacklistCounts.get(stablecoinId) ?? { count24h: 0, count7d: 0 };
      counts.count7d += 1;
      if (row.timestamp >= cutoff24h) counts.count24h += 1;
      blacklistCounts.set(stablecoinId, counts);
    }
  } catch (error) {
    ctx.registerSourceFailure("blacklist-events", error);
  }
  return { blacklistCounts, rowsRead: blacklistRowsRead };
}

export interface PreviousStressSignalsHydration {
  prevSignals: Map<string, { signals: Record<string, { value: number }>; computedAt: number; ageSec: number }>;
  prevSignalStaleIds: Set<string>;
  rowsRead: number;
}

export async function hydratePreviousStressSignals(ctx: HydrationContext): Promise<PreviousStressSignalsHydration> {
  const prevSignals = new Map<
    string,
    { signals: Record<string, { value: number }>; computedAt: number; ageSec: number }
  >();
  const prevSignalStaleIds = new Set<string>();
  let prevSignalRowsRead = 0;
  try {
    const prevRows = await loadPreviousStressSignalRows(ctx);
    prevSignalRowsRead = prevRows.length;
    for (const row of prevRows) {
      const ageSec = getRowAgeSec(row.computed_at, ctx.nowSec);
      if (ageSec == null || ageSec > DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC) {
        prevSignalStaleIds.add(row.stablecoin_id);
        continue;
      }
      const decoded = decodeLegacyStressSignals(row.signals_json, row.computed_at);
      if (!decoded.ok) {
        ctx.registerMalformedPersistedInput({
          source: "stress_signals",
          context: "stress_signals.signals_json",
          stablecoinId: row.stablecoin_id,
          updatedAt: row.computed_at,
          reason: decoded.reason,
          degradesRun: true,
        });
        continue;
      }
      prevSignals.set(row.stablecoin_id, {
        signals: decoded.payload,
        computedAt: row.computed_at,
        ageSec,
      });
    }
  } catch (error) {
    ctx.registerSourceFailure("stress-signals", error);
  }
  return { prevSignals, prevSignalStaleIds, rowsRead: prevSignalRowsRead };
}

export interface MintBurnHydration {
  mintBurnMap: Map<string, MintBurnSnapshot>;
  mintBurnAgeSecById: Map<string, number>;
  mintBurnStaleIds: Set<string>;
  freshCount: number;
  staleCount: number;
  freshnessAgeSec: number | null;
  rowsRead: number;
}

export async function hydrateMintBurn(ctx: HydrationContext): Promise<MintBurnHydration> {
  const mintBurnMap = new Map<string, MintBurnSnapshot>();
  const mintBurnAgeSecById = new Map<string, number>();
  const mintBurnStaleIds = new Set<string>();
  let mintBurnRowsRead = 0;
  let mintBurnLatestHourTs: number | null = null;
  try {
    const mb24h = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:mint-burn-24h */
                stablecoin_id, chain_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint,
                MAX(hour_ts) as latest_hour_ts
         FROM mint_burn_hourly INDEXED BY idx_mbh_ts
         WHERE hour_ts >= ? GROUP BY stablecoin_id, chain_id`,
      )
      .bind(ctx.nowSec - DAY_SECONDS)
      .all<{ stablecoin_id: string; chain_id: string; total_burn: number; total_mint: number; latest_hour_ts: number | null }>();

    const mb30d = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:mint-burn-30d */
                stablecoin_id, chain_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint,
                COUNT(DISTINCT date(hour_ts, 'unixepoch')) as days_with_data,
                MAX(hour_ts) as latest_hour_ts
         FROM mint_burn_hourly INDEXED BY idx_mbh_ts
         WHERE hour_ts >= ? GROUP BY stablecoin_id, chain_id`,
      )
      .bind(ctx.nowSec - 30 * DAY_SECONDS)
      .all<{
        stablecoin_id: string;
        chain_id: string;
        total_burn: number;
        total_mint: number;
        days_with_data: number;
        latest_hour_ts: number | null;
      }>();
    mintBurnRowsRead = (mb24h.results?.length ?? 0) + (mb30d.results?.length ?? 0);

    const mb24hMap = new Map<string, { total_burn: number; total_mint: number; latest_hour_ts: number | null }>();
    for (const row of mb24h.results) {
      if (!isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)) continue;
      const aggregate = mb24hMap.get(row.stablecoin_id) ?? { total_burn: 0, total_mint: 0, latest_hour_ts: null };
      aggregate.total_burn += row.total_burn;
      aggregate.total_mint += row.total_mint;
      if (row.latest_hour_ts != null && (aggregate.latest_hour_ts == null || row.latest_hour_ts > aggregate.latest_hour_ts)) {
        aggregate.latest_hour_ts = row.latest_hour_ts;
      }
      if (row.latest_hour_ts != null && (mintBurnLatestHourTs == null || row.latest_hour_ts > mintBurnLatestHourTs)) {
        mintBurnLatestHourTs = row.latest_hour_ts;
      }
      mb24hMap.set(row.stablecoin_id, aggregate);
    }
    const mb30dMap = new Map<string, { avg_burn: number; avg_mint: number; days_with_data: number; latest_hour_ts: number | null }>();
    for (const row of mb30d.results) {
      if (!isCanonicalMintBurnPair(row.stablecoin_id, row.chain_id)) continue;
      const aggregate = mb30dMap.get(row.stablecoin_id) ?? { avg_burn: 0, avg_mint: 0, days_with_data: 0, latest_hour_ts: null };
      const observedDays = Math.max(0, row.days_with_data);
      aggregate.avg_burn += observedDays > 0 ? row.total_burn / observedDays : 0;
      aggregate.avg_mint += observedDays > 0 ? row.total_mint / observedDays : 0;
      aggregate.days_with_data = Math.max(aggregate.days_with_data, observedDays);
      if (row.latest_hour_ts != null && (aggregate.latest_hour_ts == null || row.latest_hour_ts > aggregate.latest_hour_ts)) {
        aggregate.latest_hour_ts = row.latest_hour_ts;
      }
      if (row.latest_hour_ts != null && (mintBurnLatestHourTs == null || row.latest_hour_ts > mintBurnLatestHourTs)) {
        mintBurnLatestHourTs = row.latest_hour_ts;
      }
      mb30dMap.set(row.stablecoin_id, aggregate);
    }
    const mintBurnIds = new Set([...mb24hMap.keys(), ...mb30dMap.keys()]);

    for (const stablecoinId of mintBurnIds) {
      const latestWindow = mb24hMap.get(stablecoinId);
      const baseline = mb30dMap.get(stablecoinId);
      const latestHourTs = latestWindow?.latest_hour_ts ?? baseline?.latest_hour_ts ?? null;
      const ageSec = getRowAgeSec(latestHourTs, ctx.nowSec);
      if (ageSec != null) mintBurnAgeSecById.set(stablecoinId, ageSec);
      if (ageSec == null || ageSec > DEWS_STALE_MINT_BURN_SEC) {
        mintBurnStaleIds.add(stablecoinId);
      }
      mintBurnMap.set(stablecoinId, {
        burn24h: latestWindow?.total_burn ?? 0,
        mint24h: latestWindow?.total_mint ?? 0,
        burnBaseline: baseline?.avg_burn ?? 0,
        mintBaseline: baseline?.avg_mint ?? 0,
        baselineDays: baseline?.days_with_data ?? 0,
      });
    }
    const mintBurnAgeSec = mintBurnLatestHourTs != null ? Math.max(0, ctx.nowSec - mintBurnLatestHourTs) : null;
    if (mintBurnAgeSec != null && mintBurnAgeSec > DEWS_STALE_MINT_BURN_SEC) {
      ctx.registerSourceFailure(
        "mint-burn-hourly-freshness",
        `mint_burn_hourly age ${mintBurnAgeSec}s exceeds ${DEWS_STALE_MINT_BURN_SEC}s`,
      );
    }
  } catch (error) {
    ctx.registerSourceFailure("mint-burn-hourly", error);
  }
  return {
    mintBurnMap,
    mintBurnAgeSecById,
    mintBurnStaleIds,
    freshCount: mintBurnMap.size - mintBurnStaleIds.size,
    staleCount: mintBurnStaleIds.size,
    freshnessAgeSec: mintBurnLatestHourTs != null ? Math.max(0, ctx.nowSec - mintBurnLatestHourTs) : null,
    rowsRead: mintBurnRowsRead,
  };
}

export interface YieldWarningsHydration {
  yieldWarnings: Map<string, string[]>;
  rowsRead: number;
}

export async function hydrateYieldWarnings(ctx: HydrationContext): Promise<YieldWarningsHydration> {
  const yieldWarnings = new Map<string, string[]>();
  let yieldWarningRowsRead = 0;
  try {
    const yieldRows = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:yield-warning-signals */
           stablecoin_id, warning_signals
         FROM yield_data
         WHERE is_best = 1
           AND warning_signals IS NOT NULL
           AND warning_signals != '[]'
           AND (publication_state IS NULL OR publication_state = 'published')`,
      )
      .all<{ stablecoin_id: string; warning_signals: string }>();
    yieldWarningRowsRead = yieldRows.results.length;
    for (const row of yieldRows.results) {
      const decoded = decodeJsonString<string[], PersistedJsonDecodeReason>(row.warning_signals, {
        missingReason: "missing",
        parseErrorReason: "json-parse-failed",
        normalize: (parsed) => {
          if (!Array.isArray(parsed) || !parsed.every((signal) => typeof signal === "string")) {
            return { ok: false, reason: "invalid-shape" as const };
          }
          return { ok: true, payload: parsed };
        },
      });
      if (!decoded.ok) {
        ctx.registerMalformedPersistedInput({
          source: "yield_data",
          context: "yield_data.warning_signals",
          stablecoinId: row.stablecoin_id,
          reason: decoded.reason,
          degradesRun: true,
        });
        continue;
      }
      yieldWarnings.set(row.stablecoin_id, decoded.payload);
    }
  } catch (error) {
    ctx.registerSourceFailure("yield-data", error);
  }
  return { yieldWarnings, rowsRead: yieldWarningRowsRead };
}

export interface YieldRankingsHydration {
  yieldSourceRisk: Map<string, YieldSourceRisk>;
  yieldRankChangeAttribution: Map<string, YieldRankChangeAttribution>;
}

export async function hydrateYieldRankingsCache(ctx: HydrationContext): Promise<YieldRankingsHydration> {
  const yieldSourceRisk = new Map<string, YieldSourceRisk>();
  const yieldRankChangeAttribution = new Map<string, YieldRankChangeAttribution>();
  try {
    const rankingsCache = await ctx.db
      .prepare("SELECT /* pharos:dews:yield-rankings-cache */ value, updated_at FROM cache WHERE key = ?")
      .bind("yield-rankings")
      .first<{ value: string | null; updated_at: number | null }>();
    const decoded = decodeJsonString<unknown[], PersistedJsonDecodeReason>(rankingsCache?.value ?? null, {
      updatedAt: rankingsCache?.updated_at ?? null,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        const payload = getObject(parsed);
        return Array.isArray(payload?.rankings)
          ? { ok: true, payload: payload.rankings }
          : { ok: false, reason: "invalid-shape" as const };
      },
    });
    if (decoded.ok) {
      for (const ranking of decoded.payload) {
        const row = getObject(ranking);
        const stablecoinId = getString(row?.id);
        if (!stablecoinId) continue;

        const sourceRisk = normalizeYieldSourceRisk(row?.sourceRisk);
        if (sourceRisk) yieldSourceRisk.set(stablecoinId, sourceRisk);

        const rankChangeAttribution = normalizeYieldRankChangeAttribution(row?.rankChangeAttribution);
        if (rankChangeAttribution) yieldRankChangeAttribution.set(stablecoinId, rankChangeAttribution);
      }
    } else if (rankingsCache?.value != null) {
      ctx.registerMalformedPersistedInput({
        source: "yield-rankings",
        context: "cache.yield-rankings",
        stablecoinId: "aggregate",
        updatedAt: rankingsCache?.updated_at ?? null,
        reason: decoded.reason,
        degradesRun: false,
      });
    }
  } catch (error) {
    ctx.registerSourceFailure("yield-rankings", error);
  }
  return { yieldSourceRisk, yieldRankChangeAttribution };
}

export async function hydrateLatestPsiScore(ctx: HydrationContext): Promise<number | null> {
  try {
    const psiRow = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:latest-psi-score */
           score FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1`,
      )
      .first<{ score: number }>();
    return psiRow ? psiRow.score : null;
  } catch (error) {
    ctx.registerSourceFailure("stability-index-samples", error);
    return null;
  }
}
