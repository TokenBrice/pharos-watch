import { logWorkerEventArgs } from "../../lib/structured-log";
import { sleepWithSignal } from "../../lib/abort";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";
import { CG_TICKERS_RATE_MS } from "../dex-liquidity/constants";
import {
  aggregateCgTickersByExchange,
  buildCgTickerExchangeSummaries,
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
  fetchJsonWithRetry: typeof fetchJsonWithRetry;
  sleepWithSignal: typeof sleepWithSignal;
}

const defaultCoinGeckoTickersStageDependencies: CoinGeckoTickersStageDependencies = {
  fetchJsonWithRetry,
  sleepWithSignal,
};

/**
 * Hard per-response byte cap for the tickers payload. CoinGecko
 * serves at most 100 tickers per page and the heaviest tracked coin measures
 * ~76 KiB, so this keeps the run's largest variable-size provider body bounded
 * with several times' headroom. The shared reader rejects an over-cap declared
 * `Content-Length` before reading and streams with an abort otherwise, so a
 * mis-served body can neither be buffered into the isolate nor parsed.
 */
const CG_TICKERS_MAX_RESPONSE_BYTES = 512 * 1024;

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
    const url = cgUrl(`/coins/${geckoId}/tickers?include_exchange_logo=false`, cgApiKey);
    const result = await dependencies.fetchJsonWithRetry<{ tickers?: CgTicker[] }>(url, {
      headers: cgHeaders({ "User-Agent": USER_AGENT }, cgApiKey),
      signal: context.buildStageSignal(DISCOVERY_STAGE_TIMEOUT_MS.cgTickers),
    }, 0, { timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.cgTickers, maxResponseBytes: CG_TICKERS_MAX_RESPONSE_BYTES });
    if (result?.response.ok) {
      const data = result.body;
      const exchangeSummaries = buildCgTickerExchangeSummaries(
        aggregateCgTickersByExchange(filterValidCgTickers(data.tickers ?? [])),
      );

      for (const summary of exchangeSummaries) {
        const poolId = `orderbook:${summary.exchangeId}:${context.stablecoinId}`.toLowerCase();
        if (context.hasKnownPool(poolId)) continue;

        context.addPool(toStagedPool(context, {
          poolId,
          source: "cg_tickers",
          chain: "orderbook",
          protocol: summary.exchangeId,
          dexId: summary.exchangeId,
          symbol: `${symbol ?? context.stablecoinId} / USD`,
          // Registry price record, consumed independently of pool admission.
          tvlUsd: null,
          volume24h: summary.volumeUsd,
          qualityMultiplier: null,
          poolType: null,
          feeTier: null,
          balanceRatio: null,
          isStable: null,
          baseToken: null,
          quoteToken: null,
          quoteSymbol: "USD",
          priceUsd: summary.priceUsd,
          lockedLiqPct: null,
          rawJson: null,
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
    logWorkerEventArgs("handler", "warn", `[dex-discovery] cg_tickers error for ${context.stablecoinId}`, err);
  } finally {
    await dependencies.sleepWithSignal(CG_TICKERS_RATE_MS, context.signal);
  }
}
