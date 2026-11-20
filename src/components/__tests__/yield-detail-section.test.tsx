// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import YieldDetailSection from "@/components/yield/yield-detail-section";
import {
  buildSourceRiskGoldenFixture,
} from "@shared/test-utils/yield-source-risk-golden-fixtures";
import { makeAltYieldSource, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking, YieldRankingsResponse } from "@shared/types/yield";
import type { ApiMeta } from "@/lib/api";
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

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

vi.mock("@/components/yield/yield-history-chart", () => ({
  YieldHistoryChart: ({
    availableSources,
    hideSourceSelector,
    externalSourceKeys,
    benchmarkRate,
    benchmarkLabel,
  }: {
    availableSources: Array<{ sourceKey: string; yieldSource: string }>;
    hideSourceSelector: boolean;
    externalSourceKeys?: string[];
    benchmarkRate?: number | null;
    benchmarkLabel?: string;
  }) => (
    <div
      data-testid="yield-history-chart"
      data-available-sources={availableSources.map((source) => source.sourceKey).join(",")}
      data-hide-source-selector={String(hideSourceSelector)}
      data-external-source-keys={(externalSourceKeys ?? []).join(",")}
      data-benchmark-rate={benchmarkRate}
      data-benchmark-label={benchmarkLabel}
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

function altSource(sourceKey: string, yieldSource: string, currentApy: number, apy30d: number, sourceTvlUsd: number | null) {
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
  meta?: ApiMeta | null;
  error?: Error | null;
  isLoading?: boolean;
}): void {
  useYieldRankingsMock.mockReturnValue({
    data: undefined,
    meta: null,
    error: null,
    isLoading: false,
    dataUpdatedAt: Date.now(),
    ...overrides,
  });
}

function mockRankings(rankings: YieldRanking[], meta: ApiMeta | null = null): void {
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

  it.each(["buck-buck-assets", "msy-main-street"])("settles frozen %s as the archive without a ranking request", (id) => {
    mockRankingsQuery({ error: new Error("would retry"), isLoading: true });
    render(<YieldDetailSection stablecoinId={id} />);
    expect(useYieldRankingsMock.mock.calls.every(([, overrides]) => overrides?.enabled === false)).toBe(true);
    expect(screen.getByText(/Pharos no longer collects new metrics for this asset/)).toBeTruthy();
    expect(screen.queryByText(/latest ranking snapshot is not available yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    // The independent historical read stays available to the archive.
    expect(useYieldHistoryMock).toHaveBeenCalledWith(id, { days: 30, mode: "best" });
  });

  it("keeps a retained ranking visible on a frozen archive", () => {
    mockRankings([makeRanking({ id: "buck-buck-assets", symbol: "BUCK", name: "BUCK" })]);
    render(<YieldDetailSection stablecoinId="buck-buck-assets" />);
    expect(screen.queryByText(/Pharos no longer collects new metrics/)).toBeNull();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
  });

  it("keeps active loading and error states for a live coin", () => {
    mockRankingsQuery({ error: new Error("down") });
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(useYieldRankingsMock.mock.calls.at(-1)?.[1]).toEqual({ enabled: true });
  });

  it("never calls a ZCHF deposit holder yield and omits the leaderboard fallback link", () => {
    mockRankings([makeRanking({
      id: "zchf-frankencoin", symbol: "ZCHF", sourceRole: "external-opportunity",
      yieldSource: "Frankencoin Savings", yieldSourceUrl: "https://app.frankencoin.com/savings?chain=ethereum",
      sourceRisk: { venueProtocol: "Frankencoin", venueChain: "ethereum" },
    })]);
    const { container } = render(<YieldDetailSection stablecoinId="zchf-frankencoin" />);
    expect(container.textContent).not.toContain("Holder yield");
    // The external-opportunity caveat leads the module, outside any fold.
    expect(screen.getByText("Not yield from simply holding ZCHF.").closest("details")).toBeNull();
    // Frankencoin Savings is the issuer's own opt-in module, not a third-party venue.
    expect(screen.getAllByText("Opt-in protocol yield").some((node) => !node.closest("details"))).toBe(true);
    expect(container.textContent).toContain("part of the issuer's own protocol");
    expect(container.textContent).not.toContain("third-party venue");
    // The venue chain reads as a display name, and the slug venue key is not printed.
    expect(screen.getByText("Ethereum", { selector: "span" })).toBeTruthy();
    expect(container.textContent).not.toContain("Venue: Frankencoin");
    expect(screen.queryByRole("link", { name: "Warning timeline" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View yield opportunities" })).toBeNull();
  });

  it("names a third-party venue as an external opportunity", () => {
    mockRankings([makeRanking({
      id: "usdc-circle", symbol: "USDC", sourceRole: "external-opportunity", yieldSource: "3Jane senior credit tranche",
      sourceRisk: { venueProtocol: "3jane-lending", deploymentPlace: "strategy-vault" },
    })]);
    const { container } = render(<YieldDetailSection stablecoinId="usdc-circle" />);
    expect(screen.getAllByText("External opportunity").some((node) => !node.closest("details"))).toBe(true);
    expect(container.textContent).toContain("third-party venue");
  });

  it("does not invent a destination or missing venue facts", () => {
    mockRankings([makeRanking({ yieldSource: "No published URL", yieldSourceUrl: null, sourceRole: "external-opportunity", sourceRisk: null })]);
    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.queryByRole("link", { name: "No published URL" })).toBeNull();
    const identity = screen.getAllByText("No published URL").find((node) => !node.closest("details"));
    expect(identity?.closest("a")).toBeNull();
    expect(container.textContent).not.toContain("APY from depositing");
  });

  it("keeps retained ranking visible without a reader notice after a failed refresh (ADR-42)", () => {
    mockRankingsQuery({ data: makeYieldDetailResponse([makeRanking()]), error: new Error("refresh failed") });
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
  });

  it.each([
    ["a 199 hydration advisory", { status: "degraded" as const, warning: '199 - "Yield safety hydration degraded: safety-identity-missing"' }],
    ["mild 3x-6x lateness", {
      status: "degraded" as const,
      updatedAt: Math.floor(Date.now() / 1000) - 25_200,
      ageSeconds: 25_200,
      freshBudgetSec: 21_600,
      degradedBudgetSec: 43_200,
      warning: '110 - "Yield publication degraded (25200s old, fresh budget 21600s)"',
    }],
  ])("keeps %s out of the reader notice (ADR-42)", (_label, meta) => {
    mockRankings([makeRanking()], meta as ApiMeta);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.body.textContent).not.toContain("safety-identity-missing");
  });

  it("shows the shared stale notice when the publication is past the degraded budget", () => {
    mockRankings([makeRanking()], {
      status: "stale",
      updatedAt: Math.floor(Date.now() / 1000) - 100_000,
      ageSeconds: 100_000,
    });
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByRole("status").textContent).toContain("Showing an older snapshot");
  });

  it("does not call an unread history insufficient data", () => {
    mockRankings([makeRanking()]);
    useYieldHistoryMock.mockReturnValue({
      data: undefined, meta: null, error: null, isLoading: true, dataUpdatedAt: 0, refetch: vi.fn(),
    });
    const { rerender } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.queryByText(/Not enough data to attribute/)).toBeNull();

    useYieldHistoryMock.mockReturnValue({
      data: undefined, meta: null, error: new Error("history failed"), isLoading: false, dataUpdatedAt: 0, refetch: vi.fn(),
    });
    rerender(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.queryByText(/Not enough data to attribute/)).toBeNull();
    expect(screen.queryByText("history failed")).toBeNull();
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

  it("keeps unavailable alternate TVL last in both directions without changing APY sorting or counts", () => {
    mockRankings([makeRanking({ altSources: [
      altSource("unknown", "Unknown TVL", 9, 9, null),
      altSource("zero", "Zero TVL", 8, 8, 0),
      altSource("small", "Small TVL", 7, 7, 1_000_000),
      altSource("large", "Large TVL", 6, 6, 2_000_000),
    ] })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const table = screen.getByTestId("yield-detail-alt-sources-table");
    const labels = () => Array.from(table.querySelectorAll("tbody tr")).map((row) => row.querySelector("a")?.textContent);
    expect(labels()).toEqual(["Unknown TVL", "Zero TVL", "Small TVL"]);
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more source" }));
    expect(labels()).toEqual(["Unknown TVL", "Zero TVL", "Small TVL", "Large TVL"]);
    fireEvent.click(within(table).getByRole("button", { name: "Sort alternate sources by TVL descending" }));
    expect(labels()).toEqual(["Large TVL", "Small TVL", "Zero TVL", "Unknown TVL"]);
    fireEvent.click(within(table).getByRole("button", { name: "Sort alternate sources by TVL ascending" }));
    expect(labels()).toEqual(["Zero TVL", "Small TVL", "Large TVL", "Unknown TVL"]);
    expect(Array.from(screen.getByRole("list", { name: "Compact retained yield sources" }).querySelectorAll("li"))
      .map((row) => row.querySelector("a")?.textContent)).toEqual(["Zero TVL", "Small TVL", "Large TVL", "Unknown TVL"]);
    fireEvent.click(within(table).getByRole("button", { name: "Sort alternate sources by APY 30d descending" }));
    expect(labels()).toEqual(["Unknown TVL", "Zero TVL", "Small TVL", "Large TVL"]);
    fireEvent.click(within(table).getByRole("button", { name: "Sort alternate sources by APY 30d ascending" }));
    expect(labels()).toEqual(["Large TVL", "Small TVL", "Zero TVL", "Unknown TVL"]);
    expect(screen.queryByRole("button", { name: /Show .* more source/ })).toBeNull();
  });

  it("reads a native alternate with no venue TVL as Native, not unknown or a dash", () => {
    mockRankings([makeRanking({
      altSources: [altSource("native-holder", "Native holder", 3, 3, null)],
    })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const table = screen.getByTestId("yield-detail-alt-sources-table");
    const row = within(table).getByRole("link", { name: "Native holder" }).closest("tr")!;
    expect(within(row).getByText("Native · depth n/a")).toBeTruthy();
    // The lending-vault badge and the TVL cell both read Native; neither is a dash.
    expect(within(row).getAllByText("Native", { exact: true })).toHaveLength(2);
    expect(within(row).queryByText("—")).toBeNull();
    expect(within(row).queryByText("Unknown depth")).toBeNull();
  });

  it("reads an alternate's depth from its source role, not its yield type", () => {
    mockRankings([makeRanking({ altSources: [
      makeAltYieldSource({
        sourceKey: "native-role",
        yieldSource: "Native role source",
        yieldSourceUrl: "https://example.com/native-role",
        yieldType: "lending-opportunity",
        sourceRole: "canonical-holder",
        sourceTvlUsd: null,
      }),
      makeAltYieldSource({
        sourceKey: "external-role",
        yieldSource: "External role source",
        yieldSourceUrl: "https://example.com/external-role",
        yieldType: "lending-vault",
        sourceRole: "external-opportunity",
        sourceTvlUsd: null,
      }),
    ] })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const table = screen.getByTestId("yield-detail-alt-sources-table");
    const nativeRow = within(table).getByRole("link", { name: "Native role source" }).closest("tr")!;
    expect(within(nativeRow).getByText("Native · depth n/a")).toBeTruthy();
    expect(within(nativeRow).getByText("Native", { exact: true })).toBeTruthy();
    expect(within(nativeRow).queryByText("—")).toBeNull();

    const externalRow = within(table).getByRole("link", { name: "External role source" }).closest("tr")!;
    expect(within(externalRow).getByText("Unknown depth")).toBeTruthy();
    expect(within(externalRow).getByText("—")).toBeTruthy();

    // The compact list on the same surface reads the same role-driven values.
    const list = screen.getByRole("list", { name: "Compact retained yield sources" });
    expect(list.textContent).toContain("Native role source");
    expect(list.textContent).toContain("Native · depth n/a");
    expect(list.textContent).toContain("External role source");
    expect(list.textContent).toContain("Unknown depth");
  });

  it("does not infer a missing chain for a published venue", () => {
    mockRankings([makeRanking({ sourceRole: "external-opportunity", sourceRisk: { venueProtocol: "Published venue" } })]);
    const { container } = render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByText("Not yield from simply holding USDN.").closest("details")).toBeNull();
    expect(container.textContent).not.toMatch(/· (Ethereum|ethereum)/);
    expect(screen.queryByText(/APY from depositing/)).toBeNull();
  });

  it("separates a benchmark spread from its negative reference level", () => {
    mockRankings([makeRanking({ excessYield: 3.55, benchmarkLabel: "CHF 3M compounded SARON", benchmarkRate: -0.05 })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByLabelText(/3.55 pp above CHF 3M compounded SARON \(-0.05%\)/).textContent?.replace(/\s+/g, " ")).toContain("+3.55 pp");
    // The lead sentence spells the spread unit out; a move up carries the glyph and the up tone.
    expect(screen.getByText(/APY over 30 days, 3\.55 percentage points above CHF 3M compounded SARON \(-0\.05%\)\./)).toBeTruthy();
    expect(screen.getByLabelText(/3.55 pp above/).textContent).toContain("▲");
    expect(screen.getByLabelText(/3.55 pp above/).className).toContain("text-green-700");
  });

  it("keeps a USD history display fallback separate from the published foreign scoring hurdle", () => {
    mockRankings([makeRanking({
      benchmarkKey: "CHF",
      benchmarkLabel: "CHF 3M compounded SARON",
      benchmarkRate: undefined,
      benchmarkSelectionMode: "native",
      excessYield: 3.55,
    })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const chart = screen.getByTestId("yield-history-chart");
    expect(chart.getAttribute("data-benchmark-rate")).toBe("0.03");
    expect(chart.getAttribute("data-benchmark-label")).toBe("USD benchmark (display fallback)");
    const spread = screen.getByLabelText(/3.55 pp above CHF 3M compounded SARON/);
    expect(spread.getAttribute("aria-label")).not.toContain("0.03%");
  });

  it("exposes the published reason when PYS is unavailable", () => {
    mockRankings([makeRanking({ pharosYieldScore: null, pysNullReason: "opportunity-evidence-missing" })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    const unavailableScore = screen.getByLabelText(/Pharos Yield Score unavailable:.*opportunity.*missing/i);
    expect(unavailableScore.closest("details")).toBeNull();
    expect(screen.queryByRole("group", { name: "PYS breakdown" })).toBeNull();
  });

  it("withdraws delivery-only PYS at the batch deadline without a refetch", () => {
    const now = 1_776_000_000;
    const budget = 21_600;
    vi.useFakeTimers({ now: now * 1000 });
    try {
      const ranking = makeRanking({
        pharosYieldScore: 64,
        warningSignals: ["data-freshness-unknown"],
        provenance: makeYieldProvenance({ sourceObservedAt: null, sourceAgeSeconds: null, sourceFreshness: "unknown",
          sourceMaxAgeSeconds: budget, scoreQualification: "partial" }),
      });
      mockRankingsQuery({ data: makeYieldDetailResponse([ranking], { provenance: {
        selectionMethod: "confidence-weighted",
        benchmark: { rate: 0.03, recordDate: null, fetchedAt: now, ageSeconds: 0, source: "test", isFallback: false, fallbackMode: null },
        dlPools: { mode: "dex-cache", updatedAt: now - budget + 2, ageSeconds: budget - 2, poolCount: 1, fallbackMode: null },
        safetySnapshot: { kind: "ok", coverageRatio: 1, coveredCount: 1, trackedCount: 1, reason: null },
      } }) });
      render(<YieldDetailSection stablecoinId="usdn-smardex" />);
      act(() => vi.advanceTimersByTime(1999));
      expect(screen.getByLabelText(/Pharos Yield Score 64 out of 100/)).toBeTruthy();
      expect(screen.getByText("Partial evidence")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByLabelText(/Pharos Yield Score unavailable:.*scoring freshness window/i)).toBeTruthy();
      expect(screen.getByText("Not rated")).toBeTruthy();
      expect(screen.queryByLabelText(/Pharos Yield Score 64 out of 100/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes sub-precision benchmark spreads without claiming a negative gap", () => {
    mockRankings([makeRanking({ excessYield: -0.0000596 })]);
    render(<YieldDetailSection stablecoinId="usdn-smardex" />);
    expect(screen.getByText("+0.00 pp vs benchmark").className).toContain("text-muted-foreground");
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

  it("distinguishes an absent comparison from measured unchanged", () => {
    mockRankings([makeRanking({ rankChangeAttribution: undefined })]);

    render(<YieldDetailSection stablecoinId="usdn-smardex" />);

    expect(screen.getByText("Movement vs last publication")).toBeTruthy();
    expect(screen.getByText("Current movement unavailable")).toBeTruthy();
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

  it("withdraws cached movement when an unreturned peer's evidence expires", () => {
    const now = 1_776_000_000;
    vi.useFakeTimers({ now: now * 1000 });
    try {
      const data = {
        ...makeYieldDetailResponse([makeRanking({ pharosYieldScore: 72, liveRank: 2, rankChangeAttribution: null })]),
        projection: { stablecoinId: "usdn-smardex", generationId: null, updatedAt: now, totalCount: 2, unavailableReason: null },
        cohortValidUntil: now + 2,
      };
      mockRankingsQuery({ data });
      render(<YieldDetailSection stablecoinId="usdn-smardex" />);
      act(() => vi.advanceTimersByTime(1999));
      expect(screen.getByText("Stable — no movement since last publication.")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText("Stable — no movement since last publication.")).toBeNull();
      expect(screen.getByText("Current movement unavailable")).toBeTruthy();
      expect(screen.getByLabelText(/Pharos Yield Score 72 out of 100/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
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
