// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import YieldDetailSection from "@/components/yield-detail-section";
import { YieldChangeAttributionCard } from "@/components/yield-change-attribution-card";
import {
  buildSourceRiskGoldenFixture,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";
import { makeAltYieldSource, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types";
import { makeYieldDetailRanking, makeYieldDetailResponse } from "./yield-detail.test-support";

const { useYieldRankingsMock, useYieldHistoryMock } = vi.hoisted(() => ({
  useYieldRankingsMock: vi.fn(),
  useYieldHistoryMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useYieldRankingsCoin: useYieldRankingsMock,
  useYieldHistory: useYieldHistoryMock,
}));

vi.mock("@/hooks/use-url-filters", () => ({
  useUrlFilters: () => ({
    getParam: () => "",
    replaceParams: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
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
    useYieldRankingsMock.mockReset();
    useYieldHistoryMock.mockReset();
    useYieldHistoryMock.mockReturnValue({
      data: { current: null, history: [], methodology: { version: "v8.14" } },
      meta: null,
      error: null,
      isLoading: false,
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

  it("never calls a ZCHF deposit holder yield and omits the leaderboard fallback link", () => {
    mockRankings([makeRanking({
      id: "zchf-frankencoin", symbol: "ZCHF", sourceRole: "external-opportunity",
      yieldSource: "Frankencoin Savings", yieldSourceUrl: "https://app.frankencoin.com/savings?chain=ethereum",
      sourceRisk: { venueProtocol: "Frankencoin", venueChain: "ethereum" },
    })]);
    const { container } = render(<YieldDetailSection stablecoinId="zchf-frankencoin" />);
    expect(container.textContent).not.toContain("Holder yield");
    expect(screen.getByText(/not yield from simply holding ZCHF/).closest("details")).toBeNull();
    expect(screen.queryByRole("link", { name: "Warning timeline" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View yield opportunities" })).toBeNull();
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

  it.each(["opportunity-evidence-missing", "safety-unrated"] as const)(
    "does not claim an estimated score for withheld %s evidence",
    (reason) => {
      mockRankings([makeRanking({
        pharosYieldScore: null, pysNullReason: reason, warningSignals: [reason],
        safetyScore: null, safetyGrade: "NR",
        provenance: makeYieldProvenance({ scoreQualification: "NR" }),
      })]);
      const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
      expect(screen.getAllByText("Not rated").length).toBeGreaterThan(0);
      expect(container.textContent).not.toMatch(/This estimated PYS|uses the conservative 40-point/);
      expect(screen.getByLabelText(/Pharos Yield Score unavailable/)).toBeTruthy();
    },
  );

  it.each([[1, "+1.00 pp"], [-1, "-1.00 pp"], [-0.001, "+0.00 pp"]] as const)(
    "uses percentage points for source-change impact %s",
    (delta, label) => {
      const { container } = render(<YieldChangeAttributionCard attribution={{
        attribution: "source-switch", confidence: "high", headline: "Observed source switch",
        largestDelta: { value: delta, ts: Date.UTC(2026, 8, 1) },
        sourceSwitchDetail: { previousSourceKey: "previous", apy30dDelta: delta },
      }} />);
      expect(screen.getAllByText(label)).toHaveLength(2);
      expect(container.textContent).not.toContain(`${delta.toFixed(2)}%`);
    },
  );
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
