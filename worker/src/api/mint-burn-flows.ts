import { getCache } from "../lib/db-cache";
import { compactMintBurnPublication } from "../lib/mint-burn-publication";
import { resolveOrReject, parseQueryParams } from "../lib/api-params";
import { MINT_BURN_FLOWS_HOURS_QUERY } from "@shared/lib/api-endpoints/queries";
import { errorResponse } from "../lib/api-response";
import { getLatestSuccessfulCronTimestampResult } from "../lib/api-freshness";
import { buildMintBurnScope, getMintBurnConfigsForStablecoin } from "../lib/mint-burn-contracts";
import { buildMintBurnSyncHealth } from "../lib/mint-burn-health-config";
import {
  addMintBurnValuationTally,
  emptyMintBurnValuationTally,
  summarizeMintBurnValuation,
} from "@shared/lib/mint-burn-valuation";
import { addMintBurnClassificationTally, emptyMintBurnClassificationTally, summarizeMintBurnClassification } from "@shared/lib/mint-burn-classification";
import { MINT_BURN_HOURLY_BUCKET_COLUMNS_SQL } from "../lib/mint-burn-hourly-valuation";
import { decodeMintBurnScanCoverage, prepareMintBurnScanCoverage, type MintBurnScanSegment } from "../lib/mint-burn-pipeline/scan-coverage";
import { buildInClause } from "../lib/db";
import { hasMintBurnClassificationReview } from "../lib/mint-burn-classification";
import {
  aggregateFlowCacheKey,
  aggregateHourlyRowsByChain,
  buildHourlyFlowSeries,
  finalizeMintBurnFlowResponse,
  type HourlyRow,
  MINT_BURN_CRON_JOB,
  mintBurnHourlyWindow,
  mintBurnPairKey,
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
  refreshAggregateMintBurnFlowCache,
  reconcileCachedAggregateSafetyResponse,
} from "../lib/mint-burn-pipeline/flow-aggregate";

export { refreshAggregateMintBurnFlowCache } from "../lib/mint-burn-pipeline/flow-aggregate";

export const handleMintBurnFlows = async (db: D1Database, url: URL): Promise<Response> => {
    const params = url.searchParams;
    const stablecoinParam = params.get("stablecoin");
    const parsed = parseQueryParams(params, {
      hours: MINT_BURN_FLOWS_HOURS_QUERY,
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
    const hourlyConfigs = context.hourlyConfigs.filter((config) => config.stablecoinId === stablecoinId);
    const symbol = configured[0]!.symbol;
    const trackedChainIds = [...new Set(configs.map((config) => config.chain.chainId))];
    const hourlyChainIds = [...new Set(hourlyConfigs.map((config) => config.chain.chainId))];
    const chainInClause = hourlyChainIds.length > 0 ? buildInClause(hourlyChainIds) : { sql: "NULL", binds: [] };
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
        prepareMintBurnScanCoverage(db, hourlyConfigs, window.start, window.end),
      ]),
      readMintBurnCronSnapshot(db),
      getLatestSuccessfulCronTimestampResult(db, MINT_BURN_CRON_JOB),
    ]);

    const hourlyRows = ((snapshot[0].results ?? []) as HourlyRow[]).map((row) => ({ ...row, stablecoin_id: stablecoinId }));
    const rows = hourlyRows.filter((row) => trackedChainIds.includes(row.chain_id));
    const scanSegments = decodeMintBurnScanCoverage(snapshot[1] as D1Result<MintBurnScanSegment>);
    const latestSuccessfulSyncAt = latestSuccessfulSyncLookup.timestamp;
    const freshnessLookupWarning =
      latestSuccessfulSyncLookup.status === "lookup_failed"
        ? "Mint/burn freshness lookup failed; producer observation is unavailable."
        : null;
    const sync = buildMintBurnSyncHealth(nowSec, latestSuccessfulSyncAt, latestCronSnapshot.status);

    const scanCoverage = mintBurnWindowCoverage(configs, scanSegments, context.legacy, window.start, window.end, context.watermark);
    const chainMap = aggregateHourlyRowsByChain(rows);

    // Signed nets of a partial window are unavailable; volumes stay known subtotals.
    const chains = [...chainMap.entries()].map(([chainId, v]) => {
      const valuation = summarizeMintBurnValuation(v.valuation);
      const classification = summarizeMintBurnClassification(v.classification);
      const chainScanCoverage = mintBurnWindowCoverage(
        configs.filter((config) => config.chain.chainId === chainId), scanSegments, context.legacy, window.start, window.end, context.watermark,
      );
      return {
        chainId,
        mintVolumeUsd: v.mintVolume,
        burnVolumeUsd: v.burnVolume,
        mintCount: v.mintCount,
        burnCount: v.burnCount,
        netFlowUsd: !chainScanCoverage.complete || classification.completeness !== "complete" || valuation.completeness === "partial" ? null : v.netFlow,
        valuation,
        classification,
        scanCoverage: chainScanCoverage,
      };
    });

    const hourly = buildHourlyFlowSeries(hourlyRows, (ts) =>
      mintBurnWindowCoverage(hourlyConfigs, scanSegments, context.legacy, ts, ts + 3600, context.watermark),
      window, new Set(hourlyConfigs.filter((config) => hasMintBurnClassificationReview(config.stablecoinId))
        .map((config) => mintBurnPairKey(config.stablecoinId, config.chain.chainId))));

    let totalMint = 0;
    let totalBurn = 0;
    let totalMintCount = 0;
    let totalBurnCount = 0;
    const totalValuation = emptyMintBurnValuationTally();
    const totalClassification = emptyMintBurnClassificationTally();
    for (const c of chainMap.values()) {
      totalMint += c.mintVolume;
      totalBurn += c.burnVolume;
      totalMintCount += c.mintCount;
      totalBurnCount += c.burnCount;
      addMintBurnValuationTally(totalValuation, c.valuation);
      addMintBurnClassificationTally(totalClassification, c.classification);
    }

    const updatedAt = resolveFlowUpdatedAt(rows, nowSec);
    const valuation = summarizeMintBurnValuation(totalValuation);
    const classification = summarizeMintBurnClassification(totalClassification);

    const body = {
      stablecoinId,
      symbol,
      publication: compactMintBurnPublication({ ...context.publication,
        legs: context.publication.legs.filter((leg) => leg.stablecoinId === stablecoinId) }),
      mintVolumeUsd: totalMint,
      burnVolumeUsd: totalBurn,
      netFlowUsd: !scanCoverage.complete || classification.completeness !== "complete" || valuation.completeness === "partial" ? null : totalMint - totalBurn,
      mintCount: totalMintCount,
      burnCount: totalBurnCount,
      chains,
      hourly,
      valuation,
      classification,
      scanCoverage: context.partialCoinIds.has(stablecoinId) ? mintBurnScanWindow(false) : scanCoverage,
      totalsSemantics: "observed-subtotals",
      updatedAt,
      windowHours: hours,
      window,
      scope: {
        chainIds: trackedChainIds,
        label: buildMintBurnScope(configs).label,
      },
      hourlyScope: buildMintBurnScope(hourlyConfigs),
      sync: {
        ...sync,
        warning: appendSyncWarning(sync.warning, freshnessLookupWarning),
      },
    };

    return finalizeMintBurnFlowResponse(db, cacheKey, syncStartSec, body, latestSuccessfulSyncLookup, context.policy);
  });
}
