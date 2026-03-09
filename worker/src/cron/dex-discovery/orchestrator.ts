import type { CronResult } from "../../lib/db";
import { throwIfAborted } from "../../lib/abort";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { DiscoveryMeta } from "./types";
import { DISCOVERY_TIERS } from "./types";
import { crawlCoin } from "./crawl-sources";
import {
  cleanupStaging,
  incrementRunSeq,
  readDiscoveryMeta,
  updateDiscoveryMeta,
  upsertStagedPools,
} from "./persistence";

export type EffectiveTier = "t1" | "t2" | "t3" | "dormant" | "skip";

interface LiquidityCoverageRow {
  stablecoin_id: string;
  pool_count: number | null;
  chain_count: number | null;
}

interface DiscoveryCoverage {
  poolCount: number;
  chainCount: number;
}

interface DiscoveryCandidate {
  stablecoinId: string;
  coinChains: Map<string, string>;
  meta: DiscoveryMeta | undefined;
}

function rethrowIfAborted(err: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) throw err;
}

function cadenceEligible(tier: Exclude<EffectiveTier, "skip">, runSeq: number): boolean {
  if (tier === "t1") return true;
  if (tier === "t2") return runSeq % DISCOVERY_TIERS.T2_MODULO === 0;
  return runSeq % DISCOVERY_TIERS.T3_MODULO === 0;
}

export function computeEffectiveTier(
  poolCount: number,
  chainCount: number,
  meta: DiscoveryMeta | undefined,
  runSeq: number,
  nowSec: number,
): EffectiveTier {
  let tier: Exclude<EffectiveTier, "skip">;

  if (poolCount === DISCOVERY_TIERS.T1_MAX_POOLS) {
    tier = "t1";
  } else if (poolCount <= DISCOVERY_TIERS.T2_MAX_POOLS || chainCount <= 1) {
    tier = "t2";
  } else {
    tier = "t3";
  }

  const misses = meta?.consecutiveMisses ?? 0;
  if (misses >= DISCOVERY_TIERS.BACKOFF_DORMANT_MISSES) {
    if ((meta?.lastCrawlAt ?? 0) > nowSec - DISCOVERY_TIERS.DORMANT_INTERVAL_SEC) {
      return "skip";
    }
    tier = "dormant";
  } else if (misses >= DISCOVERY_TIERS.BACKOFF_T3_MISSES) {
    tier = "t3";
  } else if (misses >= DISCOVERY_TIERS.BACKOFF_T2_MISSES) {
    tier = "t2";
  }

  return cadenceEligible(tier, runSeq) ? tier : "skip";
}

export function isEligibleThisRun(tier: EffectiveTier): boolean {
  return tier !== "skip";
}

export function compareDiscoveryMeta(
  a: Pick<DiscoveryMeta, "lastCrawlAt"> | undefined,
  b: Pick<DiscoveryMeta, "lastCrawlAt"> | undefined,
): number {
  const aLast = a?.lastCrawlAt ?? Number.NEGATIVE_INFINITY;
  const bLast = b?.lastCrawlAt ?? Number.NEGATIVE_INFINITY;
  return aLast - bLast;
}

async function readLiquidityCoverage(db: D1Database): Promise<Map<string, DiscoveryCoverage>> {
  const rows = await db
    .prepare(
      "SELECT stablecoin_id, pool_count, chain_count FROM dex_liquidity WHERE stablecoin_id != '__global__'",
    )
    .all<LiquidityCoverageRow>();

  const coverage = new Map<string, DiscoveryCoverage>();
  for (const row of rows.results ?? []) {
    coverage.set(row.stablecoin_id, {
      poolCount: row.pool_count ?? 0,
      chainCount: row.chain_count ?? 0,
    });
  }
  return coverage;
}

export async function syncDexDiscovery(
  db: D1Database,
  cgApiKey: string | null,
  signal?: AbortSignal,
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  let runSeq = 0;
  let coinsCrawled = 0;
  let poolsDiscovered = 0;
  let budgetExhausted = false;
  const failedCoins: string[] = [];
  const tierBreakdown = { t1: 0, t2: 0, t3: 0, dormant: 0, skipped: 0 };

  try {
    throwIfAborted(signal);

    const liquidityCoverage = await readLiquidityCoverage(db);
    const metaById = await readDiscoveryMeta(db);
    runSeq = await incrementRunSeq(db);

    const eligibleCoins: DiscoveryCandidate[] = [];
    for (const coin of TRACKED_STABLECOINS) {
      const coverage = liquidityCoverage.get(coin.id);
      const tier = computeEffectiveTier(
        coverage?.poolCount ?? 0,
        coverage?.chainCount ?? 0,
        metaById.get(coin.id),
        runSeq,
        nowSec,
      );

      if (tier === "skip") {
        tierBreakdown.skipped += 1;
        continue;
      }

      tierBreakdown[tier] += 1;
      eligibleCoins.push({
        stablecoinId: coin.id,
        coinChains: new Map((coin.contracts ?? []).map((contract) => [contract.chain, contract.address])),
        meta: metaById.get(coin.id),
      });
    }

    eligibleCoins.sort((a, b) => compareDiscoveryMeta(a.meta, b.meta));

    const deadlineMs = Date.now() + 13 * 60_000;
    const knownPoolIds = new Set<string>();

    for (const candidate of eligibleCoins) {
      throwIfAborted(signal);

      try {
        const result = await crawlCoin(
          candidate.stablecoinId,
          candidate.coinChains,
          cgApiKey,
          knownPoolIds,
          signal,
          deadlineMs,
        );

        await upsertStagedPools(db, result.pools);
        // TODO(phase-2): Persist result.priceObs to a staging table for DEX price cross-validation in the scoring cron
        await updateDiscoveryMeta(db, candidate.stablecoinId, result.pools.length, nowSec);

        for (const pool of result.pools) {
          knownPoolIds.add(pool.poolId);
        }

        coinsCrawled += 1;
        poolsDiscovered += result.pools.length;
      } catch (err) {
        rethrowIfAborted(err, signal);
        console.warn("[dex-discovery]", candidate.stablecoinId, err);
        failedCoins.push(candidate.stablecoinId);
        // Count crawl errors as misses so perpetually-failing coins get demoted
        // instead of staying at T1 and consuming budget every run.
        try {
          await updateDiscoveryMeta(db, candidate.stablecoinId, 0, nowSec);
        } catch { /* non-blocking */ }
      }

      if (Date.now() >= deadlineMs) {
        budgetExhausted = true;
        break;
      }
    }

    await cleanupStaging(db, nowSec);

    return {
      status: failedCoins.length > 0 ? "degraded" : "ok",
      itemCount: coinsCrawled,
      metadata: JSON.stringify({
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        budgetExhausted,
        runSeq,
        failedCoins,
      }),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[dex-discovery] fatal", err);
    return {
      status: "error",
      itemCount: coinsCrawled,
      metadata: JSON.stringify({
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        budgetExhausted,
        runSeq,
        failedCoins,
        error,
      }),
    };
  }
}
