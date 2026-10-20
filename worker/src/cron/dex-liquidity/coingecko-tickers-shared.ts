import type { PriceValidationReferences } from "../../lib/price-validation";
import { USD_QUOTE_COIN_IDS } from "./constants";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import type { CgTicker, DexPriceObs } from "./types";

// Flow admits ticker prices; it is not a substitute for pool TVL.
export const CG_TICKER_PRICE_MIN_VOLUME_USD = 1_000;

export function dexPriceEvidenceWeight(observation: DexPriceObs): number {
  const weight = observation.sourceFamily === "cg_tickers"
    ? observation.observedVolumeUsd
    : observation.tvl;
  return typeof weight === "number" && Number.isFinite(weight) && weight > 0 ? weight : 0;
}

export interface AggregatedExchangeTicker {
  name: string;
  volumeUsd: number;
  priceVolumeWeightedSum: number;
  observedAt?: number | null;
}

export interface CgTickerExchangeSummary {
  exchangeId: string;
  exchangeName: string;
  volumeUsd: number;
  priceUsd: number;
  /** Registry refresh or conservative original ticker read time. */
  observedAt?: number | null;
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
  readObservedAt?: number,
): Map<string, AggregatedExchangeTicker> {
  const byExchange = new Map<string, AggregatedExchangeTicker>();

  for (const ticker of tickers) {
    const exchangeId = ticker.market.identifier;
    const existing = byExchange.get(exchangeId);
    const upstream = ticker.last_traded_at ? Date.parse(ticker.last_traded_at) / 1000 : NaN;
    const observedAt = Number.isFinite(upstream) && upstream >= 0 ? Math.floor(upstream) : readObservedAt;

    if (existing) {
      existing.volumeUsd += ticker.converted_volume.usd;
      existing.priceVolumeWeightedSum += ticker.converted_last.usd * ticker.converted_volume.usd;
      if (existing.observedAt != null && observedAt != null) {
        existing.observedAt = Math.min(existing.observedAt, observedAt);
      } else if (existing.observedAt !== undefined || observedAt !== undefined) {
        existing.observedAt = null;
      }
      continue;
    }

    byExchange.set(exchangeId, {
      name: ticker.market.name,
      volumeUsd: ticker.converted_volume.usd,
      priceVolumeWeightedSum: ticker.converted_last.usd * ticker.converted_volume.usd,
      ...(observedAt !== undefined ? { observedAt } : {}),
    });
  }

  return byExchange;
}

export function buildCgTickerExchangeSummaries(
  aggregates: Map<string, AggregatedExchangeTicker>,
): CgTickerExchangeSummary[] {
  const summaries: CgTickerExchangeSummary[] = [];

  for (const [exchangeId, aggregate] of aggregates) {
    summaries.push({
      exchangeId,
      exchangeName: aggregate.name,
      volumeUsd: aggregate.volumeUsd,
      priceUsd: aggregate.volumeUsd > 0
        ? aggregate.priceVolumeWeightedSum / aggregate.volumeUsd
        : 0,
      ...(aggregate.observedAt !== undefined ? { observedAt: aggregate.observedAt } : {}),
    });
  }

  return summaries;
}


export function buildCgTickerPriceObservations(
  stablecoinId: string,
  summaries: CgTickerExchangeSummary[],
  references?: PriceValidationReferences,
): DexPriceObs[] {
  return summaries.flatMap((summary) => {
    if (!Number.isFinite(summary.volumeUsd) || summary.volumeUsd < CG_TICKER_PRICE_MIN_VOLUME_USD) {
      return [];
    }

    if (!isPlausibleDexObservationPrice(stablecoinId, summary.priceUsd, references)) {
      return [];
    }

    return [{
      price: summary.priceUsd,
      observedAt: summary.observedAt ?? null,
      tvl: 0,
      observedVolumeUsd: summary.volumeUsd,
      chain: "orderbook",
      protocol: `cg-ticker-${summary.exchangeId}`,
      sourceFamily: "cg_tickers",
      poolKey: `orderbook:${summary.exchangeId}:${stablecoinId}`.toLowerCase(),
      identityConfidence: "exact",
    }];
  });
}
