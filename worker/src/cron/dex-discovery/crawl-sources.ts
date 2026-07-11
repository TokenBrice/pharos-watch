import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment } from "@shared/types/core";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { crawlCoinGeckoPoolsStage } from "./crawl-coingecko-pools";
import { crawlGeckoTerminalPoolsStage } from "./crawl-geckoterminal-pools";
import {
  crawlDexScreenerPoolsStage,
  selectDexScreenerTargets,
} from "./crawl-dexscreener-pools";
import { crawlCoinGeckoTickersStage } from "./crawl-coingecko-tickers";
import { createCrawlStageContext, type StagedPriceObservation } from "./staged-pool";
import type { DexDeploymentProviderCheck, StagedPool } from "./types";
import {
  classifyDexDeploymentOutcomes,
  type DexDeploymentOutcomeWrite,
} from "./deployment-outcomes";

export interface CrawlResult {
  pools: StagedPool[];
  unresolvedChains: string[];
  deploymentOutcomes: DexDeploymentOutcomeWrite[];
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
): Promise<CrawlResult> {
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
    return {
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
    };
  }

  const geckoTerminalStage = await crawlGeckoTerminalPoolsStage({
    coinTargets,
    cgPriceObservationTargets: coinGeckoStage.priceObservationTargets,
    context,
  });
  providerChecks.push(...geckoTerminalStage.providerChecks);

  const dexScreenerStage = await crawlDexScreenerPoolsStage({
    db,
    targets: selectDexScreenerTargets({
      coinTargets,
      discoveredPoolCount: pools.length,
    }),
    context,
  });
  providerChecks.push(...dexScreenerStage.providerChecks);
  if (dexScreenerStage.stoppedEarly) {
    return {
      pools,
      unresolvedChains: coinGeckoStage.unresolvedChains,
      deploymentOutcomes: classifyDexDeploymentOutcomes({
        stablecoinId,
        deployments: coinTargets,
        pools,
        providerChecks,
        nowSec,
      }),
    };
  }

  await crawlCoinGeckoTickersStage({
    cgApiKey,
    geckoId: stablecoinMeta?.geckoId,
    symbol: stablecoinMeta?.symbol,
    shouldRun: pools.length === 0 || priceObs.length === 0,
    context,
  });

  return {
    pools,
    unresolvedChains: coinGeckoStage.unresolvedChains,
    deploymentOutcomes: classifyDexDeploymentOutcomes({
      stablecoinId,
      deployments: coinTargets,
      pools,
      providerChecks,
      nowSec,
    }),
  };
}
