// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YieldDetailSection from "@/components/yield-detail-section";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types";

const { useYieldRankingsMock, replaceParamsMock } = vi.hoisted(() => ({
  useYieldRankingsMock: vi.fn(),
  replaceParamsMock: vi.fn(),
}));

let sourcesParam = "";

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankings: useYieldRankingsMock,
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

vi.mock("@/components/yield-source-link", () => ({
  YieldSourceLink: ({
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
}));

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return {
    id: "dola-inverse-finance",
    symbol: "DOLA",
    name: "Dola",
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
    provenance: {
      sourceKey: "primary-source",
      confidenceTier: "high",
      method: "best-source",
      upstreamIds: [],
      selectedAt: null,
    },
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

    const { container } = render(<YieldDetailSection stablecoinId="dola-inverse-finance" />);

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

    render(<YieldDetailSection stablecoinId="dola-inverse-finance" />);

    expect(
      screen.getByText("Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet."),
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

    render(<YieldDetailSection stablecoinId="dola-inverse-finance" />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("yield rankings failed")).toBeTruthy();
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

    const { rerender } = render(<YieldDetailSection stablecoinId="dola-inverse-finance" />);

    expect(screen.getByText("Alternative Sources")).toBeTruthy();
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-available-sources")).toBe(
      "primary-source,alt-source,second-alt-source",
    );
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-hide-source-selector")).toBe("true");
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Show Alt Source on chart" }));
    expect(replaceParamsMock).toHaveBeenCalledTimes(1);
    expect(sourcesParam).toBe("alt-source");

    rerender(<YieldDetailSection stablecoinId="dola-inverse-finance" />);
    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("alt-source");

    fireEvent.click(screen.getByRole("button", { name: "Remove Alt Source on chart" }));
    expect(replaceParamsMock).toHaveBeenCalledTimes(2);
    expect(sourcesParam).toBe("");
  });
});
