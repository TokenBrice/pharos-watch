import { logWorkerEventArgs } from "./structured-log";
import { getCache, setCacheIfNewer } from "./db-cache";
import { buildCronFreshnessHeaders, buildCronFreshnessMeta, type CronTimestampLookupResult } from "./api-freshness";
import { jsonResponse, jsonResponseWithHeaders } from "./api-response";
import { readCachedJsonOr503 } from "./api-cache-read";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC } from "./mint-burn-health-config";
import { getCacheRatioThresholds } from "@shared/lib/status-thresholds";

/** Same effective fresh budget returned by buildCronFreshnessMeta, not its base cadence. */
export const MINT_BURN_WATERMARK_MAX_AGE_SEC =
  MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC * getCacheRatioThresholds("cron-output").degraded;
import { MINT_BURN_CONFIGS, type MintBurnContractConfig } from "./mint-burn-contracts";
import { decodeJsonString } from "./cache-json";
import { logMalformedJsonPath } from "./json-decode-observability";
import { toErrorMessage } from "@shared/lib/error-utils";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { CHAIN_META } from "@shared/types/chain-identity";
import {
  addMintBurnValuationTally,
  emptyMintBurnValuationTally,
  summarizeMintBurnValuation,
  tallyMintBurnHourlyBucket,
  type MintBurnValuationTally,
} from "@shared/lib/mint-burn-valuation";
import { MINT_BURN_FTQ_DEPENDENCY_KEY, type MintBurnCoinCoverage, type MintBurnScanWindow, type MintBurnValuationCompleteness, type MintBurnWatermark } from "@shared/types/mint-burn";
import { mintBurnScanCoverageAdmits, mintBurnWindowAdmits, buildMintBurnLegacySpans, decodeMintBurnScanCoverage, prepareMintBurnScanCoverage, prepareMintBurnLegacyEvidence, MINT_BURN_LEGACY_CUTOVER, type MintBurnLegacySpan, type MintBurnLegacyRow, type MintBurnScanSegment } from "./mint-burn-pipeline/scan-coverage";
import { mintBurnConfigKey } from "./mint-burn-pipeline/sync-state";
import { MINT_BURN_HOURLY_VALUATION_TALLY_SQL, type MintBurnValuationTallyRow, readMintBurnValuationTallyRow } from "./mint-burn-hourly-valuation";

import { FLOW_CACHE_PREFIX } from "./mint-burn-flow-cache-keys";
import {
  decodeMintBurnDisabledKeys, isGrandfatheredMintBurnConfig, mintBurnPreviouslyAdmitted, mintBurnPublicationDisabled, persistMintBurnAdmissions,
  prepareMintBurnAdmissions, prepareMintBurnPublicationPolicy, resolveMintBurnPublication,
  type MintBurnAdmissionRow,
} from "./mint-burn-publication";

export {
  aggregateFlowCacheKey,
  perCoinFlowCacheKey,
} from "./mint-burn-flow-cache-keys";

/** Closed UTC hours only: raw-event boundary fragments cannot be recovered after retention. */
export function mintBurnHourlyWindow(nowSec: number, hours: number) {
  const end = Math.floor(nowSec / 3600) * 3600;
  return { start: end - hours * 3600, end, semantics: "closed-utc-hours" as const };
}

export function resolveMintBurnWatermark(
  nowSec: number, configs: readonly MintBurnContractConfig[],
  segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  legacy: ReadonlyMap<string, MintBurnLegacySpan> = new Map(),
): MintBurnWatermark {
  if (configs.length === 0) return {
    timestamp: null, ageSec: null, maxAgeSec: MINT_BURN_WATERMARK_MAX_AGE_SEC,
    unavailableReason: "scan-watermark-unavailable",
  };
  let end = mintBurnHourlyWindow(nowSec, 1).end;
  for (const config of configs) {
    const key = mintBurnConfigKey(config);
    const rows = (segments.get(key) ?? []).filter((row) => row.dirty_hour_ts == null);
    const acceptedEnd = Math.max(legacy.get(key)?.end ?? 0, ...rows.map((row) => row.to_timestamp));
    if (acceptedEnd === 0) return {
      timestamp: null, ageSec: null, maxAgeSec: MINT_BURN_WATERMARK_MAX_AGE_SEC,
      unavailableReason: "scan-watermark-unavailable",
    };
    end = Math.min(end, Math.floor(acceptedEnd / 3600) * 3600);
  }
  // A rounded segment tail may land inside another source's gap. Search only the
  // already-authorized freshness horizon for a genuinely common complete hour.
  while (nowSec - end <= MINT_BURN_WATERMARK_MAX_AGE_SEC
    && !mintBurnWindowAdmits(configs, segments, legacy, end - 3600, end)) end -= 3600;
  const ageSec = Math.max(0, nowSec - end);
  return {
    timestamp: end, ageSec, maxAgeSec: MINT_BURN_WATERMARK_MAX_AGE_SEC,
    unavailableReason: ageSec > MINT_BURN_WATERMARK_MAX_AGE_SEC ? "scan-watermark-stale" : null,
  };
}

/** Select the admitted-roster frontier before querying buckets; callers re-read debt/proof
 * with their data snapshot, so a concurrent dirty-hour mark can never be admitted.
 */
export async function readMintBurnWindowContext(
  db: D1Database, nowSec: number, configs: readonly MintBurnContractConfig[],
) {
  const end = mintBurnHourlyWindow(nowSec, 1).end;
  const start = end - 90 * DAY_SECONDS - MINT_BURN_WATERMARK_MAX_AGE_SEC;
  const transitionActive = start < MINT_BURN_LEGACY_CUTOVER;
  const results = await db.batch([
    prepareMintBurnScanCoverage(db, configs, start, end),
    prepareMintBurnAdmissions(db),
    prepareMintBurnPublicationPolicy(db),
    ...(transitionActive ? [prepareMintBurnLegacyEvidence(db, configs)] : []),
  ]);
  const segments = decodeMintBurnScanCoverage(results[0] as D1Result<MintBurnScanSegment>);
  const legacy = transitionActive ? buildMintBurnLegacySpans(
    configs.filter(isGrandfatheredMintBurnConfig), results[3].results as MintBurnLegacyRow[], segments, expectedBlockTimeSec,
  ) : new Map<string, MintBurnLegacySpan>();
  const admissions = results[1].results as MintBurnAdmissionRow[];
  const policy = (results[2].results as Array<{ disabled_keys: string }>)[0]?.disabled_keys ?? "[]";
  const disabledKeys = decodeMintBurnDisabledKeys(policy);
  const existing = configs.filter((config) => !mintBurnPublicationDisabled(config, configs, admissions, disabledKeys)
    && mintBurnPreviouslyAdmitted(config, admissions));
  const current = resolveMintBurnWatermark(nowSec, existing, segments, legacy);
  // A new leg must cover the incumbent window, so admission cannot move its frontier backwards.
  const scope = resolveMintBurnPublication(configs, admissions, disabledKeys, segments, nowSec,
    current.unavailableReason == null ? current.timestamp! : end, MINT_BURN_WATERMARK_MAX_AGE_SEC);
  if (scope.newAdmissions.length > 0) {
    // Scan coverage alone cannot stop an unpriced joining leg from nulling an incumbent's nets.
    const candidateKeys = new Set(scope.newAdmissions.map((row) => row.config_key));
    const candidates = scope.configs.filter((config) => candidateKeys.has(mintBurnConfigKey(config)));
    const baseline = scope.newAdmissions[0];
    const valuation = await db.prepare(`SELECT stablecoin_id, chain_id, ${MINT_BURN_HOURLY_VALUATION_TALLY_SQL}
      FROM mint_burn_hourly WHERE (stablecoin_id, chain_id) IN (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
      ) AND hour_ts >= ? AND hour_ts < ? GROUP BY stablecoin_id, chain_id`)
      .bind(JSON.stringify(candidates.map((config) => [config.stablecoinId, config.chain.chainId])),
        baseline.baseline_from, baseline.baseline_to)
      .all<MintBurnValuationTallyRow & { stablecoin_id: string; chain_id: string }>();
    const incompletePairs = new Set(valuation.results.filter((row) =>
      summarizeMintBurnValuation(readMintBurnValuationTallyRow(row)).completeness !== "complete")
      .map((row) => `${row.stablecoin_id}|${row.chain_id}`));
    const blockedKeys = new Set(candidates.filter((config) => incompletePairs.has(`${config.stablecoinId}|${config.chain.chainId}`))
      .map(mintBurnConfigKey));
    scope.configs = scope.configs.filter((config) => !blockedKeys.has(mintBurnConfigKey(config)));
    scope.newAdmissions = scope.newAdmissions.filter((row) => !blockedKeys.has(row.config_key));
    for (const leg of scope.publication.legs) {
      if (!blockedKeys.has(leg.configKey)) continue;
      leg.status = "pending-admission";
      leg.reason = "valuation-incomplete";
      leg.admittedAt = null;
    }
  }
  await persistMintBurnAdmissions(db, scope.newAdmissions);
  return {
    watermark: resolveMintBurnWatermark(nowSec, scope.configs, segments, legacy),
    legacy,
    configs: scope.configs,
    publication: scope.publication,
    policy,
  };
}

export function mintBurnWindowCoverage(
  configs: readonly MintBurnContractConfig[], segments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  legacy: ReadonlyMap<string, MintBurnLegacySpan>, from: number, to: number,
  watermark?: MintBurnWatermark,
): MintBurnScanWindow {
  // Existing Pages readers accept only this reason; watermark carries the detail.
  if (watermark?.unavailableReason) return mintBurnScanWindow(false);
  const complete = mintBurnWindowAdmits(configs, segments, legacy, from, to);
  return {
    ...mintBurnScanWindow(complete),
    ...(complete ? { provenance: mintBurnScanCoverageAdmits(configs, segments, from, to)
      ? "durable-v2" as const : "legacy-pre-cutover" as const } : {}),
  };
}

export interface HourlyRow {
  stablecoin_id: string;
  chain_id: string;
  hour_ts: number;
  mint_count: number;
  burn_count: number;
  /** NULL: bucket aggregated before valuation coverage was recorded. */
  mint_unpriced_event_count: number | null;
  burn_unpriced_event_count: number | null;
  /** Known-valuation subtotals; exact only when the matching unpriced count is 0. */
  mint_volume_usd: number;
  burn_volume_usd: number;
  net_flow_usd: number;
}

export interface DailyBaselineRow extends MintBurnValuationTallyRow {
  stablecoin_id: string;
  chain_id: string;
  day_ts: number;
  daily_net: number;
  daily_abs: number;
}

export interface FirstSeenRow {
  stablecoin_id: string;
  chain_id: string;
  first_hour_ts: number;
}

export interface EventRow {
  id: string;
  stablecoin_id: string;
  symbol: string;
  chain_id: string;
  direction: string;
  amount: number;
  amount_usd: number | null;
  counterparty: string | null;
  tx_hash: string;
  block_number: number;
  timestamp: number;
  explorer_tx_url: string;
}

import { DAY_SECONDS } from "@shared/lib/time-constants";
export const BASELINE_WINDOW_DAYS = 30;
export const ETHEREUM_CHAIN_ID = "ethereum";
export const FLOW_DEFAULT_WINDOW_HOURS = 24;
export const MINT_BURN_AGGREGATE_PUBLISH_WINDOWS = [FLOW_DEFAULT_WINDOW_HOURS, 168] as const;
export const MINT_BURN_CRON_JOB = "sync-mint-burn";
const MINT_BURN_COVERAGE_LAG_MAX_BLOCKS = 10_000;
const MINT_BURN_EXPECTED_BLOCK_TIME_SEC_BY_EVM_CHAIN_ID: Readonly<Record<number, number>> = {
  1: 12,
  10: 2,
  56: 3,
  100: 5,
  137: 2,
  8453: 2,
  42161: 0.25,
  43114: 2,
};
// For registry-known EVM chains without a reviewed value, one second is a
// conservative coverage default: it may delay declaring a complete window,
// but cannot inflate one. IDs absent from the registry remain unknown.
const CONSERVATIVE_EVM_BLOCK_TIME_SEC = 1;

function expectedBlockTimeSec(chainId: string): number | null {
  const evmChainId = CHAIN_META[chainId]?.evmChainId;
  if (evmChainId == null) return null;
  return MINT_BURN_EXPECTED_BLOCK_TIME_SEC_BY_EVM_CHAIN_ID[evmChainId]
    ?? CONSERVATIVE_EVM_BLOCK_TIME_SEC;
}

function coverageLagThresholdBlocks(chainId: string): number | null {
  const blockTimeSec = expectedBlockTimeSec(chainId);
  if (blockTimeSec == null) return null;
  return Math.max(1, Math.min(
    MINT_BURN_COVERAGE_LAG_MAX_BLOCKS,
    Math.ceil(MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC / blockTimeSec),
  ));
}

export interface MintBurnCronSnapshot {
  startedAt: number | null;
  status: string | null;
  chainHead: number | null;
  chainHeads: Map<string, number>;
}

export interface MintBurnCronSnapshotResult {
  value: MintBurnCronSnapshot;
  error: unknown | null;
}

export interface FlowAggregate {
  mintVolume: number;
  burnVolume: number;
  mintCount: number;
  burnCount: number;
  netFlow: number;
  valuation: MintBurnValuationTally;
}

export function bucketDay(ts: number): number {
  return bucketUnixSecondsToUtcDay(ts);
}

function aggregateHourlyRowsBy<K>(rows: HourlyRow[], keyOf: (row: HourlyRow) => K): Map<K, FlowAggregate> {
  const aggregates = new Map<K, FlowAggregate>();
  for (const row of rows) {
    const key = keyOf(row);
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        mintVolume: 0,
        burnVolume: 0,
        mintCount: 0,
        burnCount: 0,
        netFlow: 0,
        valuation: emptyMintBurnValuationTally(),
      };
      aggregates.set(key, aggregate);
    }
    aggregate.mintVolume += row.mint_volume_usd;
    aggregate.burnVolume += row.burn_volume_usd;
    aggregate.mintCount += row.mint_count;
    aggregate.burnCount += row.burn_count;
    aggregate.netFlow += row.net_flow_usd;
    addMintBurnValuationTally(aggregate.valuation, tallyMintBurnHourlyBucket({
      mintCount: row.mint_count,
      burnCount: row.burn_count,
      unpricedMintEventCount: row.mint_unpriced_event_count,
      unpricedBurnEventCount: row.burn_unpriced_event_count,
    }));
  }
  return aggregates;
}

export function aggregateHourlyRowsByStablecoin(rows: HourlyRow[]): Map<string, FlowAggregate> {
  return aggregateHourlyRowsBy(rows, (row) => row.stablecoin_id);
}

export function aggregateHourlyRowsByChain(rows: HourlyRow[]): Map<string, FlowAggregate> {
  return aggregateHourlyRowsBy(rows, (row) => row.chain_id);
}

export function mintBurnScanWindow(complete: boolean): MintBurnScanWindow {
  return { complete, unavailableReason: complete ? null : "scan-coverage-incomplete" };
}

/**
 * Hourly series. A partial hour publishes `netFlowUsd: null` (a partial net is
 * not a bound); volumes stay known subtotals and `valuation` qualifies them.
 */
export function buildHourlyFlowSeries(rows: HourlyRow[], admitsHour: (hourTs: number) => boolean): Array<{
  hourTs: number;
  netFlowUsd: number | null;
  mintVolumeUsd: number;
  burnVolumeUsd: number;
  valuation: MintBurnValuationCompleteness;
  scanCoverage: MintBurnScanWindow;
}> {
  return [...aggregateHourlyRowsBy(rows, (row) => row.hour_ts).entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, value]) => {
      const valuation = summarizeMintBurnValuation(value.valuation).completeness;
      const scanCoverage = mintBurnScanWindow(admitsHour(ts));
      return {
        hourTs: ts,
        netFlowUsd: !scanCoverage.complete || valuation === "partial" ? null : value.netFlow,
        mintVolumeUsd: value.mintVolume,
        burnVolumeUsd: value.burnVolume,
        valuation,
        scanCoverage,
      };
    });
}

export function resolveFlowUpdatedAt(rows: HourlyRow[], fallbackTs: number): number {
  return rows.length > 0
    ? rows.reduce((maxTs, row) => Math.max(maxTs, row.hour_ts), -Infinity)
    : fallbackTs;
}

function logMintBurnFallbackFailure(
  scope: "aggregate" | "per-coin",
  cacheKey: string,
  error: unknown,
): void {
  const summary = toErrorMessage(error);
  logWorkerEventArgs("lib", "error",
    `[mint-burn-flows] scope=${scope} event=live-query-failed cacheKey=${cacheKey} fallback=cache summary=${summary}`,
    error,
  );
}

import { isRecord } from "@shared/lib/type-guards";

function toFinitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function mintBurnPairKey(stablecoinId: string, chainId: string): string {
  return `${stablecoinId}|${chainId}`;
}

function resolveCachedFlowFreshnessTimestamp(
  payload: unknown,
  fallbackUpdatedAt: number,
): number | null {
  if (!isRecord(payload)) {
    logMalformedJsonPath({
      scope: "api",
      owner: "mint-burn-flows",
      context: "fallback-payload",
      reason: "invalid-shape",
      source: "cache:mint-burn-flows",
      updatedAt: fallbackUpdatedAt,
    });
    return null;
  }

  const sync = payload.sync;
  if (sync != null) {
    if (!isRecord(sync)) {
      logMalformedJsonPath({
        scope: "api",
        owner: "mint-burn-flows",
        context: "fallback-payload.sync",
        reason: "invalid-shape",
        source: "cache:mint-burn-flows",
        updatedAt: fallbackUpdatedAt,
      });
    } else {
      const lastSuccessfulSyncAt = toFinitePositiveNumber(sync.lastSuccessfulSyncAt);
      if (lastSuccessfulSyncAt != null) {
        return lastSuccessfulSyncAt;
      }
      if (sync.lastSuccessfulSyncAt != null) {
        logMalformedJsonPath({
          scope: "api",
          owner: "mint-burn-flows",
          context: "fallback-payload.sync.lastSuccessfulSyncAt",
          reason: "invalid-shape",
          source: "cache:mint-burn-flows",
          updatedAt: fallbackUpdatedAt,
        });
      }
    }
  }

  return null;
}

function parseMintBurnCronMetadata(
  value: string | null,
  startedAt: number | null,
): {
  chainHead: number | null;
  chainHeads: Map<string, number>;
  reason: null | "missing" | "json-parse-failed" | "invalid-shape";
} {
  const decoded = decodeJsonString<{
    chainHead: number | null;
    chainHeads?: Record<string, number>;
  }, "missing" | "json-parse-failed" | "invalid-shape">(
    value,
    {
      updatedAt: startedAt,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!isRecord(parsed)) {
          return { ok: false, reason: "invalid-shape" };
        }

        const chainHead = parsed.chainHead;
        if (chainHead != null && (typeof chainHead !== "number" || !Number.isFinite(chainHead))) {
          return { ok: false, reason: "invalid-shape" };
        }

        const rawChainHeads = parsed.chainHeads;
        if (rawChainHeads != null && !isRecord(rawChainHeads)) {
          return { ok: false, reason: "invalid-shape" };
        }

        const chainHeads: Record<string, number> = {};
        if (rawChainHeads) {
          for (const [chainId, head] of Object.entries(rawChainHeads)) {
            if (typeof head !== "number" || !Number.isFinite(head)) {
              return { ok: false, reason: "invalid-shape" };
            }
            chainHeads[chainId] = head;
          }
        }

        if (chainHead != null && chainHeads[ETHEREUM_CHAIN_ID] == null) {
          chainHeads[ETHEREUM_CHAIN_ID] = chainHead;
        }

        return {
          ok: true,
          payload: {
            chainHead: chainHead ?? null,
            chainHeads,
          },
        };
      },
    },
  );

  if (!decoded.ok) {
    return {
      chainHead: null,
      chainHeads: new Map(),
      reason: decoded.reason,
    };
  }

  return {
    chainHead: decoded.payload.chainHead,
    chainHeads: new Map(Object.entries(decoded.payload.chainHeads ?? {})),
    reason: null,
  };
}


export function cachedFlowFallbackResponse(cached: { value: string; updatedAt: number }): Response {
  const parsed = readCachedJsonOr503<Record<string, unknown>>("mint-burn-flows", "mint-burn-flows", cached);
  if (!parsed.ok) {
    return parsed.response;
  }
  const window = isRecord(parsed.data.window) ? parsed.data.window : null;
  const watermark = isRecord(window?.watermark) ? window.watermark : null;
  if (typeof watermark?.timestamp === "number"
    && Math.floor(Date.now() / 1000) - watermark.timestamp > MINT_BURN_WATERMARK_MAX_AGE_SEC) {
    return jsonResponse({ error: "Mint/burn scan watermark is stale", reason: "scan-watermark-stale" }, { status: 503, noStore: true });
  }
  const timestamp = resolveCachedFlowFreshnessTimestamp(parsed.data, cached.updatedAt);
  const meta = isRecord(parsed.data._meta) ? parsed.data._meta : {};
  const freshness: CronTimestampLookupResult = {
    timestamp,
    status: meta.reason === "freshness-lookup-failed"
      ? "lookup_failed" : timestamp == null ? "missing" : "ok",
  };

  return buildMintBurnFlowResponse(parsed.data, freshness).response;
}

/** All response paths age the flow clock and expose the same optional FTQ advisory. */
function buildMintBurnFlowResponse(body: Record<string, unknown>, freshness: CronTimestampLookupResult) {
  const headers = new Headers(
    buildCronFreshnessHeaders(freshness, MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC, CACHE_PROFILES.standard),
  );
  const freshnessMeta = buildCronFreshnessMeta(freshness, MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC);
  headers.set("X-Data-Freshness", freshnessMeta.status);
  const meta = isRecord(body._meta) ? body._meta : {};
  const dependencies = isRecord(meta.dependencies) ? meta.dependencies : null;
  const sync = isRecord(body.sync) ? body.sync : null;
  // Only aggregate payloads carry this typed dependency. Per-coin responses do
  // not acquire a market-wide classification warning.
  const classificationWarning = typeof sync?.classificationWarning === "string"
    ? sync.classificationWarning : typeof meta.warning === "string" ? meta.warning : null;
  if (dependencies?.[MINT_BURN_FTQ_DEPENDENCY_KEY] && classificationWarning) {
    const warning = classificationWarning.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    headers.append("Warning", `199 - "${warning}"`);
  }
  const responseBody = {
    ...body,
    _meta: {
      ...freshnessMeta,
      ...(dependencies ? { dependencies } : {}),
      ...(headers.has("Warning") ? { warning: headers.get("Warning") } : {}),
    },
  };
  return {
    responseBody,
    response: jsonResponseWithHeaders(responseBody, Object.fromEntries(headers.entries())),
  };
}

export async function finalizeMintBurnFlowResponse(
  db: D1Database,
  cacheKey: string,
  syncStartSec: number,
  body: Record<string, unknown>,
  freshness: CronTimestampLookupResult,
  publicationPolicy?: string,
): Promise<Response> {
  const { responseBody, response } = buildMintBurnFlowResponse(body, freshness);
  if (publicationPolicy === undefined) {
    await setCacheIfNewer(db, cacheKey, JSON.stringify(responseBody), syncStartSec);
  } else {
    // A kill switch can race a slow producer. Its old scope must never restore the purged cache.
    const written = await db.prepare(`INSERT INTO cache (key, value, updated_at)
      SELECT ?, ?, ? WHERE COALESCE((SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1), '[]') = ?
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      WHERE cache.updated_at <= excluded.updated_at`)
      .bind(cacheKey, JSON.stringify(responseBody), syncStartSec, publicationPolicy).run();
    if (written.meta.changes === 0) {
      const current = await prepareMintBurnPublicationPolicy(db).first<{ disabled_keys: string }>();
      if ((current?.disabled_keys ?? "[]") !== publicationPolicy) {
        return jsonResponse({ error: "Mint/burn publication scope changed; retry", reason: "mint-burn-publication-scope-changed" }, { status: 503 });
      }
    }
  }
  return response;
}

export async function withMintBurnFlowFallback(
  db: D1Database,
  scope: "aggregate" | "per-coin",
  cacheKey: string,
  execute: () => Promise<Response>,
  formatCachedResponse: (cached: { value: string; updatedAt: number }) => Response | Promise<Response> = cachedFlowFallbackResponse,
): Promise<Response> {
  try {
    return await execute();
  } catch (err) {
    const cached = await getCache(db, cacheKey);
    if (cached) {
      logMintBurnFallbackFailure(scope, cacheKey, err);
      return formatCachedResponse(cached);
    }
    throw err;
  }
}

function compareLargestEventRows(a: EventRow, b: EventRow): number {
  const aValue = a.amount_usd ?? 0;
  const bValue = b.amount_usd ?? 0;
  if (aValue !== bValue) return bValue - aValue;
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  if (a.block_number !== b.block_number) return b.block_number - a.block_number;
  return b.id.localeCompare(a.id);
}

export function selectLargestEvents(rows: EventRow[]): Map<string, EventRow> {
  const bestByCoin = new Map<string, EventRow>();
  for (const row of rows) {
    const current = bestByCoin.get(row.stablecoin_id);
    if (!current || compareLargestEventRows(current, row) > 0) {
      bestByCoin.set(row.stablecoin_id, row);
    }
  }
  return bestByCoin;
}

function emptyMintBurnCronSnapshot(): MintBurnCronSnapshot {
  return { startedAt: null, status: null, chainHead: null, chainHeads: new Map() };
}

export async function readMintBurnCronSnapshotResult(
  db: D1Database,
  job = MINT_BURN_CRON_JOB,
): Promise<MintBurnCronSnapshotResult> {
  try {
    const row = await db
      .prepare(
        `SELECT started_at, status, metadata
         FROM cron_runs
         WHERE job = ?
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .bind(job)
      .first<{ started_at: number | null; status: string | null; metadata: string | null }>();

    if (!row) {
      return { value: emptyMintBurnCronSnapshot(), error: null };
    }

    const metadata = parseMintBurnCronMetadata(row.metadata, row.started_at ?? null);
    if (metadata.reason && metadata.reason !== "missing") {
      logMalformedJsonPath({
        scope: "api",
        owner: "mint-burn-flows",
        context: "cron_runs.metadata.chainHead",
        reason: metadata.reason,
        source: "cron_runs:sync-mint-burn",
        updatedAt: row.started_at ?? null,
      });
    }

    return {
      value: {
        startedAt: row.started_at ?? null,
        status: row.status ?? null,
        chainHead: metadata.chainHead,
        chainHeads: metadata.chainHeads,
      },
      error: null,
    };
  } catch (error) {
    logWorkerEventArgs(
      "lib",
      "error",
      `[mint-burn-flows] event=cron-snapshot-read-failed job=${job} summary=${toErrorMessage(error)}`,
      error,
    );
    return { value: emptyMintBurnCronSnapshot(), error };
  }
}

export async function readMintBurnCronSnapshot(
  db: D1Database,
  job = MINT_BURN_CRON_JOB,
): Promise<MintBurnCronSnapshot> {
  return (await readMintBurnCronSnapshotResult(db, job)).value;
}

export interface FlowBaseline {
  avgNet: number;
  avgAbs: number;
  dataDays: number;
  /** Valuation completeness of the baseline days: a partial baseline understates its known averages. */
  valuation: MintBurnValuationCompleteness;
}

export function buildBaselineMap(
  nowSec: number,
  dailyRows: DailyBaselineRow[],
  firstSeenRows: FirstSeenRow[],
): Map<string, FlowBaseline> {
  const nowDayTs = bucketDay(nowSec);
  const baselineEndDayTs = nowDayTs - DAY_SECONDS;
  const byCoinDay = new Map<string, Map<number, { net: number; abs: number; valuation: MintBurnValuationTally }>>();
  const firstSeenByCoin = new Map<string, number>();

  for (const row of dailyRows) {
    if (!Number.isFinite(row.day_ts)) continue;
    const dayTs = bucketDay(row.day_ts);
    const perDay = byCoinDay.get(row.stablecoin_id)
      ?? new Map<number, { net: number; abs: number; valuation: MintBurnValuationTally }>();
    const prev = perDay.get(dayTs) ?? { net: 0, abs: 0, valuation: emptyMintBurnValuationTally() };
    prev.net += row.daily_net;
    prev.abs += row.daily_abs;
    addMintBurnValuationTally(prev.valuation, readMintBurnValuationTallyRow(row));
    perDay.set(dayTs, prev);
    byCoinDay.set(row.stablecoin_id, perDay);
  }

  for (const row of firstSeenRows) {
    if (!Number.isFinite(row.first_hour_ts)) continue;
    const previous = firstSeenByCoin.get(row.stablecoin_id);
    if (previous == null || row.first_hour_ts < previous) {
      firstSeenByCoin.set(row.stablecoin_id, row.first_hour_ts);
    }
  }

  const baselineMap = new Map<string, FlowBaseline>();
  for (const [stablecoinId, firstHourTs] of firstSeenByCoin) {
    const firstDayTs = bucketDay(firstHourTs);
    if (firstDayTs > baselineEndDayTs) continue;

    const trackedDays = Math.floor((baselineEndDayTs - firstDayTs) / DAY_SECONDS) + 1;
    const dataDays = Math.max(0, Math.min(BASELINE_WINDOW_DAYS, trackedDays));
    if (dataDays === 0) continue;

    const startDayTs = baselineEndDayTs - (dataDays - 1) * DAY_SECONDS;
    const perDay = byCoinDay.get(stablecoinId);
    let sumNet = 0;
    let sumAbs = 0;
    const valuation = emptyMintBurnValuationTally();

    for (let dayTs = startDayTs; dayTs <= baselineEndDayTs; dayTs += DAY_SECONDS) {
      const bucket = perDay?.get(dayTs);
      if (!bucket) continue;
      sumNet += bucket.net;
      sumAbs += bucket.abs;
      addMintBurnValuationTally(valuation, bucket.valuation);
    }

    baselineMap.set(stablecoinId, {
      avgNet: sumNet / dataDays,
      avgAbs: sumAbs / dataDays,
      dataDays,
      valuation: summarizeMintBurnValuation(valuation).completeness,
    });
  }

  return baselineMap;
}

export function buildCoinCoverageMap(
  nowSec: number,
  scanSegments: ReadonlyMap<string, readonly MintBurnScanSegment[]>,
  lastBlocks: Map<string, number>,
  chainHeads: Map<string, number>,
  unavailableReason: "cron-snapshot-unavailable" | null = null,
  requiredConfigs: readonly MintBurnContractConfig[] = MINT_BURN_CONFIGS,
  legacy: ReadonlyMap<string, MintBurnLegacySpan> = new Map(),
  watermark?: MintBurnWatermark,
) {
  const end = mintBurnHourlyWindow(nowSec, 24).end;
  const configsByCoin = new Map<string, MintBurnContractConfig[]>();
  for (const config of requiredConfigs) {
    const existing = configsByCoin.get(config.stablecoinId) ?? [];
    existing.push(config);
    configsByCoin.set(config.stablecoinId, existing);
  }

  const coverageMap = new Map<string, MintBurnCoinCoverage & {
    windows: {
      window24h: MintBurnScanWindow;
      window7d: MintBurnScanWindow;
      window30d: MintBurnScanWindow;
      window90d: MintBurnScanWindow;
    };
  }>();

  for (const [stablecoinId, configs] of configsByCoin) {
    const startBlock = Math.min(...configs.map((config) => config.startBlock));
    const lastSyncedBlocks = configs.map((config) =>
      lastBlocks.get(`${config.chain.chainId}-${config.contractAddress}`) ?? (config.startBlock - 1),
    );
    const lastSyncedBlock = Math.min(...lastSyncedBlocks);
    // The newest continuous segment is history evidence only if every config reaches the window end.
    const starts = configs.map((config) => {
      const key = mintBurnConfigKey(config);
      const candidates = (scanSegments.get(key) ?? [])
        .filter((segment) => segment.dirty_hour_ts == null && segment.to_timestamp >= end)
        .map((segment) => segment.from_timestamp);
      const legacyStart = legacy.get(key)?.start;
      if (legacyStart != null && mintBurnWindowAdmits([config], scanSegments, legacy,
        Math.ceil(legacyStart / 3600) * 3600, end)) candidates.push(legacyStart);
      return candidates;
    });
    const historyStartAt = starts.every((values) => values.length > 0)
      ? Math.max(...starts.map((values) => Math.min(...values))) : null;
    const disabled = configs.every((config) => config.enabled === false);
    let hasUnknownChainHead = false;
    const measuredLags: Array<{ chainId: string; lagBlocks: number }> = [];
    for (const [index, config] of configs.entries()) {
      const head = chainHeads.get(config.chain.chainId);
      if (head == null) {
        hasUnknownChainHead = true;
        continue;
      }
      measuredLags.push({
        chainId: config.chain.chainId,
        lagBlocks: Math.max(0, head - lastSyncedBlocks[index]!),
      });
    }
    const lagValues = measuredLags.map((entry) => entry.lagBlocks);
    const lagBlocks = lagValues.length > 0 ? Math.max(...lagValues) : null;
    const adapterKinds = [...new Set(configs.map((config) => config.adapterKind))].sort();
    const startBlockSources = [...new Set(configs.map((config) => config.startBlockSource))].sort();
    const startBlockConfidence = configs.some((config) => config.startBlockConfidence === "low")
      ? "low"
      : configs.some((config) => config.startBlockConfidence === "medium")
      ? "medium"
      : "high";

    const windowCoverage = (days: number) => mintBurnWindowCoverage(
      configs, scanSegments, legacy, end - days * DAY_SECONDS, end, watermark,
    );
    const windows = {
      window24h: windowCoverage(1),
      window7d: windowCoverage(7),
      window30d: windowCoverage(30),
      window90d: windowCoverage(90),
    };
    const has24hWindow = windows.window24h.complete;
    const has7dWindow = windows.window7d.complete;
    const has30dWindow = windows.window30d.complete;
    const has90dWindow = windows.window90d.complete;

    const status =
      disabled ? "disabled" :
      !has24hWindow ? (historyStartAt == null ? "unknown" : "bootstrapping") :
      measuredLags.some((entry) => {
        const lagThreshold = coverageLagThresholdBlocks(entry.chainId);
        return lagThreshold != null && entry.lagBlocks > lagThreshold;
      }) ? "lagging" :
      hasUnknownChainHead ? "unknown" :
      !has30dWindow ? "partial-history" :
      "full";

    coverageMap.set(stablecoinId, {
      startBlock,
      lastSyncedBlock,
      lagBlocks,
      historyStartAt,
      has24hWindow,
      has7dWindow,
      windows,
      has30dWindow,
      has90dWindow,
      isPartial: status !== "full",
      adapterKinds,
      startBlockSource: startBlockSources.length === 1 ? startBlockSources[0]! : "mixed",
      startBlockConfidence,
      unavailableReason: unavailableReason ?? windows.window24h.unavailableReason,
      provenance: windows.window90d.provenance ?? windows.window30d.provenance ?? windows.window24h.provenance,
      status,
    });
  }

  return coverageMap;
}

export async function readCachedFlow(db: D1Database, key: string): Promise<{ value: string; updatedAt: number } | null> {
  return getCache(db, key);
}

/**
 * Purge cached mint-burn-flows API responses. Called from the cron at end
 * of a successful run so the next API call recomputes against fresh events.
 *
 * Range predicate (not LIKE) because the `cache` table's PRIMARY KEY on `key`
 * supports guaranteed index-range scans; LIKE 'prefix%' falls back to a full
 * scan on SQLite in some configurations.
 */
export async function invalidateMintBurnFlowCaches(
  db: D1Database,
  options: { includeAggregate?: boolean } = {},
): Promise<void> {
  // Prefix matches every key FLOW_CACHE_PREFIX writes
  // (`lib/mint-burn-flow-cache-keys.ts`); `\uffff`
  // is the largest UTF-16 code unit and safely bounds any future suffix.
  // `includeAggregate: false` narrows the purge to per-coin keys: the
  // aggregate rows carry the published Bank Run Gauge, which only the
  // critical lane's post-run sidecar republishes, so a lane without that
  // sidecar must leave the publication in place.
  const scope = options.includeAggregate === false
    ? `${FLOW_CACHE_PREFIX}:coin:`
    : `${FLOW_CACHE_PREFIX}:`;
  await db
    .prepare("DELETE FROM cache WHERE key >= ? AND key < ?")
    .bind(scope, `${scope}\uffff`)
    .run();
}
