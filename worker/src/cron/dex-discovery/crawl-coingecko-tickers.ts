import { sleepWithSignal } from "../../lib/abort";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { USER_AGENT } from "../../lib/constants";
import { QUALITY_MULTIPLIERS } from "../../lib/dex-cron-constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { CG_TICKERS_RATE_MS } from "../dex-liquidity/constants";
import {
  aggregateCgTickersByExchange,
  buildCgTickerExchangeSummaries,
  buildCgTickerOrderbookMetadata,
  buildCgTickerPriceObservations,
  filterValidCgTickers,
} from "../dex-liquidity/coingecko-tickers-shared";
import type { CgTicker } from "../dex-liquidity/types";
import {
  DISCOVERY_STAGE_TIMEOUT_MS,
  type CrawlStageContext,
  toStagedPool,
} from "./staged-pool";

export interface CoinGeckoTickersStageDependencies {
  fetchWithRetry: typeof fetchWithRetry;
  sleepWithSignal: typeof sleepWithSignal;
}

export const defaultCoinGeckoTickersStageDependencies: CoinGeckoTickersStageDependencies = {
  fetchWithRetry,
  sleepWithSignal,
};

interface CrawlCoinGeckoTickersStageOptions {
  cgApiKey: string | null;
  geckoId: string | undefined;
  symbol: string | undefined;
  shouldRun: boolean;
  context: CrawlStageContext;
  dependencies?: CoinGeckoTickersStageDependencies;
}

export async function crawlCoinGeckoTickersStage({
  cgApiKey,
  geckoId,
  symbol,
  shouldRun,
  context,
  dependencies = defaultCoinGeckoTickersStageDependencies,
}: CrawlCoinGeckoTickersStageOptions): Promise<void> {
  if (!shouldRun || context.timeExceeded() || !geckoId) {
    return;
  }

  try {
    const url = cgUrl(`/coins/${geckoId}/tickers?include_exchange_logo=false&depth=true`, cgApiKey);
    const res = await dependencies.fetchWithRetry(url, {
      headers: cgHeaders({ "User-Agent": USER_AGENT }, cgApiKey),
      signal: context.buildStageSignal(DISCOVERY_STAGE_TIMEOUT_MS.cgTickers),
    }, 0, { timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.cgTickers });
    if (res?.ok) {
      const data = (await res.json()) as { tickers?: CgTicker[] };
      const exchangeSummaries = buildCgTickerExchangeSummaries(
        aggregateCgTickersByExchange(filterValidCgTickers(data.tickers ?? [])),
      );

      for (const summary of exchangeSummaries) {
        // Canonical orderbook pool id — no stablecoin suffix. Multiple tracked stablecoins
        // sharing the same exchange map to the same poolId and dedup correctly downstream.
        const poolId = `orderbook:${summary.exchangeId}`.toLowerCase();
        if (context.knownPoolIds.has(poolId)) continue;
        const orderbookMetadata = buildCgTickerOrderbookMetadata(summary);

        context.addPool(toStagedPool(context, {
          poolId,
          source: "cg_tickers",
          chain: "orderbook",
          protocol: summary.exchangeId,
          dexId: summary.exchangeId,
          symbol: `${symbol ?? context.stablecoinId} / USD`,
          tvlUsd: summary.syntheticTvlUsd,
          volume24h: summary.volumeUsd,
          qualityMultiplier: QUALITY_MULTIPLIERS["orderbook"],
          poolType: "orderbook",
          feeTier: null,
          balanceRatio: null,
          isStable: null,
          baseToken: null,
          quoteToken: null,
          quoteSymbol: "USD",
          priceUsd: summary.priceUsd,
          lockedLiqPct: null,
          rawJson: orderbookMetadata ? JSON.stringify(orderbookMetadata) : null,
        }));
      }

      for (const observation of buildCgTickerPriceObservations(
        context.stablecoinId,
        exchangeSummaries,
        context.references,
      )) {
        context.addPriceObs({ ...observation, stablecoinId: context.stablecoinId });
      }
    }
  } catch (err) {
    if (context.signal?.aborted) throw err;
    console.warn(`[dex-discovery] cg_tickers error for ${context.stablecoinId}`, err);
  } finally {
    await dependencies.sleepWithSignal(CG_TICKERS_RATE_MS, context.signal);
  }
}
