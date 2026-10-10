import { describe, expect, it } from "vitest";
import { buildTotalMcapChartRows } from "../total-mcap-chart";
import { MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC } from "@shared/lib/rate-series";
import productionFixtureJson from "./fixtures/hero-cohort-history.json";

// JSON imports widen literal unions such as `aggregateUniverse`; the fixture is production-shaped.
const productionFixture = productionFixtureJson as unknown as {
  chartPoints: Parameters<typeof buildTotalMcapChartRows>[0];
  histories: Parameters<typeof buildTotalMcapChartRows>[1];
  expected: ReturnType<typeof buildTotalMcapChartRows>;
};

const observedProductionExpected = productionFixture.expected.map((row, index) => ({
  ...row,
  ...(index === 0 ? { usdc: null } : {}),
  ...(index < 4 ? { sky: null, others: null } : {}),
  ...(index < 5 ? { total: null, nonUsd: null, others: null } : {}),
}));

describe("buildTotalMcapChartRows", () => {
  it("preserves observed production values without inventing coverage before the archive begins", () => {
    // Reduced from the homepage's five production endpoints on 2026-09-28.
    const rows = buildTotalMcapChartRows(productionFixture.chartPoints, productionFixture.histories);
    expect(rows).toEqual(observedProductionExpected);
  });

  it.each([null, []])("does not fold failed or empty USDC history into Others (%j)", (usdcHistory) => {
    const rows = buildTotalMcapChartRows(productionFixture.chartPoints, {
      ...productionFixture.histories,
      usdcHistory,
    });
    expect(rows).toEqual(observedProductionExpected.map((row) => ({
      ...row, usdc: null, others: null,
    })));
  });

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
      { ts: 100000, usdt: 10, usdc: 5, sky: 5, others: 80, nonUsd: 0, total: 100 },
      { ts: 200000, usdt: 20, usdc: 5, sky: 5, others: 170, nonUsd: 0, total: 200 },
      { ts: 300000, usdt: 30, usdc: 15, sky: 10, others: 245, nonUsd: 0, total: 300 },
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
      { ts: 100000, usdt: null, usdc: null, sky: null, others: null, nonUsd: 0, total: 50 },
      { ts: 200000, usdt: 20, usdc: null, sky: null, others: null, nonUsd: 0, total: 75 },
    ]);
  });

  it("withholds Sky and Others before USDS is observed, while preserving observed DAI", () => {
    const rows = buildTotalMcapChartRows(
      [
        { date: 1_580_000_000, totalCirculatingUSD: { peggedUSD: 10_000 } },
        { date: 1_620_000_000, totalCirculatingUSD: { peggedUSD: 20_000 } },
      ],
      {
        usdtHistory: [
          { date: 1_580_000_000, circulatingUsd: 4_000, price: 1 },
          { date: 1_620_000_000, circulatingUsd: 8_000, price: 1 },
        ],
        usdcHistory: [
          { date: 1_580_000_000, circulatingUsd: 2_000, price: 1 },
          { date: 1_620_000_000, circulatingUsd: 4_000, price: 1 },
        ],
        usdsHistory: [
          { date: 1_620_000_000, circulatingUsd: 500, price: 1 },
        ],
        daiHistory: [
          { date: 1_580_000_000, circulatingUsd: 1_000, price: 1 },
          { date: 1_620_000_000, circulatingUsd: 2_000, price: 1 },
        ],
      },
    );

    expect(rows).toEqual([
      { ts: 1_580_000_000_000, usdt: 4_000, usdc: 2_000, sky: null, others: null, nonUsd: 0, total: 10_000 },
      { ts: 1_620_000_000_000, usdt: 8_000, usdc: 4_000, sky: 2_500, others: 5_500, nonUsd: 0, total: 20_000 },
    ]);
  });

  it("derives the non-USD line from aggregate non-USD chart buckets", () => {
    const rows = buildTotalMcapChartRows(
      [
        { date: 100, totalCirculatingUSD: { peggedUSD: 100, peggedEUR: 8, peggedGOLD: 2, peggedCHF: 0 } },
        { date: 200, totalCirculatingUSD: { peggedUSD: 140, peggedEUR: 10, peggedCHF: 3, peggedGOLD: 0 } },
      ],
      {
        usdtHistory: [],
        usdcHistory: [],
        usdsHistory: [],
        daiHistory: [],
      },
    );

    expect(rows.map((row) => row.nonUsd)).toEqual([10, 13]);
    expect(rows.map((row) => row.total)).toEqual([110, 153]);
  });

  it("sorts history and includes a snapshot exactly at the chart timestamp", () => {
    expect(buildTotalMcapChartRows(
      [{ date: 100, totalCirculatingUSD: { peggedUSD: 100 } }],
      {
        usdtHistory: [
          { date: 200, circulatingUsd: 80, price: 1 },
          { date: 100, circulatingUsd: 30, price: 1 },
          { date: 90, circulatingUsd: 10, price: 1 },
        ],
        usdcHistory: [], usdsHistory: [], daiHistory: [],
      },
    )).toEqual([{ ts: 100000, usdt: 30, usdc: null, sky: null, others: null, nonUsd: 0, total: 100 }]);
  });

  it("withholds an unexplained negative residual without changing the observed cohorts or total", () => {
    expect(buildTotalMcapChartRows(
      [{ date: 100, totalCirculatingUSD: { peggedUSD: 20 } }],
      {
        usdtHistory: [{ date: 100, circulatingUsd: 30, price: 1 }],
        usdcHistory: [{ date: 100, circulatingUsd: 0, price: 1 }],
        usdsHistory: [{ date: 100, circulatingUsd: 0, price: 1 }],
        daiHistory: [{ date: 100, circulatingUsd: 0, price: 1 }],
      },
    )).toEqual([{ ts: 100000, usdt: 30, usdc: 0, sky: 0, others: null, nonUsd: 0, total: 20 }]);
  });

  it("preserves explicit observed zero and computes a known residual", () => {
    const zero = [{ date: 100, circulatingUsd: 0, price: 1 }];
    expect(buildTotalMcapChartRows(
      [{ date: 100, totalCirculatingUSD: { peggedUSD: 20 } }],
      { usdtHistory: zero, usdcHistory: zero, usdsHistory: zero, daiHistory: zero },
    )).toEqual([{ ts: 100000, usdt: 0, usdc: 0, sky: 0, others: 20, nonUsd: 0, total: 20 }]);
  });

  it("retains the aggregate when all histories are unavailable", () => {
    expect(buildTotalMcapChartRows(
      [{ date: 100, totalCirculatingUSD: { peggedUSD: 100 } }],
      { usdtHistory: null, usdcHistory: null, usdsHistory: null, daiHistory: null },
    )).toEqual([{ ts: 100000, usdt: null, usdc: null, sky: null, others: null, nonUsd: 0, total: 100 }]);
  });

  it.each(["usdtHistory", "usdcHistory", "usdsHistory", "daiHistory"] as const)(
    "withholds only dependent cohorts until %s recovers",
    (missing) => {
      const observed = [{ date: 100, circulatingUsd: 10, price: 1 }];
      const histories = {
        usdtHistory: observed, usdcHistory: observed, usdsHistory: observed, daiHistory: observed,
      };
      const points = [{ date: 100, totalCirculatingUSD: { peggedUSD: 100 } }];
      const [unavailable] = buildTotalMcapChartRows(points, { ...histories, [missing]: null });
      expect(unavailable).toEqual({
        ts: 100000,
        total: 100,
        nonUsd: 0,
        usdt: missing === "usdtHistory" ? null : 10,
        usdc: missing === "usdcHistory" ? null : 10,
        sky: missing === "usdsHistory" || missing === "daiHistory" ? null : 20,
        others: null,
      });
      expect(buildTotalMcapChartRows(points, histories)).toEqual([
        { ts: 100000, total: 100, nonUsd: 0, usdt: 10, usdc: 10, sky: 20, others: 60 },
      ]);
    },
  );

  it("carries history only through the shared distance budget and recovers on a new observation", () => {
    const date = 1_700_000_000;
    const next = date + MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC + 1;
    const history = [
      { date: next + 1, circulatingUsd: 20, price: 1 },
      { date, circulatingUsd: 10, price: 1 },
    ];
    const rows = buildTotalMcapChartRows(
      [next + 1, date + MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC, date - 1, next].map((date) => ({
        date, totalCirculatingUSD: { peggedUSD: 100 },
      })),
      { usdtHistory: history, usdcHistory: history, usdsHistory: history, daiHistory: history },
    );
    expect(rows.map(({ usdt, usdc, sky, others }) => ({ usdt, usdc, sky, others }))).toEqual([
      { usdt: 20, usdc: 20, sky: 40, others: 20 },
      { usdt: 10, usdc: 10, sky: 20, others: 60 },
      { usdt: null, usdc: null, sky: null, others: null },
      { usdt: null, usdc: null, sky: null, others: null },
    ]);
  });

  it("admits pre-inception zero only from an explicitly dated historical backfill row", () => {
    const history = [
      { date: 100, circulatingUsd: 0, price: null },
      { date: 200, circulatingUsd: 10, price: 1 },
    ];
    expect(buildTotalMcapChartRows(
      [90, 100, 150, 200].map((date) => ({ date, totalCirculatingUSD: { peggedUSD: 100 } })),
      { usdtHistory: history, usdcHistory: history, usdsHistory: history, daiHistory: history },
    ).map((row) => [row.usdt, row.sky, row.others])).toEqual([
      [null, null, null], [0, 0, 100], [0, 0, 100], [10, 20, 60],
    ]);
  });

  it("withholds aggregate-dependent values when a published bucket is unavailable", () => {
    const zero = [{ date: 100, circulatingUsd: 0, price: 1 }];
    expect(buildTotalMcapChartRows(
      [{ date: 100, totalCirculatingUSD: { peggedUSD: 100, peggedEUR: null } }],
      { usdtHistory: zero, usdcHistory: zero, usdsHistory: zero, daiHistory: zero },
    )).toEqual([{ ts: 100000, usdt: 0, usdc: 0, sky: 0, others: null, nonUsd: null, total: null }]);
  });

  it("preserves omitted historical buckets as unavailable across legacy cache points", () => {
    const rows = buildTotalMcapChartRows([
      { date: 100, totalCirculatingUSD: { peggedUSD: 100, peggedEUR: 10 } },
      { date: 200, totalCirculatingUSD: { peggedUSD: 100 } },
      { date: 300, totalCirculatingUSD: { peggedUSD: 100, peggedEUR: 0 } },
    ], { usdtHistory: null, usdcHistory: null, usdsHistory: null, daiHistory: null });
    expect(rows.map((row) => [row.total, row.nonUsd])).toEqual([[110, 10], [null, null], [100, 0]]);
  });

  it("returns no rows for an empty chart", () => {
    expect(buildTotalMcapChartRows([], {
      usdtHistory: [{ date: 100, circulatingUsd: 30, price: 1 }],
      usdcHistory: [], usdsHistory: [], daiHistory: [],
    })).toEqual([]);
  });
});
