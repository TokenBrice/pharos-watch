import { getCache } from "../lib/db";
import { addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC } from "../lib/mint-burn-health-config";
import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";

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

export const DAY_SEC = 86400;
export const BASELINE_WINDOW_DAYS = 30;
export const FLOW_CACHE_PREFIX = "mint-burn-flows:v2";
export const ETHEREUM_CHAIN_ID = "ethereum";
export const FLOW_DEFAULT_WINDOW_HOURS = 24;
export const MINT_BURN_CRON_JOB = "sync-mint-burn";
const ETH_BLOCK_TIME_SEC = 12;
const WINDOW_24H_BLOCKS = Math.ceil(24 * 3600 / ETH_BLOCK_TIME_SEC);
const WINDOW_30D_BLOCKS = Math.ceil(30 * DAY_SEC / ETH_BLOCK_TIME_SEC);
const WINDOW_90D_BLOCKS = Math.ceil(90 * DAY_SEC / ETH_BLOCK_TIME_SEC);
const COVERAGE_LAG_GRACE_BLOCKS = 5_000;
const COVERAGE_LAG_THRESHOLD_BLOCKS = 10_000;

export interface MintBurnCronSnapshot {
  startedAt: number | null;
  status: string | null;
  chainHead: number | null;
}

export function bucketDay(ts: number): number {
  return Math.floor(ts / DAY_SEC) * DAY_SEC;
}

export function aggregateFlowCacheKey(hours: number): string {
  return `${FLOW_CACHE_PREFIX}:aggregate:${hours}`;
}

export function perCoinFlowCacheKey(stablecoinId: string, hours: number): string {
  return `${FLOW_CACHE_PREFIX}:coin:${stablecoinId}:${hours}`;
}

export function cachedFlowFallbackResponse(cached: { value: string; updatedAt: number }): Response {
  let freshnessTs = cached.updatedAt;
  try {
    const parsed = JSON.parse(cached.value) as {
      sync?: { lastSuccessfulSyncAt?: number | null };
      updatedAt?: number;
    };
    freshnessTs = parsed.sync?.lastSuccessfulSyncAt ?? parsed.updatedAt ?? cached.updatedAt;
  } catch {
    freshnessTs = cached.updatedAt;
  }

  const headers = addFreshnessHeaders({
    "Content-Type": "application/json",
    "Cache-Control": CACHE_PROFILES.standard,
  }, freshnessTs, MINT_BURN_PUBLIC_FRESHNESS_MAX_AGE_SEC);
  return new Response(cached.value, { headers });
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

    let chainHead: number | null = null;
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as { chainHead?: unknown };
        const rawHead = parsed.chainHead;
        if (typeof rawHead === "number" && Number.isFinite(rawHead)) {
          chainHead = rawHead;
        }
      } catch {
        chainHead = null;
      }
    }

    return {
      startedAt: row.started_at ?? null,
      status: row.status ?? null,
      chainHead,
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
  const baselineEndDayTs = nowDayTs - DAY_SEC;
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

    const trackedDays = Math.floor((baselineEndDayTs - firstDayTs) / DAY_SEC) + 1;
    const dataDays = Math.max(0, Math.min(BASELINE_WINDOW_DAYS, trackedDays));
    if (dataDays === 0) continue;

    const startDayTs = baselineEndDayTs - (dataDays - 1) * DAY_SEC;
    const perDay = byCoinDay.get(row.stablecoin_id);
    let sumNet = 0;
    let sumAbs = 0;

    for (let dayTs = startDayTs; dayTs <= baselineEndDayTs; dayTs += DAY_SEC) {
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
      status,
    });
  }

  return coverageMap;
}

export async function readCachedFlow(db: D1Database, key: string): Promise<{ value: string; updatedAt: number } | null> {
  return getCache(db, key);
}
