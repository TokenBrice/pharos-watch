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
} from "../lib/mint-burn-contracts";
import { buildMintBurnSyncHealth } from "../lib/mint-burn-health-config";
import {
  computeGaugeScore,
  detectFlightToQuality,
  getGaugeBand,
} from "../lib/mint-burn-scoring";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import type { StablecoinData } from "@shared/types/market";
import { sumMcapForTrackedChains } from "../lib/mint-burn-mcap-weighting";
import { loadReportCardCache } from "../lib/report-card-cache";
import { buildFlightToQualityClassification } from "../lib/flight-to-quality-classification";
import { buildInClause } from "../lib/db";
import {
  aggregateFlowCacheKey,
  aggregateHourlyRowsByChain,
  buildHourlyFlowSeries,
  cachedFlowFallbackResponse,
  finalizeMintBurnFlowResponse,
  type HourlyRow,
  MINT_BURN_CRON_JOB,
  perCoinFlowCacheKey,
  readCachedMintBurnFlowResponse,
  readMintBurnCronSnapshot,
  resolveFlowUpdatedAt,
  withMintBurnFlowFallback,
} from "./mint-burn-flows-shared";
import {
  appendSyncWarning,
  buildAggregateQueryParams,
  buildAggregateScope,
  buildCoinSummaries,
  fetchAggregateData,
  REPORT_CARD_MAX_AGE_MS,
  TRACKED_IDS,
} from "./mint-burn-flows/aggregate";

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
// Aggregate mode (no stablecoin param)
// ---------------------------------------------------------------------------

export async function refreshAggregateMintBurnFlowCache(db: D1Database, hours: number): Promise<Response> {
  const cacheKey = aggregateFlowCacheKey(hours);
  const nowSec = Math.floor(Date.now() / 1000);
  const syncStartSec = nowSec;
  const params = buildAggregateQueryParams(nowSec, hours);

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
    if (TRACKED_IDS.has(asset.id)) {
      mcapById.set(asset.id, sumMcapForTrackedChains(asset.id, asset.chainCirculating, asset.circulating));
    }
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
      score: gaugeScore, band: gaugeBand, intensitySemantics: "signed-v2",
      flightToQuality: ftq.active, flightIntensity: ftq.intensity, classificationSource,
      trackedCoins: coins.length, trackedMcapUsd,
    },
    coins, hourly, updatedAt, windowHours: hours,
    scope: buildAggregateScope(),
    sync: {
      ...data.sync,
      warning: appendSyncWarning(data.sync.warning, data.freshnessLookupWarning),
      classificationWarning,
    },
  };

  return finalizeMintBurnFlowResponse(db, cacheKey, syncStartSec, body, data.latestSuccessfulSyncAt ?? 0);
}

async function handleAggregate(db: D1Database, hours: number): Promise<Response> {
  const cacheKey = aggregateFlowCacheKey(hours);
  const cached = await readCachedMintBurnFlowResponse(db, cacheKey);
  if (cached?.ok) return cached;
  return withMintBurnFlowFallback(db, "aggregate", cacheKey, () =>
    refreshAggregateMintBurnFlowCache(db, hours));
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

    const [hourlyResult, latestCronSnapshot, latestSuccessfulSyncLookup] = await Promise.all([
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
      getLatestSuccessfulCronTimestampResult(db, MINT_BURN_CRON_JOB),
    ]);

    const rows = hourlyResult.results ?? [];
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
