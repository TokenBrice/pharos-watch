import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { CIRCUIT_SOURCE } from "../constants";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { fetchMarketBackfillPriceSeries } from "../../api/backfill-price-sources";
import { findAsOfSnapshot } from "@shared/lib/rate-series";
import {
  buildParentDerivedLiveOverride,
  collectHistoricalBlockPrices,
  PROTOCOL_REDEEM_SOURCE,
  resolveTrustedOverrideParent,
  type HistoricalPriceContext,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const HISTORICAL_PARENT_MAX_DISTANCE_SEC = 3600;

export function createProtocolRedeemProvider(input: {
  stablecoinId: string;
  parentId: string;
  /** Returns quote-token units per child token, not USD. */
  fetchLiveQuote: (asset: PeggedAsset, context: LivePriceContext, signal?: AbortSignal) => Promise<number | null>;
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
    liveParentByAssetId: { [input.stablecoinId]: input.parentId },
    matches(stablecoinId: string): boolean {
      return stablecoinId === input.stablecoinId;
    },
    async fetchLivePrice(asset, context, signal) {
      const parent = resolveTrustedOverrideParent(context, input.parentId, () =>
        `[authoritative-price-sources] ${asset.id}: redemption quote requires a trusted ${input.parentId} USD price`,
      );
      if (!parent) return null;
      const quoteUnitsPerToken = await input.fetchLiveQuote(asset, context, signal);
      return quoteUnitsPerToken == null ? null : buildParentDerivedLiveOverride(parent, quoteUnitsPerToken);
    },
    async fetchHistoricalPrices(_meta, context) {
      const parentMeta = WORKER_TRACKED_META_BY_ID.get(input.parentId);
      if (!parentMeta?.geckoId) return null;
      const timestamps = context.candidateTimestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
      if (timestamps.length === 0) return null;
      const series = await fetchMarketBackfillPriceSeries(parentMeta, parentMeta.geckoId, {
        granularity: "hourly",
        coingeckoApiKey: context.coingeckoApiKey ?? null,
        signal: context.signal,
        range: {
          startSec: Math.max(0, Math.min(...timestamps) - HISTORICAL_PARENT_MAX_DISTANCE_SEC),
          endSec: Math.max(...timestamps) + HISTORICAL_PARENT_MAX_DISTANCE_SEC,
        },
      });
      if (!series.prices?.length) return null;
      const parentUsdByTimestamp = new Map<number, number>();
      for (const timestamp of timestamps) {
        const parent = findAsOfSnapshot(series.prices, timestamp, (point) => point.timestamp, HISTORICAL_PARENT_MAX_DISTANCE_SEC);
        // Hourly USD market observations bound the conversion; absent history
        // never becomes an assumed USDC par quote.
        if (parent && Number.isFinite(parent.price) && parent.price > 0) parentUsdByTimestamp.set(timestamp, parent.price);
      }
      return collectHistoricalBlockPrices(
        context,
        (blockNumber, timestamp, signal) => parentUsdByTimestamp.has(timestamp)
          ? input.fetchHistoricalQuote(context, blockNumber, timestamp, signal)
          : Promise.resolve(null),
        (quoteUnitsPerToken, timestamp) => {
          const parentUsd = parentUsdByTimestamp.get(timestamp);
          if (parentUsd == null) return null;
          const price = quoteUnitsPerToken * parentUsd;
          return Number.isFinite(price) && price > 0 ? price : null;
        },
      );
    },
  };
}
