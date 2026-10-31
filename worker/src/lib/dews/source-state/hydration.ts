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
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { resolveCronTimeoutBudget } from "../../cron-timeouts";
import { decodeJsonString } from "../../cache-json";
import { BLACKLIST_PUBLIC_EVENT_SQL, type BlacklistPersistedRow } from "../../blacklist/shared";
import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../../structured-log";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../dex-liquidity";
import { getDexLiquidityTrendTolerances, selectLiquidityObservation, selectTrendBaseline } from "../../dex-liquidity-response";
import type { DexHistoryRow } from "../../dex-liquidity-response";
import {
  CONTRACT_CONFIGS,
  getBlacklistConfigByContract,
  getBlacklistConfigByKey,
} from "../../blacklist-contracts";
import { getDexTrustPolicy, isTrustedDexPriceRow } from "../../depeg-trust-policy";
import { isCanonicalMintBurnPair } from "../../mint-burn-canonical-chain";
import { readPublishedMintBurnGauge } from "../../mint-burn-published-gauge";
import { MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { isGrandfatheredMintBurnConfig } from "../../mint-burn-publication";
import { readMintBurnWindowContext } from "../../mint-burn-flows-service";
import {
  MINT_BURN_HOURLY_VALUATION_TALLY_SQL,
  type MintBurnValuationTallyRow,
  readMintBurnValuationTallyRow,
} from "../../mint-burn-hourly-valuation";
import {
  addMintBurnValuationTally,
  emptyMintBurnValuationTally,
  summarizeMintBurnValuation,
  type MintBurnValuationTally,
} from "@shared/lib/mint-burn-valuation";
import type {
  BlacklistCountByStablecoinId,
  DexLiquidityDependencyDiagnostics,
  DexLiquidityRow,
  DexPriceSnapshot,
  LiquidityHistorySnapshot,
  MintBurnSnapshot,
  PersistedJsonDecodeReason,
  StablecoinsDependencyDiagnostics,
} from "../contracts";
import {
  normalizeYieldRankChangeAttribution,
  normalizeYieldSourceRisk,
  type YieldRankChangeAttribution,
  type YieldSourceRisk,
} from "@shared/types/yield";
import { readRecord as getObject, stringValue as getString } from "@shared/lib/type-guards";
import { decodeLegacyStressSignals } from "./legacy-bridge";
import {
  loadPreviousStressSignalCurrentRows,
  type PreviousStressSignalCurrentRow,
} from "../../stress-signals-current-rows";
import { classifyFreshness } from "../../status/freshness-oracle";

import {
  DEWS_PSI_FRESHNESS_BUDGET_SEC,
  DEWS_STALE_DEX_LIQUIDITY_SEC,
  DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC,
} from "./budgets";
import { assessFreshnessTimestamp } from "../../api-freshness-age";
const DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC = 2 * 3600;
const DEWS_STALE_MINT_BURN_SEC = DAY_SECONDS;
// DEWS can overlap the next yield producer while it is still publishing.
const DEWS_FRESH_YIELD_RANKINGS_SEC = CRON_INTERVALS["sync-yield-data"]
  + resolveCronTimeoutBudget("sync-yield-data").configuredTimeoutMs / 1000;
const DEWS_DEX_PRICE_TRUST_POLICY = getDexTrustPolicy("depeg");

type PreviousStressSignalRow = PreviousStressSignalCurrentRow;

export interface HydrationCallbacks {
  registerSourceFailure: (source: string, error: unknown) => void;
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
    // Producers may publish after this run's captured clock while hydration is in flight.
    { readAtSec: Math.floor(Date.now() / 1000) },
  ).state === "fresh";
}

async function loadPreviousStressSignalRows(ctx: HydrationContext): Promise<{
  rows: PreviousStressSignalRow[];
  generationUnavailableReason: string | null;
}> {
  let generationUnavailableReason: string | null = null;
  const rows = await loadPreviousStressSignalCurrentRows(ctx.db, ctx.nowSec, {
    staleAfterSec: DEWS_PREVIOUS_SIGNAL_SMOOTHING_MAX_AGE_SEC,
    // Smoothing is an optional self-produced input: an unreadable previous
    // pointer withholds the previous reading, not this run's publication. The
    // pointer is only rewritten by a publication, so holding here would never
    // repair it (the same rule the PSI amplifier follows).
    onGenerationUnavailable: (reason) => {
      generationUnavailableReason = reason;
    },
    onReadError: (error) => {
      ctx.registerSourceFailure("stress-signals-latest", error);
    },
  });
  return { rows, generationUnavailableReason };
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
        `SELECT stablecoin_id, weighted_balance_ratio, avg_pool_stress, top_pools_json, liquidity_score, total_tvl_usd, updated_at, methodology_version
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

export async function hydrateDexLiquidityHistory(
  ctx: HydrationContext,
  currentLiquidityById: ReadonlyMap<string, DexLiquidityRow>,
): Promise<DexLiquidityHistoryHydration> {
  const target7d = ctx.nowSec - 7 * DAY_SECONDS;
  const tolerance = getDexLiquidityTrendTolerances().week;
  const liqHistCutoff = target7d - tolerance;
  const liqHist7dMap = new Map<string, LiquidityHistorySnapshot>();
  let liqHistRowsRead = 0;
  try {
    const liqHistRows = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:dex-liquidity-history */
           stablecoin_id, snapshot_date, liquidity_score, total_tvl_usd, coverage_class, coverage_confidence, methodology_version
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
        coverage_confidence: number | null;
        coverage_class: string | null;
        methodology_version: string | null;
      }>();
    liqHistRowsRead = liqHistRows.results.length;

    const byId = new Map<string, (DexHistoryRow & { liquidity_score: number | null })[]>();
    for (const row of liqHistRows.results) {
      const history = byId.get(row.stablecoin_id) ?? [];
      history.push({ ...row, total_tvl_usd: row.total_tvl_usd ?? 0 });
      byId.set(row.stablecoin_id, history);
    }
    for (const [id, history] of byId) {
      const scoreBaseline = selectLiquidityObservation(history, target7d, tolerance);
      const current = currentLiquidityById.get(id);
      const tvlBaseline = current
        ? selectTrendBaseline(history, target7d, tolerance, current.methodology_version)
        : null;
      if (scoreBaseline) {
        liqHist7dMap.set(id, {
          score: scoreBaseline.liquidity_score ?? null,
          tvl: tvlBaseline?.total_tvl_usd ?? null,
          date: scoreBaseline.snapshot_date,
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
  blacklistSourceOk: boolean;
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
  let blacklistSourceOk = false;
  try {
    const rows = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:blacklist-events-7d */
           stablecoin, chain_id, config_key, contract_address, timestamp
         FROM blacklist_events
         WHERE timestamp >= ? AND ${BLACKLIST_PUBLIC_EVENT_SQL}`,
      )
      .bind(ctx.nowSec - 7 * DAY_SECONDS)
      .all<BlacklistEventHydrationRow>();
    blacklistRowsRead = rows.results?.length ?? 0;
    blacklistSourceOk = true;

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
  return { blacklistCounts, blacklistSourceOk, rowsRead: blacklistRowsRead };
}

export interface PreviousStressSignalsHydration {
  prevSignals: Map<string, { signals: Record<string, { value: number; available?: boolean }>; computedAt: number; ageSec: number }>;
  prevSignalStaleIds: Set<string>;
  /** True when the accepted-generation pointer itself was unreadable or invalid. */
  generationUnavailable: boolean;
  rowsRead: number;
}

export async function hydratePreviousStressSignals(ctx: HydrationContext): Promise<PreviousStressSignalsHydration> {
  const prevSignals = new Map<
    string,
    { signals: Record<string, { value: number; available?: boolean }>; computedAt: number; ageSec: number }
  >();
  const prevSignalStaleIds = new Set<string>();
  let generationUnavailable = false;
  let prevSignalRowsRead = 0;
  try {
    const { rows: prevRows, generationUnavailableReason } = await loadPreviousStressSignalRows(ctx);
    if (generationUnavailableReason != null) {
      generationUnavailable = true;
      logWorkerEventArgs(
        "lib",
        "warn",
        `[dews] Previous stress-signal generation unavailable: ${generationUnavailableReason}`,
      );
    }
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
  return { prevSignals, prevSignalStaleIds, generationUnavailable, rowsRead: prevSignalRowsRead };
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
    const published = await readPublishedMintBurnGauge(ctx.db, ctx.nowSec);
    const end = published.kind === "ok" && published.gauge.window != null
      ? published.gauge.window.end : Math.floor(ctx.nowSec / 3600) * 3600;
    let publication = published.kind === "ok" ? published.gauge.publication : null;
    if (published.kind === "ok" && publication == null && published.gauge.window != null) {
      // Retained pre-admission publications describe only the pinned incumbent roster.
      // Reapply current policy so rollback still removes a legacy leg immediately.
      const publishedIds = new Set(published.gauge.coins.map((coin) => coin.id));
      const legacyConfigs = MINT_BURN_CONFIGS.filter((config) => publishedIds.has(config.stablecoinId)
        && isGrandfatheredMintBurnConfig(config));
      publication = (await readMintBurnWindowContext(ctx.db, ctx.nowSec, legacyConfigs)).publication;
    }
    const publishedPairs = publication?.legsScope === "non-admitted"
      ? publication.admittedPairs ?? []
      : publication?.legs.filter((leg) => leg.status === "admitted")
        .map((leg) => [leg.stablecoinId, leg.chainId] as const) ?? [];
    const admittedPairs = new Set(publishedPairs.filter(([id, chain]) => isCanonicalMintBurnPair(id, chain))
      .map(([id, chain]) => `${id}|${chain}`));
    const admittedCoinIds = new Set([...admittedPairs].map((pair) => pair.split("|")[0]));
    const scopedPairsJson = JSON.stringify([...admittedPairs].map((pair) => pair.split("|")));
    const scanCoverageById = new Map(published.kind === "ok" && published.gauge.window != null
      ? published.gauge.coins.filter((coin) => admittedCoinIds.has(coin.id))
        .map((coin) => [coin.id, coin.scanCoverage] as const) : []);
    type FlowRow = MintBurnValuationTallyRow & {
      stablecoin_id: string;
      chain_id: string;
      total_burn: number;
      total_mint: number;
      latest_hour_ts: number | null;
    };
    const snapshot = await ctx.db.batch([
      ctx.db
      .prepare(
        `SELECT /* pharos:dews:mint-burn-24h */
                stablecoin_id, chain_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint,
                ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL},
                MAX(hour_ts) as latest_hour_ts
         FROM mint_burn_hourly INDEXED BY idx_mbh_ts
         WHERE hour_ts >= ? AND hour_ts < ? AND (stablecoin_id, chain_id) IN (
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
         ) GROUP BY stablecoin_id, chain_id`,
      )
      .bind(end - DAY_SECONDS, end, scopedPairsJson),
      ctx.db
      .prepare(
        `SELECT /* pharos:dews:mint-burn-30d */
                stablecoin_id, chain_id,
                SUM(CASE WHEN burn_volume_usd IS NOT NULL THEN burn_volume_usd ELSE 0 END) as total_burn,
                SUM(CASE WHEN mint_volume_usd IS NOT NULL THEN mint_volume_usd ELSE 0 END) as total_mint,
                ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL},
                MAX(hour_ts) as latest_hour_ts
         FROM mint_burn_hourly INDEXED BY idx_mbh_ts
         WHERE hour_ts >= ? AND hour_ts < ? AND (stablecoin_id, chain_id) IN (
           SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
         ) GROUP BY stablecoin_id, chain_id`,
      )
      .bind(end - 30 * DAY_SECONDS, end, scopedPairsJson),
      ctx.db.prepare(`SELECT stablecoin_id, chain_id FROM mint_burn_dirty_hours
        WHERE hour_ts >= ? AND hour_ts < ? GROUP BY stablecoin_id, chain_id`)
        .bind(end - 30 * DAY_SECONDS, end),
    ]);
    const mb24h = snapshot[0] as D1Result<FlowRow>;
    const mb30d = snapshot[1] as D1Result<FlowRow>;
    const dirtyIds = new Set((snapshot[2].results as Array<{ stablecoin_id: string; chain_id: string }>)
      .filter((row) => admittedPairs.has(`${row.stablecoin_id}|${row.chain_id}`)).map((row) => row.stablecoin_id));
    mintBurnRowsRead = (mb24h.results?.length ?? 0) + (mb30d.results?.length ?? 0);

    const mb24hMap = new Map<string, {
      total_burn: number;
      total_mint: number;
      latest_hour_ts: number | null;
      valuation: MintBurnValuationTally;
    }>();
    for (const row of mb24h.results) {
      if (!admittedPairs.has(`${row.stablecoin_id}|${row.chain_id}`)) continue;
      const aggregate = mb24hMap.get(row.stablecoin_id)
        ?? { total_burn: 0, total_mint: 0, latest_hour_ts: null, valuation: emptyMintBurnValuationTally() };
      aggregate.total_burn += row.total_burn;
      aggregate.total_mint += row.total_mint;
      addMintBurnValuationTally(aggregate.valuation, readMintBurnValuationTallyRow(row));
      if (row.latest_hour_ts != null && (aggregate.latest_hour_ts == null || row.latest_hour_ts > aggregate.latest_hour_ts)) {
        aggregate.latest_hour_ts = row.latest_hour_ts;
      }
      if (row.latest_hour_ts != null && (mintBurnLatestHourTs == null || row.latest_hour_ts > mintBurnLatestHourTs)) {
        mintBurnLatestHourTs = row.latest_hour_ts;
      }
      mb24hMap.set(row.stablecoin_id, aggregate);
    }
    const mb30dMap = new Map<string, {
      avg_burn: number;
      avg_mint: number;
      latest_hour_ts: number | null;
      valuation: MintBurnValuationTally;
    }>();
    for (const row of mb30d.results) {
      if (!admittedPairs.has(`${row.stablecoin_id}|${row.chain_id}`)) continue;
      const aggregate = mb30dMap.get(row.stablecoin_id)
        ?? { avg_burn: 0, avg_mint: 0, latest_hour_ts: null, valuation: emptyMintBurnValuationTally() };
      // A proven 30-day scan includes quiet days, not only event-bearing days.
      aggregate.avg_burn += row.total_burn / 30;
      aggregate.avg_mint += row.total_mint / 30;
      addMintBurnValuationTally(aggregate.valuation, readMintBurnValuationTallyRow(row));
      if (row.latest_hour_ts != null && (aggregate.latest_hour_ts == null || row.latest_hour_ts > aggregate.latest_hour_ts)) {
        aggregate.latest_hour_ts = row.latest_hour_ts;
      }
      if (row.latest_hour_ts != null && (mintBurnLatestHourTs == null || row.latest_hour_ts > mintBurnLatestHourTs)) {
        mintBurnLatestHourTs = row.latest_hour_ts;
      }
      mb30dMap.set(row.stablecoin_id, aggregate);
    }
    const mintBurnIds = new Set([...mb24hMap.keys(), ...mb30dMap.keys(), ...scanCoverageById.keys()]);

    for (const stablecoinId of mintBurnIds) {
      const scanCoverage = scanCoverageById.get(stablecoinId);
      // Missing history is an unavailable leg, not a cron execution failure or a calm zero.
      if (scanCoverage?.window24h.complete !== true || scanCoverage.window30d.complete !== true
        || dirtyIds.has(stablecoinId)) continue;
      const latestWindow = mb24hMap.get(stablecoinId);
      const baseline = mb30dMap.get(stablecoinId);
      const latestHourTs = end;
      const ageSec = getRowAgeSec(latestHourTs, ctx.nowSec);
      if (ageSec != null) mintBurnAgeSecById.set(stablecoinId, ageSec);
      if (ageSec == null || ageSec > DEWS_STALE_MINT_BURN_SEC) {
        mintBurnStaleIds.add(stablecoinId);
      }
      // Only fully proven windows admit quiet zero; gross values remain observed subtotals.
      mintBurnMap.set(stablecoinId, {
        burn24h: latestWindow?.total_burn ?? 0,
        mint24h: latestWindow?.total_mint ?? 0,
        burnBaseline: baseline?.avg_burn ?? 0,
        mintBaseline: baseline?.avg_mint ?? 0,
        baselineDays: 30,
        valuation24h: summarizeMintBurnValuation(latestWindow?.valuation ?? emptyMintBurnValuationTally()).completeness,
        burnBaselineValuation:
          summarizeMintBurnValuation(baseline?.valuation ?? emptyMintBurnValuationTally()).burnCompleteness,
      });
    }
    if (mintBurnMap.size > 0) mintBurnLatestHourTs = end;
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
  /** Age of the admitted rankings generation; null when none was admitted. */
  yieldRankingsAgeSec: number | null;
  /** True when the admitted generation is a retained last-good one past the producer budget. */
  yieldRankingsRetained: boolean;
  dependencyDiagnostics: StablecoinsDependencyDiagnostics;
}

export async function hydrateYieldRankingsCache(ctx: HydrationContext): Promise<YieldRankingsHydration> {
  const yieldSourceRisk = new Map<string, YieldSourceRisk>();
  const yieldRankChangeAttribution = new Map<string, YieldRankChangeAttribution>();
  const diagnostics: StablecoinsDependencyDiagnostics = {
    generationId: null, updatedAt: null, ageSeconds: null,
    freshnessBudgetSec: DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC, reason: "missing",
  };
  let yieldRankingsAgeSec: number | null = null;
  let yieldRankingsRetained = false;
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
      // A generation past the producer budget is retained as last-good evidence
      // within the retention budget. Beyond it, or with an inadmissible clock,
      // readable evidence stays for diagnostics but publication is held.
      const rankingsFreshness = classifyFreshness(
        {
          job: "sync-yield-data",
          lastSuccessAt: rankingsCache?.updated_at ?? null,
          lastRunAt: rankingsCache?.updated_at ?? null,
          expectedIntervalSec: DEWS_FRESH_YIELD_RANKINGS_SEC,
          lastStatus: "ok",
        },
        {
          watchAt: { absoluteSec: DEWS_FRESH_YIELD_RANKINGS_SEC },
          staleAt: { absoluteSec: DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC },
        },
        ctx.nowSec,
        { readAtSec: Math.floor(Date.now() / 1000) },
      );
      const updatedAt = rankingsCache?.updated_at;
      diagnostics.updatedAt = typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : null;
      diagnostics.generationId = diagnostics.updatedAt == null ? null : `yield-rankings:${diagnostics.updatedAt}`;
      diagnostics.ageSeconds = rankingsFreshness.ageSec;
      diagnostics.reason = rankingsFreshness.timestampReason
        ?? (rankingsFreshness.state === "stale" ? "stale-generation"
          : rankingsFreshness.state === "watch" ? "retained-last-good" : null);
      if (rankingsFreshness.state === "stale") {
        ctx.registerSourceFailure(
          "yield-rankings-freshness",
          rankingsFreshness.timestampReason != null
            ? `yield-rankings ${rankingsFreshness.timestampReason}`
            : `yield-rankings age ${rankingsFreshness.ageSec}s exceeds ${DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC}s`,
        );
      } else {
        yieldRankingsAgeSec = rankingsFreshness.ageSec;
        yieldRankingsRetained = rankingsFreshness.state === "watch";
      }
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
      diagnostics.reason = decoded.reason;
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
    diagnostics.reason = "read-failed";
  }
  return {
    yieldSourceRisk,
    yieldRankChangeAttribution,
    yieldRankingsAgeSec,
    yieldRankingsRetained,
    dependencyDiagnostics: diagnostics,
  };
}

export async function hydrateLatestPsiScore(ctx: HydrationContext): Promise<{
  latestPsiScore: number | null;
  dependencyDiagnostics: StablecoinsDependencyDiagnostics;
}> {
  const diagnostics: StablecoinsDependencyDiagnostics = {
    generationId: null, updatedAt: null, ageSeconds: null,
    freshnessBudgetSec: DEWS_PSI_FRESHNESS_BUDGET_SEC, reason: "missing-sample",
  };
  try {
    const psiRow = await ctx.db
      .prepare(
        `SELECT /* pharos:dews:latest-psi-score */
           score, stored_at FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1`,
      )
      .first<{ score: number; stored_at: number }>();
    if (!psiRow) return { latestPsiScore: null, dependencyDiagnostics: diagnostics };
    const age = assessFreshnessTimestamp(ctx.nowSec, psiRow.stored_at);
    diagnostics.updatedAt = Number.isFinite(psiRow.stored_at) ? psiRow.stored_at : null;
    diagnostics.generationId = diagnostics.updatedAt == null ? null : `stability-index-samples:${diagnostics.updatedAt}`;
    diagnostics.ageSeconds = age.ageSeconds;
    diagnostics.reason = age.reason != null ? age.reason
      : age.ageSeconds > DEWS_PSI_FRESHNESS_BUDGET_SEC ? "stale-sample"
      : !Number.isFinite(psiRow.score) ? "invalid-score" : null;
    // An inadmissible sample only omits the optional amplifier. It must not hold
    // publication: PSI fails closed without a fresh DEWS generation, so holding
    // here deadlocks both producers after a single missed slot.
    return {
      latestPsiScore: diagnostics.reason ? null : psiRow.score,
      dependencyDiagnostics: diagnostics,
    };
  } catch (error) {
    ctx.registerSourceFailure("stability-index-samples", error);
    diagnostics.reason = "read-failed";
    return { latestPsiScore: null, dependencyDiagnostics: diagnostics };
  }
}
