// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import YieldDetailSection from "@/components/yield-detail-section";
import {
  buildSourceRiskGoldenFixture,
  mergeSourceRiskGoldenFixtures,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";
import { makeAltYieldSource, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types";
import { makeYieldDetailRanking, makeYieldDetailResponse } from "./yield-detail.test-support";

const { useYieldRankingsMock, useYieldHistoryMock, replaceParamsMock, isMobileMock } = vi.hoisted(() => ({
  useYieldRankingsMock: vi.fn(),
  useYieldHistoryMock: vi.fn(),
  replaceParamsMock: vi.fn(),
  isMobileMock: vi.fn(),
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

vi.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: isMobileMock,
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
  }) => href ? (
    <a href={href} className={className}>{children}</a>
  ) : <span className={className}>{children}</span>,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MethodologyCardActions: () => null,
  MethodologyHint: () => null,
  MethodologyTriggerButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

function makeRanking(overrides: Partial<YieldRanking> = {}): YieldRanking {
  return makeYieldDetailRanking({
    id: "usdn-smardex",
    symbol: "USDN",
    name: "SmarDex USDN",
    currentApy: 0.053,
    apy7d: 0.051,
    apy30d: 0.05,
    yieldType: "lending-vault",
    dataSource: "defillama",
    sourceTvlUsd: 1_000_000,
    pharosYieldScore: 72,
    safetyScore: 82,
    safetyGrade: "A",
    excessYield: 0.02,
    benchmarkLabel: "SOFR",
    benchmarkRate: 0.03,
    yieldStability: 0.85,
    apyVariance30d: 0.002,
    apyMin30d: 0.045,
    apyMax30d: 0.055,
    altSources: [],
    ...overrides,
  });
}

function altSource(sourceKey: string, yieldSource: string, currentApy: number, apy30d: number, sourceTvlUsd: number) {
  return makeAltYieldSource({
    sourceKey,
    yieldSource,
    yieldSourceUrl: `https://example.com/${sourceKey}`,
    yieldType: "lending-vault",
    currentApy,
    apy30d,
    sourceTvlUsd,
    dataSource: "defillama",
  });
}

function mockRankingsQuery(overrides: {
  data?: YieldRankingsResponse;
  meta?: { warning: string } | null;
  error?: Error | null;
  isLoading?: boolean;
}): void {
  useYieldRankingsMock.mockReturnValue({ data: undefined, meta: null, error: null, isLoading: false, ...overrides });
}

function mockRankings(rankings: YieldRanking[], meta: { warning: string } | null = null): void {
  mockRankingsQuery({ data: makeYieldDetailResponse(rankings, { riskFreeRate: 0.03, scalingFactor: 1 }), meta });
}

describe("YieldDetailSection", () => {
  beforeEach(() => {
    sourcesParam = "";
    useYieldRankingsMock.mockReset();
    useYieldHistoryMock.mockReset();
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(false);
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

  it.each([
    ["canonical-holder", "rated", "Holder yield"],
    ["external-opportunity", "partial", "External opportunity"],
    ["fallback-proxy", "estimated", "Estimated"],
    [undefined, "rated", null],
  ] as const)("exposes published identity with disclosures closed for %s", (sourceRole, scoreQualification, prefix) => {
    mockRankings([makeRanking({
      sourceRole,
      yieldSource: "Published venue",
      yieldSourceUrl: "https://example.com/instrument",
      sourceRisk: { venueProtocol: "Venue", venueChain: "ethereum" },
      provenance: makeYieldProvenance({ scoreQualification, sourceSwitch: true }),
    })]);
    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const link = screen.getByRole("link", { name: "Published venue" });
    expect(link.getAttribute("href")).toBe("https://example.com/instrument");
    expect(link.closest("details")).toBeNull();
    expect(container.querySelector("details[open]")).toBeNull();
    if (prefix) expect(screen.getAllByText(prefix, { exact: false })[0].closest("details")).toBeNull();
    else expect(container.textContent).not.toContain("Holder yield");
    expect(screen.getAllByText("source changed").some((node) => !node.closest("details"))).toBe(true);
    const qualificationText = scoreQualification === "partial" ? "Partial evidence" : scoreQualification === "estimated" ? "Estimated" : "Rated";
    expect(screen.getAllByText(qualificationText).some((node) => !node.closest("details"))).toBe(true);
  });

  it.each(["rate-derived", "price-derived"] as const)("does not repeat the %s badge in deployment facts", (dataSource) => {
    mockRankings([makeRanking({
      dataSource,
      sourceRole: "fallback-proxy",
      sourceRisk: { deploymentPlace: dataSource },
      provenance: makeYieldProvenance({ scoreQualification: "estimated" }),
    })]);
    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const facts = container.querySelector(".text-muted-foreground > .rounded-full")?.parentElement;
    expect(facts).toBeTruthy();
    expect(facts!.textContent?.toLowerCase().replaceAll("-", " ")).toBe(dataSource.replaceAll("-", " "));
    expect(facts!.textContent).not.toContain("·");
  });

  it("does not prefix chain or deployment facts with a separator without a venue", () => {
    mockRankings([makeRanking({ sourceRisk: { venueChain: "ethereum", deploymentPlace: "lending-vault" } })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByText("ethereum", { selector: "span" }).textContent).not.toContain("·");
    expect(screen.getByText("· lending vault")).toBeTruthy();
  });

  it("never calls a ZCHF deposit holder yield and routes to the existing fallback", () => {
    mockRankings([makeRanking({
      id: "zchf-frankencoin", symbol: "ZCHF", sourceRole: "external-opportunity",
      yieldSource: "Frankencoin Savings", yieldSourceUrl: "https://app.frankencoin.com/savings?chain=ethereum",
      sourceRisk: { venueProtocol: "Frankencoin", venueChain: "ethereum" },
    })]);
    const { container } = render(<YieldDetailSection stablecoinId="zchf-frankencoin" />);
    expect(container.textContent).not.toContain("Holder yield");
    expect(screen.getByText(/not yield from simply holding ZCHF/).closest("details")).toBeNull();
    expect(screen.queryByRole("link", { name: "Warning timeline" })).toBeNull();
    const destination = new URL(screen.getByRole("link", { name: "View yield opportunities" }).getAttribute("href")!, window.location.origin);
    expect(destination.pathname.replace(/\/$/, "")).toBe("/yield");
    expect(destination.searchParams.get("workbenchFallback")).toBe("zchf-frankencoin");
  });

  it("does not invent a destination or missing venue facts", () => {
    mockRankings([makeRanking({ yieldSource: "No published URL", yieldSourceUrl: null, sourceRole: "external-opportunity", sourceRisk: null })]);
    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.queryByRole("link", { name: "No published URL" })).toBeNull();
    const identity = screen.getAllByText("No published URL").find((node) => !node.closest("details"));
    expect(identity?.closest("a")).toBeNull();
    expect(container.textContent).not.toContain("APY from depositing");
  });

  it("keeps retained ranking visible while announcing refresh failure", () => {
    mockRankingsQuery({ data: makeYieldDetailResponse([makeRanking()]), error: new Error("refresh failed") });
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
  });

  it("gates price appreciation explanation on the published calculation mode", () => {
    const row = makeRanking({ sourceRole: "fallback-proxy", provenance: makeYieldProvenance({ calculationMode: "benchmark-model", scoreQualification: "estimated" }) });
    mockRankings([row]);
    const { rerender } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.queryByText(/not a quoted deposit rate/)).toBeNull();
    mockRankings([{ ...row, provenance: makeYieldProvenance({ calculationMode: "price-return", scoreQualification: "estimated" }) }]);
    rerender(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByText(/not a quoted deposit rate/).closest("details")).toBeNull();
  });

  it("disambiguates duplicate source labels in the visible selected identity", () => {
    mockRankings([makeRanking({
      yieldSource: "Shared venue",
      provenance: makeYieldProvenance({ sourceKey: "selected-key" }),
      altSources: [altSource("alternate-key", "Shared venue", 3, 3, 1_000_000)],
    })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByRole("link", { name: "Shared venue (selected-key)" }).closest("details")).toBeNull();
  });

  it("does not infer a missing chain for a published venue", () => {
    mockRankings([makeRanking({ sourceRole: "external-opportunity", sourceRisk: { venueProtocol: "Published venue" } })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByText("Venue: Published venue").closest("details")).toBeNull();
    expect(screen.queryByText(/APY from depositing/)).toBeNull();
  });

  it("separates a benchmark spread from its negative reference level", () => {
    mockRankings([makeRanking({ excessYield: 3.55, benchmarkLabel: "CHF 3M compounded SARON", benchmarkRate: -0.05 })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByLabelText(/3.55 pp above CHF 3M compounded SARON \(-0.05%\)/).textContent).toContain("+3.55 pp");
  });

  it("exposes the published reason when PYS is unavailable", () => {
    mockRankings([makeRanking({ pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing" })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const unavailableScore = screen.getByLabelText(/Pharos Yield Score unavailable:.*opportunity.*missing/i);
    expect(unavailableScore.closest("details")).toBeNull();
    expect(screen.queryByRole("group", { name: "PYS breakdown" })).toBeNull();
  });

  it("normalizes sub-precision benchmark spreads without claiming a negative gap", () => {
    mockRankings([makeRanking({ excessYield: -0.0000596 })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByText("+0.00 pp vs benchmark")).toBeTruthy();
    expect(screen.queryByText("-0.00 pp vs benchmark")).toBeNull();
  });

  it("renders the loading shell for tracked yield-bearing assets", () => {
    mockRankingsQuery({ isLoading: true });

    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByRole("heading", { name: "Yield Intelligence" })).toBeTruthy();
    expect(container.querySelectorAll("[data-slot='skeleton']").length).toBeGreaterThanOrEqual(6);
  });

  it("mounts one history chart in each viewport mode", async () => {
    mockRankings([makeRanking()]);

    const { container, rerender } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(container.querySelectorAll("[data-testid='yield-history-chart']")).toHaveLength(1);

    isMobileMock.mockReturnValue(true);
    rerender(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(container.querySelectorAll("[data-testid='yield-history-chart']")).toHaveLength(0);

    const disclosure = Array.from(container.querySelectorAll("details")).find((element) =>
      element.querySelector("summary")?.textContent?.includes("APY trend"),
    );
    expect(disclosure).toBeTruthy();
    if (!disclosure) return;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle", { bubbles: false }));
    await waitFor(() => {
      expect(container.querySelectorAll("[data-testid='yield-history-chart']")).toHaveLength(1);
    });
  });

  it("shows the unavailable-yet state when a yield-bearing asset has no ranking and no fetch error", () => {
    mockRankings([]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(
      screen.getByText(
        "Yield tracking is expected for this stablecoin, but the latest ranking snapshot is not available yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the error notice when the ranking fetch fails for a tracked yield-bearing asset", () => {
    mockRankingsQuery({ error: new Error("yield rankings failed") });

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("yield rankings failed")).toBeTruthy();
  });

  it("renders the deep-link breadcrumb with three named anchor links when ready", () => {
    mockRankings([makeRanking()]);

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
    mockRankings([
      makeRanking({
        sourceRisk: buildSourceRiskGoldenFixture("reward-heavy", { sourceRiskPenalty: 2 }),
      }),
    ]);

    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText(/source-risk penalty/i)).toBeTruthy();
    expect(container.textContent ?? "").toContain("2.00×");
  });

  it("explains populated source-risk drivers in the detail PYS block", () => {
    mockRankings([
      makeRanking({
        sourceRisk: mergeSourceRiskGoldenFixtures(
          ["reward-heavy", "stale-source-age"],
          { sourceRiskPenalty: 1.8 },
        ),
        provenance: makeYieldProvenance({
          sourceKey: "primary-source", sourceObservedAt: 1_700_000_000,
          sourceAgeSeconds: 8 * 60 * 60, sourceFreshness: "stale",
          selectionReason: "Higher confidence than retained alternates.",
          sourceSwitch: true, previousBestSourceKey: "previous-source", benchmarkRecordDate: null,
        }),
      }),
    ]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getAllByText("reward-heavy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("stale source").length).toBeGreaterThan(0);
    // WHY: driver descriptions are exposed on compact tag chips through the
    // accessible label and tooltip, not as visible text.
    const rewardChip = screen.getAllByText("reward-heavy")[0] as HTMLElement;
    expect(rewardChip.getAttribute("aria-label")).toMatch(/Most APY comes from incentives/i);
  });

  it("persists selected alternative sources in the URL state and forwards them to the chart", () => {
    mockRankings(
      [makeRanking({ altSources: [altSource("alt-source", "Alt Source", 0.049, 0.048, 750_000), altSource("second-alt-source", "Second Alt Source", 0.047, 0.046, 600_000)] })],
      { warning: "Using cached yield snapshot." },
    );

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
    mockRankings([makeRanking({ altSources: [altSource("alt-source", "Alt Source", 0.049, 0.048, 750_000)] })]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("alt-source");
  });

  it("falls back to best chart source when all sources URL values are stale", () => {
    sourcesParam = "stale-source";
    mockRankings([makeRanking()]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByTestId("yield-history-chart").getAttribute("data-external-source-keys")).toBe("");
  });

  it("limits the chart source selection to four alternatives", () => {
    mockRankings([
      makeRanking({
        altSources: Array.from({ length: 5 }, (_, index) => {
          const n = index + 1;
          return altSource(`alt-source-${n}`, `Alt Source ${n}`, 0.05 - n * 0.001, 0.049 - n * 0.001, 800_000 - n * 50_000);
        }),
      }),
    ]);

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

  it("keeps embedded attribution compact and links to the full analysis", () => {
    mockRankings([makeRanking()]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.queryByText(/Why this APY changed/i)).toBeNull();
    expect(screen.getByText(/Not enough data to attribute/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View full yield analysis" }).getAttribute("href")).toBe("/stablecoin/usdn-smardex/yield");
  });

  it("uses decision-ledger reason codes for source arbitration copy", () => {
    mockRankings([
      makeRanking({
        provenance: makeYieldProvenance({
          sourceKey: "primary-source", sourceObservedAt: 1_700_000_000, sourceAgeSeconds: 60,
          selectionReason: "legacy freeform selection reason", benchmarkRecordDate: null,
        }),
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
    ]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByLabelText("Why this source won")).toBeTruthy();
    expect(screen.getByText("Curated source preferred")).toBeTruthy();
    expect(screen.getByText("1 alternate rejected")).toBeTruthy();
    expect(screen.getByText("Alt Source")).toBeTruthy();
    expect(screen.getByText("lower confidence")).toBeTruthy();
    expect(screen.getByText("+0.01% APY30d")).toBeTruthy();
    expect(screen.queryByText("legacy freeform selection reason")).toBeNull();
  });

  it("distinguishes an absent comparison from measured unchanged", () => {
    mockRankings([makeRanking({ rankChangeAttribution: undefined })]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText("Movement vs last publication")).toBeTruthy();
    expect(screen.getByText(/No comparison baseline — movement vs the previous publication was not measured/)).toBeTruthy();
    expect(screen.queryByText("Stable — no movement since last publication.")).toBeNull();
  });

  it("renders stable for an explicitly unchanged publication comparison", () => {
    mockRankings([
      makeRanking({
        rankChangeAttribution: null,
      }),
    ]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText("Stable — no movement since last publication.")).toBeTruthy();
  });


  it("renders rank delta and PYS delta when rankChangeAttribution carries movement", () => {
    mockRankings([
      makeRanking({
        rankChangeAttribution: {
          previousRank: 12,
          rankDelta: 3,
          previousPys: 60,
          pysDelta: 4.5,
          primaryDriver: "apy",
          driverContributions: {
            apy: 3.2,
            benchmark: 80,
            stablecoinSafety: 4.5,
            sourceRisk: -0.2,
            sourceSwitch: null,
            freshness: null,
            volatility: null,
            tvlDepth: null,
          },
        },
      }),
    ]);

    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText("Movement vs last publication")).toBeTruthy();
    // Arrow + signed delta together: "▲ +3 places"
    expect(container.textContent ?? "").toMatch(/▲\s*\+3 places/);
    expect(container.textContent ?? "").toMatch(/\+4\.50\s+PYS/);
    expect(container.textContent ?? "").not.toMatch(/PYS\s*\+4\.50%/);
    expect(container.textContent ?? "").toMatch(/APY:\s*\+3\.20\s+rank places \(heuristic\)/);
    expect(container.textContent ?? "").toMatch(/Benchmark:\s*\+80\.00\s+rank places \(heuristic\)/);
    expect(container.textContent ?? "").toContain("-0.20 multiplier change");
    expect(container.textContent ?? "").toContain("+4.50 PYS total change (heuristic)");
    const driverList = Array.from(container.querySelectorAll("ul")).find((list) => list.textContent?.includes("multiplier change"));
    expect(driverList?.firstElementChild?.textContent).toMatch(/^APY:/);
    expect(container.textContent ?? "").toMatch(/Previous rank/);
    expect(container.textContent ?? "").toMatch(/#12/);
    expect(container.textContent ?? "").toMatch(/#9/);
  });
});
