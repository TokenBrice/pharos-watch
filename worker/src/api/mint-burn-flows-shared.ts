import { getCache, setCacheIfNewer } from "../lib/db-cache";
import { addFreshnessHeaders, jsonResponse, readCachedJsonOr503 } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC } from "../lib/mint-burn-health-config";
import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
import { decodeJsonString } from "../lib/cache-json";
import { logMalformedJsonPath } from "../lib/json-decode-observability";

export interface HourlyRow {
  stablecoin_id: string;
  chain_id: string;
  hour_ts: number;
  mint_count: number;
  burn_count: number;
  mint_volume_usd: number;
  burn_volume_usd: number;
  net_flow_usd: number;
}

export interface DailyBaselineRow {
  stablecoin_id: string;
  day_ts: number;
  daily_net: number;
  daily_abs: number;
}

export interface FirstSeenRow {
  stablecoin_id: string;
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
export const FLOW_CACHE_PREFIX = "mint-burn-flows:v2";
export const ETHEREUM_CHAIN_ID = "ethereum";
export const FLOW_DEFAULT_WINDOW_HOURS = 24;
export const MINT_BURN_CRON_JOB = "sync-mint-burn";
const ETH_BLOCK_TIME_SEC = 12;
const WINDOW_24H_BLOCKS = Math.ceil(24 * 3600 / ETH_BLOCK_TIME_SEC);
const WINDOW_30D_BLOCKS = Math.ceil(30 * DAY_SECONDS / ETH_BLOCK_TIME_SEC);
const WINDOW_90D_BLOCKS = Math.ceil(90 * DAY_SECONDS / ETH_BLOCK_TIME_SEC);
const COVERAGE_LAG_GRACE_BLOCKS = 5_000;
const COVERAGE_LAG_THRESHOLD_BLOCKS = 10_000;

export interface MintBurnCronSnapshot {
  startedAt: number | null;
  status: string | null;
  chainHead: number | null;
}

export interface FlowAggregate {
  mintVolume: number;
  burnVolume: number;
  mintCount: number;
  burnCount: number;
  netFlow: number;
}

export function bucketDay(ts: number): number {
  return Math.floor(ts / DAY_SECONDS) * DAY_SECONDS;
}

export function aggregateFlowCacheKey(hours: number): string {
  return `${FLOW_CACHE_PREFIX}:aggregate:${hours}`;
}

export function perCoinFlowCacheKey(stablecoinId: string, hours: number): string {
  return `${FLOW_CACHE_PREFIX}:coin:${stablecoinId}:${hours}`;
}

function emptyFlowAggregate(): FlowAggregate {
  return {
    mintVolume: 0,
    burnVolume: 0,
    mintCount: 0,
    burnCount: 0,
    netFlow: 0,
  };
}

function addHourlyRowToAggregate(aggregate: FlowAggregate, row: HourlyRow): void {
  aggregate.mintVolume += row.mint_volume_usd;
  aggregate.burnVolume += row.burn_volume_usd;
  aggregate.mintCount += row.mint_count;
  aggregate.burnCount += row.burn_count;
  aggregate.netFlow += row.net_flow_usd;
}

export function aggregateHourlyRowsByStablecoin(rows: HourlyRow[]): Map<string, FlowAggregate> {
  const aggregates = new Map<string, FlowAggregate>();
  for (const row of rows) {
    const aggregate = aggregates.get(row.stablecoin_id) ?? emptyFlowAggregate();
    addHourlyRowToAggregate(aggregate, row);
    aggregates.set(row.stablecoin_id, aggregate);
  }
  return aggregates;
}

export function aggregateHourlyRowsByChain(rows: HourlyRow[]): Map<string, FlowAggregate> {
  const aggregates = new Map<string, FlowAggregate>();
  for (const row of rows) {
    const aggregate = aggregates.get(row.chain_id) ?? emptyFlowAggregate();
    addHourlyRowToAggregate(aggregate, row);
    aggregates.set(row.chain_id, aggregate);
  }
  return aggregates;
}

function aggregateHourlyRowsByTimestamp(rows: HourlyRow[]): Map<number, { net: number; mint: number; burn: number }> {
  const aggregates = new Map<number, { net: number; mint: number; burn: number }>();
  for (const row of rows) {
    const aggregate = aggregates.get(row.hour_ts) ?? { net: 0, mint: 0, burn: 0 };
    aggregate.net += row.net_flow_usd;
    aggregate.mint += row.mint_volume_usd;
    aggregate.burn += row.burn_volume_usd;
    aggregates.set(row.hour_ts, aggregate);
  }
  return aggregates;
}

export function buildHourlyFlowSeries(rows: HourlyRow[]): Array<{
  hourTs: number;
  netFlowUsd: number;
  mintVolumeUsd: number;
  burnVolumeUsd: number;
}> {
  return [...aggregateHourlyRowsByTimestamp(rows).entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, value]) => ({
      hourTs: ts,
      netFlowUsd: value.net,
      mintVolumeUsd: value.mint,
      burnVolumeUsd: value.burn,
    }));
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
  const summary = error instanceof Error ? error.message : String(error);
  console.error(
    `[mint-burn-flows] scope=${scope} event=live-query-failed cacheKey=${cacheKey} fallback=cache summary=${summary}`,
    error,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFinitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function resolveCachedFlowFreshnessTimestamp(
  payload: unknown,
  fallbackUpdatedAt: number,
): number {
  if (!isRecord(payload)) {
    logMalformedJsonPath({
      scope: "api",
      owner: "mint-burn-flows",
      context: "fallback-payload",
      reason: "invalid-shape",
      source: "cache:mint-burn-flows",
      updatedAt: fallbackUpdatedAt,
    });
    return fallbackUpdatedAt;
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

  const updatedAt = toFinitePositiveNumber(payload.updatedAt);
  if (updatedAt != null) {
    return updatedAt;
  }
  if ("updatedAt" in payload && payload.updatedAt != null) {
    logMalformedJsonPath({
      scope: "api",
      owner: "mint-burn-flows",
      context: "fallback-payload.updatedAt",
      reason: "invalid-shape",
      source: "cache:mint-burn-flows",
      updatedAt: fallbackUpdatedAt,
    });
  }

  return fallbackUpdatedAt;
}

function parseMintBurnCronMetadata(
  value: string | null,
  startedAt: number | null,
): { chainHead: number | null; reason: null | "missing" | "json-parse-failed" | "invalid-shape" } {
  const decoded = decodeJsonString<{ chainHead: number | null }, "missing" | "json-parse-failed" | "invalid-shape">(
    value,
    {
      mode: "best-effort",
      updatedAt: startedAt,
      missingReason: "missing",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        if (!isRecord(parsed)) {
          return { ok: false, reason: "invalid-shape" };
        }

        const chainHead = parsed.chainHead;
        if (chainHead == null) {
          return { ok: true, payload: { chainHead: null } };
        }
        if (typeof chainHead === "number" && Number.isFinite(chainHead)) {
          return { ok: true, payload: { chainHead } };
        }
        return { ok: false, reason: "invalid-shape" };
      },
    },
  );

  if (!decoded.ok) {
    return {
      chainHead: null,
      reason: decoded.reason,
    };
  }

  return {
    chainHead: decoded.payload.chainHead,
    reason: null,
  };
}

export function cachedFlowFallbackResponse(cached: { value: string; updatedAt: number }): Response {
  const parsed = readCachedJsonOr503<{
    sync?: { lastSuccessfulSyncAt?: number | null };
    updatedAt?: number;
  }>("mint-burn-flows", "mint-burn-flows", cached);
  if (!parsed.ok) {
    return parsed.response;
  }
  const freshnessTs = resolveCachedFlowFreshnessTimestamp(parsed.data, cached.updatedAt);

  const headers = addFreshnessHeaders({
    "Content-Type": "application/json",
    "Cache-Control": CACHE_PROFILES.standard,
  }, freshnessTs, MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC);
  return new Response(cached.value, { headers });
}

export async function finalizeMintBurnFlowResponse(
  db: D1Database,
  cacheKey: string,
  syncStartSec: number,
  body: unknown,
  freshnessTs: number,
): Promise<Response> {
  await setCacheIfNewer(db, cacheKey, JSON.stringify(body), syncStartSec);
  return jsonResponse(body, addFreshnessHeaders({
    "Cache-Control": CACHE_PROFILES.standard,
  }, freshnessTs, MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC));
}

export async function withMintBurnFlowFallback(
  db: D1Database,
  scope: "aggregate" | "per-coin",
  cacheKey: string,
  execute: () => Promise<Response>,
): Promise<Response> {
  try {
    return await execute();
  } catch (err) {
    const cached = await getCache(db, cacheKey);
    if (cached) {
      logMintBurnFallbackFailure(scope, cacheKey, err);
      return cachedFlowFallbackResponse(cached);
    }
    throw err;
  }
}

function compareLargestEventRows(a: EventRow, b: EventRow): number {
  const aValue = a.amount_usd ?? a.amount ?? 0;
  const bValue = b.amount_usd ?? b.amount ?? 0;
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

export async function readMintBurnCronSnapshot(db: D1Database): Promise<MintBurnCronSnapshot> {
  try {
    const row = await db
      .prepare(
        `SELECT started_at, status, metadata
         FROM cron_runs
         WHERE job = ?
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .bind(MINT_BURN_CRON_JOB)
      .first<{ started_at: number | null; status: string | null; metadata: string | null }>();

    if (!row) {
      return { startedAt: null, status: null, chainHead: null };
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
      startedAt: row.started_at ?? null,
      status: row.status ?? null,
      chainHead: metadata.chainHead,
    };
  } catch {
    return { startedAt: null, status: null, chainHead: null };
  }
}

export function buildBaselineMap(
  nowSec: number,
  dailyRows: DailyBaselineRow[],
  firstSeenRows: FirstSeenRow[],
): Map<string, { avgNet: number; avgAbs: number; dataDays: number }> {
  const nowDayTs = bucketDay(nowSec);
  const baselineEndDayTs = nowDayTs - DAY_SECONDS;
  const byCoinDay = new Map<string, Map<number, { net: number; abs: number }>>();

  for (const row of dailyRows) {
    if (!Number.isFinite(row.day_ts)) continue;
    const dayTs = bucketDay(row.day_ts);
    const perDay = byCoinDay.get(row.stablecoin_id) ?? new Map<number, { net: number; abs: number }>();
    const prev = perDay.get(dayTs) ?? { net: 0, abs: 0 };
    prev.net += row.daily_net;
    prev.abs += row.daily_abs;
    perDay.set(dayTs, prev);
    byCoinDay.set(row.stablecoin_id, perDay);
  }

  const baselineMap = new Map<string, { avgNet: number; avgAbs: number; dataDays: number }>();
  for (const row of firstSeenRows) {
    if (!Number.isFinite(row.first_hour_ts)) continue;
    const firstDayTs = bucketDay(row.first_hour_ts);
    if (firstDayTs > baselineEndDayTs) continue;

    const trackedDays = Math.floor((baselineEndDayTs - firstDayTs) / DAY_SECONDS) + 1;
    const dataDays = Math.max(0, Math.min(BASELINE_WINDOW_DAYS, trackedDays));
    if (dataDays === 0) continue;

    const startDayTs = baselineEndDayTs - (dataDays - 1) * DAY_SECONDS;
    const perDay = byCoinDay.get(row.stablecoin_id);
    let sumNet = 0;
    let sumAbs = 0;

    for (let dayTs = startDayTs; dayTs <= baselineEndDayTs; dayTs += DAY_SECONDS) {
      const bucket = perDay?.get(dayTs);
      if (!bucket) continue;
      sumNet += bucket.net;
      sumAbs += bucket.abs;
    }

    baselineMap.set(row.stablecoin_id, {
      avgNet: sumNet / dataDays,
      avgAbs: sumAbs / dataDays,
      dataDays,
    });
  }

  return baselineMap;
}

export function buildCoinCoverageMap(
  nowSec: number,
  firstSeenRows: FirstSeenRow[],
  lastBlocks: Map<string, number>,
  referenceHead: number | null,
) {
  const firstSeenMap = new Map(firstSeenRows.map((row) => [row.stablecoin_id, row.first_hour_ts]));
  const configsByCoin = new Map<string, typeof MINT_BURN_CONFIGS>();
  for (const config of MINT_BURN_CONFIGS) {
    if (config.chain.chainId !== ETHEREUM_CHAIN_ID) continue;
    const existing = configsByCoin.get(config.stablecoinId) ?? [];
    existing.push(config);
    configsByCoin.set(config.stablecoinId, existing);
  }

  const fallbackHead = referenceHead ?? Math.max(
    0,
    ...[...lastBlocks.values()].filter((value) => Number.isFinite(value)),
  );
  const effectiveHead = fallbackHead > 0 ? fallbackHead : null;

  const coverageMap = new Map<string, {
    startBlock: number;
    lastSyncedBlock: number | null;
    lagBlocks: number | null;
    historyStartAt: number | null;
    has24hWindow: boolean;
    has30dWindow: boolean;
    has90dWindow: boolean;
    isPartial: boolean;
    adapterKinds: string[];
    startBlockSource: string;
    startBlockConfidence: "high" | "medium" | "low";
    status: "full" | "partial-history" | "lagging" | "bootstrapping" | "disabled";
  }>();

  for (const [stablecoinId, configs] of configsByCoin) {
    const startBlock = Math.min(...configs.map((config) => config.startBlock));
    const lastSyncedBlock = Math.min(
      ...configs.map((config) => lastBlocks.get(`${config.chain.chainId}-${config.contractAddress}`) ?? (config.startBlock - 1)),
    );
    const historyStartAt = firstSeenMap.get(stablecoinId) ?? null;
    const disabled = configs.every((config) => config.enabled === false);
    const lagBlocks = effectiveHead != null ? Math.max(0, effectiveHead - lastSyncedBlock) : null;
    const adapterKinds = [...new Set(configs.map((config) => config.adapterKind))].sort();
    const startBlockSources = [...new Set(configs.map((config) => config.startBlockSource))].sort();
    const startBlockConfidence = configs.some((config) => config.startBlockConfidence === "low")
      ? "low"
      : configs.some((config) => config.startBlockConfidence === "medium")
      ? "medium"
      : "high";

    const has24hWindow = effectiveHead != null
      ? startBlock <= effectiveHead - WINDOW_24H_BLOCKS && lastSyncedBlock >= effectiveHead - COVERAGE_LAG_GRACE_BLOCKS
      : historyStartAt != null && historyStartAt <= nowSec - (24 * 3600);
    const has30dWindow = effectiveHead != null
      ? startBlock <= effectiveHead - WINDOW_30D_BLOCKS && lastSyncedBlock >= effectiveHead - COVERAGE_LAG_GRACE_BLOCKS
      : false;
    const has90dWindow = effectiveHead != null
      ? startBlock <= effectiveHead - WINDOW_90D_BLOCKS && lastSyncedBlock >= effectiveHead - COVERAGE_LAG_GRACE_BLOCKS
      : false;

    const status =
      disabled ? "disabled" :
      !has24hWindow || lastSyncedBlock < startBlock ? "bootstrapping" :
      lagBlocks != null && lagBlocks > COVERAGE_LAG_THRESHOLD_BLOCKS ? "lagging" :
      !has30dWindow ? "partial-history" :
      "full";

    coverageMap.set(stablecoinId, {
      startBlock,
      lastSyncedBlock,
      lagBlocks,
      historyStartAt,
      has24hWindow,
      has30dWindow,
      has90dWindow,
      isPartial: status !== "full",
      adapterKinds,
      startBlockSource: startBlockSources.length === 1 ? startBlockSources[0]! : "mixed",
      startBlockConfidence,
      status,
    });
  }

  return coverageMap;
}

export async function readCachedFlow(db: D1Database, key: string): Promise<{ value: string; updatedAt: number } | null> {
  return getCache(db, key);
}
