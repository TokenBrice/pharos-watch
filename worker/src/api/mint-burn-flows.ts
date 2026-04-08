import { getCache } from "../lib/db-cache";
import {
  withErrorHandler,
  resolveOrReject,
  errorResponse,
  parseQueryParams,
  getLatestSuccessfulCronTimestampResult,
} from "../lib/api-utils";
import {
  buildMintBurnScope,
  getMintBurnConfigsForStablecoin,
  getMintBurnTrackedPairs,
  MINT_BURN_CONFIGS,
} from "../lib/mint-burn-contracts";
import { readMintBurnSyncStateBatch } from "../lib/mint-burn-pipeline/sync-state";
import { buildMintBurnSyncHealth } from "../lib/mint-burn-health-config";
import {
  computeFlowIntensity,
  computeGaugeScore,
  detectFlightToQuality,
  getGaugeBand,
} from "../lib/mint-burn-scoring";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import type { StablecoinData } from "@shared/types/market";
import { sumPegBuckets } from "@shared/lib/supply";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
} from "@shared/lib/mint-burn-signals";
import { loadReportCardCache } from "../lib/report-card-cache";
import { buildFlightToQualityClassification } from "../lib/flight-to-quality-classification";
import { buildInClause } from "../lib/db";
import {
  aggregateFlowCacheKey,
  aggregateHourlyRowsByChain,
  aggregateHourlyRowsByStablecoin,
  BASELINE_WINDOW_DAYS,
  buildBaselineMap,
  buildHourlyFlowSeries,
  buildCoinCoverageMap,
  bucketDay,
  cachedFlowFallbackResponse,
  type DailyBaselineRow,
  type EventRow,
  finalizeMintBurnFlowResponse,
  type FirstSeenRow,
  FLOW_DEFAULT_WINDOW_HOURS,
  type HourlyRow,
  MINT_BURN_CRON_JOB,
  mintBurnPairKey,
  perCoinFlowCacheKey,
  readMintBurnCronSnapshot,
  resolveFlowUpdatedAt,
  selectLargestEvents,
  withMintBurnFlowFallback,
} from "./mint-burn-flows-shared";

// ---------------------------------------------------------------------------
// Safe-haven classification (flight-to-quality)
// ---------------------------------------------------------------------------

/** All tracked stablecoin IDs from config */
const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((c) => c.stablecoinId));

/** Max age for report card cache before FTQ classification is treated as unavailable (2 hours) */
const REPORT_CARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CoinFlowSummary {
  stablecoinId: string;
  symbol: string;
  flowIntensity: number | null;
  pressureShiftScore: number | null;
  pressureShiftState: "improving" | "stable" | "worsening" | "nr";
  netFlowDirection24h: "minting" | "burning" | "flat" | "inactive";
  has24hActivity: boolean;
  baselineDailyNetUsd: number | null;
  baselineDailyAbsUsd: number | null;
  baselineDataDays: number | null;
  netFlow24hUsd: number;
  mintVolume24hUsd: number;
  burnVolume24hUsd: number;
  mintCount24h: number;
  burnCount24h: number;
  netFlow7dUsd: number;
  netFlow30dUsd: number;
  netFlow90dUsd: number;
  largestEvent24h: {
    direction: string;
    amountUsd: number;
    txHash: string;
    timestamp: number;
  } | null;
  coverage: {
    startBlock: number;
    lastSyncedBlock: number | null;
    lagBlocks: number | null;
    historyStartAt: number | null;
    has24hWindow: boolean;
    has30dWindow: boolean;
    has90dWindow: boolean;
    isPartial: boolean;
    adapterKinds?: string[];
    startBlockSource?: string;
    startBlockConfidence?: "high" | "medium" | "low";
    status: "full" | "partial-history" | "lagging" | "bootstrapping" | "disabled";
  };
}

interface AggregateQueryParams {
  nowSec: number;
  windowStart: number;
  window24h: number;
  window7d: number;
  window30d: number;
  window90d: number;
  nowDayTs: number;
  baselineWindowStart: number;
}

interface AggregateData {
  hourlyRows: HourlyRow[];
  hourly24hRows: HourlyRow[];
  net7dMap: Map<string, number>;
  net30dMap: Map<string, number>;
  net90dMap: Map<string, number>;
  baselineMap: ReturnType<typeof buildBaselineMap>;
  largestEventMap: ReturnType<typeof selectLargestEvents>;
  coverageMap: ReturnType<typeof buildCoinCoverageMap>;
  sync: ReturnType<typeof buildMintBurnSyncHealth>;
  latestSuccessfulSyncAt: number | null;
  freshnessLookupWarning: string | null;
}

interface GroupedNetFlowRow {
  stablecoin_id: string;
  chain_id: string;
  net_flow_usd: number;
}

function appendSyncWarning(baseWarning: string | null, extraWarning: string | null): string | null {
  if (!baseWarning) return extraWarning;
  if (!extraWarning) return baseWarning;
  return `${baseWarning} ${extraWarning}`;
}

function filterRowsToTrackedPairs<T extends { stablecoin_id: string; chain_id: string }>(
  rows: T[],
  trackedPairs: Set<string>,
): T[] {
  return rows.filter((row) => trackedPairs.has(mintBurnPairKey(row.stablecoin_id, row.chain_id)));
}

function buildGroupedNetFlowMap(
  rows: GroupedNetFlowRow[],
  trackedPairs: Set<string>,
): Map<string, number> {
  const netMap = new Map<string, number>();
  for (const row of rows) {
    if (!trackedPairs.has(mintBurnPairKey(row.stablecoin_id, row.chain_id))) continue;
    netMap.set(row.stablecoin_id, (netMap.get(row.stablecoin_id) ?? 0) + row.net_flow_usd);
  }
  return netMap;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleMintBurnFlows = withErrorHandler(
  "mint-burn-flows",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
    const stablecoinParam = params.get("stablecoin");
    const parsed = parseQueryParams(params, {
      hours: { type: "int", default: 24, min: 1, max: 720, rangePolicy: "reject" },
    });
    if (parsed instanceof Response) return parsed;
    const { hours } = parsed;

    if (stablecoinParam) {
      const resolved = resolveOrReject(stablecoinParam);
      if (resolved instanceof Response) {
        return resolved;
      }
      return handlePerCoin(db, resolved.canonicalId, hours);
    }
    return handleAggregate(db, hours);
  },
);

// ---------------------------------------------------------------------------
// Aggregate mode — data fetching
// ---------------------------------------------------------------------------

async function fetchAggregateData(
  db: D1Database,
  params: AggregateQueryParams,
): Promise<AggregateData> {
  const trackedPairs = getMintBurnTrackedPairs();
  const trackedChainIds = [...new Set(MINT_BURN_CONFIGS.map((config) => config.chain.chainId))];
  const chainInClause = buildInClause(trackedChainIds);

  const [batchResults, [lastBlocks, latestCronSnapshot]] = await Promise.all([
    db.batch([
      // 0: hourlyWindow
      db
        .prepare(
           `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
                   mint_volume_usd, burn_volume_usd, net_flow_usd
            FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
            ORDER BY hour_ts ASC`,
        )
        .bind(...chainInClause.binds, params.windowStart),
      // 1: hourly24h
      db
        .prepare(
           `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
                   mint_volume_usd, burn_volume_usd, net_flow_usd
            FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
            ORDER BY hour_ts ASC`,
        )
        .bind(...chainInClause.binds, params.window24h),
      // 2: hourly7d
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(...chainInClause.binds, params.window7d),
      // 3: hourly30d
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(...chainInClause.binds, params.window30d),
      // 4: hourly90d
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(...chainInClause.binds, params.window90d),
      // 5: baselineDaily
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  (hour_ts / 86400) * 86400 as day_ts,
                  SUM(net_flow_usd) as daily_net,
                  SUM(mint_volume_usd + burn_volume_usd) as daily_abs
           FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, chain_id, day_ts`,
        )
        .bind(...chainInClause.binds, params.baselineWindowStart, params.nowDayTs),
      // 6: firstSeen
      db
        .prepare(
          `SELECT stablecoin_id, chain_id, MIN(hour_ts) as first_hour_ts
           FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql})
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(...chainInClause.binds),
      // 7: largestEvents
      db
        .prepare(
          `SELECT id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
                  counterparty, tx_hash, block_number, timestamp, explorer_tx_url
           FROM mint_burn_events
           WHERE chain_id IN (${chainInClause.sql})
             AND timestamp >= ?
             AND (direction = 'mint' OR burn_type = 'effective_burn')
             AND flow_type = 'standard'`,
        )
        .bind(...chainInClause.binds, params.window24h),
    ]),
    Promise.all([
      readMintBurnSyncStateBatch(db, MINT_BURN_CONFIGS),
      readMintBurnCronSnapshot(db),
    ]),
  ]);

  const hourlyWindowResult = { results: (batchResults[0].results ?? []) as HourlyRow[] };
  const hourly24hResult = { results: (batchResults[1].results ?? []) as HourlyRow[] };
  const hourly7dResult = { results: (batchResults[2].results ?? []) as GroupedNetFlowRow[] };
  const hourly30dResult = { results: (batchResults[3].results ?? []) as GroupedNetFlowRow[] };
  const hourly90dResult = { results: (batchResults[4].results ?? []) as GroupedNetFlowRow[] };
  const baselineDailyResult = { results: (batchResults[5].results ?? []) as DailyBaselineRow[] };
  const firstSeenResult = { results: (batchResults[6].results ?? []) as FirstSeenRow[] };
  const largestEventsResult = { results: (batchResults[7].results ?? []) as EventRow[] };

  const hourlyRows = filterRowsToTrackedPairs(hourlyWindowResult.results ?? [], trackedPairs);
  const hourly24hRows = filterRowsToTrackedPairs(hourly24hResult.results ?? [], trackedPairs);
  const baselineRows = filterRowsToTrackedPairs(baselineDailyResult.results ?? [], trackedPairs);
  const firstSeenRows = filterRowsToTrackedPairs(firstSeenResult.results ?? [], trackedPairs);
  const largestEventRows = filterRowsToTrackedPairs(largestEventsResult.results ?? [], trackedPairs);
  const latestSuccessfulSyncLookup = await getLatestSuccessfulCronTimestampResult(db, MINT_BURN_CRON_JOB);
  const fallbackSyncAt =
    latestCronSnapshot.startedAt
    ?? (hourlyRows.length > 0 ? resolveFlowUpdatedAt(hourlyRows, 0) : null);
  const latestSuccessfulSyncAt = latestSuccessfulSyncLookup.timestamp ?? fallbackSyncAt;
  const freshnessLookupWarning = latestSuccessfulSyncLookup.status === "lookup_failed"
    ? "Mint/burn freshness lookup failed; falling back to cached row timestamps."
    : null;

  return {
    hourlyRows,
    hourly24hRows,
    net7dMap: buildGroupedNetFlowMap(hourly7dResult.results ?? [], trackedPairs),
    net30dMap: buildGroupedNetFlowMap(hourly30dResult.results ?? [], trackedPairs),
    net90dMap: buildGroupedNetFlowMap(hourly90dResult.results ?? [], trackedPairs),
    baselineMap: buildBaselineMap(params.nowSec, baselineRows, firstSeenRows),
    largestEventMap: selectLargestEvents(largestEventRows),
    coverageMap: buildCoinCoverageMap(params.nowSec, firstSeenRows, lastBlocks, latestCronSnapshot.chainHeads),
    sync: buildMintBurnSyncHealth(params.nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status),
    latestSuccessfulSyncAt,
    freshnessLookupWarning,
  };
}

// ---------------------------------------------------------------------------
// Aggregate mode — per-coin summary builder
// ---------------------------------------------------------------------------

function buildCoinSummaries(
  data: AggregateData,
  mcapById: Map<string, number>,
  gradeClassification: ReturnType<typeof buildFlightToQualityClassification> | null,
): { coins: CoinFlowSummary[]; gaugeInputs: Array<{ intensity: number | null; mcap: number }>; safeNet24h: number; riskyNet24h: number; trackedMcapUsd: number } {
  const coinAgg = aggregateHourlyRowsByStablecoin(data.hourly24hRows);
  const coins: CoinFlowSummary[] = [];
  const gaugeInputs: Array<{ intensity: number | null; mcap: number }> = [];
  let safeNet24h = 0;
  let riskyNet24h = 0;
  let trackedMcapUsd = 0;

  const seenCoinIds = new Set<string>();
  for (const config of MINT_BURN_CONFIGS) {
    const id = config.stablecoinId;
    if (seenCoinIds.has(id)) continue;
    seenCoinIds.add(id);
    const agg = coinAgg.get(id);
    const baseline = data.baselineMap.get(id);
    const mcap = mcapById.get(id) ?? 0;
    trackedMcapUsd += mcap;

    const netFlow24h = agg?.netFlow ?? 0;
    const has24hActivity = (agg?.mintCount ?? 0) > 0
      || (agg?.burnCount ?? 0) > 0
      || (agg?.mintVolume ?? 0) > 0
      || (agg?.burnVolume ?? 0) > 0;
    const intensity = has24hActivity && baseline
      ? computeFlowIntensity({
          currentDailyNet: netFlow24h,
          baselineDailyNet: baseline.avgNet,
          baselineDailyAbs: baseline.avgAbs,
          dataAgeDays: baseline.dataDays,
          currentDailyAbs: (agg?.mintVolume ?? 0) + (agg?.burnVolume ?? 0),
        })
      : null;
    const pressureShiftScore = intensity;

    gaugeInputs.push({ intensity, mcap });

    if (gradeClassification) {
      if (gradeClassification.safeIds.has(id)) {
        safeNet24h += netFlow24h;
      } else if (gradeClassification.riskyIds.has(id)) {
        riskyNet24h += netFlow24h;
      }
    }

    const largest = data.largestEventMap.get(id);
    const coverage = data.coverageMap.get(id) ?? {
      startBlock: 0,
      lastSyncedBlock: null,
      lagBlocks: null,
      historyStartAt: null,
      has24hWindow: false,
      has30dWindow: false,
      has90dWindow: false,
      isPartial: true,
      status: "bootstrapping" as const,
    };
    coins.push({
      stablecoinId: id,
      symbol: config.symbol,
      flowIntensity: intensity,
      pressureShiftScore,
      pressureShiftState: getPressureShiftState(pressureShiftScore),
      netFlowDirection24h: getNetFlowDirection24h({ netFlow24hUsd: netFlow24h, has24hActivity }),
      has24hActivity,
      baselineDailyNetUsd: baseline?.avgNet ?? null,
      baselineDailyAbsUsd: baseline?.avgAbs ?? null,
      baselineDataDays: baseline?.dataDays ?? null,
      netFlow24hUsd: netFlow24h,
      mintVolume24hUsd: agg?.mintVolume ?? 0,
      burnVolume24hUsd: agg?.burnVolume ?? 0,
      mintCount24h: agg?.mintCount ?? 0,
      burnCount24h: agg?.burnCount ?? 0,
      netFlow7dUsd: data.net7dMap.get(id) ?? 0,
      netFlow30dUsd: data.net30dMap.get(id) ?? 0,
      netFlow90dUsd: data.net90dMap.get(id) ?? 0,
      largestEvent24h: largest
        ? { direction: largest.direction, amountUsd: largest.amount_usd ?? largest.amount, txHash: largest.tx_hash, timestamp: largest.timestamp }
        : null,
      coverage,
    });
  }

  return { coins, gaugeInputs, safeNet24h, riskyNet24h, trackedMcapUsd };
}

// ---------------------------------------------------------------------------
// Aggregate mode (no stablecoin param)
// ---------------------------------------------------------------------------

async function handleAggregate(db: D1Database, hours: number): Promise<Response> {
  const cacheKey = aggregateFlowCacheKey(hours);
  return withMintBurnFlowFallback(db, "aggregate", cacheKey, async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const syncStartSec = nowSec;
    const nowDayTs = bucketDay(nowSec);
    const params: AggregateQueryParams = {
      nowSec,
      windowStart: nowSec - hours * 3600,
      window24h: nowSec - FLOW_DEFAULT_WINDOW_HOURS * 3600,
      window7d: nowSec - 7 * 24 * 3600,
      window30d: nowSec - 30 * 24 * 3600,
      window90d: nowSec - 90 * 24 * 3600,
      nowDayTs,
      baselineWindowStart: nowDayTs - BASELINE_WINDOW_DAYS * DAY_SECONDS,
    };

    // Load grade-based classification (FTQ disabled when cache unavailable)
    const reportCardCache = await loadReportCardCache(db, { maxAgeMs: REPORT_CARD_MAX_AGE_MS });
    const gradeClassification = reportCardCache.kind === "ok"
      ? buildFlightToQualityClassification(reportCardCache.payload)
      : null;
    const classificationWarning = reportCardCache.kind === "ok"
      ? null
      : `Report-card FTQ classification unavailable (${reportCardCache.reason})`;
    const classificationSource = reportCardCache.kind === "ok" ? "report-card-cache" : "unavailable";
    if (classificationWarning) console.warn(`[mint-burn-flows] ${classificationWarning}`);

    // Load stablecoins cache for mcap lookup
    const mcapById = new Map<string, number>();
    const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
    if (stablecoinsCacheResult.kind !== "ok") {
      const cached = await getCache(db, cacheKey);
      if (cached) {
        console.error(
          `[mint-burn-flows] stablecoins cache ${stablecoinsCacheResult.kind} (${stablecoinsCacheResult.reason}), serving fallback cache (${cacheKey})`,
        );
        return cachedFlowFallbackResponse(cached);
      }
      return errorResponse(503, "Stablecoins data not yet available");
    }
    for (const asset of stablecoinsCacheResult.payload.peggedAssets as StablecoinData[]) {
      if (TRACKED_IDS.has(asset.id)) mcapById.set(asset.id, sumPegBuckets(asset.circulating));
    }

    const data = await fetchAggregateData(db, params);
    const { coins, gaugeInputs, safeNet24h, riskyNet24h, trackedMcapUsd } =
      buildCoinSummaries(data, mcapById, gradeClassification);

    const gaugeScore = computeGaugeScore(gaugeInputs);
    const gaugeBand = gaugeScore !== null ? getGaugeBand(gaugeScore) : null;
    const ftq = detectFlightToQuality({ safeNet24h, riskyNet24h });
    const hourly = buildHourlyFlowSeries(data.hourlyRows);
    const updatedAt = resolveFlowUpdatedAt(data.hourlyRows, nowSec);

    const body = {
      gauge: {
        score: gaugeScore, band: gaugeBand?.label ?? null, intensitySemantics: "signed-v2",
        flightToQuality: ftq.active, flightIntensity: ftq.intensity, classificationSource,
        trackedCoins: coins.length, trackedMcapUsd,
      },
      coins, hourly, updatedAt, windowHours: hours,
      scope: buildMintBurnScope(MINT_BURN_CONFIGS),
      sync: {
        ...data.sync,
        warning: appendSyncWarning(data.sync.warning, data.freshnessLookupWarning),
        classificationWarning,
      },
    };

    return finalizeMintBurnFlowResponse(db, cacheKey, syncStartSec, body, data.latestSuccessfulSyncAt ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Per-coin mode (with stablecoin param)
// ---------------------------------------------------------------------------

async function handlePerCoin(
  db: D1Database,
  stablecoinId: string,
  hours: number,
): Promise<Response> {
  const configs = getMintBurnConfigsForStablecoin(stablecoinId);
  if (configs.length === 0) {
    return errorResponse(404, `Stablecoin "${stablecoinId}" is not tracked for mint/burn flows`);
  }
  const symbol = configs[0]!.symbol;
  const trackedChainIds = [...new Set(configs.map((config) => config.chain.chainId))];
  const chainInClause = buildInClause(trackedChainIds);

  const cacheKey = perCoinFlowCacheKey(stablecoinId, hours);
  return withMintBurnFlowFallback(db, "per-coin", cacheKey, async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const syncStartSec = nowSec;
    const windowStart = nowSec - hours * 3600;

    const [hourlyResult, latestCronSnapshot] = await Promise.all([
      db
        .prepare(
          `SELECT chain_id, hour_ts, mint_count, burn_count,
                  mint_volume_usd, burn_volume_usd, net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND stablecoin_id = ? AND hour_ts >= ?
           ORDER BY hour_ts ASC`,
        )
        .bind(...chainInClause.binds, stablecoinId, windowStart)
        .all<HourlyRow>(),
      readMintBurnCronSnapshot(db),
    ]);

    const rows = hourlyResult.results ?? [];
    const latestSuccessfulSyncLookup = await getLatestSuccessfulCronTimestampResult(db, MINT_BURN_CRON_JOB);
    const fallbackSyncAt =
      latestCronSnapshot.startedAt
      ?? (rows.length > 0 ? resolveFlowUpdatedAt(rows, 0) : null);
    const latestSuccessfulSyncAt = latestSuccessfulSyncLookup.timestamp ?? fallbackSyncAt;
    const freshnessLookupWarning = latestSuccessfulSyncLookup.status === "lookup_failed"
      ? "Mint/burn freshness lookup failed; falling back to cached row timestamps."
      : null;
    const sync = buildMintBurnSyncHealth(nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status);

    // Per-chain breakdown
    const chainMap = aggregateHourlyRowsByChain(rows);

    const chains = [...chainMap.entries()].map(([chainId, v]) => ({
      chainId,
      mintVolumeUsd: v.mintVolume,
      burnVolumeUsd: v.burnVolume,
      mintCount: v.mintCount,
      burnCount: v.burnCount,
      netFlowUsd: v.netFlow,
    }));

    const hourly = buildHourlyFlowSeries(rows);

    // Totals
    let totalMint = 0;
    let totalBurn = 0;
    let totalMintCount = 0;
    let totalBurnCount = 0;
    for (const c of chainMap.values()) {
      totalMint += c.mintVolume;
      totalBurn += c.burnVolume;
      totalMintCount += c.mintCount;
      totalBurnCount += c.burnCount;
    }

    const updatedAt = resolveFlowUpdatedAt(rows, nowSec);

    const body = {
      stablecoinId,
      symbol,
      mintVolumeUsd: totalMint,
      burnVolumeUsd: totalBurn,
      netFlowUsd: totalMint - totalBurn,
      mintCount: totalMintCount,
      burnCount: totalBurnCount,
      chains,
      hourly,
      updatedAt,
      windowHours: hours,
      scope: {
        chainIds: trackedChainIds,
        label: buildMintBurnScope(configs).label,
      },
      sync: {
        ...sync,
        warning: appendSyncWarning(sync.warning, freshnessLookupWarning),
      },
    };

    return finalizeMintBurnFlowResponse(db, cacheKey, syncStartSec, body, latestSuccessfulSyncAt ?? 0);
  });
}
