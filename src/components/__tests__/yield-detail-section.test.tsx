// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YieldDetailSection from "@/components/yield-detail-section";
import {
  SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS,
  buildSourceRiskGoldenFixture,
  mergeSourceRiskGoldenFixtures,
} from "@shared/lib/__tests__/yield-source-risk-golden-fixtures";
import { makeYieldProvenance } from "@/test/fixtures/yield";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types";

const { useYieldRankingsMock, useYieldHistoryMock, replaceParamsMock } = vi.hoisted(() => ({
  useYieldRankingsMock: vi.fn(),
  useYieldHistoryMock: vi.fn(),
  replaceParamsMock: vi.fn(),
}));

let sourcesParam = "";

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankings: useYieldRankingsMock,
  useYieldHistory: useYieldHistoryMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    getParam: (key: string) => (key === "sources" ? sourcesParam : ""),
    replaceParams: replaceParamsMock,
  }),
}));

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: ({
    availableSources,
    hideSourceSelector,
    externalSourceKeys,
  }: {
    availableSources: Array<{ sourceKey: string; yieldSource: string }>;
    hideSourceSelector: boolean;
    externalSourceKeys?: string[];
  }) => (
    <div
      data-testid="yield-history-chart"
      data-available-sources={availableSources.map((source) => source.sourceKey).join(",")}
      data-hide-source-selector={String(hideSourceSelector)}
      data-external-source-keys={(externalSourceKeys ?? []).join(",")}
    />
  ),
}));

vi.mock("@/components/table/client", () => ({
  TableSourceLink: ({
    href,
    children,
    className,
  }: {
    href?: string | null;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href ?? undefined} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MethodologyCardActions: () => null,
  MethodologyHint: () => null,
  MethodologyTriggerButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return {
    id: "usdn-smardex",
    symbol: "USDN",
    name: "SmarDex USDN",
    currentApy: 0.053,
    apy7d: 0.051,
    apy30d: 0.05,
    apyBase: null,
    apyReward: null,
    yieldSource: "Primary Source",
    yieldSourceUrl: "https://example.com/primary",
    yieldType: "lending-vault",
    dataSource: "defillama",
    sourceTvlUsd: 1_000_000,
    pharosYieldScore: 72,
    safetyScore: 82,
    safetyGrade: "A",
    yieldToRisk: 1.2,
    excessYield: 0.02,
    benchmarkLabel: "SOFR",
    benchmarkRate: 0.03,
    benchmarkSelectionMode: "native",
    benchmarkIsFallback: false,
    yieldStability: 0.85,
    apyVariance30d: 0.002,
    apyMin30d: 0.045,
    apyMax30d: 0.055,
    warningSignals: [],
    altSources: [],
    provenance: makeYieldProvenance({
      sourceKey: "primary-source",
      confidenceTier: "curated",
    }),
    ...overrides,
  };
}

function makeResponse(rankings: YieldRanking[] = []): YieldRankingsResponse {
  return {
    rankings,
    riskFreeRate: 0.03,
    scalingFactor: 1,
    medianApy: 0.04,
    updatedAt: 1_710_500_000,
    provenance: null,
  };
}

describe("YieldDetailSection", () => {
  beforeEach(() => {
    sourcesParam = "";
    useYieldRankingsMock.mockReset();
    useYieldHistoryMock.mockReset();
    useYieldHistoryMock.mockReturnValue({
      data: { current: null, history: [], methodology: { version: "v8.14" } },
      meta: null,
      error: null,
      isLoading: false,
    });
    replaceParamsMock.mockReset();
    replaceParamsMock.mockImplementation((updater: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(sourcesParam ? `sources=${sourcesParam}` : "");
      updater(params);
      sourcesParam = params.get("sources") ?? "";
    });
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading shell for tracked yield-bearing assets", () => {
    useYieldRankingsMock.mockReturnValue({
      data: undefined,
      meta: null,
      error: null,
      isLoading: true,
    });

    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByRole("heading", { name: "Yield Intelligence" })).toBeTruthy();
    expect(container.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThanOrEqual(6);
  });

  it("shows the unavailable-yet state when a yield-bearing asset has no ranking and no fetch error", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(
      screen.getByText(
        "Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the error notice when the ranking fetch fails for a tracked yield-bearing asset", () => {
    useYieldRankingsMock.mockReturnValue({
      data: undefined,
      meta: null,
      error: new Error("yield rankings failed"),
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("yield rankings failed")).toBeTruthy();
  });

  it("renders the deep-link breadcrumb with three named anchor links when ready", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([makeRanking()]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    const nav = screen.getByRole("navigation", { name: "More yield analysis" });
    const warningLink = screen.getByRole("link", { name: "Warning timeline" });
    const switchesLink = screen.getByRole("link", { name: "Source switches" });
    const comparisonLink = screen.getByRole("link", { name: "Source comparison" });

    expect(nav).toBeTruthy();
    // Next.js Link normalizes /foo/#bar → /foo#bar; the deep-link page is still served at /foo/.
    expect(warningLink.getAttribute("href")).toBe("/stablecoin/usdn-smardex/yield#warning-signals");
    expect(switchesLink.getAttribute("href")).toBe("/stablecoin/usdn-smardex/yield#source-switches");
    expect(comparisonLink.getAttribute("href")).toBe("/stablecoin/usdn-smardex/yield#source-comparison");
  });

  it("renders source-risk penalty in the PYS breakdown", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([
        makeRanking({
          sourceRisk: buildSourceRiskGoldenFixture("reward-heavy", { sourceRiskPenalty: 2 }),
        }),
      ]),
      meta: null,
      error: null,
      isLoading: false,
    });

    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText(/source-risk penalty/i)).toBeTruthy();
    expect(container.textContent ?? "").toContain("2.00×");
  });

  it("explains populated source-risk drivers in the detail PYS block", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([
        makeRanking({
          sourceRisk: mergeSourceRiskGoldenFixtures(
            [
              "reward-heavy",
              "low-source-depth",
              "stale-source-age",
              "bootstrap-observation-count",
              "source-switch-churn",
            ],
            { sourceRiskPenalty: 1.8 },
          ),
          provenance: {
            sourceKey: "primary-source",
            sourceObservedAt: 1_700_000_000,
            sourceAgeSeconds: 8 * 60 * 60,
            sourceFreshness: "stale",
            confidenceTier: "curated",
            selectionMethod: "confidence-weighted",
            selectionReason: "Higher confidence than retained alternates.",
            sourceSwitch: true,
            previousBestSourceKey: "previous-source",
            usedLegacyHistory: false,
            usedDefaultSafety: false,
            benchmarkRecordDate: null,
            benchmarkIsFallback: false,
            benchmarkFallbackMode: null,
            anomalies: [],
          },
        }),
      ]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    for (const label of SOURCE_RISK_GOLDEN_UI_DRIVER_LABELS) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // WHY: driver descriptions are exposed on compact tag chips through the
    // accessible label and tooltip, not as visible text.
    const rewardChip = screen.getAllByText("reward-heavy")[0] as HTMLElement;
    expect(rewardChip.getAttribute("aria-label")).toMatch(/Most APY comes from incentives/i);
  });

  it("persists selected alternative sources in the URL state and forwards them to the chart", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([
        makeRanking({
          altSources: [
            {
              sourceKey: "alt-source",
              yieldSource: "Alt Source",
              yieldSourceUrl: "https://example.com/alt",
              yieldType: "lending-vault",
              currentApy: 0.049,
              apy30d: 0.048,
              sourceTvlUsd: 750_000,
              dataSource: "defillama",
            },
            {
              sourceKey: "second-alt-source",
              yieldSource: "Second Alt Source",
              yieldSourceUrl: "https://example.com/alt-2",
              yieldType: "lending-vault",
              currentApy: 0.047,
              apy30d: 0.046,
              sourceTvlUsd: 600_000,
              dataSource: "defillama",
            },
          ],
        }),
      ]),
      meta: { warning: "Using cached yield snapshot." },
      error: null,
      isLoading: false,
    });

    const { rerender } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText("Retained alternates")).toBeTruthy();
    expect(screen.getByTestId("yield-detail-alt-sources-table").getAttribute("data-table-id")).toBe(
      "yield-detail-alt-sources",
    );
    expect(screen.getByRole("table", { name: "Retained alternate yield sources" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /APY 30d/ }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("button", { name: /Sort alternate sources by APY 30d ascending/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Sort alternate sources by TVL descending/ }));
    expect(screen.getByRole("columnheader", { name: /TVL/ }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-available-sources")).toBe(
      "primary-source,alt-source,second-alt-source",
    );
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-hide-source-selector")).toBe("true");
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Show Alt Source on chart" }));
    expect(replaceParamsMock).toHaveBeenCalledTimes(1);
    expect(sourcesParam).toBe("alt-source");

    rerender(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("alt-source");

    fireEvent.click(screen.getByRole("button", { name: "Remove Alt Source on chart" }));
    expect(replaceParamsMock).toHaveBeenCalledTimes(2);
    expect(sourcesParam).toBe("");
  });

  it("drops stale sources URL values before forwarding chart overlays", () => {
    sourcesParam = "stale-source,alt-source";
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([
        makeRanking({
          altSources: [
            {
              sourceKey: "alt-source",
              yieldSource: "Alt Source",
              yieldSourceUrl: "https://example.com/alt",
              yieldType: "lending-vault",
              currentApy: 0.049,
              apy30d: 0.048,
              sourceTvlUsd: 750_000,
              dataSource: "defillama",
            },
          ],
        }),
      ]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("alt-source");
  });

  it("falls back to best chart source when all sources URL values are stale", () => {
    sourcesParam = "stale-source";
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([makeRanking()]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("");
  });

  it("limits the chart source selection to four alternatives", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([
        makeRanking({
          altSources: [
            {
              sourceKey: "alt-source-1",
              yieldSource: "Alt Source 1",
              yieldSourceUrl: "https://example.com/alt-1",
              yieldType: "lending-vault",
              currentApy: 0.049,
              apy30d: 0.048,
              sourceTvlUsd: 750_000,
              dataSource: "defillama",
            },
            {
              sourceKey: "alt-source-2",
              yieldSource: "Alt Source 2",
              yieldSourceUrl: "https://example.com/alt-2",
              yieldType: "lending-vault",
              currentApy: 0.048,
              apy30d: 0.047,
              sourceTvlUsd: 700_000,
              dataSource: "defillama",
            },
            {
              sourceKey: "alt-source-3",
              yieldSource: "Alt Source 3",
              yieldSourceUrl: "https://example.com/alt-3",
              yieldType: "lending-vault",
              currentApy: 0.047,
              apy30d: 0.046,
              sourceTvlUsd: 650_000,
              dataSource: "defillama",
            },
            {
              sourceKey: "alt-source-4",
              yieldSource: "Alt Source 4",
              yieldSourceUrl: "https://example.com/alt-4",
              yieldType: "lending-vault",
              currentApy: 0.046,
              apy30d: 0.045,
              sourceTvlUsd: 600_000,
              dataSource: "defillama",
            },
            {
              sourceKey: "alt-source-5",
              yieldSource: "Alt Source 5",
              yieldSourceUrl: "https://example.com/alt-5",
              yieldType: "lending-vault",
              currentApy: 0.045,
              apy30d: 0.044,
              sourceTvlUsd: 550_000,
              dataSource: "defillama",
            },
          ],
        }),
      ]),
      meta: null,
      error: null,
      isLoading: false,
    });

    const { rerender } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    const sourceNames = ["Alt Source 1", "Alt Source 2", "Alt Source 3", "Alt Source 4", "Alt Source 5"];
    for (const [index, sourceName] of sourceNames.entries()) {
      fireEvent.click(screen.getByRole("button", { name: `Show ${sourceName} on chart` }));
      rerender(<YieldDetailSection stablecoinId="usdn-smardex" />);

      const params = sourcesParam.split(",").filter(Boolean);
      expect(params.length).toBe(Math.min(index + 1, 4));
    }

    expect(sourcesParam).toBe("alt-source-1,alt-source-2,alt-source-3,alt-source-4");
  });

  it("renders the 'Why this APY changed' attribution card with a headline", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([makeRanking()]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText(/Why this APY changed/i)).toBeTruthy();
    // No history points → insufficient-data path
    expect(screen.getByText(/Not enough data to attribute/i)).toBeTruthy();
  });

  it("uses decision-ledger reason codes for source arbitration copy", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([
        makeRanking({
          provenance: {
            sourceKey: "primary-source",
            sourceObservedAt: 1_700_000_000,
            sourceAgeSeconds: 60,
            confidenceTier: "curated",
            selectionMethod: "confidence-weighted",
            selectionReason: "legacy freeform selection reason",
            sourceSwitch: false,
            previousBestSourceKey: null,
            usedLegacyHistory: false,
            usedDefaultSafety: false,
            benchmarkRecordDate: null,
            benchmarkIsFallback: false,
            benchmarkFallbackMode: null,
            anomalies: [],
          },
          decisionLedger: {
            selectedReasonCode: "curated-over-discovered",
            sourceSwitch: false,
            rejectedCount: 1,
            alternatives: [
              {
                sourceKey: "alt-source",
                yieldSource: "Alt Source",
                apy30dDelta: 0.01,
                rejectionReasonCode: "lower-confidence",
              },
            ],
          },
        }),
      ]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByLabelText("Why this source won")).toBeTruthy();
    expect(screen.getByText("Curated source preferred")).toBeTruthy();
    expect(screen.getByText("1 alternate rejected")).toBeTruthy();
    expect(screen.getByText("Alt Source")).toBeTruthy();
    expect(screen.getByText("lower confidence")).toBeTruthy();
    expect(screen.getByText("+0.01% APY30d")).toBeTruthy();
    expect(screen.queryByText("legacy freeform selection reason")).toBeNull();
  });

  it("renders the rank-movement card as 'Stable' when rankChangeAttribution is null", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([makeRanking()]),
      meta: null,
      error: null,
      isLoading: false,
    });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText("Movement vs last publication")).toBeTruthy();
    expect(screen.getByText("Stable — no movement since last publication.")).toBeTruthy();
  });

  it("renders rank delta and PYS delta when rankChangeAttribution carries movement", () => {
    useYieldRankingsMock.mockReturnValue({
      data: makeResponse([
        makeRanking({
          rankChangeAttribution: {
            previousRank: 12,
            rankDelta: 3,
            previousPys: 60,
            pysDelta: 4.5,
            primaryDriver: "apy",
            driverContributions: {
              apy: 3.2,
              benchmark: 0.8,
              stablecoinSafety: null,
              sourceRisk: null,
              sourceSwitch: null,
              freshness: null,
              volatility: null,
              tvlDepth: null,
            },
          },
        }),
      ]),
      meta: null,
      error: null,
      isLoading: false,
    });

    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText("Movement vs last publication")).toBeTruthy();
    // Arrow + signed delta together: "▲ +3"
    expect(container.textContent ?? "").toMatch(/▲\s*\+3/);
    expect(container.textContent ?? "").toMatch(/PYS\s+\+4\.50%/);
    expect(container.textContent ?? "").toMatch(/Previous rank/);
    expect(container.textContent ?? "").toMatch(/#12/);
    expect(container.textContent ?? "").toMatch(/#9/);
  });
});
