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
import { isRecord } from "@shared/lib/type-guards";
import { safetyScoreV8PublicationIdentitiesMatch } from "@shared/lib/safety-score-v8-publication";
import { SafetyScoreV8PublicationIdentitySchema } from "@shared/types/safety-score-publication";
import {
  aggregateFlowCacheKey,
  aggregateHourlyRowsByChain,
  buildHourlyFlowSeries,
  cachedFlowFallbackResponse,
  finalizeMintBurnFlowResponse,
  type HourlyRow,
  MINT_BURN_CRON_JOB,
  perCoinFlowCacheKey,
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
  const reportCardCache = await loadReportCardCache(db, {
    maxAgeMs: REPORT_CARD_MAX_AGE_MS,
    requireCompleteness: true,
  });
  const classification = reportCardCache.kind === "ok"
    ? buildFlightToQualityClassification(reportCardCache.payload)
    : { kind: "unavailable" as const, reason: reportCardCache.reason };
  const gradeClassification = classification.kind === "ok" ? classification.classification : null;
  const classificationWarning = classification.kind === "ok"
    ? null
    : `Report-card FTQ classification unavailable (${classification.reason})`;
  const classificationSource = classification.kind === "ok" ? "report-card-cache" : "unavailable";
  const safetyScoreIdentity = classification.kind === "ok"
    ? classification.classification.safetyScoreIdentity
    : null;
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
      return reconcileCachedAggregateSafetyResponse(db, cached);
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
      safetyScoreIdentity,
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

function cachedAggregateUsesSafety(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.gauge)) return false;
  return payload.gauge.classificationSource === "report-card-cache"
    || payload.gauge.flightToQuality === true
    || payload.gauge.safetyScoreIdentity != null;
}

function cachedAggregateSafetyReason(
  payload: Record<string, unknown>,
  reportCardCache: Awaited<ReturnType<typeof loadReportCardCache>>,
): string | null {
  if (reportCardCache.kind !== "ok") return reportCardCache.reason;

  const classification = buildFlightToQualityClassification(reportCardCache.payload);
  if (classification.kind !== "ok") return classification.reason;

  const gauge = payload.gauge;
  if (!isRecord(gauge)) return "identity-missing";
  const cachedIdentity = SafetyScoreV8PublicationIdentitySchema.safeParse(gauge.safetyScoreIdentity);
  if (!cachedIdentity.success) return "identity-missing";
  return safetyScoreV8PublicationIdentitiesMatch(
    cachedIdentity.data,
    classification.classification.safetyScoreIdentity,
  )
    ? null
    : "identity-mismatch";
}

/**
 * Aggregate flow cache rows retain their FTQ cohort identity. A cache may be
 * served for flow freshness, but never with an FTQ decision from another
 * report-card publication.
 */
async function reconcileCachedAggregateSafetyResponse(
  db: D1Database,
  cached: { value: string; updatedAt: number },
): Promise<Response> {
  const fallback = cachedFlowFallbackResponse(cached);
  if (!fallback.ok) return fallback;

  let payload: unknown;
  try {
    payload = JSON.parse(cached.value) as unknown;
  } catch {
    return fallback;
  }
  if (!cachedAggregateUsesSafety(payload) || !isRecord(payload)) return fallback;

  let reason: string | null;
  try {
    const reportCardCache = await loadReportCardCache(db, {
      maxAgeMs: REPORT_CARD_MAX_AGE_MS,
      requireCompleteness: true,
    });
    reason = cachedAggregateSafetyReason(payload, reportCardCache);
  } catch (error) {
    console.warn(
      "[mint-burn-flows] Failed to validate cached FTQ classification:",
      error instanceof Error ? error.message : error,
    );
    reason = "cache-read-failed";
  }
  if (reason == null) return fallback;

  const gauge = isRecord(payload.gauge) ? payload.gauge : {};
  const warning = `Report-card FTQ classification unavailable (${reason})`;
  const sync = isRecord(payload.sync)
    ? {
        ...payload.sync,
        classificationWarning: appendSyncWarning(
          typeof payload.sync.classificationWarning === "string" ? payload.sync.classificationWarning : null,
          warning,
        ),
      }
    : payload.sync;
  const degraded = {
    ...payload,
    gauge: {
      ...gauge,
      flightToQuality: false,
      flightIntensity: 0,
      classificationSource: "unavailable",
      safetyScoreIdentity: null,
    },
    ...(isRecord(sync) ? { sync } : {}),
  };
  return new Response(JSON.stringify(degraded), {
    status: fallback.status,
    statusText: fallback.statusText,
    headers: new Headers(fallback.headers),
  });
}

async function handleAggregate(db: D1Database, hours: number): Promise<Response> {
  const cacheKey = aggregateFlowCacheKey(hours);
  const cached = await getCache(db, cacheKey);
  if (cached) return reconcileCachedAggregateSafetyResponse(db, cached);
  return withMintBurnFlowFallback(
    db,
    "aggregate",
    cacheKey,
    () => refreshAggregateMintBurnFlowCache(db, hours),
    (fallbackCached) => reconcileCachedAggregateSafetyResponse(db, fallbackCached),
  );
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
