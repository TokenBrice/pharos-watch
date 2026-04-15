import { DEX_PRICE_OBSERVATION_MIN_TVL_USD } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { ORDERBOOK_TVL_FACTOR, USD_QUOTE_COIN_IDS } from "./constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { CgTicker, DexPriceObs } from "./types";

export interface AggregatedExchangeTicker {
  name: string;
  volumeUsd: number;
  priceVolumeWeightedSum: number;
  depthDownUsd: number;
  depthDownCount: number;
  depthUpUsd: number;
  depthUpCount: number;
}

export interface CgTickerExchangeSummary {
  exchangeId: string;
  exchangeName: string;
  volumeUsd: number;
  volumeDerivedTvlUsd: number;
  syntheticTvlUsd: number;
  depthDownUsd: number | null;
  depthUpUsd: number | null;
  tvlBasis: "volume-derived" | "coingecko-depth-2pct-capped-by-volume";
  priceUsd: number;
}

export interface CgTickerOrderbookMetadata {
  orderbookDepthUsd?: number;
  orderbookDepthUpUsd?: number;
  orderbookTvlBasis?: "volume-derived" | "coingecko-depth-2pct-capped-by-volume";
}

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function filterValidCgTickers(tickers: CgTicker[]): CgTicker[] {
  return tickers.filter((ticker) => {
    const volumeUsd = ticker.converted_volume?.usd;
    const priceUsd = ticker.converted_last?.usd;
    const exchangeId = ticker.market?.identifier?.trim();

    if (ticker.is_stale || ticker.is_anomaly) {
      return false;
    }
    if (!exchangeId) return false;
    if (!Number.isFinite(volumeUsd) || volumeUsd < 1_000) return false;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return false;

    const isUsdQuote =
      ticker.target === "USD" ||
      (ticker.target_coin_id != null && USD_QUOTE_COIN_IDS.has(ticker.target_coin_id));

    return isUsdQuote;
  });
}

export function aggregateCgTickersByExchange(
  tickers: CgTicker[],
): Map<string, AggregatedExchangeTicker> {
  const byExchange = new Map<string, AggregatedExchangeTicker>();

  for (const ticker of tickers) {
    const exchangeId = ticker.market.identifier;
    const existing = byExchange.get(exchangeId);
    const depthDownUsd = finitePositive(ticker.cost_to_move_down_usd);
    const depthUpUsd = finitePositive(ticker.cost_to_move_up_usd);

    if (existing) {
      existing.volumeUsd += ticker.converted_volume.usd;
      existing.priceVolumeWeightedSum += ticker.converted_last.usd * ticker.converted_volume.usd;
      if (depthDownUsd != null) {
        existing.depthDownUsd += depthDownUsd;
        existing.depthDownCount += 1;
      }
      if (depthUpUsd != null) {
        existing.depthUpUsd += depthUpUsd;
        existing.depthUpCount += 1;
      }
      continue;
    }

    byExchange.set(exchangeId, {
      name: ticker.market.name,
      volumeUsd: ticker.converted_volume.usd,
      priceVolumeWeightedSum: ticker.converted_last.usd * ticker.converted_volume.usd,
      depthDownUsd: depthDownUsd ?? 0,
      depthDownCount: depthDownUsd != null ? 1 : 0,
      depthUpUsd: depthUpUsd ?? 0,
      depthUpCount: depthUpUsd != null ? 1 : 0,
    });
  }

  return byExchange;
}

export function buildCgTickerExchangeSummaries(
  aggregates: Map<string, AggregatedExchangeTicker>,
): CgTickerExchangeSummary[] {
  const summaries: CgTickerExchangeSummary[] = [];

  for (const [exchangeId, aggregate] of aggregates) {
    const volumeDerivedTvlUsd = aggregate.volumeUsd * ORDERBOOK_TVL_FACTOR;
    const depthDownUsd = aggregate.depthDownCount > 0 ? aggregate.depthDownUsd : null;
    const depthUpUsd = aggregate.depthUpCount > 0 ? aggregate.depthUpUsd : null;
    const syntheticTvlUsd = depthDownUsd != null
      ? Math.min(volumeDerivedTvlUsd, depthDownUsd)
      : volumeDerivedTvlUsd;
    summaries.push({
      exchangeId,
      exchangeName: aggregate.name,
      volumeUsd: aggregate.volumeUsd,
      volumeDerivedTvlUsd,
      syntheticTvlUsd,
      depthDownUsd,
      depthUpUsd,
      tvlBasis: depthDownUsd != null ? "coingecko-depth-2pct-capped-by-volume" : "volume-derived",
      priceUsd: aggregate.volumeUsd > 0
        ? aggregate.priceVolumeWeightedSum / aggregate.volumeUsd
        : 0,
    });
  }

  return summaries;
}

export function buildCgTickerOrderbookMetadata(
  summary: CgTickerExchangeSummary,
): CgTickerOrderbookMetadata | null {
  if (summary.tvlBasis === "volume-derived" && summary.depthDownUsd == null && summary.depthUpUsd == null) {
    return null;
  }
  return {
    orderbookTvlBasis: summary.tvlBasis,
    ...(summary.depthDownUsd != null ? { orderbookDepthUsd: summary.depthDownUsd } : {}),
    ...(summary.depthUpUsd != null ? { orderbookDepthUpUsd: summary.depthUpUsd } : {}),
  };
}

export function buildCgTickerPriceObservations(
  stablecoinId: string,
  summaries: CgTickerExchangeSummary[],
  references?: PriceValidationReferences,
): DexPriceObs[] {
  return summaries.flatMap((summary) => {
    if (summary.syntheticTvlUsd < DEX_PRICE_OBSERVATION_MIN_TVL_USD) {
      return [];
    }

    if (!isPlausibleDexObservationPrice(stablecoinId, summary.priceUsd, references)) {
      return [];
    }

    return [{
      price: summary.priceUsd,
      tvl: summary.syntheticTvlUsd,
      chain: "orderbook",
      protocol: `cg-ticker-${summary.exchangeId}`,
    }];
  });
}
