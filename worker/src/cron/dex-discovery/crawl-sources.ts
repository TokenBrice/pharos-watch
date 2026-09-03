import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
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
import { crawlCosmosPoolsStage } from "./crawl-cosmos-pools";
import { createCrawlStageContext, type StagedPriceObservation } from "./staged-pool";
import type { DexDeploymentProviderCheck, StagedPool } from "./types";
import { classifyDexDeploymentOutcomes, type DexDeploymentOutcomeWrite } from "./deployment-outcomes";
import { getRuntimeDexDiscoveryProviders } from "./provider-registry";
import { DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY } from "./provider-registry";
import type { DexDiscoveryCrawlerLeafId } from "@shared/lib/dex-deployment-coverage";

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
      if (!getRuntimeDexDiscoveryProviders(chain, address).includes("dexscreener")) return false;
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
  const stablecoinMeta = WORKER_TRACKED_META_BY_ID.get(stablecoinId);
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

  type ProviderStageResult = {
    providerChecks: DexDeploymentProviderCheck[];
    stoppedEarly?: boolean;
    unresolvedChains?: string[];
  };
  const providerLeaves: Record<DexDiscoveryCrawlerLeafId, () => Promise<ProviderStageResult>> = {
    coingecko: () => crawlCoinGeckoPoolsStage({ db, coinTargets, cgApiKey, context }),
    geckoterminal: () => crawlGeckoTerminalPoolsStage({
      coinTargets,
      // Only a completed CoinGecko pool query may suppress GeckoTerminal.
      cgPriceObservationTargets: completedPoolQueryKeys(providerChecks, ["coingecko"]),
      context,
    }),
    dexscreener: () => crawlDexScreenerPoolsStage({
      db,
      targets: selectDexScreenerFallbackTargets(coinTargets, providerChecks),
      context,
      runState: dexScreenerRunState,
    }),
    curve: () => crawlCurvePoolsStage({ coinTargets, context }),
    horizon: () => crawlHorizonPoolsStage({ coinTargets, context }),
    aquarius: () => crawlSorobanPoolsStage({ coinTargets, context }),
    tezos: () => crawlTezosPoolsStage({ coinTargets, context }),
    "icon-balanced": () => crawlIconBalancedPoolsStage({ coinTargets, context }),
    "kava-swap": () => crawlKavaSwapPoolsStage({ coinTargets, context }),
    cosmos: () => crawlCosmosPoolsStage({ coinTargets, context }),
  };
  const executionLeaves = [...new Set(
    DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY
      .filter((provider) => provider.lifecycle === "active")
      .sort((left, right) => left.executionOrder - right.executionOrder)
      .flatMap((provider) => provider.crawlerLeaf ? [provider.crawlerLeaf] : []),
  )];
  let unresolvedChains: string[] = [];
  for (const leaf of executionLeaves) {
    const stage = await providerLeaves[leaf]();
    providerChecks.push(...stage.providerChecks);
    if (stage.unresolvedChains) unresolvedChains = stage.unresolvedChains;
    if (stage.stoppedEarly) {
      return await finalizeOwnRun({
        pools,
        unresolvedChains,
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
    if (leaf === "dexscreener") {
      await crawlCoinGeckoTickersStage({
        cgApiKey,
        geckoId: stablecoinMeta?.geckoId,
        symbol: stablecoinMeta?.symbol,
        shouldRun: pools.length === 0 || priceObs.length === 0,
        context,
      });
    }
  }

  return await finalizeOwnRun({
    pools,
    unresolvedChains,
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
