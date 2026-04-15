// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportCardsClient } from "./client";
import type { ReportCard } from "@shared/types";

const refetchReportCards = vi.fn();
const refetchPrices = vi.fn();

let reportCardsState: {
  data: { cards: ReportCard[] } | undefined;
  isLoading: boolean;
  dataUpdatedAt: number;
  error: Error | null;
  meta: Record<string, unknown>;
} = {
  data: undefined,
  isLoading: false,
  dataUpdatedAt: 0,
  error: null,
  meta: {},
};

let stablecoinsState: {
  data: { peggedAssets: Array<{ id: string; circulating?: Record<string, number> | null; chains: string[] }> } | undefined;
  dataUpdatedAt: number;
  error: Error | null;
  meta: Record<string, unknown>;
} = {
  data: undefined,
  dataUpdatedAt: 0,
  error: null,
  meta: {},
};

let stressTestState: {
  stressedCards: ReportCard[] | null;
  allAffectedIds: Set<string>;
  systemicRisks: unknown[];
  targetCoinId: string | null;
  targetGrade: string | null;
  clear: () => void;
} = {
  stressedCards: null,
  allAffectedIds: new Set(),
  systemicRisks: [],
  targetCoinId: null,
  targetGrade: null,
  clear: vi.fn(),
};

vi.mock("@/hooks/api-hooks", () => ({
  useReportCards: () => ({
    ...reportCardsState,
    refetch: refetchReportCards,
  }),
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: () => ({
    ...stablecoinsState,
    refetch: refetchPrices,
  }),
}));

vi.mock("@/hooks/use-logos", () => ({
  useLogos: () => ({ data: {} }),
}));

vi.mock("@/hooks/use-stress-test", () => ({
  useStressTest: () => stressTestState,
}));

vi.mock("@/components/report-card-mini", () => ({
  ReportCardMini: ({ card, coreSettlement }: { card: ReportCard; coreSettlement?: boolean }) => (
    <article data-testid={`report-card-${card.id}`}>
      {card.symbol}
      {coreSettlement ? " Core rail" : ""}
    </article>
  ),
}));

vi.mock("@/components/stress-test-panel", () => ({
  StressTestPanel: () => <div>stress-test-panel</div>,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

vi.mock("@/components/query-error-notice", () => ({
  QueryErrorNotice: ({ error }: { error?: Error | null }) => error ? <div role="alert">{error.message}</div> : null,
}));

vi.mock("@/components/systemic-risk-headline", () => ({
  SystemicRiskHeadline: ({ onOpenSimulator }: { onOpenSimulator: () => void }) => (
    <button onClick={onOpenSimulator}>open-simulator</button>
  ),
}));

function makeCard(overrides: Partial<ReportCard> = {}): ReportCard {
  return {
    id: overrides.id ?? "usdc-circle",
    name: overrides.name ?? "USD Coin",
    symbol: overrides.symbol ?? "USDC",
    overallScore: overrides.overallScore !== undefined ? overrides.overallScore : 92,
    overallGrade: overrides.overallGrade ?? "A",
    isDefunct: overrides.isDefunct ?? false,
    dimensions: overrides.dimensions ?? {
      pegStability: { score: 95, grade: "A" },
      liquidity: { score: 90, grade: "A" },
      resilience: { score: 88, grade: "B+" },
      decentralization: { score: 70, grade: "B-" },
      dependencyRisk: { score: 95, grade: "A+" },
    },
    rawInputs: overrides.rawInputs ?? {
      pegScore: 95,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 90,
      effectiveExitScore: 90,
      redemptionBackstopScore: 65,
      redemptionRouteFamily: "offchain-issuer",
      redemptionModelConfidence: "medium",
      redemptionUsedForLiquidity: true,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: 0.01,
      bluechipGrade: null,
      canBeBlacklisted: true,
      chainTier: "ethereum",
      deploymentModel: "native-multichain",
      collateralQuality: "rwa",
      custodyModel: "institutional-top",
      governanceTier: "centralized",
      governanceQuality: "regulated-entity",
      dependencies: [],
      navToken: false,
      collateralFromLive: true,
    },
  } as ReportCard;
}

describe("ReportCardsClient", () => {
  beforeEach(() => {
    refetchReportCards.mockReset();
    refetchPrices.mockReset();
    window.history.replaceState(null, "", "/safety-scores/");
    reportCardsState = {
      data: {
        cards: [
          makeCard({ id: "usdc-circle", overallScore: 92, overallGrade: "A" }),
          makeCard({ id: "usdt-tether", symbol: "USDT", overallScore: 81, overallGrade: "B" }),
        ],
      },
      isLoading: false,
      dataUpdatedAt: Date.now(),
      error: null,
      meta: {},
    };
    stablecoinsState = {
      data: {
        peggedAssets: [
          { id: "usdc-circle", circulating: { peggedUSD: 60_000_000_000 }, chains: Array.from({ length: 20 }, (_, i) => `chain-${i}`) },
          { id: "usdt-tether", circulating: { peggedUSD: 120_000_000_000 }, chains: Array.from({ length: 20 }, (_, i) => `chain-${i}`) },
        ],
      },
      dataUpdatedAt: Date.now(),
      error: null,
      meta: {},
    };
    stressTestState = {
      stressedCards: null,
      allAffectedIds: new Set(),
      systemicRisks: [],
      targetCoinId: null,
      targetGrade: null,
      clear: vi.fn(),
    };

    vi.stubGlobal("IntersectionObserver", class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe() {
        this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders report-card groups and filters the visible cards by grade", () => {
    render(<ReportCardsClient />);

    expect(screen.getByText("Safety Landscape")).toBeTruthy();
    expect(screen.getByText("Core settlement rails")).toBeTruthy();
    expect(screen.getByTestId("report-card-usdc-circle")).toBeTruthy();
    expect(screen.getByTestId("report-card-usdt-tether")).toBeTruthy();
    expect(screen.getAllByText("Core rail").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(screen.getAllByRole("button", { name: /B \(1\)/ })[0]!);

    expect(screen.queryByTestId("report-card-usdc-circle")).toBeNull();
    expect(screen.getByTestId("report-card-usdt-tether")).toBeTruthy();
  });

  it("keeps the query string synced with the active stress-test selection", async () => {
    stressTestState = {
      ...stressTestState,
      targetCoinId: "usdc-circle",
      targetGrade: "B",
    };
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    render(<ReportCardsClient />);

    await waitFor(() => {
      expect(replaceStateSpy).toHaveBeenCalled();
    });
    const latestPath = String(replaceStateSpy.mock.calls.at(-1)?.[2] ?? "");
    expect(latestPath).toContain("/safety-scores/?stress=");
    expect(latestPath).toContain("grade=B");
    expect(window.location.search).toContain("grade=B");
  });
});
