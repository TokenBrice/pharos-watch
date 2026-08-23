import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import {
  collectHistoricalBlockPrices,
  PROTOCOL_REDEEM_SOURCE,
  type HistoricalPriceContext,
  type PriceSourceProvider,
} from "./helpers";

export function createProtocolRedeemProvider(input: {
  stablecoinId: string;
  fetchLiveQuote: (asset: PeggedAsset, signal?: AbortSignal) => Promise<number | null>;
  fetchHistoricalQuote: (
    context: HistoricalPriceContext,
    blockNumber: number,
    timestamp: number,
    signal?: AbortSignal,
  ) => Promise<number | null>;
}): PriceSourceProvider {
  return {
    source: PROTOCOL_REDEEM_SOURCE,
    liveCircuitSource: CIRCUIT_SOURCE.PROTOCOL_REDEEM,
    recordNullLiveResultAsCircuitFailure: true,
    matches(stablecoinId: string): boolean {
      return stablecoinId === input.stablecoinId;
    },
    async fetchLivePrice(asset, _context, signal) {
      const price = await input.fetchLiveQuote(asset, signal);
      return price == null ? null : { price, source: PROTOCOL_REDEEM_SOURCE, confidence: "high" };
    },
    async fetchHistoricalPrices(_meta, context) {
      return collectHistoricalBlockPrices(
        context,
        (blockNumber, timestamp, signal) => input.fetchHistoricalQuote(context, blockNumber, timestamp, signal),
      );
    },
  };
}
