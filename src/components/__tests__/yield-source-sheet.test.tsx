// @vitest-environment jsdom

import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldSourceSheet } from "@/components/yield-source-sheet";
import { mergeSourceRiskGoldenFixtures } from "@shared/test-utils/yield-source-risk-golden-fixtures";
import { makeAltYieldSource, makeYieldProvenance, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldRanking } from "@shared/types";
import { renderYieldSourceSheet } from "./yield-source-sheet-test-support";

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/yield-history-chart", () => ({
  YieldHistoryChart: ({ externalSourceKey }: { externalSourceKey: string }) => (
    <div data-testid="yield-history-chart">{externalSourceKey}</div>
  ),
}));

vi.mock("@/components/table/client", () => ({
  TableSourceLink: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
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

  it("resets the selected source when the ranking changes", () => {
    const usdc = makeRanking("usdc", "best-usdc", "alt-usdc");
    const usdt = makeRanking("usdt", "best-usdt", "alt-usdt");
    const { rerender } = renderYieldSourceSheet(usdc);

    fireEvent.click(screen.getByRole("button", { name: /usdc-alt/i }));
    expect(screen.getByTestId("yield-history-chart").textContent).toContain("alt-usdc");

    rerender(<YieldSourceSheet ranking={usdt} logo={undefined} riskFreeRate={0.02} medianApy={0.03} open onOpenChange={vi.fn()} />);

    expect(screen.getByTestId("yield-history-chart").textContent).toContain("best-usdt");
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
    renderYieldSourceSheet(makeRanking("usdc", "best-usdc", "alt-usdc"));

    const deepDive = screen.getByRole("link", { name: /Deep dive yield/i });
    expect(deepDive.getAttribute("href")).toMatch(/^\/stablecoin\/usdc\/yield\/?$/);
  });

  it("appends sources param to deep-dive link when an alternate is selected", () => {
    renderYieldSourceSheet(makeRanking("usdc", "best-usdc", "alt-usdc"));

    fireEvent.click(screen.getByRole("button", { name: /usdc-alt/i }));
    const deepDive = screen.getByRole("link", { name: /Deep dive yield/i });
    expect(deepDive.getAttribute("href")).toMatch(/^\/stablecoin\/usdc\/yield\/?\?sources=alt-usdc$/);
  });

  it("normalizes malformed unicode source keys in the deep-dive link", () => {
    renderYieldSourceSheet(makeRanking("usdc", "best-usdc", "\uD800"));

    fireEvent.click(screen.getByRole("button", { name: /usdc-alt/i }));
    const deepDive = screen.getByRole("link", { name: /Deep dive yield/i });
    expect(deepDive.getAttribute("href")).toMatch(/^\/stablecoin\/usdc\/yield\/?\?sources=%EF%BF%BD$/);
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
        }),
      ],
    });

    expect(screen.getByText("thinner")).toBeTruthy();
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
