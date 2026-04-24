// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { YieldSourceBoard } from "@/app/yield/source-board";
import { buildYieldSourceBoardModel } from "@/app/yield/source-board-model";
import type { AltYieldSource, YieldRanking, YieldRankingProvenance } from "@shared/types";

function makeProvenance(overrides: Partial<YieldRankingProvenance> = {}): YieldRankingProvenance {
  return {
    sourceKey: "selected-source",
    sourceObservedAt: 1_776_000_000,
    sourceAgeSeconds: 300,
    comparisonAnchorObservedAt: null,
    comparisonAnchorAgeSeconds: null,
    confidenceTier: "deterministic",
    selectionMethod: "confidence-weighted",
    selectionReason: "selected by confidence-weighted arbitration",
    sourceSwitch: true,
    previousBestSourceKey: "previous-source",
    usedLegacyHistory: false,
    usedDefaultSafety: false,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 4.25,
    benchmarkRecordDate: "2026-04-23",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    anomalies: ["low-source-tvl"],
    ...overrides,
  };
}

function makeAltSource(overrides: Partial<AltYieldSource> = {}): AltYieldSource {
  return {
    sourceKey: "alt-source",
    yieldSource: "Aave V3 USDC",
    yieldSourceUrl: "https://example.com/aave",
    yieldType: "lending-opportunity",
    currentApy: 4,
    apy30d: 4,
    sourceTvlUsd: 2_000_000,
    dataSource: "defillama-auto",
    ...overrides,
  };
}

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    currentApy: 5,
    apy7d: 5,
    apy30d: 5,
    apyBase: null,
    apyReward: null,
    yieldSource: "Compound V3 USDC",
    yieldSourceUrl: "https://example.com/compound",
    yieldType: "lending-opportunity",
    dataSource: "protocol-api",
    sourceTvlUsd: 5_000_000,
    pharosYieldScore: 50,
    safetyScore: 80,
    safetyGrade: "A",
    yieldToRisk: 1.2,
    excessYield: 0.75,
    benchmarkKey: "USD",
    benchmarkLabel: "USD 3M T-Bill",
    benchmarkCurrency: "USD",
    benchmarkRate: 4.25,
    benchmarkRecordDate: "2026-04-23",
    benchmarkIsFallback: false,
    benchmarkFallbackMode: null,
    benchmarkSelectionMode: "native",
    benchmarkIsProxy: false,
    yieldStability: 0.9,
    apyVariance30d: 0.3,
    apyMin30d: 4.5,
    apyMax30d: 5.5,
    warningSignals: [],
    altSources: [makeAltSource()],
    provenance: makeProvenance(),
    ...overrides,
  };
}

describe("YieldSourceBoard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders exact source counts, selected-source confidence, source-row APY, and caveat text", () => {
    const model = buildYieldSourceBoardModel([
      makeRanking(),
      makeRanking({
        id: "usdt-tether",
        symbol: "USDT",
        name: "Tether",
        apy30d: 6,
        yieldSource: "Morpho USDT",
        dataSource: "protocol-api",
        provenance: makeProvenance({
          sourceKey: "morpho-usdt",
          confidenceTier: "curated",
          sourceSwitch: false,
          anomalies: [],
        }),
        altSources: [],
      }),
    ]);

    render(<YieldSourceBoard model={model} />);

    expect(screen.getByRole("heading", { name: "Source provenance in the current view" })).toBeTruthy();
    expect(screen.getByText("Selected-source confidence")).toBeTruthy();
    expect(screen.queryByText(/alternate-source confidence/i)).toBeNull();

    const sourceCounts = screen.getByText("Source rows").closest("dl");
    expect(sourceCounts ? within(sourceCounts).getByText("Selected") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("2") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("Alt") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("1") : null).toBeTruthy();
    expect(sourceCounts ? within(sourceCounts).getByText("3") : null).toBeTruthy();

    expect(screen.getByText("1 source switch")).toBeTruthy();
    expect(screen.getByText("1 selected row with source anomalies")).toBeTruthy();
    expect(screen.getAllByText("Source-row APY").length).toBeGreaterThan(1);
    expect(screen.getByText("4.00% / 4.00% / 4.00%")).toBeTruthy();
    expect(screen.getByText("USD 3M T-Bill")).toBeTruthy();
    expect(screen.getByText(/not an asset median, market median, investability rating, or safety signal/i)).toBeTruthy();
  });

  it("does not render an empty board", () => {
    const { container } = render(<YieldSourceBoard model={buildYieldSourceBoardModel([])} />);

    expect(container.textContent).toBe("");
  });
});
