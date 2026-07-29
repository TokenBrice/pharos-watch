import { describe, expect, it } from "vitest";

import { ORDERBOOK_TVL_FACTOR } from "../constants";
import {
  aggregateCgTickersByExchange,
  buildCgTickerExchangeSummaries,
  buildCgTickerPriceObservations,
  filterValidCgTickers,
} from "../coingecko-tickers-shared";
import type { CgTicker } from "../types";

function makeTicker(overrides: Partial<CgTicker> = {}): CgTicker {
  return {
    base: "USDC",
    target: "USD",
    market: { name: "Example Exchange", identifier: "example" },
    converted_last: { usd: 1.0 },
    converted_volume: { usd: 10_000 },
    bid_ask_spread_percentage: 0.1,
    is_anomaly: false,
    is_stale: false,
    trust_score: null,
    ...overrides,
  };
}

describe("CoinGecko tickers shared helpers", () => {
  it("filters out stale, anomalous, non-USD, and low-volume tickers", () => {
    const filtered = filterValidCgTickers([
      makeTicker(),
      makeTicker({ is_stale: true, market: { name: "Stale", identifier: "stale" } }),
      makeTicker({ is_anomaly: true, market: { name: "Anomaly", identifier: "anomaly" } }),
      makeTicker({ market: { name: "No Trust", identifier: "no-trust" } }),
      makeTicker({ target: "EUR", target_coin_id: undefined, market: { name: "EUR", identifier: "eur" } }),
      makeTicker({ target: "USDT", target_coin_id: "tether", market: { name: "USDT", identifier: "usdt" } }),
      makeTicker({ converted_volume: { usd: 999 }, market: { name: "Tiny", identifier: "tiny" } }),
      makeTicker({ converted_last: { usd: 0 }, market: { name: "Zero Price", identifier: "zero-price" } }),
      makeTicker({ market: { name: "Missing Id", identifier: "" } }),
    ]);

    expect(filtered.map((ticker) => ticker.market.identifier)).toEqual(["example", "no-trust", "usdt"]);
  });

  it("aggregates valid tickers by exchange and computes weighted prices", () => {
    const aggregates = aggregateCgTickersByExchange([
      makeTicker({
        market: { name: "Kinesis", identifier: "kinesis" },
        converted_last: { usd: 1.0 },
        converted_volume: { usd: 20_000 },
      }),
      makeTicker({
        market: { name: "Kinesis", identifier: "kinesis" },
        converted_last: { usd: 0.99 },
        converted_volume: { usd: 10_000 },
      }),
      makeTicker({
        market: { name: "Kraken", identifier: "kraken" },
        converted_last: { usd: 1.01 },
        converted_volume: { usd: 5_000 },
      }),
    ]);

    expect(aggregates.get("kinesis")).toEqual({
      name: "Kinesis",
      volumeUsd: 30_000,
      priceVolumeWeightedSum: 29_900,
      depthDownUsd: 0,
      depthDownCount: 0,
      depthUpUsd: 0,
      depthUpCount: 0,
    });
    expect(aggregates.get("kraken")).toEqual({
      name: "Kraken",
      volumeUsd: 5_000,
      priceVolumeWeightedSum: 5_050,
      depthDownUsd: 0,
      depthDownCount: 0,
      depthUpUsd: 0,
      depthUpCount: 0,
    });
  });

  it("builds synthetic orderbook TVL and price observations with plausibility gating", () => {
    const summaries = buildCgTickerExchangeSummaries(
      new Map([
        [
          "kinesis",
          {
            name: "Kinesis",
            volumeUsd: 20_000,
            priceVolumeWeightedSum: 20_000,
            depthDownUsd: 0,
            depthDownCount: 0,
            depthUpUsd: 0,
            depthUpCount: 0,
          },
        ],
        [
          "tiny",
          {
            name: "Tiny Exchange",
            volumeUsd: 10_000,
            priceVolumeWeightedSum: 12_000,
            depthDownUsd: 0,
            depthDownCount: 0,
            depthUpUsd: 0,
            depthUpCount: 0,
          },
        ],
      ]),
    );

    expect(summaries).toEqual([
      {
        exchangeId: "kinesis",
        exchangeName: "Kinesis",
        volumeUsd: 20_000,
        volumeDerivedTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        depthDownUsd: null,
        depthUpUsd: null,
        tvlBasis: "volume-derived",
        priceUsd: 1,
      },
      {
        exchangeId: "tiny",
        exchangeName: "Tiny Exchange",
        volumeUsd: 10_000,
        volumeDerivedTvlUsd: 10_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 10_000 * ORDERBOOK_TVL_FACTOR,
        depthDownUsd: null,
        depthUpUsd: null,
        tvlBasis: "volume-derived",
        priceUsd: 1.2,
      },
    ]);

    const priceObs = buildCgTickerPriceObservations("usdc-circle", summaries);

    expect(priceObs).toEqual([
      {
        price: 1,
        tvl: 20_000 * ORDERBOOK_TVL_FACTOR,
        chain: "orderbook",
        protocol: "cg-ticker-kinesis",
      },
    ]);
  });

  it("uses measured 2% downside orderbook depth when available, capped by volume-derived TVL", () => {
    const summaries = buildCgTickerExchangeSummaries(
      new Map([
        [
          "deep",
          {
            name: "Deep Exchange",
            volumeUsd: 20_000,
            priceVolumeWeightedSum: 20_000,
            depthDownUsd: 500_000,
            depthDownCount: 1,
            depthUpUsd: 450_000,
            depthUpCount: 1,
          },
        ],
        [
          "shallow",
          {
            name: "Shallow Exchange",
            volumeUsd: 20_000,
            priceVolumeWeightedSum: 20_000,
            depthDownUsd: 12_000,
            depthDownCount: 1,
            depthUpUsd: 18_000,
            depthUpCount: 1,
          },
        ],
      ]),
    );

    expect(summaries).toEqual([
      expect.objectContaining({
        exchangeId: "deep",
        volumeDerivedTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        depthDownUsd: 500_000,
        depthUpUsd: 450_000,
        tvlBasis: "coingecko-depth-2pct-capped-by-volume",
      }),
      expect.objectContaining({
        exchangeId: "shallow",
        volumeDerivedTvlUsd: 20_000 * ORDERBOOK_TVL_FACTOR,
        syntheticTvlUsd: 12_000,
        depthDownUsd: 12_000,
        depthUpUsd: 18_000,
        tvlBasis: "coingecko-depth-2pct-capped-by-volume",
      }),
    ]);
  });
});
