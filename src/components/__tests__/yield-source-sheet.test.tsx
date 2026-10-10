// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import { mergeSourceRiskGoldenFixtures } from "@shared/test-utils/yield-source-risk-golden-fixtures";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking } from "@shared/types";
import { renderYieldSourceSheet } from "./yield-source-sheet-test-support";
import { REGISTRY_WITH_EUR } from "./yield-test-support";
import { trackEvent } from "@/lib/analytics";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: ({
    externalSourceKey,
    benchmarkRate,
    benchmarkLabel,
  }: {
    externalSourceKey: string;
    benchmarkRate: number | null;
    benchmarkLabel?: string;
  }) => (
    <div data-testid="yield-history-chart" data-benchmark-rate={benchmarkRate} data-benchmark-label={benchmarkLabel}>
      {externalSourceKey}
    </div>
  ),
}));


vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name }: { name: string }) => <div>{name}</div>,
}));

vi.mock("@/components/yield-source-risk-bar", () => ({
  YieldSourceRiskBar: ({ score }: { score: number | null }) => (
    <div data-testid="yield-source-risk-bar">{score == null ? "unavailable" : String(score)}</div>
  ),
}));

function makeRanking(id: string, bestSourceKey: string, altSourceKey: string): YieldRanking {
  return makeYieldRanking({
    id,
    symbol: id.toUpperCase(),
    name: id === "usdc" ? "USD Coin" : "Tether",
    yieldSource: `${id}-best`,
    yieldSourceUrl: `https://example.com/${id}/best`,
    provenance: makeYieldProvenance({ sourceKey: bestSourceKey }),
    altSources: [
      makeAltYieldSource({
        sourceKey: altSourceKey,
        yieldSource: `${id}-alt`,
        yieldSourceUrl: `https://example.com/${id}/alt`,
        apy30d: 0.04,
        currentApy: 0.04,
        sourceTvlUsd: 500_000,
      }),
    ],
  });
}

describe("YieldSourceSheet", () => {
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    vi.restoreAllMocks();
  });

  it("shows the advanced observation age rather than the publication-time age", () => {
    const ranking = makeRanking("usdc", "selected", "alternate");
    ranking.sourceRisk = {
      sourceRiskScore: null, sourceRiskPenalty: null, sourceDepthRatio: null, rewardShare: null,
      sourceAgeSeconds: 14401, observationCount30d: null, sourceSwitchCount30d: null,
    };
    ranking.provenance = makeYieldProvenance({ sourceFreshness: "stale", sourceAgeSeconds: 14401 });
    renderYieldSourceSheet(ranking);
    expect(screen.getAllByText(/4h ago/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/0s ago/)).toBeNull();
  });

  it("keeps the sheet open through loading, error, retry, unavailable and loaded states", () => {
    const onRetry = vi.fn();
    const props = { logo: undefined, riskFreeRate: 3, medianApy: null, open: true, onOpenChange: vi.fn(), onRetry };
    const { rerender } = render(<YieldSourceSheet {...props} ranking={null} loading />);
    expect(screen.getByRole("heading", { name: "Yield source details" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<YieldSourceSheet {...props} ranking={null} error={new Error("source fetch failed")} />);
    expect(screen.getByRole("heading", { name: "Yield source details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<YieldSourceSheet {...props} ranking={null} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Yield source details" })).toBeTruthy();
    rerender(<YieldSourceSheet {...props} ranking={makeRanking("usdc", "best-usdc", "alt-usdc")} />);
    expect(screen.getByRole("link", { name: "usdc-best" }).getAttribute("href")).toBe("https://example.com/usdc/best");
    expect(screen.getByTestId("yield-history-chart")).toBeTruthy();
  });

  it("records provider opens from the chosen source link", () => {
    const ranking = makeRanking("usdc", "best-usdc", "alt-usdc");
    renderYieldSourceSheet(ranking);
    vi.mocked(trackEvent).mockClear();
    fireEvent.click(screen.getByRole("link", { name: "usdc-best" }));
    expect(trackEvent).toHaveBeenCalledExactlyOnceWith("yield_row_action", {
      action: "provider_opened", coin_id: "usdc", warning_count: ranking.warningSignals.length,
    });
  });

  it("resets the selected source when the ranking changes", () => {
    const usdc = makeRanking("usdc", "best-usdc", "alt-usdc");
    const usdt = makeRanking("usdt", "best-usdt", "alt-usdt");
    const { rerender } = renderYieldSourceSheet(usdc);

    fireEvent.click(screen.getByRole("button", { name: /usdc-alt/i }));
    expect(screen.getByTestId("yield-history-chart").textContent).toContain("alt-usdc");

    rerender(<YieldSourceSheet ranking={usdt} logo={undefined} riskFreeRate={0.02} medianApy={0.03} open onOpenChange={vi.fn()} />);

    expect(screen.getByTestId("yield-history-chart").textContent).toContain("best-usdt");
  });

  it("resolves a missing row rate from its registry benchmark for the history chart", () => {
    renderYieldSourceSheet(
      {
        ...makeRanking("eurc", "best-eurc", "alt-eurc"),
        benchmarkKey: "EUR",
        benchmarkLabel: "EUR 3M compounded €STR",
        benchmarkRate: undefined,
      },
      { benchmarks: REGISTRY_WITH_EUR },
    );

    const chart = screen.getByTestId("yield-history-chart");
    expect(chart.getAttribute("data-benchmark-rate")).toBe("1.94");
    expect(chart.getAttribute("data-benchmark-label")).toBe("EUR 3M compounded €STR");
  });

  it("shows current and previous source identity for source changes", () => {
    renderYieldSourceSheet({
      ...makeRanking("usdc", "best-usdc", "alt-usdc"),
      provenance: makeYieldProvenance({
        sourceKey: "best-usdc",
        sourceSwitch: true,
        previousBestSourceKey: "alt-usdc",
        selectionReason: "Higher confidence than retained alternates.",
      }),
      decisionLedger: {
        selectedReasonCode: "curated-over-discovered",
        previousBestSourceKey: "alt-usdc",
        sourceSwitch: true,
        apy30dDeltaFromPrevious: 0.8,
        rejectedCount: 1,
        alternatives: [
          {
            sourceKey: "alt-usdc",
            yieldSource: "usdc-alt",
            apy30dDelta: -0.2,
            rejectionReasonCode: "lower-confidence",
          },
        ],
      },
    });

    expect(screen.getByText("Current source key:")).toBeTruthy();
    expect(screen.getAllByText("best-usdc").length).toBeGreaterThan(0);
    expect(screen.getByText("Previous source:")).toBeTruthy();
    expect(screen.getAllByText("usdc-alt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("alt-usdc").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Why this source won")).toBeTruthy();
    expect(screen.getByText("Curated source preferred")).toBeTruthy();
    expect(screen.getAllByText("Curated").length).toBeGreaterThan(0);
    expect(screen.getByText("Source changed (+0.80% APY30d)")).toBeTruthy();
    expect(screen.getByText("1 alternate rejected")).toBeTruthy();
  });

  it("shows modeled evidence qualification without presenting it as a direct observation", () => {
    renderYieldSourceSheet({
      ...makeRanking("usdc", "best-usdc", "alt-usdc"),
      provenance: makeYieldProvenance({
        sourceKey: "rate-derived:usdc",
        confidenceTier: "deterministic",
        calculationMode: "benchmark-model",
        evidenceClass: "modeled-proxy",
        evidenceCompleteness: 0.7143,
        scoreQualification: "estimated",
        selectionReason: "Modeled proxy retained as context.",
      }),
    });

    expect(screen.getByText("Estimated")).toBeTruthy();
    expect(screen.getByText("Modeled proxy")).toBeTruthy();
    expect(screen.getByText("Benchmark model")).toBeTruthy();
    expect(screen.getByText("71% evidence")).toBeTruthy();
  });

  it("renders the source-risk sparkbar under the APY with the provided score", () => {
    renderYieldSourceSheet({
      ...makeRanking("usdc", "best-usdc", "alt-usdc"),
      sourceRisk: { sourceRiskScore: 72, sourceAgeSeconds: null },
    });

    expect(screen.getAllByTestId("yield-source-risk-bar").map((node) => node.textContent)).toContain("72");
    expect(screen.getByText("Score")).toBeTruthy();
    expect(screen.getByText("72/100")).toBeTruthy();
    expect(screen.getByText("Penalty")).toBeTruthy();
    expect(screen.getAllByText("1.00x").length).toBeGreaterThan(0);
  });

  it("renders the sparkbar in the unavailable variant when sourceRiskScore is missing", () => {
    renderYieldSourceSheet(makeRanking("usdc", "best-usdc", "alt-usdc"));

    expect(screen.getAllByTestId("yield-source-risk-bar").some((node) => node.textContent === "unavailable")).toBe(
      true,
    );
  });

  it("renders a freshness stamp when sourceAgeSeconds is provided", () => {
    const base = makeRanking("usdc", "best-usdc", "alt-usdc");
    renderYieldSourceSheet({
      ...base,
      provenance: { ...base.provenance!, sourceFreshness: "fresh" },
      sourceRisk: { sourceRiskScore: null, sourceAgeSeconds: 90 * 60 },
    });

    const stamp = screen
      .getAllByText("Fresh · 1h ago")
      .find((node) => node.getAttribute("title")?.startsWith("Published source freshness: Fresh."));
    expect(stamp).toBeTruthy();
  });

  it("does not render a freshness stamp when sourceAgeSeconds is missing", () => {
    renderYieldSourceSheet(makeRanking("usdc", "best-usdc", "alt-usdc"));

    expect(screen.queryByText(/ago$/)).toBeNull();
  });

  it("renders the deep-dive yield link without a sources param by default", () => {
    renderYieldSourceSheet(makeRanking("susde-ethena", "selected", "alternate"));

    const deepDive = screen.getByRole("link", { name: /Deep dive yield/i });
    expect(deepDive.getAttribute("href")).toBe("/stablecoin/susde-ethena/yield");
  });

  it("appends sources param to deep-dive link when an alternate is selected", () => {
    renderYieldSourceSheet(makeRanking("susde-ethena", "selected", "alternate"));

    fireEvent.click(screen.getByRole("button", { name: /susde-ethena-alt/i }));
    const deepDive = screen.getByRole("link", { name: /Deep dive yield/i });
    expect(deepDive.getAttribute("href")).toBe("/stablecoin/susde-ethena/yield?sources=alternate");
  });

  it("normalizes malformed unicode source keys in the deep-dive link", () => {
    renderYieldSourceSheet(makeRanking("susde-ethena", "selected", "\uD800"));

    fireEvent.click(screen.getByRole("button", { name: /susde-ethena-alt/i }));
    const deepDive = screen.getByRole("link", { name: /Deep dive yield/i });
    expect(deepDive.getAttribute("href")).toBe("/stablecoin/susde-ethena/yield?sources=%EF%BF%BD");
  });

  it("uses an honestly named leaderboard fallback for dynamically covered USDC, without source params", () => {
    renderYieldSourceSheet(makeRanking("usdc-circle", "selected", "alternate"));
    fireEvent.click(screen.getByRole("button", { name: /usdc-circle-alt/i }));
    expect(screen.getByRole("link", { name: /View yield opportunities/i }).getAttribute("href"))
      .toBe("/yield?workbenchFallback=usdc-circle");
    expect(screen.queryByRole("link", { name: /Deep dive yield/i })).toBeNull();
  });

  it("keeps the existing View full dossier link to the main detail page", () => {
    renderYieldSourceSheet(makeRanking("usdc", "best-usdc", "alt-usdc"));

    const dossier = screen.getByRole("link", { name: /View full dossier/i });
    expect(dossier.getAttribute("href")).toBe("/stablecoin/usdc");
  });

  it("shows source-risk driver labels from the shared golden fixture", () => {
    const baseRanking = makeRanking("usdc", "best-usdc", "alt-usdc");
    renderYieldSourceSheet({
      ...baseRanking,
      provenance: { ...baseRanking.provenance!, sourceFreshness: "stale" },
      sourceRisk: mergeSourceRiskGoldenFixtures(["reward-heavy", "stale-source-age"], { sourceRiskPenalty: 1.65 }),
    });

    expect(screen.getByText("Source risk")).toBeTruthy();
    expect(screen.getByText("reward-heavy")).toBeTruthy();
    expect(screen.getByText("stale source")).toBeTruthy();
  });

  it("renders a rejection-hint chip on retained alternates when populated", () => {
    const base = makeRanking("usdc", "best-usdc", "alt-usdc");
    renderYieldSourceSheet({
      ...base,
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0 },
      altSources: [
        makeAltYieldSource({
          sourceKey: "alt-usdc",
          yieldSource: "usdc-alt",
          yieldSourceUrl: null,
          currentApy: 0.04,
          apy30d: 0.04,
          sourceTvlUsd: 10_000_000,
          dataSource: "defillama",
          sourceRisk: { sourceDepthRatio: 0.001, sourceAgeSeconds: 60, rewardShare: 0 },
          rejectionReasonCode: "thinner",
        }),
      ],
    });

    expect(screen.getByText("thinner venue")).toBeTruthy();
    expect(screen.getByText("Risk n/a | 1.00x")).toBeTruthy();
    expect(screen.getByText("Moderate depth")).toBeTruthy();
  });

  it("does not render a rejection-hint chip when rejectionHint is null", () => {
    const base = makeRanking("usdc", "best-usdc", "alt-usdc");
    renderYieldSourceSheet({
      ...base,
      dataSource: "defillama",
      sourceTvlUsd: 10_000_000,
      sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0 },
      altSources: [
        makeAltYieldSource({
          sourceKey: "alt-usdc",
          yieldSource: "usdc-alt",
          yieldSourceUrl: null,
          currentApy: 0.04,
          apy30d: 0.04,
          sourceTvlUsd: 10_000_000,
          dataSource: "defillama",
          sourceRisk: { sourceDepthRatio: 0.05, sourceAgeSeconds: 60, rewardShare: 0 },
        }),
      ],
    });

    expect(screen.queryByText("thinner")).toBeNull();
    expect(screen.queryByText("stale")).toBeNull();
    expect(screen.queryByText("rewards-only")).toBeNull();
    expect(screen.queryByText("lower-conf")).toBeNull();
    expect(screen.queryByText("smaller")).toBeNull();
  });
});
