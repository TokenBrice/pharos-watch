// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { COVERAGE_FEATURES } from "@/lib/coverage";
import type { CoverageFeatureSummary } from "@/lib/coverage";
import { CoverageFeatureSnapshotRow } from "@/components/coverage/coverage-feature-snapshot";

afterEach(cleanup);

describe("CoverageFeatureSnapshotRow", () => {
  it("uses only mint-authority route buckets for stacked-bar semantics", () => {
    const summary: CoverageFeatureSummary = {
      feature: COVERAGE_FEATURES.find((feature) => feature.key === "mintAuthority")!,
      availableCount: 1,
      totalCount: 2,
      coveragePct: 50,
      coveredMcapUsd: 800,
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
});
