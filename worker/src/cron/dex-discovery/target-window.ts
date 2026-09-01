import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import type { ContractDeployment } from "@shared/types/core";
import { rotateFromCursor } from "../shared/cursor-rotation";
import { DISCOVERY_TIERS } from "./types";
import {
  DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY,
  getRuntimeDexDiscoveryProviders,
} from "./provider-registry";

/**
 * Per-coin wall-clock crawl budget, shared by every provider stage of one coin
 * crawl. Window selection exists to keep a footprint's priced targets inside it,
 * so the budget lives beside the pricing table it is compared against.
 */
export const DEX_DISCOVERY_PER_COIN_BUDGET_MS = 25_000;

/**
 * Wall-clock cost of one bounded provider query for a deployment: the provider's
 * pacing floor plus a measured request allowance. A deployment may be visited by
 * several serial stages, so window pricing must include every registered
 * provider rather than only the first one. The old first-provider estimate
 * admitted windows that fit CoinGecko but expired before GT/DexScreener/Curve,
 * repeatedly publishing bounded-crawl gaps for the tail.
 */
export interface DiscoveryTargetWindow {
  targets: ContractDeployment[];
  windowed: boolean;
  estimatedCostMs: number;
  totalEstimatedCostMs: number;
}

interface SelectDiscoveryTargetWindowOptions {
  targets: readonly ContractDeployment[];
  cursor: string | null | undefined;
  budgetMs: number;
}

export function discoveryTargetCursorKey(deployment: ContractDeployment): string {
  return canonicalExitRouteAssetKey(deployment.chain, deployment.address);
}

/**
 * Estimated per-coin budget consumed by one deployment. Chains with no
 * registered discovery provider cost nothing: no stage ever queries them and
 * their census rows are re-asserted from the static registry every run.
 */
export function estimateDeploymentCrawlCostMs(chain: string, address?: string): number {
  return DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY.reduce(
    (sum, provider) => sum + (
      provider.lifecycle === "active" && provider.supports(chain, address)
        ? provider.requestCostMs
        : 0
    ),
    0,
  );
}

/**
 * Pick the slice of a coin's deployment footprint that one crawl can actually
 * finish inside the per-coin budget, resuming after the last deployment a
 * provider reached on the previous run.
 *
 * The stages iterate the whole target list before handing control to the next
 * stage, so an oversized footprint let the first stage (CoinGecko on-chain)
 * consume the entire per-coin budget and permanently starved every chain only a
 * later stage can serve. Bounding the list instead of the stage keeps rotation
 * fair across all providers, and deployments outside the window keep their
 * previous census row rather than being downgraded to a bounded-crawl deferral.
 */
export function selectDiscoveryTargetWindow({
  targets,
  cursor,
  budgetMs,
}: SelectDiscoveryTargetWindowOptions): DiscoveryTargetWindow {
  const totalEstimatedCostMs = targets.reduce(
    (sum, target) => sum + estimateDeploymentCrawlCostMs(target.chain, target.address),
    0,
  );
  if (targets.length === 0 || totalEstimatedCostMs <= budgetMs) {
    return {
      targets: [...targets],
      windowed: false,
      estimatedCostMs: totalEstimatedCostMs,
      totalEstimatedCostMs,
    };
  }

  const grouped = new Map<string, ContractDeployment[]>();
  for (const target of targets) {
    const signature = getRuntimeDexDiscoveryProviders(target.chain, target.address).join("+") || "unsupported";
    const rows = grouped.get(signature) ?? [];
    rows.push(target);
    grouped.set(signature, rows);
  }
  const providerGroups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, rows]) => rows);
  const providerFairTargets: ContractDeployment[] = [];
  for (let depth = 0; providerGroups.some((rows) => depth < rows.length); depth++) {
    for (const rows of providerGroups) {
      const target = rows[depth];
      if (target) providerFairTargets.push(target);
    }
  }
  const rotated = rotateFromCursor(providerFairTargets, cursor, discoveryTargetCursorKey, {
    startAfterCursor: true,
  }).items;
  const window: ContractDeployment[] = [];
  let estimatedCostMs = 0;
  for (const target of rotated) {
    const costMs = estimateDeploymentCrawlCostMs(target.chain, target.address);
    if (window.length > 0 && estimatedCostMs + costMs > budgetMs) break;
    window.push(target);
    estimatedCostMs += costMs;
  }

  return { targets: window, windowed: true, estimatedCostMs, totalEstimatedCostMs };
}

/**
 * Resume marker for the next run: the last window deployment a provider actually
 * reached. Deployments a stage never got to stay ahead of the cursor so the next
 * run retries them instead of waiting a full rotation.
 */
export function advanceDiscoveryTargetCursor(
  window: readonly ContractDeployment[],
  checkedDeploymentKeys: ReadonlySet<string>,
): string | null {
  for (let index = window.length - 1; index >= 0; index--) {
    const target = window[index]!;
    const key = discoveryTargetCursorKey(target);
    if (checkedDeploymentKeys.has(key) || estimateDeploymentCrawlCostMs(target.chain, target.address) === 0) {
      return key;
    }
  }
  return null;
}

/**
 * Wall-clock gap between two crawl opportunities for one windowed coin.
 * Cadence eligibility is cohort-based, so a coin is handed a window once every
 * `T3_MODULO` discovery runs. A footprint large enough to need windowing is by
 * construction a many-chain coin, whose steady-state cohort is t3; the t1 and t2
 * cohorts sweep strictly faster than this, so it is the conservative cadence for
 * a statically derived sweep estimate.
 */
export const DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC =
  CRON_INTERVALS["sync-dex-discovery"] * DISCOVERY_TIERS.T3_MODULO;

/**
 * Number of resumable windows one full sweep of a footprint needs. Simulated
 * with the real selector and resume rule instead of a second cost model, so the
 * estimate cannot drift from the provider pricing table. A footprint that fits
 * the per-coin budget sweeps in a single window; an empty footprint needs none.
 */
export function estimateDiscoverySweepWindowCount(
  targets: readonly ContractDeployment[],
  budgetMs = DEX_DISCOVERY_PER_COIN_BUDGET_MS,
): number {
  // The crawl is handed the coin's deduped tracked contracts, so price the same
  // footprint rather than the raw registry concatenation.
  const footprint: ContractDeployment[] = [];
  const footprintKeys = new Set<string>();
  for (const target of targets) {
    const key = discoveryTargetCursorKey(target);
    if (footprintKeys.has(key)) continue;
    footprintKeys.add(key);
    footprint.push(target);
  }
  if (footprint.length === 0) return 0;

  const covered = new Set<string>();
  let cursor: string | null = null;
  let windows = 0;
  // Each window holds at least one target and the cursor advances past its last
  // target, so one rotation cannot need more windows than the footprint has
  // deployments; the bound is a guard, not the expected exit.
  while (covered.size < footprint.length && windows < footprint.length) {
    const selected = selectDiscoveryTargetWindow({ targets: footprint, cursor, budgetMs });
    windows += 1;
    for (const target of selected.targets) {
      covered.add(discoveryTargetCursorKey(target));
    }
    cursor = discoveryTargetCursorKey(selected.targets[selected.targets.length - 1]!);
  }
  return windows;
}

/**
 * Wall-clock time one full census sweep of a footprint takes at the coin's crawl
 * cadence. This is a floor: a run that reaches only part of its window resumes
 * mid-window, which lengthens the real sweep.
 */
export function estimateDiscoverySweepPeriodSec(
  targets: readonly ContractDeployment[],
  budgetMs = DEX_DISCOVERY_PER_COIN_BUDGET_MS,
): number {
  return (
    estimateDiscoverySweepWindowCount(targets, budgetMs) * DISCOVERY_WINDOWED_CRAWL_INTERVAL_SEC
  );
}
