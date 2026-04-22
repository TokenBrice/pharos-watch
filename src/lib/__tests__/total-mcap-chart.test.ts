import { describe, expect, it } from "vitest";
import { buildCurrentTotalMcapRow, buildTotalMcapChartRows } from "../total-mcap-chart";

describe("buildTotalMcapChartRows", () => {
  it("aligns per-coin history to the latest snapshot at or before each downsampled chart point", () => {
    const rows = buildTotalMcapChartRows(
      [
        { date: 100, totalCirculatingUSD: { peggedUSD: 100 } },
        { date: 200, totalCirculatingUSD: { peggedUSD: 200 } },
        { date: 300, totalCirculatingUSD: { peggedUSD: 300 } },
      ],
      {
        usdtHistory: [
          { date: 90, circulatingUsd: 10, price: 1 },
          { date: 150, circulatingUsd: 20, price: 1 },
          { date: 260, circulatingUsd: 30, price: 1 },
        ],
        usdcHistory: [
          { date: 80, circulatingUsd: 5, price: 1 },
          { date: 210, circulatingUsd: 15, price: 1 },
        ],
        usdsHistory: [
          { date: 70, circulatingUsd: 2, price: 1 },
          { date: 220, circulatingUsd: 4, price: 1 },
        ],
        daiHistory: [
          { date: 95, circulatingUsd: 3, price: 1 },
          { date: 230, circulatingUsd: 6, price: 1 },
        ],
      },
    );

    expect(rows).toEqual([
      { ts: 100000, usdt: 10, usdc: 5, sky: 5, others: 80, total: 100 },
      { ts: 200000, usdt: 20, usdc: 5, sky: 5, others: 170, total: 200 },
      { ts: 300000, usdt: 30, usdc: 15, sky: 10, others: 245, total: 300 },
    ]);
  });

  it("does not leak future snapshots into earlier chart points", () => {
    const rows = buildTotalMcapChartRows(
      [
        { date: 100, totalCirculatingUSD: { peggedUSD: 50 } },
        { date: 200, totalCirculatingUSD: { peggedUSD: 75 } },
      ],
      {
        usdtHistory: [{ date: 150, circulatingUsd: 20, price: 1 }],
        usdcHistory: [],
        usdsHistory: [],
        daiHistory: [],
      },
    );

    expect(rows).toEqual([
      { ts: 100000, usdt: 0, usdc: 0, sky: 0, others: 50, total: 50 },
      { ts: 200000, usdt: 20, usdc: 0, sky: 0, others: 55, total: 75 },
    ]);
  });

  it("appends a live current snapshot so the latest chart total matches the live cache", () => {
    const currentSnapshot = buildCurrentTotalMcapRow(
      {
        peggedAssets: [
          {
            id: "usdt-tether",
            name: "Tether",
            symbol: "USDT",
            geckoId: "tether",
            pegType: "peggedUSD",
            pegMechanism: "fiat-backed",
            price: 1,
            priceSource: "defillama",
            priceConfidence: "high",
            priceUpdatedAt: null,
            priceObservedAt: null,
            priceObservedAtMode: null,
            priceSyncedAt: null,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 110 },
            circulatingPrevDay: {},
            circulatingPrevWeek: {},
            circulatingPrevMonth: {},
            chainCirculating: {},
            chains: [],
          },
          {
            id: "usdc-circle",
            name: "USD Coin",
            symbol: "USDC",
            geckoId: "usd-coin",
            pegType: "peggedUSD",
            pegMechanism: "fiat-backed",
            price: 1,
            priceSource: "defillama",
            priceConfidence: "high",
            priceUpdatedAt: null,
            priceObservedAt: null,
            priceObservedAtMode: null,
            priceSyncedAt: null,
            consensusSources: [],
            agreeSources: [],
            supplySource: "defillama",
            circulating: { peggedUSD: 70 },
            circulatingPrevDay: {},
            circulatingPrevWeek: {},
            circulatingPrevMonth: {},
            chainCirculating: {},
            chains: [],
          },
          {
            id: "susds-sky",
            name: "Savings USDS",
            symbol: "sUSDS",
            geckoId: "susds",
            pegType: "peggedUSD",
            pegMechanism: "yield-bearing",
            price: 1,
            priceSource: "coingecko",
            priceConfidence: "single-source",
            priceUpdatedAt: null,
            priceObservedAt: null,
            priceObservedAtMode: null,
            priceSyncedAt: null,
            consensusSources: [],
            agreeSources: [],
            supplySource: "coingecko-fallback",
            circulating: { peggedUSD: 20 },
            circulatingPrevDay: {},
            circulatingPrevWeek: {},
            circulatingPrevMonth: {},
            chainCirculating: {},
            chains: [],
          },
        ],
      },
      250000,
    );

    const rows = buildTotalMcapChartRows(
      [
        { date: 100, totalCirculatingUSD: { peggedUSD: 150 } },
        { date: 200, totalCirculatingUSD: { peggedUSD: 175 } },
      ],
      {
        usdtHistory: [],
        usdcHistory: [],
        usdsHistory: [],
        daiHistory: [],
      },
      currentSnapshot,
    );

    expect(rows).toEqual([
      { ts: 100000, usdt: 0, usdc: 0, sky: 0, others: 150, total: 150 },
      { ts: 200000, usdt: 0, usdc: 0, sky: 0, others: 175, total: 175 },
      { ts: 250000, usdt: 110, usdc: 70, sky: 0, others: 20, total: 200 },
    ]);
  });
});
