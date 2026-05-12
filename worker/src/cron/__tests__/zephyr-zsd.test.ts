import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  buildZephyrZsdPeggedAsset,
  parseZephyrZsdStats,
  ZEPHYR_ZSD_ASSET_ID,
} from "../sync-stablecoins/zephyr-zsd";

function makeZsdMeta(): StablecoinMeta {
  return {
    id: ZEPHYR_ZSD_ASSET_ID,
    name: "Zephyr Stable Dollar",
    symbol: "ZSD",
    detailProvider: "coingecko",
    geckoId: "zephyr-protocol-stable-dollar",
    flags: {
      pegCurrency: "USD",
      backing: "crypto-backed",
      governance: "decentralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

describe("parseZephyrZsdStats", () => {
  it("uses official zsd_circ and live zsd_price for market cap", () => {
    expect(parseZephyrZsdStats({
      zsd_circ: 385_038.0963333748,
      zsd_price: 1.003,
    })).toEqual({
      supply: 385_038.0963333748,
      mcapPrice: 1.003,
      mcap: 386_193.2106223749,
    });
  });

  it("falls back to a 1.0 USD peg market-cap price when zsd_price is unavailable", () => {
    expect(parseZephyrZsdStats({
      zsd_circ: "385038.0963333748",
      zsd_price: 0,
    })).toEqual({
      supply: 385_038.0963333748,
      mcapPrice: 1,
      mcap: 385_038.0963333748,
    });
  });

  it("rejects payloads without a positive official ZSD circulation", () => {
    expect(parseZephyrZsdStats({ zsd_price: 1 })).toBeNull();
    expect(parseZephyrZsdStats({ zsd_circ: 0, zsd_price: 1 })).toBeNull();
    expect(parseZephyrZsdStats(null)).toBeNull();
  });
});

describe("buildZephyrZsdPeggedAsset", () => {
  it("builds a PeggedAsset that sources supply from Zephyr Scanner and price from CoinGecko", () => {
    const asset = buildZephyrZsdPeggedAsset(
      makeZsdMeta(),
      { supply: 385_038.0963333748, mcapPrice: 1.003, mcap: 386_193.2106223749 },
      {
        price: 0.998,
        source: "coingecko",
        observedAt: 1_700_000_000,
        observedAtMode: "upstream",
      },
      1_700_000_060,
    );

    expect(asset).toMatchObject({
      id: ZEPHYR_ZSD_ASSET_ID,
      symbol: "ZSD",
      geckoId: "zephyr-protocol-stable-dollar",
      pegType: "peggedUSD",
      price: 0.998,
      priceSource: "coingecko",
      priceConfidence: "single-source",
      priceUpdatedAt: 1_700_000_000,
      priceObservedAt: 1_700_000_000,
      priceObservedAtMode: "upstream",
      priceSyncedAt: 1_700_000_060,
      supplySource: "zephyr-scanner",
      circulating: { peggedUSD: 386_193.2106223749 },
      chainCirculating: {},
      chains: [],
    });
  });

  it("still publishes official supply when CoinGecko price is unavailable", () => {
    const asset = buildZephyrZsdPeggedAsset(
      makeZsdMeta(),
      { supply: 385_038.0963333748, mcapPrice: 1, mcap: 385_038.0963333748 },
      null,
      1_700_000_060,
    );

    expect(asset).toMatchObject({
      price: null,
      priceConfidence: null,
      priceUpdatedAt: null,
      priceObservedAt: null,
      priceObservedAtMode: null,
      priceSyncedAt: null,
      supplySource: "zephyr-scanner",
      circulating: { peggedUSD: 385_038.0963333748 },
    });
  });
});
