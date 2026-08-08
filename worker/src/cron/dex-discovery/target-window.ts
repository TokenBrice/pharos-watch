import { getDexDiscoveryProviders } from "@shared/lib/dex-deployment-coverage";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import type { ContractDeployment } from "@shared/types/core";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { rotateFromCursor } from "../shared/cursor-rotation";

/**
 * Wall-clock cost of one bounded provider query for a deployment: the provider's
 * pacing floor plus a measured request allowance. GeckoTerminal's 2s floor makes
 * a GT-only chain roughly twice as expensive as a CoinGecko chain, so a window
 * has to price its targets per provider instead of counting them.
 */
const DEPLOYMENT_CRAWL_COST_MS = {
  coingecko: RATE_LIMITS.COINGECKO_ONCHAIN_MS + 1_200,
  geckoterminal: RATE_LIMITS.GECKO_TERMINAL_MS + 800,
  dexscreener: RATE_LIMITS.DEXSCREENER_MS + 600,
  curve: 1_200,
} as const;

/** Provider stage order inside a coin crawl; the first supporter sets the cost. */
const COST_PROVIDER_ORDER = ["coingecko", "geckoterminal", "dexscreener", "curve"] as const;

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
export function estimateDeploymentCrawlCostMs(chain: string): number {
  const providers = getDexDiscoveryProviders(chain);
  if (providers.length === 0) return 0;
  for (const provider of COST_PROVIDER_ORDER) {
    if (providers.includes(provider)) return DEPLOYMENT_CRAWL_COST_MS[provider];
  }
  return 0;
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
    (sum, target) => sum + estimateDeploymentCrawlCostMs(target.chain),
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

  const rotated = rotateFromCursor(targets, cursor, discoveryTargetCursorKey, {
    startAfterCursor: true,
  }).items;
  const window: ContractDeployment[] = [];
  let estimatedCostMs = 0;
  for (const target of rotated) {
    const costMs = estimateDeploymentCrawlCostMs(target.chain);
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
    if (checkedDeploymentKeys.has(key) || estimateDeploymentCrawlCostMs(target.chain) === 0) {
      return key;
    }
  }
  return null;
}
