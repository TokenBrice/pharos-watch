import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import {
  buildZephyrProtocolPeggedAsset,
  buildZephyrZsdPeggedAsset,
  buildZephyrZysPeggedAsset,
  parseZephyrProtocolStats,
  parseZephyrZsdStats,
  parseZephyrZysStats,
  ZEPHYR_ZSD_ASSET_ID,
  ZEPHYR_ZYS_ASSET_ID,
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

function makeZysMeta(): StablecoinMeta {
  return {
    id: ZEPHYR_ZYS_ASSET_ID,
    name: "Zephyr Yield Share",
    symbol: "ZYS",
    detailProvider: "coingecko",
    flags: {
      pegCurrency: "USD",
      backing: "crypto-backed",
      governance: "decentralized",
      yieldBearing: true,
      rwa: false,
      navToken: true,
    },
  } as StablecoinMeta;
}

describe("parseZephyrZsdStats", () => {
  it("uses official zsd_circ and reasonable live zsd_price for fallback price metadata", () => {
    expect(parseZephyrZsdStats({
      zsd_circ: 385_038.0963333748,
      zsd_price: 1.003,
    })).toEqual({
      supply: 385_038.0963333748,
      mcapPrice: 1.003,
      mcap: 386_193.2106223749,
      priceReported: true,
    });
  });

  it("ignores unreasonable live zsd_price values for ZSD market-cap metadata", () => {
    expect(parseZephyrZsdStats({
      zsd_circ: 12_345,
      zsd_price: "1000000000000",
    })).toEqual({
      supply: 12_345,
      mcapPrice: 1,
      mcap: 12_345,
      priceReported: false,
    });

    expect(parseZephyrZsdStats({
      zsd_circ: 12_345,
      zsd_price: "0.000001",
    })).toEqual({
      supply: 12_345,
      mcapPrice: 1,
      mcap: 12_345,
      priceReported: false,
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
      priceReported: false,
    });
  });

  it("rejects payloads without a positive official ZSD circulation", () => {
    expect(parseZephyrZsdStats({ zsd_price: 1 })).toBeNull();
    expect(parseZephyrZsdStats({ zsd_circ: 0, zsd_price: 1 })).toBeNull();
    expect(parseZephyrZsdStats(null)).toBeNull();
  });
});

describe("parseZephyrZysStats", () => {
  it("uses official ZYS circulation and share price for NAV market cap", () => {
    expect(parseZephyrZysStats({
      zys_circ: 165_587.3320289986,
      zys_price: 1.9068,
    })).toEqual({
      supply: 165_587.3320289986,
      mcapPrice: 1.9068,
      mcap: 315_741.9247128945,
      priceReported: true,
    });
  });

  it("rejects ZYS payloads without a positive share price", () => {
    expect(parseZephyrZysStats({ zys_circ: 165_587.3320289986 })).toBeNull();
    expect(parseZephyrZysStats({ zys_circ: 165_587.3320289986, zys_price: 0 })).toBeNull();
  });
});

describe("parseZephyrProtocolStats", () => {
  it("requires ZSD stats and carries ZYS stats when present", () => {
    expect(parseZephyrProtocolStats({
      zsd_circ: 385_038.0963333748,
      zsd_price: 0.9999,
      zys_circ: 165_587.3320289986,
      zys_price: 1.9068,
    })).toMatchObject({
      zsd: {
        supply: 385_038.0963333748,
        mcapPrice: 0.9999,
      },
      zys: {
        supply: 165_587.3320289986,
        mcapPrice: 1.9068,
      },
    });
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
      circulating: { peggedUSD: 384_268.020140708 },
      chainCirculating: {},
      chains: [],
    });
  });

  it("falls back to peg price for ZSD market cap when supplemental price is unreasonable", () => {
    const asset = buildZephyrZsdPeggedAsset(
      makeZsdMeta(),
      { supply: 1_000, mcapPrice: 1, mcap: 1_000 },
      {
        price: 50_000,
        source: "coingecko",
        observedAt: 1_700_000_000,
        observedAtMode: "upstream",
      },
      1_700_000_060,
    );

    expect(asset).toMatchObject({
      price: 50_000,
      priceSource: "coingecko",
      circulating: { peggedUSD: 1_000 },
    });
  });

  it("uses Zephyr Scanner price as a fallback when the official ZSD price is reported", () => {
    const asset = buildZephyrZsdPeggedAsset(
      makeZsdMeta(),
      { supply: 385_038.0963333748, mcapPrice: 0.9999, mcap: 384_999.5925237415, priceReported: true },
      null,
      1_700_000_060,
    );

    expect(asset).toMatchObject({
      price: 0.9999,
      priceSource: "zephyr-scanner",
      priceConfidence: "single-source",
      priceUpdatedAt: 1_700_000_060,
      priceObservedAt: 1_700_000_060,
      priceObservedAtMode: "local_fetch",
      priceSyncedAt: 1_700_000_060,
      supplySource: "zephyr-scanner",
      circulating: { peggedUSD: 385_038.0963333748 },
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

describe("buildZephyrZysPeggedAsset", () => {
  it("publishes ZYS NAV supply and price from Zephyr Scanner", () => {
    const asset = buildZephyrZysPeggedAsset(
      makeZysMeta(),
      { supply: 165_587.3320289986, mcapPrice: 1.9068, mcap: 315_741.9247128945, priceReported: true },
      1_700_000_060,
    );

    expect(asset).toMatchObject({
      id: ZEPHYR_ZYS_ASSET_ID,
      symbol: "ZYS",
      pegType: "peggedUSD",
      price: 1.9068,
      priceSource: "zephyr-scanner",
      priceConfidence: "single-source",
      supplySource: "zephyr-scanner",
      circulating: { peggedUSD: 315_741.9247128945 },
      chainCirculating: {},
      chains: [],
    });
  });
});

describe("buildZephyrProtocolPeggedAsset", () => {
  it("routes protocol stats by stablecoin id", () => {
    const stats = {
      zsd: { supply: 385_038.0963333748, mcapPrice: 0.9999, mcap: 384_999.5925237415, priceReported: true },
      zys: { supply: 165_587.3320289986, mcapPrice: 1.9068, mcap: 315_741.9247128945, priceReported: true },
    };

    expect(buildZephyrProtocolPeggedAsset(makeZsdMeta(), stats, null, 1_700_000_060)?.id)
      .toBe(ZEPHYR_ZSD_ASSET_ID);
    expect(buildZephyrProtocolPeggedAsset(makeZysMeta(), stats, null, 1_700_000_060)?.id)
      .toBe(ZEPHYR_ZYS_ASSET_ID);
  });
});
