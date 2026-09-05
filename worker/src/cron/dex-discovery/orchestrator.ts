import { logWorkerEventArgs } from "../../lib/structured-log";
import { recordCronFailure, type CronProgressReporter, type CronResult } from "../../lib/cron-logger";
import { rethrowIfAborted, throwIfAborted } from "../../lib/abort";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { WORKER_ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { ContractDeployment } from "@shared/types/core";
import { DEX_LIQUIDITY_PUBLISHED_ROW_FILTER } from "../../lib/dex-liquidity";
import { loadPriceValidationReferences } from "../../lib/price-validation";
import type { DiscoveryMeta } from "./types";
import { DISCOVERY_TIERS } from "./types";
import { crawlCoin } from "./crawl-sources";
import {
  createDexScreenerDiscoveryRunState,
  finalizeDexScreenerDiscoveryRun,
} from "./crawl-dexscreener-pools";
import {
  cleanupStaging,
  incrementRunSeq,
  readDiscoveryCensusSummaries,
  readDiscoveryMeta,
  readDiscoveryTargetCursors,
  recordDiscoveryAttemptFence,
  updateDiscoveryMeta,
  upsertStagedPools,
  writeDiscoveryTargetCursors,
  type DiscoveryCensusSummary,
} from "./persistence";
import {
  advanceDiscoveryTargetCursor,
  DEX_DISCOVERY_PER_COIN_BUDGET_MS,
  discoveryTargetCursorKey,
  selectDiscoveryTargetWindow,
  estimateDiscoverySweepWindowCount,
} from "./target-window";
import {
  buildFailedCrawlDeploymentOutcomes,
  buildStaticInaccessibleDeploymentOutcomes,
  upsertDexDeploymentOutcomes,
} from "./deployment-outcomes";
import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEvent } from "../../lib/structured-log";
import { getRuntimeDexDiscoveryProviders } from "./provider-registry";

export type EffectiveTier = "refresh" | "t1" | "t2" | "t3" | "dormant" | "skip";

interface LiquidityCoverageRow {
  stablecoin_id: string;
  pool_count: number | null;
  chain_count: number | null;
  has_supplemental_coverage?: number;
}

interface DiscoveryCoverage {
  poolCount: number;
  chainCount: number;
  hasSupplementalCoverage: boolean;
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

async function fenceFailedDiscoveryAttempt(
  db: D1Database,
  candidate: DiscoveryCandidate,
  deployments: readonly ContractDeployment[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<number> {
  let outcomesWritten = 0;
  try {
    outcomesWritten = await upsertDexDeploymentOutcomes(
      db,
      buildFailedCrawlDeploymentOutcomes({
        stablecoinId: candidate.stablecoinId,
        deployments,
        nowSec,
      }),
      signal,
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dex_discovery.failed_attempt_outcome_fence_failed",
      job: "sync-dex-discovery",
      message: `Failed to fence deployment outcomes for ${candidate.stablecoinId}`,
      error,
    });
  }
  try {
    await recordDiscoveryAttemptFence(
      db,
      candidate.stablecoinId,
      deployments,
      nowSec,
      signal,
    );
  } catch (error) {
    rethrowIfAborted(error, signal);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dex_discovery.failed_attempt_meta_fence_failed",
      job: "sync-dex-discovery",
      message: `Failed to record the discovery-attempt fence for ${candidate.stablecoinId}`,
      error,
    });
  }
  return outcomesWritten;
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
  if (tier === "t1" || tier === "refresh") return true;
  if (!stablecoinId) {
    if (tier === "t2") return runSeq % DISCOVERY_TIERS.T2_MODULO === 0;
    return runSeq % DISCOVERY_TIERS.T3_MODULO === 0;
  }

  const modulo = tier === "t2" ? DISCOVERY_TIERS.T2_MODULO : DISCOVERY_TIERS.T3_MODULO;
  return discoveryCohort(stablecoinId, modulo) === runCohort(runSeq, modulo);
}

/**
 * Does this coin's census already hold a complete, honest "no DEX pools
 * anywhere" answer for its provider-supported footprint?
 *
 * `updateDiscoveryMeta` counts every zero-pool crawl as a miss, so a footprint
 * whose correct answer is zero accrues misses forever. Left alone the backoff
 * ladder demotes it to dormant, whose 24h-plus per-window cadence is slower than
 * the census freshness bound (`resolveDexDeploymentCensusMaxAgeSec`, priced at
 * the t3 cadence plus headroom) — so a correct zero-pool answer decayed into a
 * permanently stale census. Chains with no registered discovery provider are
 * excluded because the census carries them as a standing unsupported remainder
 * rather than an unanswered deployment (owner ruling R1-D).
 */
export function hasVerifiedEmptyCensus(
  targets: readonly ContractDeployment[],
  summary: DiscoveryCensusSummary | undefined,
): boolean {
  if (!summary) return false;
  if (summary.observedPoolsCount > 0 || summary.providerSupportedInaccessibleCount > 0) return false;
  const supportedDeploymentCount = targets.filter(
    (target) => getRuntimeDexDiscoveryProviders(target.chain, target.address).length > 0,
  ).length;
  return supportedDeploymentCount > 0 && summary.verifiedNoPoolsCount >= supportedDeploymentCount;
}

export function computeEffectiveTier(
  stablecoinId: string,
  poolCount: number,
  chainCount: number,
  meta: DiscoveryMeta | undefined,
  runSeq: number,
  nowSec: number,
  censusVerifiedEmpty = false,
  supplementalRefreshDue = false,
): EffectiveTier {
  if (supplementalRefreshDue) return "refresh";
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
  // A footprint that has already answered "no pools anywhere" for every
  // provider-supported deployment keeps backing off to t3 but never falls to
  // dormant: t3 is the cadence the census freshness bound is priced at, so its
  // own correct answer can no longer age itself out of the reviewed scope.
  if (misses >= DISCOVERY_TIERS.BACKOFF_DORMANT_MISSES && !censusVerifiedEmpty) {
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
    case "refresh":
      return 0;
    case "t1":
      return 1;
    case "t2":
      return 2;
    case "t3":
      return 3;
    case "dormant":
      return 4;
  }
}

/** Refresh discovery evidence inside its lifetime, with an 18h sweep target.
 * Existing windows and the run deadline remain hard bounds; oversized footprints
 * get every existing tick rather than extending the evidence freshness window.
 */
export function isDiscoveryEvidenceRefreshDue(
  targets: readonly ContractDeployment[],
  meta: DiscoveryMeta | undefined,
  nowSec: number,
): boolean {
  const windows = Math.max(1, estimateDiscoverySweepWindowCount(targets));
  const tick = CRON_INTERVALS["sync-dex-discovery"];
  const interval = Math.max(tick, Math.floor((18 * 3600) / windows / tick) * tick);
  return meta == null || nowSec - meta.lastCrawlAt >= interval;
}

async function readLiquidityCoverage(db: D1Database): Promise<Map<string, DiscoveryCoverage>> {
  const rows = await db
    .prepare(
      `SELECT stablecoin_id, pool_count, chain_count,
         EXISTS (SELECT 1 FROM json_each(COALESCE(source_mix_json, '{}'))
           WHERE key NOT IN ('dl', 'direct_api') AND json_extract(value, '$.tvlUsd') > 0) AS has_supplemental_coverage
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
      hasSupplementalCoverage: row.has_supplemental_coverage === 1,
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
  let cleanup: Awaited<ReturnType<typeof cleanupStaging>> | null = null;
  let deploymentOutcomesWritten = 0;
  const failedCoins: string[] = [];
  const failedCoinErrors: Record<string, string> = {};
  const tierBreakdown = { refresh: 0, t1: 0, t2: 0, t3: 0, dormant: 0, skipped: 0 };
  // Coins the verified-empty census held above dormant this run. Observability
  // for the cadence rule: a green deploy proves nothing about a 20h cadence.
  let censusCadenceHolds = 0;
  let windowedCoins = 0;
  let windowedDeploymentsDeferred = 0;
  let targetCursors = new Map<string, string>();
  let targetCursorsChanged = false;
  const allUnresolvedChains = new Set<string>();
  const poolsBySource: Record<string, number> = {};
  const dexScreenerRunState = createDexScreenerDiscoveryRunState();
  const persistTargetCursors = async () => {
    if (!targetCursorsChanged) return;
    try {
      await writeDiscoveryTargetCursors(db, targetCursors, signal);
      targetCursorsChanged = false;
    } catch (err) {
      rethrowIfAborted(err, signal);
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "dex_discovery.target_cursor_write_failed",
        job: "sync-dex-discovery",
        message: "Failed to persist deployment-window resume markers",
        error: err,
      });
    }
  };
  const finalizeDexScreenerOutcome = async () => {
    try {
      await finalizeDexScreenerDiscoveryRun(db, dexScreenerRunState);
    } catch (err) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: "dex_discovery.dexscreener_outcome_failed",
        job: "sync-dex-discovery",
        provider: "dexscreener",
        message: "Failed to record DexScreener run outcome",
        error: err,
      });
    }
  };

  try {
    throwIfAborted(signal);
    const validationReferences = await loadPriceValidationReferences(db);
    deploymentOutcomesWritten += await upsertDexDeploymentOutcomes(
      db,
      buildStaticInaccessibleDeploymentOutcomes(nowSec),
      signal,
    );

    const liquidityCoverage = await readLiquidityCoverage(db);
    const metaById = await readDiscoveryMeta(db, signal);
    const censusById = await readDiscoveryCensusSummaries(db, signal);
    targetCursors = await readDiscoveryTargetCursors(db, signal);
    runSeq = await incrementRunSeq(db, signal);

    const eligibleCoins: DiscoveryCandidate[] = [];
    const activeIds = new Set<string>();
    for (const coin of WORKER_ACTIVE_STABLECOINS) {
      activeIds.add(coin.id);
      const coverage = liquidityCoverage.get(coin.id);
      const targets = [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])];
      const censusVerifiedEmpty = hasVerifiedEmptyCensus(targets, censusById.get(coin.id));
      if (
        censusVerifiedEmpty &&
        (metaById.get(coin.id)?.consecutiveMisses ?? 0) >= DISCOVERY_TIERS.BACKOFF_DORMANT_MISSES
      ) {
        censusCadenceHolds += 1;
      }
      const tier = computeEffectiveTier(
        coin.id,
        coverage?.poolCount ?? 0,
        coverage?.chainCount ?? 0,
        metaById.get(coin.id),
        runSeq,
        nowSec,
        censusVerifiedEmpty,
        (coverage?.hasSupplementalCoverage === true ||
          (coverage?.poolCount === 0 && targets.some((target) =>
            getRuntimeDexDiscoveryProviders(target.chain, target.address).length > 0))) &&
          isDiscoveryEvidenceRefreshDue(targets, metaById.get(coin.id), nowSec),
      );

      if (tier === "skip") {
        tierBreakdown.skipped += 1;
        continue;
      }

      tierBreakdown[tier] += 1;
      eligibleCoins.push({
        stablecoinId: coin.id,
        tier,
        targets,
        meta: metaById.get(coin.id),
      });
    }

    eligibleCoins.sort(
      (a, b) => discoveryTierPriority(a.tier) - discoveryTierPriority(b.tier) || compareDiscoveryMeta(a.meta, b.meta),
    );

    for (const stablecoinId of [...targetCursors.keys()]) {
      if (activeIds.has(stablecoinId)) continue;
      targetCursors.delete(stablecoinId);
      targetCursorsChanged = true;
    }

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

      // A footprint whose bounded provider queries cannot finish inside the
      // per-coin budget is crawled one resumable window at a time. Without this
      // the first stage consumed the whole budget every run and the chains only a
      // later stage can serve were never queried at all.
      const targetWindow = selectDiscoveryTargetWindow({
        targets: candidate.targets,
        cursor: targetCursors.get(candidate.stablecoinId),
        budgetMs: DEX_DISCOVERY_PER_COIN_BUDGET_MS,
      });
      if (targetWindow.windowed) {
        windowedCoins += 1;
        windowedDeploymentsDeferred += candidate.targets.length - targetWindow.targets.length;
      }

      try {
        // Persist the attempt boundary before any network work. If the crawl is
        // aborted, budget-discarded, or cannot persist its result, an older
        // verified-empty outcome is already superseded without changing
        // backoff counters.
        await recordDiscoveryAttemptFence(
          db,
          candidate.stablecoinId,
          targetWindow.targets,
          nowSec,
          signal,
        );
        const coinDeadline = Math.min(deadlineMs, Date.now() + DEX_DISCOVERY_PER_COIN_BUDGET_MS);
        const result = await crawlCoin(
          db,
          candidate.stablecoinId,
          targetWindow.targets,
          cgApiKey,
          knownPoolIds,
          signal,
          coinDeadline,
          validationReferences,
          dexScreenerRunState,
        );

        try {
          if (!hasDiscoveryFinalizationWindow(deadlineMs)) {
            budgetExhausted = true;
            stagingWritesSkippedForBudget += 1;
            break;
          }
          await upsertStagedPools(db, result.pools, signal);
          deploymentOutcomesWritten += await upsertDexDeploymentOutcomes(db, result.deploymentOutcomes, signal);
          await updateDiscoveryMeta(db, candidate.stablecoinId, result.pools.length, nowSec, signal);

          coinsCrawled += 1;
          poolsDiscovered += result.pools.length;
          if (targetWindow.windowed) {
            const nextCursor = advanceDiscoveryTargetCursor(
              targetWindow.targets,
              new Set(result.checkedDeploymentKeys ?? []),
            );
            if (nextCursor != null && targetCursors.get(candidate.stablecoinId) !== nextCursor) {
              targetCursors.set(candidate.stablecoinId, nextCursor);
              targetCursorsChanged = true;
            }
          } else if (targetCursors.delete(candidate.stablecoinId)) {
            targetCursorsChanged = true;
          }
          for (const chain of result.unresolvedChains) {
            allUnresolvedChains.add(chain);
          }
          for (const pool of result.pools) {
            poolsBySource[pool.source] = (poolsBySource[pool.source] ?? 0) + 1;
          }
        } catch (persistErr) {
          rethrowIfAborted(persistErr, signal);
          // Persistence failed but crawl succeeded — do NOT record miss (H-3)
          // or a provider-inaccessible outcome. The pre-crawl attempt fence
          // already supersedes old empty evidence and correctly leaves this as
          // a discovery deferral rather than mislabeling a D1 failure as a
          // provider outage.
          logWorkerEventArgs("handler", "warn", "[dex-discovery] Persistence failed for", candidate.stablecoinId, persistErr);
          failedCoins.push(candidate.stablecoinId);
          failedCoinErrors[candidate.stablecoinId] = summarizeDiscoveryError(persistErr);
        }
      } catch (err) {
        rethrowIfAborted(err, signal);
        logWorkerEventArgs("handler", "warn", "[dex-discovery]", candidate.stablecoinId, err);
        failedCoins.push(candidate.stablecoinId);
        failedCoinErrors[candidate.stablecoinId] = summarizeDiscoveryError(err);
        deploymentOutcomesWritten += await fenceFailedDiscoveryAttempt(
          db,
          candidate,
          targetWindow.targets,
          nowSec,
          signal,
        );
        // The window was attempted and fenced as inaccessible, so advance past it.
        // Holding the cursor here would let one failing window block the rest of
        // the footprint from ever being crawled again.
        const failedWindowCursor = targetWindow.windowed
          ? discoveryTargetCursorKey(targetWindow.targets[targetWindow.targets.length - 1]!)
          : null;
        if (failedWindowCursor != null && targetCursors.get(candidate.stablecoinId) !== failedWindowCursor) {
          targetCursors.set(candidate.stablecoinId, failedWindowCursor);
          targetCursorsChanged = true;
        }
        // Count crawl errors as misses so perpetually-failing coins get demoted
        // instead of staying at T1 and consuming budget every run.
        // Skip demotion for coins with existing pool coverage to avoid permanent
        // dormant state after transient crawl failures.
        const existingCoverage = liquidityCoverage.get(candidate.stablecoinId);
        if (!existingCoverage || existingCoverage.poolCount === 0) {
          try {
            await updateDiscoveryMeta(db, candidate.stablecoinId, 0, nowSec, signal);
          } catch (err) {
            logWorkerEventArgs("handler", "warn", `[dex-discovery] Failed to update discovery meta for ${candidate.stablecoinId}: ${toErrorMessage(err)}`);
          }
        }
      }

      if (Date.now() >= deadlineMs) {
        budgetExhausted = true;
        break;
      }
    }

    await finalizeDexScreenerOutcome();
    await persistTargetCursors();

    if (hasDiscoveryFinalizationWindow(deadlineMs)) {
      cleanup = await cleanupStaging(db, nowSec, signal);
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
        censusCadenceHolds,
        budgetExhausted,
        stagingWritesSkippedForBudget,
        cleanupSkippedForBudget,
        cleanup,
        runSeq,
        deploymentOutcomesWritten,
        windowedCoins,
        windowedDeploymentsDeferred,
        dexscreener: {
          attemptedRequests: dexScreenerRunState.attemptedRequests,
          successfulRequests: dexScreenerRunState.successfulRequests,
          hardRefusal: dexScreenerRunState.hardRefusal,
        },
      },
    });

    return {
      status: failedCoins.length > 0 || budgetExhausted || cleanup?.error != null ? "degraded" : "ok",
      itemCount: coinsCrawled,
      metadata: JSON.stringify({
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        censusCadenceHolds,
        budgetExhausted,
        stagingWritesSkippedForBudget,
        cleanupSkippedForBudget,
        cleanup,
        finalizationTailBudgetMs: DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS,
        runSeq,
        deploymentOutcomesWritten,
        windowedCoins,
        windowedDeploymentsDeferred,
        dexscreener: {
          attemptedRequests: dexScreenerRunState.attemptedRequests,
          successfulRequests: dexScreenerRunState.successfulRequests,
          hardRefusal: dexScreenerRunState.hardRefusal,
        },
        failedCoins,
        failedCoinErrors: Object.keys(failedCoinErrors).length > 0 ? failedCoinErrors : undefined,
        unresolvedChains: allUnresolvedChains.size > 0 ? [...allUnresolvedChains] : undefined,
        poolsBySource: Object.keys(poolsBySource).length > 0 ? poolsBySource : undefined,
      }),
    };
  } catch (err) {
    await finalizeDexScreenerOutcome();
    const error = toErrorMessage(err);
    recordCronFailure("dex-discovery", err, { metadata: { stage: "orchestrator", fatal: true, runSeq } });
    return {
      status: "error",
      itemCount: coinsCrawled,
      metadata: JSON.stringify({
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        censusCadenceHolds,
        budgetExhausted,
        stagingWritesSkippedForBudget,
        cleanupSkippedForBudget,
        cleanup,
        finalizationTailBudgetMs: DEX_DISCOVERY_FINALIZATION_TAIL_BUDGET_MS,
        runSeq,
        deploymentOutcomesWritten,
        windowedCoins,
        windowedDeploymentsDeferred,
        dexscreener: {
          attemptedRequests: dexScreenerRunState.attemptedRequests,
          successfulRequests: dexScreenerRunState.successfulRequests,
          hardRefusal: dexScreenerRunState.hardRefusal,
        },
        failedCoins,
        failedCoinErrors: Object.keys(failedCoinErrors).length > 0 ? failedCoinErrors : undefined,
        unresolvedChains: allUnresolvedChains.size > 0 ? [...allUnresolvedChains] : undefined,
        poolsBySource: Object.keys(poolsBySource).length > 0 ? poolsBySource : undefined,
        error,
      }),
    };
  }
}
