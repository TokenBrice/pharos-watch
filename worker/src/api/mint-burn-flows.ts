import { getCache, setCacheIfNewer } from "../lib/db-cache";
import {
  withErrorHandler,
  addFreshnessHeaders,
  resolveOrReject,
  errorResponse,
  parseQueryParams,
  jsonResponse,
  getLatestSuccessfulCronTimestamp,
} from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
import { readMintBurnSyncStateBatch } from "../lib/mint-burn-pipeline/sync-state";
import {
  buildMintBurnSyncHealth,
  MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC,
} from "../lib/mint-burn-health-config";
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
  ETHEREUM_CHAIN_ID,
  type EventRow,
  type FirstSeenRow,
  FLOW_DEFAULT_WINDOW_HOURS,
  type HourlyRow,
  logMintBurnFallbackFailure,
  MINT_BURN_CRON_JOB,
  perCoinFlowCacheKey,
  readMintBurnCronSnapshot,
  resolveFlowUpdatedAt,
  selectLargestEvents,
} from "./mint-burn-flows-shared";

// ---------------------------------------------------------------------------
// Safe-haven classification (flight-to-quality)
// ---------------------------------------------------------------------------

/** All tracked stablecoin IDs from config */
const TRACKED_IDS = new Set(MINT_BURN_CONFIGS.map((c) => c.stablecoinId));

/** Max age for report card cache before FTQ classification is treated as unavailable (2 hours) */
const REPORT_CARD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleMintBurnFlows = withErrorHandler(
  "mint-burn-flows",
  async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
    const stablecoinParam = params.get("stablecoin");
    const parsed = parseQueryParams(params, {
      hours: { type: "int", default: 24, min: 1, max: 720 },
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
// Aggregate mode (no stablecoin param)
// ---------------------------------------------------------------------------

async function handleAggregate(db: D1Database, hours: number): Promise<Response> {
  const cacheKey = aggregateFlowCacheKey(hours);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const syncStartSec = nowSec;
    const windowStart = nowSec - hours * 3600;
    const window24h = nowSec - FLOW_DEFAULT_WINDOW_HOURS * 3600;
    const window7d  = nowSec - 7  * 24 * 3600;
    const window30d = nowSec - 30 * 24 * 3600;
    const window90d = nowSec - 90 * 24 * 3600;
    const nowDayTs = bucketDay(nowSec);
    const baselineWindowStart = nowDayTs - BASELINE_WINDOW_DAYS * DAY_SECONDS;

    // Load grade-based classification (FTQ disabled when cache unavailable; see classificationWarning)
    const reportCardCache = await loadReportCardCache(db, { maxAgeMs: REPORT_CARD_MAX_AGE_MS });
    const gradeClassification = reportCardCache.kind === "ok"
      ? buildFlightToQualityClassification(reportCardCache.payload)
      : null;

    // Load stablecoins cache for mcap lookup
    const mcapById = new Map<string, number>();
    const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
    if (stablecoinsCacheResult.kind !== "ok") {
      const cached = await getCache(db, cacheKey);
      if (cached) {
        console.error(
          `[mint-burn-flows] stablecoins cache ${stablecoinsCacheResult.kind} (${stablecoinsCacheResult.reason}), ` +
          `serving fallback cache (${cacheKey})`,
        );
        return cachedFlowFallbackResponse(cached);
      }
      return errorResponse(503, "Stablecoins data not yet available");
    }
    for (const asset of stablecoinsCacheResult.payload.peggedAssets as StablecoinData[]) {
      if (TRACKED_IDS.has(asset.id)) {
        mcapById.set(asset.id, sumPegBuckets(asset.circulating));
      }
    }
    const ethereumConfigs = MINT_BURN_CONFIGS.filter((config) => config.chain.chainId === ETHEREUM_CHAIN_ID);

    // Parallel queries:
    // - hourly data for requested chart window
    // - hourly data for canonical 24h coin/gauge summaries
    // - 7d/30d/90d net sums
    // - daily baseline rows excluding the current UTC day
    // - first-seen timestamps
    // - raw 24h event candidates for deterministic largest-event selection
    // - sync state / cron freshness inputs
    const [
      hourlyWindowResult,
      hourly24hResult,
      hourly7dResult,
      hourly30dResult,
      hourly90dResult,
      baselineDailyResult,
      firstSeenResult,
      largestEventsResult,
      lastBlocks,
      latestCronSnapshot,
      latestSuccessfulSyncAt,
    ] = await Promise.all([
      db
        .prepare(
           `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
                   mint_volume_usd, burn_volume_usd, net_flow_usd
            FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
            ORDER BY hour_ts ASC`,
        )
        .bind(ETHEREUM_CHAIN_ID, windowStart)
        .all<HourlyRow>(),
      db
        .prepare(
           `SELECT stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
                   mint_volume_usd, burn_volume_usd, net_flow_usd
            FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
            ORDER BY hour_ts ASC`,
        )
        .bind(ETHEREUM_CHAIN_ID, window24h)
        .all<HourlyRow>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID, window7d)
        .all<{ stablecoin_id: string; net_flow_usd: number }>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID, window30d)
        .all<{ stablecoin_id: string; net_flow_usd: number }>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  SUM(net_flow_usd) as net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID, window90d)
        .all<{ stablecoin_id: string; net_flow_usd: number }>(),
      db
        .prepare(
          `SELECT stablecoin_id,
                  (hour_ts / 86400) * 86400 as day_ts,
                  SUM(net_flow_usd) as daily_net,
                  SUM(mint_volume_usd + burn_volume_usd) as daily_abs
           FROM mint_burn_hourly
           WHERE chain_id = ? AND hour_ts >= ? AND hour_ts < ?
           GROUP BY stablecoin_id, day_ts`,
        )
        .bind(ETHEREUM_CHAIN_ID, baselineWindowStart, nowDayTs)
        .all<DailyBaselineRow>(),
      db
        .prepare(
          `SELECT stablecoin_id, MIN(hour_ts) as first_hour_ts
           FROM mint_burn_hourly
           WHERE chain_id = ?
           GROUP BY stablecoin_id`,
        )
        .bind(ETHEREUM_CHAIN_ID)
        .all<FirstSeenRow>(),
      db
        .prepare(
          `SELECT id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd,
                  counterparty, tx_hash, block_number, timestamp, explorer_tx_url
           FROM mint_burn_events
           WHERE chain_id = ?
             AND timestamp >= ?
             AND (direction = 'mint' OR burn_type = 'effective_burn')
             AND flow_type = 'standard'`,
        )
        .bind(ETHEREUM_CHAIN_ID, window24h)
        .all<EventRow>(),
      readMintBurnSyncStateBatch(db, ethereumConfigs),
      readMintBurnCronSnapshot(db),
      getLatestSuccessfulCronTimestamp(db, MINT_BURN_CRON_JOB, nowSec),
    ]);

    const hourlyRows = hourlyWindowResult.results ?? [];
    const hourly24hRows = hourly24hResult.results ?? [];
    const net7dMap  = new Map((hourly7dResult.results  ?? []).map((r) => [r.stablecoin_id, r.net_flow_usd]));
    const net30dMap = new Map((hourly30dResult.results ?? []).map((r) => [r.stablecoin_id, r.net_flow_usd]));
    const net90dMap = new Map((hourly90dResult.results ?? []).map((r) => [r.stablecoin_id, r.net_flow_usd]));
    const baselineMap = buildBaselineMap(
      nowSec,
      baselineDailyResult.results ?? [],
      firstSeenResult.results ?? [],
    );
    const largestEventMap = selectLargestEvents(largestEventsResult.results ?? []);
    const coverageMap = buildCoinCoverageMap(
      nowSec,
      firstSeenResult.results ?? [],
      lastBlocks,
      latestCronSnapshot.chainHead,
    );
    const sync = buildMintBurnSyncHealth(nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status);

    // Aggregate per-coin summaries from canonical 24h rows
    const coinAgg = aggregateHourlyRowsByStablecoin(hourly24hRows);

    // Compute FIS and build coin responses
    const coins: Array<{
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
    }> = [];

    const gaugeInputs: Array<{ intensity: number | null; mcap: number }> = [];
    let safeNet24h = 0;
    let riskyNet24h = 0;
    let trackedMcapUsd = 0;

    const classificationWarning = reportCardCache.kind === "ok"
      ? null
      : `Report-card FTQ classification unavailable (${reportCardCache.reason})`;
    const classificationSource = reportCardCache.kind === "ok" ? "report-card-cache" : "unavailable";
    if (classificationWarning) {
      console.warn(`[mint-burn-flows] ${classificationWarning}`);
    }

    const seenCoinIds = new Set<string>();
    for (const config of MINT_BURN_CONFIGS) {
      const id = config.stablecoinId;
      if (seenCoinIds.has(id)) continue;
      seenCoinIds.add(id);
      const agg = coinAgg.get(id);
      const baseline = baselineMap.get(id);
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
      const pressureShiftState = getPressureShiftState(pressureShiftScore);
      const netFlowDirection24h = getNetFlowDirection24h({
        netFlow24hUsd: netFlow24h,
        has24hActivity,
      });

      gaugeInputs.push({ intensity, mcap });

      if (gradeClassification) {
        // Grade-based: safe (>=65), risky (<50), neutral (50-64) ignored
        if (gradeClassification.safeIds.has(id)) {
          safeNet24h += netFlow24h;
        } else if (gradeClassification.riskyIds.has(id)) {
          riskyNet24h += netFlow24h;
        }
        // Neutral coins don't contribute to FTQ signal
      }

      const largest = largestEventMap.get(id);
      const coverage = coverageMap.get(id) ?? {
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
        pressureShiftState,
        netFlowDirection24h,
        has24hActivity,
        baselineDailyNetUsd: baseline?.avgNet ?? null,
        baselineDailyAbsUsd: baseline?.avgAbs ?? null,
        baselineDataDays: baseline?.dataDays ?? null,
        netFlow24hUsd: netFlow24h,
        mintVolume24hUsd: agg?.mintVolume ?? 0,
        burnVolume24hUsd: agg?.burnVolume ?? 0,
        mintCount24h: agg?.mintCount ?? 0,
        burnCount24h: agg?.burnCount ?? 0,
        netFlow7dUsd:  net7dMap.get(id)  ?? 0,
        netFlow30dUsd: net30dMap.get(id) ?? 0,
        netFlow90dUsd: net90dMap.get(id) ?? 0,
        largestEvent24h: largest
          ? {
              direction: largest.direction,
              amountUsd: largest.amount_usd ?? largest.amount,
              txHash: largest.tx_hash,
              timestamp: largest.timestamp,
            }
          : null,
        coverage,
      });
    }

    // Gauge score
    const gaugeScore = computeGaugeScore(gaugeInputs);
    const gaugeBand = gaugeScore !== null ? getGaugeBand(gaugeScore) : null;

    // Flight-to-quality
    const ftq = detectFlightToQuality({ safeNet24h, riskyNet24h });

    // Hourly timeseries (aggregate across all coins)
    const hourly = buildHourlyFlowSeries(hourlyRows);
    const updatedAt = resolveFlowUpdatedAt(hourlyRows, nowSec);

    const body = {
      gauge: {
        score: gaugeScore,
        band: gaugeBand?.label ?? null,
        intensitySemantics: "signed-v2",
        flightToQuality: ftq.active,
        flightIntensity: ftq.intensity,
        classificationSource,
        // Use deduped stablecoin count (configs can include multiple contracts/chains per coin).
        trackedCoins: coins.length,
        trackedMcapUsd,
      },
      coins,
      hourly,
      updatedAt,
      windowHours: hours,
      scope: {
        chainIds: [ETHEREUM_CHAIN_ID],
        label: "Ethereum-only",
      },
      sync: {
        ...sync,
        classificationWarning,
      },
    };

    await setCacheIfNewer(db, cacheKey, JSON.stringify(body), syncStartSec);
    return jsonResponse(body, addFreshnessHeaders({
      "Cache-Control": CACHE_PROFILES.standard,
    }, latestSuccessfulSyncAt, MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC));
  } catch (err) {
    const cached = await getCache(db, cacheKey);
    if (cached) {
      logMintBurnFallbackFailure("aggregate", cacheKey, err);
      return cachedFlowFallbackResponse(cached);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-coin mode (with stablecoin param)
// ---------------------------------------------------------------------------

async function handlePerCoin(
  db: D1Database,
  stablecoinId: string,
  hours: number,
): Promise<Response> {
  const config = MINT_BURN_CONFIGS.find((c) => c.stablecoinId === stablecoinId);
  if (!config) {
    return errorResponse(404, `Stablecoin "${stablecoinId}" is not tracked for mint/burn flows`);
  }

  const cacheKey = perCoinFlowCacheKey(stablecoinId, hours);
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const syncStartSec = nowSec;
    const windowStart = nowSec - hours * 3600;

    const [hourlyResult, latestCronSnapshot, latestSuccessfulSyncAt] = await Promise.all([
      db
        .prepare(
          `SELECT chain_id, hour_ts, mint_count, burn_count,
                  mint_volume_usd, burn_volume_usd, net_flow_usd
           FROM mint_burn_hourly
           WHERE chain_id = ? AND stablecoin_id = ? AND hour_ts >= ?
           ORDER BY hour_ts ASC`,
        )
        .bind(ETHEREUM_CHAIN_ID, stablecoinId, windowStart)
        .all<HourlyRow>(),
      readMintBurnCronSnapshot(db),
      getLatestSuccessfulCronTimestamp(db, MINT_BURN_CRON_JOB, nowSec),
    ]);

    const rows = hourlyResult.results ?? [];

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
      symbol: config.symbol,
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
        chainIds: [ETHEREUM_CHAIN_ID],
        label: "Ethereum-only",
      },
      sync: buildMintBurnSyncHealth(nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status),
    };

    await setCacheIfNewer(db, cacheKey, JSON.stringify(body), syncStartSec);
    return jsonResponse(body, addFreshnessHeaders({
      "Cache-Control": CACHE_PROFILES.standard,
    }, latestSuccessfulSyncAt, MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC));
  } catch (err) {
    const cached = await getCache(db, cacheKey);
    if (cached) {
      logMintBurnFallbackFailure("per-coin", cacheKey, err);
      return cachedFlowFallbackResponse(cached);
    }
    throw err;
  }
}
