// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { scoreToGrade } from "@shared/lib/report-cards";
import type { DimensionKey, ReportCard } from "@shared/types";
import { usePortfolio } from "../use-portfolio";

const STORAGE_KEY = "pharos:portfolio";
const DIMENSIONS: DimensionKey[] = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
];

function makeCard(
  id: string,
  options: {
    overallScore: number | null;
    dimensions?: Partial<Record<DimensionKey, number | null>>;
  },
): ReportCard {
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => {
      const score = options.dimensions?.[dimension] ?? 80;
      return [
        dimension,
        {
          grade: scoreToGrade(score),
          score,
          detail: `${dimension} detail`,
        },
      ];
    }),
  ) as ReportCard["dimensions"];

  return {
    id,
    name: id,
    symbol: id.slice(0, 4).toUpperCase(),
    overallGrade: scoreToGrade(options.overallScore),
    overallScore: options.overallScore,
    baseScore: options.overallScore,
    dimensions,
    ratedDimensions: DIMENSIONS.filter((dimension) => dimensions[dimension].score !== null).length,
    rawInputs: createReportCardRawInputs({
      pegScore: dimensions.pegStability.score,
      liquidityScore: dimensions.liquidity.score,
      collateralQuality: "rwa",
      governanceQuality: "regulated-entity",
      custodyModel: "institutional-regulated",
    }),
    isDefunct: false,
  };
}

describe("usePortfolio", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/portfolio/");
  });

  it("excludes NR overall scores from weighted portfolio scoring", () => {
    const cards = [
      makeCard("usdc-circle", { overallScore: 90 }),
      makeCard("usdt-tether", { overallScore: null }),
    ];
    const { result } = renderHook(() => usePortfolio(cards));

    act(() => {
      result.current.addCoin("usdc-circle", 100);
      result.current.addCoin("usdt-tether", 900);
    });

    expect(result.current.totalUsd).toBe(1000);
    expect(result.current.portfolioScore).toBe(90);
    expect(result.current.portfolioGrade).toBe(scoreToGrade(90));
  });

  it("excludes null dimension scores from per-dimension weighted averages", () => {
    const cards = [
      makeCard("usdc-circle", {
        overallScore: 90,
        dimensions: { liquidity: 80 },
      }),
      makeCard("usdt-tether", {
        overallScore: 80,
        dimensions: { liquidity: null },
      }),
    ];
    const { result } = renderHook(() => usePortfolio(cards));

    act(() => {
      result.current.addCoin("usdc-circle", 100);
      result.current.addCoin("usdt-tether", 900);
    });

    expect(result.current.dimensionScores.liquidity).toBe(80);
  });

  it("returns NR and null dimensions for a zero-total draft portfolio", () => {
    const { result } = renderHook(() =>
      usePortfolio([makeCard("usdc-circle", { overallScore: 90 })]),
    );

    act(() => {
      result.current.addCoin("usdc-circle", 0);
    });

    expect(result.current.totalUsd).toBe(0);
    expect(result.current.portfolioGrade).toBe("NR");
    expect(result.current.portfolioScore).toBeNull();
    expect(Object.values(result.current.dimensionScores).every((score) => score === null)).toBe(true);
  });

  it("normalizes stored holdings and writes the migrated state back", () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { coinId: "usdc-circle", amount: 0 },
        { coinId: "usdt-tether", amount: -1 },
        { coinId: "1", amount: 2 },
        { coinId: "not-a-coin", amount: 5 },
      ]),
    );

    const { result } = renderHook(() => usePortfolio([]));

    expect(result.current.holdings).toEqual([
      { coinId: "usdc-circle", amount: 0 },
    ]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(result.current.holdings);
  });

  it("ignores invalid programmatic amounts", () => {
    const { result } = renderHook(() =>
      usePortfolio([makeCard("usdc-circle", { overallScore: 90 })]),
    );

    act(() => {
      result.current.addCoin("usdc-circle", 10);
      result.current.setAmount("usdc-circle", Infinity);
    });

    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 10 }]);
    expect(result.current.totalUsd).toBe(10);
  });

  it("persists clearAll for local storage portfolios", async () => {
    const { result } = renderHook(() =>
      usePortfolio([makeCard("usdc-circle", { overallScore: 90 })]),
    );

    act(() => {
      result.current.addCoin("usdc-circle", 10);
      result.current.clearAll();
    });

    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
    });
  });

  it("does not persist URL-sourced holdings to storage", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ coinId: "usdt-tether", amount: 50 }]));
    window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:0");

    const { result } = renderHook(() => usePortfolio([]));

    expect(result.current.isFromUrl).toBe(true);
    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual([
      { coinId: "usdt-tether", amount: 50 },
    ]);
  });

  it("seeds URL-sourced holdings from a router-supplied param without reading the location bar", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ coinId: "usdt-tether", amount: 50 }]));
    // location bar is bare ("/portfolio/"); the param arrives from the caller.
    const { result } = renderHook(() => usePortfolio([], "usdc-circle:0"));

    expect(result.current.isFromUrl).toBe(true);
    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
  });

  it("falls back to the location bar when no router param is supplied", () => {
    window.history.replaceState(null, "", "/portfolio/?p=usdc-circle:0");
    const { result } = renderHook(() => usePortfolio([]));

    expect(result.current.isFromUrl).toBe(true);
    expect(result.current.holdings).toEqual([{ coinId: "usdc-circle", amount: 0 }]);
  });

  it("treats an empty router param as no shared portfolio", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([{ coinId: "usdt-tether", amount: 50 }]));
    const { result } = renderHook(() => usePortfolio([], ""));

    expect(result.current.isFromUrl).toBe(false);
    expect(result.current.holdings).toEqual([{ coinId: "usdt-tether", amount: 50 }]);
  });

  it("builds share URLs from normalized holdings and removes p when empty", () => {
    const { result } = renderHook(() => usePortfolio([]));

    act(() => {
      result.current.addCoin("usdt-tether", 0);
      result.current.addCoin("usdc-circle", 20);
    });

    const shared = new URL(result.current.shareUrl());
    expect(shared.searchParams.get("p")).toBe("usdt-tether:0,usdc-circle:20");

    act(() => {
      result.current.clearAll();
    });

    expect(new URL(result.current.shareUrl()).searchParams.has("p")).toBe(false);
  });
});
