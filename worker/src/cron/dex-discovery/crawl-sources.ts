import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import type { ContractDeployment } from "@shared/types/core";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { crawlCoinGeckoPoolsStage } from "./crawl-coingecko-pools";
import { crawlGeckoTerminalPoolsStage } from "./crawl-geckoterminal-pools";
import {
  crawlDexScreenerPoolsStage,
  selectDexScreenerTargets,
} from "./crawl-dexscreener-pools";
import { crawlCoinGeckoTickersStage } from "./crawl-coingecko-tickers";
import { createCrawlStageContext } from "./staged-pool";
import type { StagedPool } from "./types";

export interface CrawlResult {
  pools: StagedPool[];
  priceObs: Array<{
    stablecoinId: string;
    price: number;
    tvl: number;
    chain: string;
    protocol: string;
  }>;
  unresolvedChains: string[];
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
  const priceObs: CrawlResult["priceObs"] = [];
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
  if (coinGeckoStage.stoppedEarly) {
    return { pools, priceObs, unresolvedChains: coinGeckoStage.unresolvedChains };
  }

  await crawlGeckoTerminalPoolsStage({
    coinTargets,
    cgQueriedChains: coinGeckoStage.queriedChains,
    context,
  });

  const dexScreenerStage = await crawlDexScreenerPoolsStage({
    db,
    targets: selectDexScreenerTargets({
      coinTargets,
      discoveredPoolCount: pools.length,
    }),
    context,
  });
  if (dexScreenerStage.stoppedEarly) {
    return { pools, priceObs, unresolvedChains: coinGeckoStage.unresolvedChains };
  }

  await crawlCoinGeckoTickersStage({
    cgApiKey,
    geckoId: stablecoinMeta?.geckoId,
    symbol: stablecoinMeta?.symbol,
    shouldRun: pools.length === 0 || priceObs.length === 0,
    context,
  });

  return { pools, priceObs, unresolvedChains: coinGeckoStage.unresolvedChains };
}
