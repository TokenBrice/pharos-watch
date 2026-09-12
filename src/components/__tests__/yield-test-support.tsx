import { render } from "@testing-library/react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { YieldMobileCard } from "@/components/yield-leaderboard";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import type { YieldBenchmarkRegistry } from "@shared/types";
import type { YieldRankingProvenance } from "@shared/types/yield";

/** Complete provenance record: spreading the factory's own (nullable) field widens the type. */
export const YIELD_TEST_PROVENANCE: YieldRankingProvenance = {
  sourceKey: "aave",
  sourceObservedAt: 0,
  sourceAgeSeconds: 60,
  confidenceTier: "curated",
  selectionMethod: "confidence-weighted",
  selectionReason: "best source",
  sourceSwitch: false,
  previousBestSourceKey: null,
  usedLegacyHistory: false,
  usedDefaultSafety: false,
  benchmarkRecordDate: null,
  benchmarkIsFallback: false,
  benchmarkFallbackMode: null,
  anomalies: [],
};

export function makeYieldViewModelRow(overrides: Partial<YieldViewModelRow> = {}): YieldViewModelRow {
  // YieldViewModelRow is an intersection, so spreading Partial<> into the literal
  // yields a union TypeScript cannot prove assignable. Build the full row, then merge.
  const base: YieldViewModelRow = {
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether",
    currentApy: 4.2,
    apy7d: 4.1,
    apy30d: 4.3,
    apyBase: 3.9,
    apyReward: 0.4,
    yieldSource: "Aave",
    yieldSourceUrl: "https://example.com/yield",
    yieldType: "lending-vault",
    dataSource: "fixture",
    sourceTvlUsd: 25_000_000,
    pharosYieldScore: 76,
    safetyScore: 82,
    safetyGrade: "B+",
    yieldToRisk: 1.1,
    excessYield: 0.6,
    benchmarkKey: "USD",
    benchmarkLabel: "USD short rate",
    benchmarkCurrency: "USD",
    benchmarkRate: 3.7,
    benchmarkIsFallback: false,
    benchmarkSelectionMode: "native",
    yieldStability: 0.9,
    apyVariance30d: 0.1,
    apyMin30d: 4,
    apyMax30d: 4.5,
    warningSignals: ["thin-source-depth"],
    altSources: [],
    provenance: YIELD_TEST_PROVENANCE,
    sourceRisk: null,
    peg: "USD",
    viewRank: 1,
    rankLabel: "#1",
    opportunity: "holder-yield",
    sourceDepthLens: "moderate",
    sourcePosture: "clean",
    cohortPercentile: null,
  };
  return Object.assign(base, overrides);
}

type MobileCardProps = React.ComponentProps<typeof YieldMobileCard>;

export function renderYieldMobileCard(
  row: YieldViewModelRow,
  overrides: Partial<Omit<MobileCardProps, "row">> = {},
) {
  return render(
    <TooltipProvider>
      <YieldMobileCard
        row={row}
        riskFreeRate={3.5}
        medianApy={4}
        scalingFactor={overrides.scalingFactor ?? 1}
        expanded={false}
        isCompared={false}
        compareDisabled={false}
        onToggleExpanded={vi.fn()}
        onOpenSourceSheet={vi.fn()}
        onToggleCompare={vi.fn()}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

/** Two-currency benchmark registry for zone-chip resolution tests (ZONE-CHIP). */
export const REGISTRY_WITH_EUR: YieldBenchmarkRegistry = {
  USD: {
    key: "USD",
    label: "USD 3M T-Bill",
    currency: "USD",
    rate: 4.25,
    recordDate: "2026-09-01",
    fetchedAt: 1_783_632_600,
    ageSeconds: 1_800,
    source: "fred-dgs3mo",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
  EUR: {
    key: "EUR",
    label: "EUR 3M compounded €STR",
    currency: "EUR",
    rate: 1.94,
    recordDate: "2026-09-01",
    fetchedAt: 1_783_632_600,
    ageSeconds: 1_800,
    source: "ecb-estr-3m",
    isFallback: false,
    fallbackMode: null,
    isProxy: false,
  },
};
