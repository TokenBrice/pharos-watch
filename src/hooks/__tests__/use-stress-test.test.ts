// @vitest-environment jsdom

"use client";

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { GRADE_THRESHOLDS, scoreToGrade } from "@shared/lib/report-cards";
import type { DimensionKey, ReportCard, ReportCardsResponse } from "@shared/types";
import { parseStressSelectionFromSearch, useStressTest } from "../use-stress-test";

const DIMENSIONS: DimensionKey[] = [
  "pegStability",
  "liquidity",
  "resilience",
  "decentralization",
  "dependencyRisk",
];

function makeCard(
  id: string,
  score: number,
  dependencies: Array<{ id: string; weight: number }> = [],
): ReportCard {
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      {
        grade: scoreToGrade(score),
        score,
        detail: `${dimension} detail`,
      },
    ]),
  ) as ReportCard["dimensions"];

  return {
    id,
    name: id,
    symbol: id.slice(0, 4).toUpperCase(),
    overallGrade: scoreToGrade(score),
    overallScore: score,
    baseScore: score,
    dimensions,
    ratedDimensions: DIMENSIONS.length,
    rawInputs: createReportCardRawInputs({
      pegScore: score,
      liquidityScore: score,
      collateralQuality: "rwa",
      governanceQuality: "regulated-entity",
      dependencies,
      custodyModel: "institutional-regulated",
    }),
    isDefunct: false,
  };
}

function makeReportData(): ReportCardsResponse {
  return {
    cards: [
      makeCard("usdc-circle", 90),
      makeCard("usdt-tether", 84),
      makeCard("dai-makerdao", 86, [
        { id: "usdc-circle", weight: 0.5 },
        { id: "usdt-tether", weight: 0.2 },
      ]),
      makeCard("frax-frax", 82, [{ id: "usdc-circle", weight: 0.8 }]),
    ],
    methodology: {
      version: "test",
      weights: {
        pegStability: 0,
        liquidity: 0.3,
        resilience: 0.2,
        decentralization: 0.15,
        dependencyRisk: 0.25,
      },
      pegMultiplierExponent: 0.4,
      thresholds: GRADE_THRESHOLDS,
    },
    dependencyGraph: {
      edges: [
        { from: "usdc-circle", to: "dai-makerdao", weight: 0.5, type: "collateral" },
        { from: "usdc-circle", to: "frax-frax", weight: 0.8, type: "collateral" },
        { from: "usdt-tether", to: "dai-makerdao", weight: 0.2, type: "collateral" },
      ],
    },
    updatedAt: 1,
  };
}

describe("parseStressSelectionFromSearch", () => {
  it("parses canonical ids from the query string", () => {
    expect(parseStressSelectionFromSearch("?stress=usdf-falcon&grade=D")).toEqual({
      coinId: "usdf-falcon",
      grade: "D",
    });
  });

  it("rejects non-canonical stress params", () => {
    expect(parseStressSelectionFromSearch("?stress=usdf&grade=D")).toEqual({
      coinId: null,
      grade: null,
    });
    expect(parseStressSelectionFromSearch("?stress=1&grade=D")).toEqual({
      coinId: null,
      grade: null,
    });
  });
});

describe("useStressTest", () => {
  it("sorts targetable coins by dependent count and exposes only downgrade options", () => {
    const { result } = renderHook(() => useStressTest(makeReportData()));

    expect(result.current.targetableCoins.map((coin) => [coin.id, coin.dependentCount])).toEqual([
      ["usdc-circle", 2],
      ["usdt-tether", 1],
    ]);

    act(() => {
      result.current.setTarget("usdc-circle");
    });

    expect(result.current.gradeOptions).toEqual(["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D", "F"]);
  });

  it("resets grade when the target changes", () => {
    const { result } = renderHook(() => useStressTest(makeReportData()));

    act(() => {
      result.current.setTarget("usdc-circle");
      result.current.setGrade("D");
    });
    expect(result.current.targetGrade).toBe("D");

    act(() => {
      result.current.setTarget("usdt-tether");
    });
    expect(result.current.targetGrade).toBeNull();
  });

  it("produces affected ids and impacts sorted by absolute delta", () => {
    const { result } = renderHook(() => useStressTest(makeReportData()));

    act(() => {
      result.current.setTarget("usdc-circle");
      result.current.setGrade("D");
    });

    expect(result.current.allAffectedIds.has("usdc-circle")).toBe(true);
    expect(result.current.allAffectedIds.has("dai-makerdao")).toBe(true);
    expect(result.current.impacts.length).toBeGreaterThan(1);
    expect(result.current.impacts.map((impact) => Math.abs(impact.delta))).toEqual(
      [...result.current.impacts].map((impact) => Math.abs(impact.delta)).sort((a, b) => b - a),
    );
  });

  it("uses mcapMap for headline totals and systemic risk ordering", () => {
    const mcapMap = new Map([
      ["usdc-circle", 100],
      ["usdt-tether", 200],
      ["dai-makerdao", 500],
      ["frax-frax", 300],
    ]);
    const { result } = renderHook(() => useStressTest(makeReportData(), mcapMap));

    expect(result.current.systemicRisks[0]).toMatchObject({
      coinId: "usdc-circle",
      dependentSupplyAtRisk: expect.any(Number),
    });
    expect(result.current.systemicRisks[0].dependentSupplyAtRisk).toBeGreaterThan(
      result.current.systemicRisks[1].dependentSupplyAtRisk,
    );

    act(() => {
      result.current.setTarget("usdc-circle");
      result.current.setGrade("D");
    });

    expect(result.current.headline).toMatchObject({
      totalSupply: 1100,
      affectedCount: result.current.allAffectedIds.size,
    });
    expect(result.current.headline?.totalAtRisk).toBeGreaterThan(0);
  });

  it("returns stable empty state without report data", () => {
    const { result } = renderHook(() => useStressTest(undefined));

    expect(result.current.targetableCoins).toEqual([]);
    expect(result.current.gradeOptions).toEqual([]);
    expect(result.current.stressedCards).toBeNull();
    expect(result.current.impacts).toEqual([]);
    expect(result.current.headline).toBeNull();
    expect(result.current.systemicRisks).toEqual([]);
  });
});
