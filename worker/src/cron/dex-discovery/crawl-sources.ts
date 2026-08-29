import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { canonicalExitRouteAssetKey } from "@shared/lib/exit-route-identity";
import type { ContractDeployment } from "@shared/types/core";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { crawlCoinGeckoPoolsStage } from "./crawl-coingecko-pools";
import { crawlGeckoTerminalPoolsStage } from "./crawl-geckoterminal-pools";
import {
  createDexScreenerDiscoveryRunState,
  crawlDexScreenerPoolsStage,
  finalizeDexScreenerDiscoveryRun,
  type DexScreenerDiscoveryRunState,
} from "./crawl-dexscreener-pools";
import { crawlCoinGeckoTickersStage } from "./crawl-coingecko-tickers";
import { crawlCurvePoolsStage } from "./crawl-curve-pools";
import { crawlHorizonPoolsStage } from "./crawl-horizon-pools";
import { crawlSorobanPoolsStage } from "./crawl-soroban-pools";
import { crawlTezosPoolsStage } from "./crawl-tezos-pools";
import { crawlIconBalancedPoolsStage } from "./crawl-icon-balanced-pools";
import { crawlKavaSwapPoolsStage } from "./crawl-kava-swap-pools";
import { createCrawlStageContext, type StagedPriceObservation } from "./staged-pool";
import type { DexDeploymentProviderCheck, StagedPool } from "./types";
import { classifyDexDeploymentOutcomes, type DexDeploymentOutcomeWrite } from "./deployment-outcomes";
import { getDexDiscoveryProviders } from "@shared/lib/dex-deployment-coverage";

export interface CrawlResult {
  pools: StagedPool[];
  unresolvedChains: string[];
  deploymentOutcomes: DexDeploymentOutcomeWrite[];
  /** Deployments a provider stage actually queried, keyed like the census rows. */
  checkedDeploymentKeys: string[];
}

function checkedDeploymentKeys(providerChecks: readonly DexDeploymentProviderCheck[]): string[] {
  return [
    ...new Set(providerChecks.map((check) => canonicalExitRouteAssetKey(check.chain, check.address))),
  ];
}

/**
 * A successful provider check is the completion signal for a direct pool
 * query. It intentionally includes a completed-empty response, while price
 * observations and failed/degraded responses do not suppress the next pool
 * provider. The key is the same chain-scoped identity used by the census.
 */
function completedPoolQueryKeys(
  providerChecks: readonly DexDeploymentProviderCheck[],
  providers: readonly DexDeploymentProviderCheck["provider"][],
): Set<string> {
  const providerSet = new Set(providers);
  return new Set(
    providerChecks
      .filter((check) => check.status === "success" && providerSet.has(check.provider))
      .map((check) => canonicalExitRouteAssetKey(check.chain, check.address)),
  );
}

function selectDexScreenerFallbackTargets(
  coinTargets: readonly ContractDeployment[],
  providerChecks: readonly DexDeploymentProviderCheck[],
): Array<readonly [string, string]> {
  const completedEarlierQueries = completedPoolQueryKeys(providerChecks, ["coingecko", "geckoterminal"]);
  return coinTargets
    .filter(({ chain, address }) => {
      if (!getDexDiscoveryProviders(chain, address).includes("dexscreener")) return false;
      return !completedEarlierQueries.has(canonicalExitRouteAssetKey(chain, address));
    })
    .map(({ chain, address }) => [chain, address] as const);
}

export async function crawlCoin(
  db: D1Database,
  stablecoinId: string,
  coinTargets: ContractDeployment[],
  cgApiKey: string | null,
  knownPoolIds: Set<string>,
  signal?: AbortSignal,
  deadlineMs?: number,
  references?: PriceValidationReferences,
  sharedDexScreenerRunState?: DexScreenerDiscoveryRunState,
): Promise<CrawlResult> {
  const dexScreenerRunState = sharedDexScreenerRunState ?? createDexScreenerDiscoveryRunState();
  const finalizeOwnRun = async (result: CrawlResult): Promise<CrawlResult> => {
    if (!sharedDexScreenerRunState) {
      await finalizeDexScreenerDiscoveryRun(db, dexScreenerRunState);
    }
    return result;
  };
  const pools: StagedPool[] = [];
  const priceObs: StagedPriceObservation[] = [];
  const providerChecks: DexDeploymentProviderCheck[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const stablecoinMeta = TRACKED_META_BY_ID.get(stablecoinId);
  const context = createCrawlStageContext({
    stablecoinId,
    knownPoolIds,
    nowSec,
    pools,
    priceObs,
    signal,
    deadlineMs,
    references,
  });

  const coinGeckoStage = await crawlCoinGeckoPoolsStage({
    db,
    coinTargets,
    cgApiKey,
    context,
  });
  providerChecks.push(...coinGeckoStage.providerChecks);
  if (coinGeckoStage.stoppedEarly) {
    return await finalizeOwnRun({
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
      checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
    });
  }

  const completedCoinGeckoQueries = completedPoolQueryKeys(coinGeckoStage.providerChecks, ["coingecko"]);
  const geckoTerminalStage = await crawlGeckoTerminalPoolsStage({
    coinTargets,
    // The stage option retains its historical name, but only completed
    // CoinGecko pool queries may suppress GeckoTerminal. A price observation
    // by itself is not pool-query completion.
    cgPriceObservationTargets: completedCoinGeckoQueries,
    context,
  });
  providerChecks.push(...geckoTerminalStage.providerChecks);

  const dexScreenerStage = await crawlDexScreenerPoolsStage({
    db,
    targets: selectDexScreenerFallbackTargets(coinTargets, providerChecks),
    context,
    runState: dexScreenerRunState,
  });
  providerChecks.push(...dexScreenerStage.providerChecks);
  if (dexScreenerStage.stoppedEarly) {
    return await finalizeOwnRun({
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
      checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
    });
  }

  await crawlCoinGeckoTickersStage({
    cgApiKey,
    geckoId: stablecoinMeta?.geckoId,
    symbol: stablecoinMeta?.symbol,
    shouldRun: pools.length === 0 || priceObs.length === 0,
    context,
  });

  const curveStage = await crawlCurvePoolsStage({ coinTargets, context });
  providerChecks.push(...curveStage.providerChecks);

  const horizonStage = await crawlHorizonPoolsStage({ coinTargets, context });
  providerChecks.push(...horizonStage.providerChecks);
  if (horizonStage.stoppedEarly) {
    return await finalizeOwnRun({
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
      checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
    });
  }

  const aquariusStage = await crawlSorobanPoolsStage({ coinTargets, context });
  providerChecks.push(...aquariusStage.providerChecks);
  if (aquariusStage.stoppedEarly) {
    return await finalizeOwnRun({
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
      checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
    });
  }

  const tezosStage = await crawlTezosPoolsStage({ coinTargets, context });
  providerChecks.push(...tezosStage.providerChecks);
  if (tezosStage.stoppedEarly) {
    return await finalizeOwnRun({
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
      checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
    });
  }

  const iconBalancedStage = await crawlIconBalancedPoolsStage({ coinTargets, context });
  providerChecks.push(...iconBalancedStage.providerChecks);
  if (iconBalancedStage.stoppedEarly) {
    return await finalizeOwnRun({
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
      checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
    });
  }

  const kavaSwapStage = await crawlKavaSwapPoolsStage({ coinTargets, context });
  providerChecks.push(...kavaSwapStage.providerChecks);
  if (kavaSwapStage.stoppedEarly) {
    return await finalizeOwnRun({
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
      checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
    });
  }

  return await finalizeOwnRun({
    pools,
    unresolvedChains: coinGeckoStage.unresolvedChains,
    deploymentOutcomes: classifyDexDeploymentOutcomes({
      stablecoinId,
      deployments: coinTargets,
      pools,
      providerChecks,
      nowSec,
    }),
    checkedDeploymentKeys: checkedDeploymentKeys(providerChecks),
  });
}
