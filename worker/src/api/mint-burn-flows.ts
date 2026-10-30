import { logWorkerEventArgs } from "../lib/structured-log";
import { getCache } from "../lib/db-cache";
import { compactMintBurnPublication } from "../lib/mint-burn-publication";
import { resolveOrReject, parseQueryParams } from "../lib/api-params";
import { errorResponse } from "../lib/api-response";
import { getLatestSuccessfulCronTimestampResult } from "../lib/api-freshness";
import { buildMintBurnScope, getMintBurnConfigsForStablecoin } from "../lib/mint-burn-contracts";
import { buildMintBurnSyncHealth } from "../lib/mint-burn-health-config";
import {
  buildFlightToQualityCohorts,
  computeGaugeScore,
  detectFlightToQualityFromValuedNets,
  getGaugeBand,
  type ValuedNetFlow24h,
} from "../lib/mint-burn-scoring";
import { loadStablecoinsCache } from "../lib/stablecoins-cache";
import type { StablecoinData } from "@shared/types/market";
import { MINT_BURN_FTQ_DEPENDENCY_KEY, MintBurnFlowsResponseSchema } from "@shared/types/mint-burn";
import {
  addMintBurnValuationTally,
  emptyMintBurnValuationTally,
  resolveMintBurnValuation,
  summarizeMintBurnValuation,
} from "@shared/lib/mint-burn-valuation";
import { MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL } from "../lib/mint-burn-hourly-valuation";
import { decodeMintBurnScanCoverage, prepareMintBurnScanCoverage, type MintBurnScanSegment } from "../lib/mint-burn-pipeline/scan-coverage";
import { sumMcapForTrackedChains } from "../lib/mint-burn-mcap-weighting";
import {
  buildFlightToQualityClassificationFromV9Snapshot,
  type FlightToQualityClassification,
} from "../lib/flight-to-quality-classification";
import { buildInClause } from "../lib/db";
import { isRecord } from "@shared/lib/type-guards";
import { formatElapsedSeconds } from "@shared/lib/format";
import type { ApiDependencyMeta } from "@pharos/contracts/api-meta";
import { tryParseJson } from "../lib/json-parse";
import { logWorkerEvent } from "../lib/structured-log";
import { loadActiveSafetyScoreIndex } from "../lib/safety-score-index";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../lib/safety-score-v9/consumer-freshness";
import {
  aggregateFlowCacheKey,
  aggregateHourlyRowsByChain,
  buildHourlyFlowSeries,
  cachedFlowFallbackResponse,
  finalizeMintBurnFlowResponse,
  type HourlyRow,
  MINT_BURN_CRON_JOB,
  mintBurnHourlyWindow,
  mintBurnScanWindow,
  mintBurnWindowCoverage,
  readMintBurnWindowContext,
  perCoinFlowCacheKey,
  readMintBurnCronSnapshot,
  resolveFlowUpdatedAt,
  withMintBurnFlowFallback,
} from "../lib/mint-burn-flows-service";
import {
  appendSyncWarning,
  ACTIVE_MINT_BURN_CONFIGS,
  buildAggregateQueryParams,
  buildAggregateScope,
  buildCoinSummaries,
  fetchAggregateData,
} from "./mint-burn-flows/aggregate";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleMintBurnFlows = async (db: D1Database, url: URL): Promise<Response> => {
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
  };

// ---------------------------------------------------------------------------
// Aggregate mode (no stablecoin param)
// ---------------------------------------------------------------------------

export async function refreshAggregateMintBurnFlowCache(db: D1Database, hours: number): Promise<Response> {
  const cacheKey = aggregateFlowCacheKey(hours);
  const nowSec = Math.floor(Date.now() / 1000);
  const syncStartSec = nowSec;
  const params = buildAggregateQueryParams(nowSec, hours);

  const ftqSource = await loadAggregateFtqSource(db);
  const gradeClassification = ftqSource.classification;

  // Load stablecoins cache for mcap lookup. Only observed weights enter the map;
  // an absent id is an unavailable weight, counted by buildCoinSummaries.
  const mcapById = new Map<string, number>();
  const stablecoinsCacheResult = await loadStablecoinsCache(db, { mode: "lenient" });
  if (stablecoinsCacheResult.kind !== "ok") {
    const cached = await getCache(db, cacheKey);
    if (cached) {
      logWorkerEventArgs("api", "error",
        `[mint-burn-flows] stablecoins cache ${stablecoinsCacheResult.kind} (${stablecoinsCacheResult.reason}), serving fallback cache (${cacheKey})`,
      );
      return reconcileCachedAggregateSafetyResponse(db, cached);
    }
    return errorResponse(503, "Stablecoins data not yet available");
  }
  const data = await fetchAggregateData(db, params);
  const trackedIds = new Set(data.configs.map((config) => config.stablecoinId));
  for (const asset of stablecoinsCacheResult.payload.peggedAssets as StablecoinData[]) {
    if (trackedIds.has(asset.id)) {
      const mcap = sumMcapForTrackedChains(asset.id, asset.chainCirculating, asset.circulating, data.configs);
      if (mcap !== null) mcapById.set(asset.id, mcap);
    }
  }

  const {
    coins,
    gaugeInputs,
    flightToQuality,
    trackedMcapUsd,
    mcapUnavailableCoins,
    partialValuationInputs,
    partialValuationMcapUsd,
    scoredMcapUsd,
  } = buildCoinSummaries(
    data,
    mcapById,
    gradeClassification,
  );

  const gaugeScanCoverage = {
    ...mintBurnScanWindow(coins.length > 0 && coins.every((coin) => coin.coverage.has24hWindow)),
    ...(coins.some((coin) => coin.coverage.windows?.window24h.provenance === "legacy-pre-cutover")
      ? { provenance: "legacy-pre-cutover" as const } : {}),
    admittedCoins: coins.filter((coin) => coin.coverage.has24hWindow).length,
    excludedCoins: coins.filter((coin) => !coin.coverage.has24hWindow).length,
    excludedMcapUsd: coins.some((coin) => !coin.coverage.has24hWindow && coin.gaugeWeightUsd == null)
      ? null : coins.reduce((sum, coin) => sum + (!coin.coverage.has24hWindow ? coin.gaugeWeightUsd ?? 0 : 0), 0),
  };
  // Pre-T1 semantics: only admitted, scored, observed-weight members contribute.
  // There was no roster-weight quorum; incomplete membership remains explicit above.
  const gaugeScore = computeGaugeScore(gaugeInputs);
  const gaugeBand = gaugeScore !== null ? getGaugeBand(gaugeScore) : null;
  const hourly = buildHourlyFlowSeries(data.hourlyRows, (ts) =>
    mintBurnWindowCoverage(data.configs, data.scanSegments, data.legacy, ts, ts + 3600, data.watermark).complete);
  const updatedAt = resolveFlowUpdatedAt(data.hourlyRows, nowSec);
  // Per-chain 24h net flow over the same tracked-pair universe as `coins`, so
  // consumers of the published payload (daily digest) never re-derive a chain
  // breakdown from a different universe. A partial chain net is unavailable and
  // sorts after every published net.
  const chains = [...aggregateHourlyRowsByChain(data.hourly24hRows).entries()]
    .map(([chainId, aggregate]) => {
      const valuation = summarizeMintBurnValuation(aggregate.valuation).completeness;
      const scanCoverage = mintBurnWindowCoverage(
        data.configs.filter((config) => config.chain.chainId === chainId),
        data.scanSegments, data.legacy, data.windowEnd - 24 * 3600, data.windowEnd, data.watermark,
      );
      return { chainId, netFlow24hUsd: !scanCoverage.complete || valuation === "partial" ? null : aggregate.netFlow, valuation, scanCoverage };
    })
    .sort((a, b) => {
      if (a.netFlow24hUsd === null || b.netFlow24hUsd === null) {
        return Number(a.netFlow24hUsd === null) - Number(b.netFlow24hUsd === null);
      }
      return Math.abs(b.netFlow24hUsd) - Math.abs(a.netFlow24hUsd);
    });

  const body = {
    gauge: {
      score: gaugeScore,
      band: gaugeBand,
      intensitySemantics: "signed-v2",
      scoreScope: "admitted-coins",
      flightToQuality: flightToQuality?.active ?? null,
      flightIntensity: flightToQuality?.intensity ?? null,
      scanCoverage: gaugeScanCoverage,
      classificationSource: gradeClassification ? "safety-score-v9-publication" : "unavailable",
      safetyScoreIdentity: gradeClassification?.safetyScoreIdentity ?? null,
      trackedCoins: coins.length,
      trackedMcapUsd,
      mcapUnavailableCoins,
      partialValuationInputs,
      partialValuationMcapUsd,
      scoredMcapUsd,
    },
    coins,
    chains,
    hourly,
    updatedAt,
    windowHours: hours,
    window: { ...mintBurnHourlyWindow(data.windowEnd, hours), watermark: data.watermark },
    scope: buildAggregateScope(data.configs),
    publication: compactMintBurnPublication(data.publication),
    sync: {
      ...data.sync,
      warning: appendSyncWarning(data.sync.warning, data.freshnessLookupWarning),
      classificationWarning: null,
    },
  };

  return finalizeMintBurnFlowResponse(
    db, cacheKey, syncStartSec, applyAggregateFtqState(body, ftqSource), data.freshnessLookup, data.publicationPolicy,
  );
}

interface AggregateFtqSource {
  classification: FlightToQualityClassification | null;
  dependency: ApiDependencyMeta;
}

/** The compact accepted index is re-admitted on every read, including unavailable caches. */
async function loadAggregateFtqSource(db: D1Database): Promise<AggregateFtqSource> {
  let classification: FlightToQualityClassification | null = null;
  let reason: string | null = null;
  let updatedAt: number | null = null;
  let generationId: string | null = null;
  try {
    const active = await loadActiveSafetyScoreIndex(db);
    if (active.kind === "error") {
      reason = active.reason;
    } else {
      updatedAt = Number.isFinite(active.snapshot.updatedAt) && active.snapshot.updatedAt > 0
        ? active.snapshot.updatedAt : null;
      generationId = active.snapshot.safetyScoreIdentity.publicationGenerationId;
      const current = buildFlightToQualityClassificationFromV9Snapshot(active.snapshot);
      if (active.kind === "held") reason = "publication-held";
      else if (current.kind === "ok") classification = current.classification;
      else reason = current.reason;
    }
  } catch (error) {
    logWorkerEvent({
      scope: "api",
      level: "warn",
      event: "ftq_classification_load_failed",
      route: "mint-burn-flows",
      message: "Failed to load Safety Score FTQ classification",
      error,
    });
    reason = "cache-read-failed";
  }
  return {
    classification,
    dependency: {
      updatedAt,
      ageSeconds: updatedAt == null ? null : Math.floor(Date.now() / 1000) - updatedAt,
      generationId,
      freshBudgetSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
      status: classification ? "fresh" : reason === "source-stale" ? "stale" : "unavailable",
      reason,
    },
  };
}

function ftqClassificationWarning(reason: string | null): string | null {
  if (reason == null) return null;
  const budget = formatElapsedSeconds(SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC);
  const cause = reason === "source-stale"
    ? `the Safety Score source is outside its ${budget} freshness budget`
    : reason === "publication-held"
      ? `the Safety Score publication is held; its freshness budget is ${budget}`
      : reason === "cached-flow-contract-invalid"
        ? "the cached coin flow inputs are invalid"
        : `the Safety Score source could not be admitted; its freshness budget is ${budget}`;
  return `Flight-to-quality classification is unavailable because ${cause} (${reason}).`;
}

/** One availability/warning projection for materialized, cached and fallback responses. */
function applyAggregateFtqState(
  payload: Record<string, unknown>,
  source: AggregateFtqSource,
  reason: string | null = source.dependency.reason ?? null,
): Record<string, unknown> {
  const gauge = isRecord(payload.gauge) ? payload.gauge : {};
  const unavailable = reason != null;
  const warning = ftqClassificationWarning(reason);
  const meta = isRecord(payload._meta) ? payload._meta : {};
  return {
    ...payload,
    gauge: {
      ...gauge,
      ...(unavailable ? { flightToQuality: null, flightIntensity: null } : {}),
      classificationSource: unavailable ? "unavailable" : "safety-score-v9-publication",
      classificationReason: reason,
      safetyScoreIdentity: unavailable ? null : source.classification?.safetyScoreIdentity ?? null,
    },
    ...(isRecord(payload.sync) ? { sync: { ...payload.sync, classificationWarning: warning } } : {}),
    _meta: {
      ...meta,
      warning,
      dependencies: {
        ...(isRecord(meta.dependencies) ? meta.dependencies : {}),
        [MINT_BURN_FTQ_DEPENDENCY_KEY]: source.dependency,
      },
    },
  };
}

/**
 * Reclassifying stored coin nets never renews the flow generation. In particular,
 * an unavailable cached classification must recover without waiting for a flow write.
 */
async function reconcileCachedAggregateSafetyResponse(
  db: D1Database,
  cached: { value: string; updatedAt: number },
): Promise<Response> {
  const payload = tryParseJson(cached.value, { onFailure: () => undefined });
  if (!isRecord(payload) || !isRecord(payload.gauge)) return cachedFlowFallbackResponse(cached);
  const source = await loadAggregateFtqSource(db);
  let reason = source.dependency.reason ?? null;
  if (source.classification) {
    const coins = MintBurnFlowsResponseSchema.shape.coins.safeParse(payload.coins);
    if (!coins.success) {
      reason = "cached-flow-contract-invalid";
    } else {
      const flowsById = new Map<string, ValuedNetFlow24h>();
      for (const coin of coins.data) {
        flowsById.set(coin.stablecoinId, {
          knownNetUsd: coin.netFlow24hUsd,
          valuation: resolveMintBurnValuation(coin.valuation?.window24h),
        });
      }
      const ftq = detectFlightToQualityFromValuedNets(
        buildFlightToQualityCohorts(source.classification, flowsById),
      );
      payload.gauge = {
        ...payload.gauge,
        flightToQuality: ftq?.active ?? null,
        flightIntensity: ftq?.intensity ?? null,
      };
    }
  }
  return cachedFlowFallbackResponse({
    ...cached,
    value: JSON.stringify(applyAggregateFtqState(payload, source, reason)),
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

async function handlePerCoin(db: D1Database, stablecoinId: string, hours: number): Promise<Response> {
  const nowSec = Math.floor(Date.now() / 1000);
  const configured = getMintBurnConfigsForStablecoin(stablecoinId);
  if (configured.length === 0) {
    return errorResponse(404, `Stablecoin "${stablecoinId}" is not tracked for mint/burn flows`);
  }
  const cacheKey = perCoinFlowCacheKey(stablecoinId, hours);
  return withMintBurnFlowFallback(db, "per-coin", cacheKey, async () => {
    // Quarantined known coins retain detail history without joining the public aggregate.
    const roster = ACTIVE_MINT_BURN_CONFIGS.some((config) => config.stablecoinId === stablecoinId)
      ? ACTIVE_MINT_BURN_CONFIGS : configured;
    const context = await readMintBurnWindowContext(db, nowSec, roster);
    const configs = context.configs.filter((config) => config.stablecoinId === stablecoinId);
    const symbol = configured[0]!.symbol;
    const trackedChainIds = [...new Set(configs.map((config) => config.chain.chainId))];
    const chainInClause = trackedChainIds.length > 0 ? buildInClause(trackedChainIds) : { sql: "NULL", binds: [] };
    const syncStartSec = nowSec;
    const window = {
      ...mintBurnHourlyWindow(context.watermark.timestamp ?? nowSec, hours),
      watermark: context.watermark,
    };

    const [snapshot, latestCronSnapshot, latestSuccessfulSyncLookup] = await Promise.all([
      db.batch([
        db
        .prepare(
          `SELECT chain_id, hour_ts, ${MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL}
           FROM mint_burn_hourly
           WHERE chain_id IN (${chainInClause.sql}) AND stablecoin_id = ? AND hour_ts >= ? AND hour_ts < ?
           ORDER BY hour_ts ASC`,
        )
          .bind(...chainInClause.binds, stablecoinId, window.start, window.end),
        prepareMintBurnScanCoverage(db, configs, window.start, window.end),
      ]),
      readMintBurnCronSnapshot(db),
      getLatestSuccessfulCronTimestampResult(db, MINT_BURN_CRON_JOB),
    ]);

    const rows = (snapshot[0].results ?? []) as HourlyRow[];
    const scanSegments = decodeMintBurnScanCoverage(snapshot[1] as D1Result<MintBurnScanSegment>);
    const latestSuccessfulSyncAt = latestSuccessfulSyncLookup.timestamp;
    const freshnessLookupWarning =
      latestSuccessfulSyncLookup.status === "lookup_failed"
        ? "Mint/burn freshness lookup failed; producer observation is unavailable."
        : null;
    const sync = buildMintBurnSyncHealth(nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status);

    const scanCoverage = mintBurnWindowCoverage(configs, scanSegments, context.legacy, window.start, window.end, context.watermark);
    // Per-chain breakdown
    const chainMap = aggregateHourlyRowsByChain(rows);

    // Signed nets of a partial window are unavailable; volumes stay known subtotals.
    const chains = [...chainMap.entries()].map(([chainId, v]) => {
      const valuation = summarizeMintBurnValuation(v.valuation);
      const chainScanCoverage = mintBurnWindowCoverage(
        configs.filter((config) => config.chain.chainId === chainId), scanSegments, context.legacy, window.start, window.end, context.watermark,
      );
      return {
        chainId,
        mintVolumeUsd: v.mintVolume,
        burnVolumeUsd: v.burnVolume,
        mintCount: v.mintCount,
        burnCount: v.burnCount,
        netFlowUsd: !chainScanCoverage.complete || valuation.completeness === "partial" ? null : v.netFlow,
        valuation,
        scanCoverage: chainScanCoverage,
      };
    });

    const hourly = buildHourlyFlowSeries(rows, (ts) =>
      mintBurnWindowCoverage(configs, scanSegments, context.legacy, ts, ts + 3600, context.watermark).complete);

    // Totals
    let totalMint = 0;
    let totalBurn = 0;
    let totalMintCount = 0;
    let totalBurnCount = 0;
    const totalValuation = emptyMintBurnValuationTally();
    for (const c of chainMap.values()) {
      totalMint += c.mintVolume;
      totalBurn += c.burnVolume;
      totalMintCount += c.mintCount;
      totalBurnCount += c.burnCount;
      addMintBurnValuationTally(totalValuation, c.valuation);
    }

    const updatedAt = resolveFlowUpdatedAt(rows, nowSec);
    const valuation = summarizeMintBurnValuation(totalValuation);

    const body = {
      stablecoinId,
      symbol,
      publication: compactMintBurnPublication({ ...context.publication,
        legs: context.publication.legs.filter((leg) => leg.stablecoinId === stablecoinId) }),
      mintVolumeUsd: totalMint,
      burnVolumeUsd: totalBurn,
      netFlowUsd: !scanCoverage.complete || valuation.completeness === "partial" ? null : totalMint - totalBurn,
      mintCount: totalMintCount,
      burnCount: totalBurnCount,
      chains,
      hourly,
      valuation,
      scanCoverage,
      totalsSemantics: "observed-subtotals",
      updatedAt,
      windowHours: hours,
      window,
      scope: {
        chainIds: trackedChainIds,
        label: buildMintBurnScope(configs).label,
      },
      sync: {
        ...sync,
        warning: appendSyncWarning(sync.warning, freshnessLookupWarning),
      },
    };

    return finalizeMintBurnFlowResponse(db, cacheKey, syncStartSec, body, latestSuccessfulSyncLookup, context.policy);
  });
}
