// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildCoverageFeatureSummary, buildCoverageRow, COVERAGE_FEATURES } from "@/lib/coverage";
import type { CoverageFeatureSummary } from "@/lib/coverage";
import { CoverageFeatureSnapshotRow } from "@/components/coverage/coverage-feature-snapshot";
import { CoverageFeatureSnapshotCard } from "@/components/coverage/coverage-page-sections";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";


describe("CoverageFeatureSnapshotRow", () => {
  it("renders a pipeline gap as unavailable, never NR or an ordinary missing safety row", () => {
    const row = buildCoverageRow({
      coin: makeStablecoinMeta(), marketCapUsd: 100, hasPegCoverage: true,
      safetyScore: null, safetyRatingStatus: "pipeline-gap",
      safetyReasonCodes: ["single-pillar-pipeline-gap"],
      dexCoverageClass: null, hasYieldCoverage: false, flowCoverageStatus: null,
    });
    const feature = COVERAGE_FEATURES.find((entry) => entry.key === "safety")!;
    const { container } = render(<CoverageFeatureSnapshotRow summary={buildCoverageFeatureSummary(feature, [row])} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Safety Score coverage: data n/a 1");
    expect(container.textContent).toContain("n/a 1");
    expect(container.textContent).toContain("/0");
    expect(container.textContent).not.toMatch(/NR|Not rated|not covered/);
  });

  it("uses only mint-authority route buckets for stacked-bar semantics", () => {
    const summary: CoverageFeatureSummary = {
      feature: COVERAGE_FEATURES.find((feature) => feature.key === "mintAuthority")!,
      availableCount: 1,
      totalCount: 2,
      coveragePct: 50,
      coverageUnavailable: false,
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
      denominatorBreakdown: [
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
      coverageUnavailable: false,
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
      denominatorBreakdown: [
        { key: "primary", label: "primary", count: 2 },
        { key: "legacy", label: "legacy", count: 1 },
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
      coverageUnavailable: true,
      coveredMcapUsd: 0,
      marketCapObservedCount: 0,
      marketCapComplete: true,
      mcapSharePct: null,
      countLabel: "Coin count",
      coverageLabel: "Data n/a",
      shareLabel: "Active market-cap reach",
      breakdown: [{ key: "data-unavailable", label: "data n/a", count: 3 }],
      denominatorBreakdown: [],
    };

    render(<CoverageFeatureSnapshotRow summary={summary} />);

    expect(screen.getAllByText("Data n/a").length).toBeGreaterThan(0);
    expect(screen.queryByText("0%")).toBeNull();
  });

  it("reconciles the price depth bar with the narrowed denominator", () => {
    const base = {
      coin: makeStablecoinMeta(), marketCapUsd: 100, hasPegCoverage: true,
      safetyScore: null, safetyRatingStatus: "not-rated" as const, dexCoverageClass: null,
      hasYieldCoverage: false, flowCoverageStatus: null,
    };
    const navFlags = { ...makeStablecoinMeta().flags, navToken: true };
    const feature = COVERAGE_FEATURES.find((entry) => entry.key === "price")!;
    const summary = buildCoverageFeatureSummary(feature, [
      buildCoverageRow({ ...base, consensusSources: ["a", "b", "c"] }),
      buildCoverageRow({ ...base, coin: makeStablecoinMeta({ id: "unknown-depth" }) }),
      buildCoverageRow({
        ...base,
        coin: makeStablecoinMeta({ id: "nav-only", flags: navFlags }),
        hasPegCoverage: false,
      }),
      buildCoverageRow({ ...base, coin: makeStablecoinMeta({ id: "unpriced" }), currentPriceUnavailable: true }),
    ]);
    const { container } = render(<CoverageFeatureSnapshotRow summary={summary} />);

    const bar = screen.getByRole("img");
    // The denominator admits the known-depth tracked row and the uncovered row;
    // price-only and unknown-depth rows stay outside it.
    expect(summary.totalCount).toBe(2);
    expect(bar.getAttribute("aria-label")).toContain("not covered 1");
    expect(bar.getAttribute("aria-label")).not.toContain("price-only");
    expect(container.textContent).not.toContain("tracked 2");
  });

  it("qualifies the price cap share when the denominator excludes active rows", () => {
    const base = {
      coin: makeStablecoinMeta(), marketCapUsd: 100, hasPegCoverage: true,
      safetyScore: null, safetyRatingStatus: "not-rated" as const, dexCoverageClass: null,
      hasYieldCoverage: false, flowCoverageStatus: null,
    };
    const feature = COVERAGE_FEATURES.find((entry) => entry.key === "price")!;
    const summary = buildCoverageFeatureSummary(feature, [
      buildCoverageRow({ ...base, consensusSources: ["a", "b", "c"] }),
      buildCoverageRow({
        ...base,
        coin: makeStablecoinMeta({
          id: "nav-only",
          flags: { ...makeStablecoinMeta().flags, navToken: true },
        }),
        marketCapUsd: 900,
        hasPegCoverage: false,
      }),
    ]);
    render(<CoverageFeatureSnapshotRow summary={summary} />);

    expect(screen.getByText("of known cap")).toBeTruthy();
  });

  it("renders an empty price denominator as n/a rather than a data outage", () => {
    const feature = COVERAGE_FEATURES.find((entry) => entry.key === "price")!;
    const summary = buildCoverageFeatureSummary(feature, [
      buildCoverageRow({
        coin: makeStablecoinMeta({
          id: "nav-only",
          flags: { ...makeStablecoinMeta().flags, navToken: true },
        }),
        marketCapUsd: 100,
        hasPegCoverage: false,
        safetyScore: null,
        safetyRatingStatus: "not-rated",
        dexCoverageClass: null,
        hasYieldCoverage: false,
        flowCoverageStatus: null,
      }),
    ]);
    expect(summary.coveragePct).toBeNull();
    expect(summary.coverageUnavailable).toBe(false);
    const { container } = render(<CoverageFeatureSnapshotRow summary={summary} />);

    expect(container.textContent).not.toContain("Data n/a");
  });

  it("labels observed-only snapshot ratios as known cap", () => {
    const feature = COVERAGE_FEATURES.find((entry) => entry.key === "yield")!;
    const base = buildCoverageRow({
      coin: makeStablecoinMeta(), marketCapUsd: 100, hasPegCoverage: true,
      safetyScore: null, safetyRatingStatus: "not-rated", dexCoverageClass: null, hasYieldCoverage: true, flowCoverageStatus: null,
    });
    const summary = buildCoverageFeatureSummary(feature, [
      base, { ...base, id: "unknown", marketCapAvailable: false },
    ]);
    render(<CoverageFeatureSnapshotRow summary={summary} />);
    expect(screen.getByText("of known cap")).toBeTruthy();
  });

  it("renders a report-cards outage as a data n/a reserve segment, not a coverage gap", () => {
    const base = {
      coin: makeStablecoinMeta(), marketCapUsd: 100, hasPegCoverage: true,
      safetyScore: null, safetyRatingStatus: "not-rated" as const, dexCoverageClass: null,
      hasYieldCoverage: false, flowCoverageStatus: null, dataAvailability: { reserves: false },
    };
    const feature = COVERAGE_FEATURES.find((entry) => entry.key === "reserves")!;
    const summary = buildCoverageFeatureSummary(feature, [
      buildCoverageRow({ ...base }),
      buildCoverageRow({ ...base, coin: makeStablecoinMeta({ id: "second" }) }),
    ]);
    const { container } = render(<CoverageFeatureSnapshotRow summary={summary} />);

    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Reserve view coverage: data n/a 2");
    expect(container.textContent).toContain("of known cap");
    expect(container.textContent).not.toContain("not covered");
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
