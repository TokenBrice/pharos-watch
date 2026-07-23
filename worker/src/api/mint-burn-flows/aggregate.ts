import { DAY_SECONDS } from "@shared/lib/time-constants";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import {
  getNetFlowDirection24h,
  getPressureShiftState,
} from "@shared/lib/mint-burn-signals";
import { getLatestSuccessfulCronTimestampResult } from "../../lib/api-utils";
import { buildInClause } from "../../lib/db";
import type { FlightToQualityClassification } from "../../lib/flight-to-quality-classification";
import {
  buildMintBurnSyncHealth,
} from "../../lib/mint-burn-health-config";
import {
  buildMintBurnScope,
  getMintBurnTrackedPairs,
  MINT_BURN_CONFIGS,
} from "../../lib/mint-burn-contracts";
import { readMintBurnSyncStateBatch } from "../../lib/mint-burn-pipeline/sync-state";
import { computeFlowIntensity } from "../../lib/mint-burn-scoring";
import { buildMintBurnFirstHourSeekStatements } from "../../lib/mint-burn-hourly-queries";
import {
  aggregateHourlyRowsByStablecoin,
  BASELINE_WINDOW_DAYS,
  buildBaselineMap,
  buildCoinCoverageMap,
  bucketDay,
  type DailyBaselineRow,
  type EventRow,
  type FirstSeenRow,
  FLOW_DEFAULT_WINDOW_HOURS,
  type HourlyRow,
  MINT_BURN_CRON_JOB,
  mintBurnPairKey,
  readMintBurnCronSnapshot,
  resolveFlowUpdatedAt,
  selectLargestEvents,
} from "../mint-burn-flows-shared";

const ACTIVE_MINT_BURN_CONFIGS = MINT_BURN_CONFIGS.filter((config) => ACTIVE_IDS.has(config.stablecoinId));
export const TRACKED_IDS = new Set(ACTIVE_MINT_BURN_CONFIGS.map((config) => config.stablecoinId));
export const REPORT_CARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface CoinFlowSummary {
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
    status: "full" | "partial-history" | "lagging" | "bootstrapping" | "unknown" | "disabled";
  };
}

export interface AggregateQueryParams {
  nowSec: number;
  windowStart: number;
  window24h: number;
  window7d: number;
  window30d: number;
  window90d: number;
  nowDayTs: number;
  baselineWindowStart: number;
}

export interface AggregateData {
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

export function appendSyncWarning(baseWarning: string | null, extraWarning: string | null): string | null {
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

function filterRowsByWindow(rows: HourlyRow[], windowStart: number): HourlyRow[] {
  return rows.filter((row) => row.hour_ts >= windowStart);
}

export function buildAggregateQueryParams(nowSec: number, hours: number): AggregateQueryParams {
  const nowDayTs = bucketDay(nowSec);
  return {
    nowSec,
    windowStart: nowSec - hours * 3600,
    window24h: nowSec - FLOW_DEFAULT_WINDOW_HOURS * 3600,
    window7d: nowSec - 7 * 24 * 3600,
    window30d: nowSec - 30 * 24 * 3600,
    window90d: nowSec - 90 * 24 * 3600,
    nowDayTs,
    baselineWindowStart: nowDayTs - BASELINE_WINDOW_DAYS * DAY_SECONDS,
  };
}

export async function fetchAggregateData(
  db: D1Database,
  params: AggregateQueryParams,
): Promise<AggregateData> {
  const trackedPairs = getMintBurnTrackedPairs(ACTIVE_MINT_BURN_CONFIGS);
  const trackedChainIds = [...new Set(ACTIVE_MINT_BURN_CONFIGS.map((config) => config.chain.chainId))];
  const chainInClause = buildInClause(trackedChainIds);
  const hourlyScanStart = Math.min(params.windowStart, params.window24h);
  const firstHourSeekStatements = buildMintBurnFirstHourSeekStatements(
    db,
    ACTIVE_MINT_BURN_CONFIGS.map((config) => ({
      stablecoinId: config.stablecoinId,
      chainId: config.chain.chainId,
    })),
    "flows",
  );
  const eventResultIndex = 5 + firstHourSeekStatements.length;

  const [batchResults, [lastBlocks, latestCronSnapshot]] = await Promise.all([
    db.batch([
      db
        .prepare(
           `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
                   /* pharos:mint-burn-flows:window-rows */
                   mint_volume_usd, burn_volume_usd, net_flow_usd
            FROM mint_burn_hourly INDEXED BY idx_mbh_ts
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
            ORDER BY hour_ts ASC`,
        )
        .bind(...chainInClause.binds, hourlyScanStart),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:net-7d */
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly INDEXED BY idx_mbh_ts
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(...chainInClause.binds, params.window7d),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:net-30d */
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly INDEXED BY idx_mbh_ts
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(...chainInClause.binds, params.window30d),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:net-90d */
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly INDEXED BY idx_mbh_ts
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ?
           GROUP BY stablecoin_id, chain_id`,
        )
        .bind(...chainInClause.binds, params.window90d),
      db
        .prepare(
          `SELECT stablecoin_id, chain_id,
                  /* pharos:mint-burn-flows:baseline-days */
                  (hour_ts / 86400) * 86400 as day_ts,
                  SUM(net_flow_usd) as daily_net,
                  SUM(mint_volume_usd + burn_volume_usd) as daily_abs
           FROM mint_burn_hourly INDEXED BY idx_mbh_ts
           WHERE chain_id IN (${chainInClause.sql}) AND hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, chain_id, day_ts`,
        )
        .bind(...chainInClause.binds, params.baselineWindowStart, params.nowDayTs),
      ...firstHourSeekStatements,
      db
        .prepare(
          `SELECT id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
                  counterparty, tx_hash, block_number, timestamp, explorer_tx_url
           FROM mint_burn_events
           WHERE chain_id IN (${chainInClause.sql})
             AND timestamp >= ?
             AND (direction = 'mint' OR burn_type = 'effective_burn')
             AND flow_type = 'standard'
             AND amount_usd IS NOT NULL`,
        )
        .bind(...chainInClause.binds, params.window24h),
    ]),
    Promise.all([
      readMintBurnSyncStateBatch(db, ACTIVE_MINT_BURN_CONFIGS),
      readMintBurnCronSnapshot(db),
    ]),
  ]);

  const scannedHourlyRows = filterRowsToTrackedPairs((batchResults[0].results ?? []) as HourlyRow[], trackedPairs);
  const hourlyRows = filterRowsByWindow(scannedHourlyRows, params.windowStart);
  const hourly24hRows = filterRowsByWindow(scannedHourlyRows, params.window24h);
  const baselineRows = filterRowsToTrackedPairs((batchResults[4].results ?? []) as DailyBaselineRow[], trackedPairs);
  const firstSeenRows = filterRowsToTrackedPairs(
    batchResults
      .slice(5, eventResultIndex)
      .flatMap((result) => (result.results ?? []) as Array<FirstSeenRow & { first_hour_ts: number | null }>)
      .filter((row): row is FirstSeenRow => row.first_hour_ts != null),
    trackedPairs,
  );
  const largestEventRows = filterRowsToTrackedPairs(
    (batchResults[eventResultIndex]?.results ?? []) as EventRow[],
    trackedPairs,
  );
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
    net7dMap: buildGroupedNetFlowMap((batchResults[1].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    net30dMap: buildGroupedNetFlowMap((batchResults[2].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    net90dMap: buildGroupedNetFlowMap((batchResults[3].results ?? []) as GroupedNetFlowRow[], trackedPairs),
    baselineMap: buildBaselineMap(params.nowSec, baselineRows, firstSeenRows),
    largestEventMap: selectLargestEvents(largestEventRows),
    coverageMap: buildCoinCoverageMap(params.nowSec, firstSeenRows, lastBlocks, latestCronSnapshot.chainHeads),
    sync: buildMintBurnSyncHealth(params.nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status),
    latestSuccessfulSyncAt,
    freshnessLookupWarning,
  };
}

export function buildCoinSummaries(
  data: AggregateData,
  mcapById: Map<string, number>,
  gradeClassification: FlightToQualityClassification | null,
): { coins: CoinFlowSummary[]; gaugeInputs: Array<{ intensity: number | null; mcap: number }>; safeNet24h: number; riskyNet24h: number; trackedMcapUsd: number } {
  const coinAgg = aggregateHourlyRowsByStablecoin(data.hourly24hRows);
  const coins: CoinFlowSummary[] = [];
  const gaugeInputs: Array<{ intensity: number | null; mcap: number }> = [];
  let safeNet24h = 0;
  let riskyNet24h = 0;
  let trackedMcapUsd = 0;

  const seenCoinIds = new Set<string>();
  for (const config of ACTIVE_MINT_BURN_CONFIGS) {
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
      largestEvent24h: largest && largest.amount_usd != null
        ? { direction: largest.direction, amountUsd: largest.amount_usd, txHash: largest.tx_hash, timestamp: largest.timestamp }
        : null,
      coverage,
    });
  }

  return { coins, gaugeInputs, safeNet24h, riskyNet24h, trackedMcapUsd };
}

export function buildAggregateScope() {
  return buildMintBurnScope(ACTIVE_MINT_BURN_CONFIGS);
}
