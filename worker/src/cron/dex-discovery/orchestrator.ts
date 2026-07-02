import { recordCronFailure, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment } from "@shared/types/core";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { getTrackedContracts } from "../dex-liquidity/pool-helpers";
import { loadPriceValidationReferences } from "../../lib/price-validation";
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
import { toErrorMessage } from "../../lib/error-utils";

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
  tier: Exclude<EffectiveTier, "skip">;
  targets: ContractDeployment[];
  meta: DiscoveryMeta | undefined;
}

// Keep discovery comfortably below the wrapper timeout so partial staging runs
// degrade cleanly instead of dying mid-flight and leaving stale progress behind.
export const DEX_DISCOVERY_RUN_BUDGET_MS = 12 * 60_000;
const DEX_DISCOVERY_PER_COIN_BUDGET_MS = 25_000;
export const DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS = 20_000;

function summarizeDiscoveryError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    return `${name}${err.message}`.slice(0, 240);
  }
  return String(err).slice(0, 240);
}

function hasDiscoveryFinalizationWindow(deadlineMs: number): boolean {
  return Date.now() + DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS < deadlineMs;
}

function discoveryCohort(stablecoinId: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < stablecoinId.length; i++) {
    hash = (hash * 31 + stablecoinId.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function runCohort(runSeq: number, modulo: number): number {
  return ((runSeq % modulo) + modulo) % modulo;
}

function cadenceEligible(
  tier: Exclude<EffectiveTier, "skip">,
  runSeq: number,
  stablecoinId?: string,
): boolean {
  if (tier === "t1") return true;
  if (!stablecoinId) {
    if (tier === "t2") return runSeq % DISCOVERY_TIERS.T2_MODULO === 0;
    return runSeq % DISCOVERY_TIERS.T3_MODULO === 0;
  }

  const modulo = tier === "t2" ? DISCOVERY_TIERS.T2_MODULO : DISCOVERY_TIERS.T3_MODULO;
  return discoveryCohort(stablecoinId, modulo) === runCohort(runSeq, modulo);
}

export function computeEffectiveTier(
  stablecoinId: string,
  poolCount: number,
  chainCount: number,
  meta: DiscoveryMeta | undefined,
  runSeq: number,
  nowSec: number,
): EffectiveTier {
  let tier: Exclude<EffectiveTier, "skip">;

  // No pools discovered yet → highest crawl priority (priority inversion: zero means t1, not "empty").
  if (poolCount === DISCOVERY_TIERS.T1_ZERO_POOL_SENTINEL) {
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

  return cadenceEligible(tier, runSeq, stablecoinId) ? tier : "skip";
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

function discoveryTierPriority(tier: Exclude<EffectiveTier, "skip">): number {
  switch (tier) {
    case "t1":
      return 0;
    case "t2":
      return 1;
    case "t3":
      return 2;
    case "dormant":
      return 3;
  }
}

async function readLiquidityCoverage(db: D1Database): Promise<Map<string, DiscoveryCoverage>> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, pool_count, chain_count
       FROM dex_liquidity
       WHERE stablecoin_id != '__global__'
         AND ${DEX_LIQUIDITY_PUBLISHED_ROW_FILTER}`,
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
  onProgress?: CronProgressReporter,
): Promise<CronResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  let runSeq = 0;
  let coinsCrawled = 0;
  let poolsDiscovered = 0;
  let budgetExhausted = false;
  let stagingWritesSkippedForBudget = 0;
  let cleanupSkippedForBudget = false;
  const failedCoins: string[] = [];
  const failedCoinErrors: Record<string, string> = {};
  const tierBreakdown = { t1: 0, t2: 0, t3: 0, dormant: 0, skipped: 0 };
  const allUnresolvedChains = new Set<string>();
  const poolsBySource: Record<string, number> = {};

  try {
    throwIfAborted(signal);
    const validationReferences = await loadPriceValidationReferences(db);

    const liquidityCoverage = await readLiquidityCoverage(db);
    const metaById = await readDiscoveryMeta(db, signal);
    runSeq = await incrementRunSeq(db, signal);

    const eligibleCoins: DiscoveryCandidate[] = [];
    for (const coin of ACTIVE_STABLECOINS) {
      const coverage = liquidityCoverage.get(coin.id);
      const tier = computeEffectiveTier(
        coin.id,
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
        tier,
        targets: getTrackedContracts(coin),
        meta: metaById.get(coin.id),
      });
    }

    eligibleCoins.sort(
      (a, b) => discoveryTierPriority(a.tier) - discoveryTierPriority(b.tier) || compareDiscoveryMeta(a.meta, b.meta),
    );

    const deadlineMs = Date.now() + DEX_DISCOVERY_RUN_BUDGET_MS;
    const knownPoolIds = new Set<string>();
    await onProgress?.({
      stage: "queue-built",
      itemsDone: 0,
      itemsTotal: eligibleCoins.length,
      message: `Prepared ${eligibleCoins.length} eligible discovery candidate(s)`,
      metadata: {
        tierBreakdown,
        runSeq,
      },
    });

    for (let index = 0; index < eligibleCoins.length; index++) {
      const candidate = eligibleCoins[index];
      throwIfAborted(signal);
      if (!hasDiscoveryFinalizationWindow(deadlineMs)) {
        budgetExhausted = true;
        break;
      }
      await onProgress?.({
        stage: "crawl-coin",
        itemsDone: index,
        itemsTotal: eligibleCoins.length,
        message: `Crawling ${candidate.stablecoinId} (${candidate.tier})`,
        metadata: {
          runSeq,
          tier: candidate.tier,
          coinsCrawled,
          poolsDiscovered,
        },
      });

      try {
        const coinDeadline = Math.min(deadlineMs, Date.now() + DEX_DISCOVERY_PER_COIN_BUDGET_MS);
        const result = await crawlCoin(
          db,
          candidate.stablecoinId,
          candidate.targets,
          cgApiKey,
          knownPoolIds,
          signal,
          coinDeadline,
          validationReferences,
        );

        try {
          if (!hasDiscoveryFinalizationWindow(deadlineMs)) {
            budgetExhausted = true;
            stagingWritesSkippedForBudget += 1;
            break;
          }
          await upsertStagedPools(db, result.pools, signal);
          await updateDiscoveryMeta(db, candidate.stablecoinId, result.pools.length, nowSec, signal);

          coinsCrawled += 1;
          poolsDiscovered += result.pools.length;
          for (const chain of result.unresolvedChains) {
            allUnresolvedChains.add(chain);
          }
          for (const pool of result.pools) {
            poolsBySource[pool.source] = (poolsBySource[pool.source] ?? 0) + 1;
          }
        } catch (persistErr) {
          rethrowIfAborted(persistErr, signal);
          // Persistence failed but crawl succeeded — do NOT record miss (H-3)
          console.warn("[dex-discovery] Persistence failed for", candidate.stablecoinId, persistErr);
          failedCoins.push(candidate.stablecoinId);
          failedCoinErrors[candidate.stablecoinId] = summarizeDiscoveryError(persistErr);
        }
      } catch (err) {
        rethrowIfAborted(err, signal);
        console.warn("[dex-discovery]", candidate.stablecoinId, err);
        failedCoins.push(candidate.stablecoinId);
        failedCoinErrors[candidate.stablecoinId] = summarizeDiscoveryError(err);
        // Count crawl errors as misses so perpetually-failing coins get demoted
        // instead of staying at T1 and consuming budget every run.
        // Skip demotion for coins with existing pool coverage to avoid permanent
        // dormant state after transient crawl failures.
        const existingCoverage = liquidityCoverage.get(candidate.stablecoinId);
        if (!existingCoverage || existingCoverage.poolCount === 0) {
          try {
            await updateDiscoveryMeta(db, candidate.stablecoinId, 0, nowSec, signal);
          } catch (err) {
            console.warn(`[dex-discovery] Failed to update discovery meta for ${candidate.stablecoinId}: ${toErrorMessage(err)}`);
          }
        }
      }

      if (Date.now() >= deadlineMs) {
        budgetExhausted = true;
        break;
      }
    }

    if (hasDiscoveryFinalizationWindow(deadlineMs)) {
      await cleanupStaging(db, nowSec, signal);
    } else {
      cleanupSkippedForBudget = true;
      budgetExhausted = true;
    }
    await onProgress?.({
      stage: "complete",
      itemsDone: eligibleCoins.length,
      itemsTotal: eligibleCoins.length,
      message: "Completed DEX discovery sync",
      metadata: {
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        budgetExhausted,
        stagingWritesSkippedForBudget,
        cleanupSkippedForBudget,
        runSeq,
      },
    });

    return {
      status: failedCoins.length > 0 || budgetExhausted ? "degraded" : "ok",
      itemCount: coinsCrawled,
      metadata: JSON.stringify({
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        budgetExhausted,
        stagingWritesSkippedForBudget,
        cleanupSkippedForBudget,
        finalizationTailBudgetMs: DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS,
        runSeq,
        failedCoins,
        failedCoinErrors: Object.keys(failedCoinErrors).length > 0 ? failedCoinErrors : undefined,
        unresolvedChains: allUnresolvedChains.size > 0 ? [...allUnresolvedChains] : undefined,
        poolsBySource: Object.keys(poolsBySource).length > 0 ? poolsBySource : undefined,
      }),
    };
  } catch (err) {
    const error = toErrorMessage(err);
    recordCronFailure("dex-discovery", err, { metadata: { stage: "orchestrator", fatal: true, runSeq } });
    return {
      status: "error",
      itemCount: coinsCrawled,
      metadata: JSON.stringify({
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        budgetExhausted,
        stagingWritesSkippedForBudget,
        cleanupSkippedForBudget,
        finalizationTailBudgetMs: DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS,
        runSeq,
        failedCoins,
        failedCoinErrors: Object.keys(failedCoinErrors).length > 0 ? failedCoinErrors : undefined,
        unresolvedChains: allUnresolvedChains.size > 0 ? [...allUnresolvedChains] : undefined,
        poolsBySource: Object.keys(poolsBySource).length > 0 ? poolsBySource : undefined,
        error,
      }),
    };
  }
}
