// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCoverageFeatureSummary, buildCoverageRow, COVERAGE_FEATURES } from "@/lib/coverage";
import type { CoverageFeatureSummary } from "@/lib/coverage";
import { CoverageFeatureSnapshotRow } from "@/components/coverage/coverage-feature-snapshot";
import { CoverageFeatureSnapshotCard } from "@/components/coverage/coverage-page-sections";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";

afterEach(cleanup);

describe("CoverageFeatureSnapshotRow", () => {
  it("uses only mint-authority route buckets for stacked-bar semantics", () => {
    const summary: CoverageFeatureSummary = {
      feature: COVERAGE_FEATURES.find((feature) => feature.key === "mintAuthority")!,
      availableCount: 1,
      totalCount: 2,
      coveragePct: 50,
      coveredMcapUsd: 800,
      marketCapObservedCount: 2,
      marketCapComplete: true,
      mcapSharePct: 80,
      countLabel: "Reviewed authority",
      coverageLabel: "50% with reviewed mint authority",
      shareLabel: "Reviewed mint-authority market-cap reach",
      breakdown: [
        { key: "issuer-or-backend-mint", label: "issuer/backend", count: 1 },
        { key: "unknown", label: "unknown", count: 1 },
        { key: "score-concentrated", label: "Concentrated", count: 1 },
        { key: "score-nr", label: "NR", count: 1 },
      ],
    };

    render(<CoverageFeatureSnapshotRow summary={summary} />);

    const bar = screen.getByRole("img", {
      name: "Mint Authority coverage: issuer/backend 1, unknown 1",
    });

    expect(bar).toBeTruthy();
    expect(bar.querySelectorAll("[title]")).toHaveLength(2);
    expect(bar.getAttribute("aria-label")).not.toContain("Concentrated");
    expect(bar.getAttribute("aria-label")).not.toContain("NR");
  });

  it("stacks legacy DEX rows in their own bucket and counts only true gaps as not covered", () => {
    const summary: CoverageFeatureSummary = {
      feature: COVERAGE_FEATURES.find((feature) => feature.key === "dex")!,
      availableCount: 3,
      totalCount: 4,
      coveragePct: 75,
      coveredMcapUsd: 0,
      marketCapObservedCount: 4,
      marketCapComplete: true,
      mcapSharePct: null,
      countLabel: "Coin count",
      coverageLabel: "75% of active coins",
      shareLabel: "Active market-cap reach",
      breakdown: [
        { key: "primary", label: "primary", count: 2 },
        { key: "legacy", label: "legacy", count: 1 },
        { key: "data-unavailable", label: "data n/a", count: 1 },
      ],
    };

    render(<CoverageFeatureSnapshotRow summary={summary} />);

    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toContain("primary 2");
    expect(label).toContain("legacy 1");
    expect(label).toContain("data n/a 1");
    // One unobserved row is the only true gap; the n/a row must not inflate it.
    expect(label).toContain("not covered 1");
  });

  it("renders Data n/a instead of 0% when the whole feature is unavailable", () => {
    const summary: CoverageFeatureSummary = {
      feature: COVERAGE_FEATURES.find((feature) => feature.key === "yield")!,
      availableCount: 0,
      totalCount: 0,
      coveragePct: null,
      coveredMcapUsd: 0,
      marketCapObservedCount: 0,
      marketCapComplete: true,
      mcapSharePct: null,
      countLabel: "Coin count",
      coverageLabel: "Data n/a",
      shareLabel: "Active market-cap reach",
      breakdown: [{ key: "data-unavailable", label: "data n/a", count: 3 }],
    };

    render(<CoverageFeatureSnapshotRow summary={summary} />);

    expect(screen.getAllByText("Data n/a").length).toBeGreaterThan(0);
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("labels observed-only snapshot ratios as known cap", () => {
    const feature = COVERAGE_FEATURES.find((entry) => entry.key === "yield")!;
    const base = buildCoverageRow({
      coin: makeStablecoinMeta(), marketCapUsd: 100, hasPegCoverage: true,
      safetyScore: null, dexCoverageClass: null, hasYieldCoverage: true, flowCoverageStatus: null,
    });
    const summary = buildCoverageFeatureSummary(feature, [
      base, { ...base, id: "unknown", marketCapAvailable: false },
    ]);
    render(<CoverageFeatureSnapshotRow summary={summary} />);
    expect(screen.getByText("of known cap")).toBeTruthy();
  });

  it("renders cap skew unavailable without naming a feature when no share is observed", () => {
    render(<CoverageFeatureSnapshotCard
      featureSummaries={[]}
      sourceDepthProgress={{
        totalCount: 0, atTargetCount: 0, exactTwoCount: 0, belowTargetCount: 0,
        marketCapComplete: false, atTargetPct: null, atTargetMcapPct: null, exactTwoMcapPct: null,
      }}
      widestFeature={null} narrowestFeature={null} mostConcentratedFeature={null}
    />);
    const tile = screen.getByText("Cap skew").parentElement!;
    expect(tile.textContent).toMatch(/n\/a/);
    expect(tile.textContent).not.toContain("Price");
  });
});
