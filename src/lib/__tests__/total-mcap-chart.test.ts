import { describe, expect, it } from "vitest";
import { buildTotalMcapChartRows } from "../total-mcap-chart";

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

  it("keeps pre-2021 rows aligned with long-range cohort history instead of zeroing the majors", () => {
    const rows = buildTotalMcapChartRows(
      [
        { date: 1_580_000_000, totalCirculatingUSD: { peggedUSD: 10_000 } },
        { date: 1_620_000_000, totalCirculatingUSD: { peggedUSD: 20_000 } },
      ],
      {
        usdtHistory: [
          { date: 1_570_000_000, circulatingUsd: 4_000, price: 1 },
          { date: 1_610_000_000, circulatingUsd: 8_000, price: 1 },
        ],
        usdcHistory: [
          { date: 1_570_000_000, circulatingUsd: 2_000, price: 1 },
          { date: 1_610_000_000, circulatingUsd: 4_000, price: 1 },
        ],
        usdsHistory: [
          { date: 1_570_000_000, circulatingUsd: 500, price: 1 },
        ],
        daiHistory: [
          { date: 1_570_000_000, circulatingUsd: 1_000, price: 1 },
          { date: 1_610_000_000, circulatingUsd: 2_000, price: 1 },
        ],
      },
    );

    expect(rows).toEqual([
      { ts: 1_580_000_000_000, usdt: 4_000, usdc: 2_000, sky: 1_500, others: 2_500, total: 10_000 },
      { ts: 1_620_000_000_000, usdt: 8_000, usdc: 4_000, sky: 2_500, others: 5_500, total: 20_000 },
    ]);
  });
});
