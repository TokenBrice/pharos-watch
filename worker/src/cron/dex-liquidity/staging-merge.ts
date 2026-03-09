import type { StagedPool } from "../dex-discovery/types";
import { stagedPoolConfidence, stagedPoolMaturityDays } from "../dex-discovery/types";
import { mergeCgPools, mergeGtPools } from "./fetch-crawlers";
import { getGtDexQuality } from "./pool-helpers";
import type { CgNewPool, GtNewPool, LiquidityMetrics } from "./types";

interface StagedPoolRow {
  pool_id: string;
  stablecoin_id: string;
  source: StagedPool["source"];
  chain: string;
  protocol: string;
  symbol: string;
  tvl_usd: number | null;
  volume_24h: number | null;
  fee_tier: number | null;
  balance_ratio: number | null;
  is_stable: number | boolean | null;
  base_token: string | null;
  quote_token: string | null;
  quote_symbol: string | null;
  price_usd: number | null;
  locked_liq_pct: number | null;
  discovered_at: number;
  refreshed_at: number;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBoolean(value: number | boolean | null): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return null;
}

function toStagedPool(row: StagedPoolRow): StagedPool {
  return {
    poolId: row.pool_id.toLowerCase(),
    stablecoinId: row.stablecoin_id,
    source: row.source,
    chain: row.chain,
    protocol: row.protocol,
    symbol: row.symbol,
    tvlUsd: toNumber(row.tvl_usd),
    volume24h: toNumber(row.volume_24h),
    feeTier: toNumber(row.fee_tier),
    balanceRatio: toNumber(row.balance_ratio),
    isStable: toBoolean(row.is_stable),
    baseToken: row.base_token,
    quoteToken: row.quote_token,
    quoteSymbol: row.quote_symbol,
    priceUsd: toNumber(row.price_usd),
    lockedLiqPct: toNumber(row.locked_liq_pct),
    rawJson: null,
    discoveredAt: toNumber(row.discovered_at) ?? 0,
    refreshedAt: toNumber(row.refreshed_at) ?? 0,
  };
}

function pushPool<T>(poolMap: Map<string, T[]>, stablecoinId: string, pool: T): void {
  const existing = poolMap.get(stablecoinId) ?? [];
  existing.push(pool);
  poolMap.set(stablecoinId, existing);
}

/**
 * Read staged pools from dex_pool_staging (refreshed within 24h),
 * convert to pool entries with confidence decay and defaults,
 * and merge into existing metrics.
 *
 * If the staging table doesn't exist yet (pre-migration), catches the D1 error
 * and returns zero counts gracefully.
 */
export async function mergeStagedPools(
  db: D1Database,
  metrics: Map<string, LiquidityMetrics>,
  knownPoolAddrs: Set<string>,
  nowSec: number,
): Promise<{ mergedCount: number; skippedCount: number }> {
  let rows: StagedPoolRow[];
  try {
    const result = await db
      .prepare(`SELECT pool_id, stablecoin_id, source, chain, protocol, symbol,
                       tvl_usd, volume_24h, fee_tier, balance_ratio, is_stable,
                       base_token, quote_token, quote_symbol, price_usd, locked_liq_pct,
                       discovered_at, refreshed_at
                FROM dex_pool_staging WHERE refreshed_at >= ?`)
      .bind(nowSec - 86400)
      .all<StagedPoolRow>();
    rows = result.results ?? [];
  } catch (err) {
    console.warn("[dex-liquidity] staging table read failed (pre-migration?):", err);
    return { mergedCount: 0, skippedCount: 0 };
  }

  const cgPoolMap = new Map<string, CgNewPool[]>();
  const gtPoolMap = new Map<string, GtNewPool[]>();
  let skippedCount = 0;

  for (const row of rows) {
    const stagedPool = toStagedPool(row);
    if (!stagedPool.poolId || !stagedPool.stablecoinId) continue;

    if (knownPoolAddrs.has(stagedPool.poolId)) {
      skippedCount++;
      continue;
    }

    const ageHours = (nowSec - stagedPool.refreshedAt) / 3600;
    const confidence = stagedPoolConfidence(ageHours);
    if (confidence === 0) continue;

    const adjustedTvl = (stagedPool.tvlUsd ?? 0) * confidence;
    const adjustedVolume = (stagedPool.volume24h ?? 0) * confidence;
    const qualityMultiplier = getGtDexQuality(stagedPool.protocol);
    const address = stagedPool.poolId.split(":")[1] ?? stagedPool.poolId;
    const maturityDays = stagedPoolMaturityDays(stagedPool.discoveredAt, nowSec);
    const poolType = stagedPool.isStable ? "stable" : "amm";

    if (stagedPool.source === "cg_onchain") {
      pushPool(cgPoolMap, stagedPool.stablecoinId, {
        address,
        chain: stagedPool.chain,
        dexId: stagedPool.protocol,
        name: stagedPool.symbol,
        tvlUsd: adjustedTvl,
        volume24hUsd: adjustedVolume,
        qualityMultiplier,
        maturityDays,
        poolType,
        price: stagedPool.priceUsd ?? 0,
        symbol: stagedPool.symbol,
        balanceRatio: stagedPool.balanceRatio,
        lockedLiquidityPct: stagedPool.lockedLiqPct,
        feePercentage: stagedPool.feeTier ? stagedPool.feeTier / 100 : null,
      });
      continue;
    }

    pushPool(gtPoolMap, stagedPool.stablecoinId, {
      address,
      chain: stagedPool.chain,
      dexId: stagedPool.protocol,
      name: stagedPool.symbol,
      tvlUsd: adjustedTvl,
      volume24hUsd: adjustedVolume,
      qualityMultiplier,
      maturityDays,
      poolType,
      price: stagedPool.priceUsd ?? 0,
      symbol: stagedPool.symbol,
    });
  }

  let mergedCount = 0;
  for (const pools of cgPoolMap.values()) mergedCount += pools.length;
  for (const pools of gtPoolMap.values()) mergedCount += pools.length;

  if (cgPoolMap.size > 0) mergeCgPools(metrics, cgPoolMap);
  if (gtPoolMap.size > 0) mergeGtPools(metrics, gtPoolMap);

  return { mergedCount, skippedCount };
}
