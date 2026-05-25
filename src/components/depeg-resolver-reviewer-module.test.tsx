// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DepegResolverReviewerModule } from "@/components/depeg-resolver-reviewer-module";
import type { DdrrResponse, DdrrRow, DdrrSummary } from "@shared/types";

vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverReviewerEnabled: () => true,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: () => <span data-testid="logo" />,
}));

afterEach(() => {
  cleanup();
});

const summary: DdrrSummary = {
  recoveryLikelihoodCorrectCount: 2,
  recoveryLikelihoodScoredCount: 4,
  recoveryLikelihoodAccuracyPct: 0.5,
  durationScoredCount: 2,
  averageSignedDurationErrorSec: 3600,
  averageAbsoluteDurationErrorSec: 5400,
  correctRecoverable: 1,
  correctTerminal: 1,
  falseTerminal: 1,
  falseRecoverable: 1,
  riskNotedTerminal: 0,
  unscoredInsufficientSignal: 0,
  pending: 1,
  dataIssue: 0,
  verdictScoredCount: 4,
  durationUnscoredCount: 1,
  withinIqrCount: 1,
  iqrScoredCount: 2,
  withinIqrPct: 0.5,
  medianAbsoluteErrorSec: 5400,
  horizonHitRates: [
    { horizon: "6h", scored: 1, hits: 1, misses: 0, hitRate: 1 },
    { horizon: "24h", scored: 0, hits: 0, misses: 0, hitRate: null },
    { horizon: "7d", scored: 0, hits: 0, misses: 0, hitRate: null },
    { horizon: "30d", scored: 0, hits: 0, misses: 0, hitRate: null },
  ],
};

const row: DdrrRow = {
  eventId: 42,
  stablecoinId: "lusd-liquity",
  symbol: "LUSD",
  name: "Liquity USD",
  pegCurrency: "USD",
  governance: "decentralized",
  direction: "below",
  startedAt: 1,
  assessedAt: 2,
  eventAgeSec: 1,
  checkpoint: "first",
  methodologyVersion: "1.0",
  resolutionTier: "recovery_likely",
  durationSuppressed: false,
  durationSuppressedReason: null,
  predictedRemainingSec: 3600,
  iqrRemainingSec: [1800, 7200],
  actualOutcome: "recovered",
  actualEndedAt: 7202,
  actualRemainingSec: 7200,
  verdictReview: "correct_recoverable",
  durationReview: "inside_band",
  medianReview: "median_late_by",
  signedErrorSec: 3600,
  absoluteErrorSec: 3600,
  withinIqr: true,
  horizonReviews: [],
  stratum: "below - moderate - robust - USD",
  factors: [],
  sourceEventState: "recovered",
};

function response(overrides: Partial<DdrrResponse> = {}): DdrrResponse {
  return {
    _meta: {
      computedAt: 1,
      expiresAt: 2,
      degraded: false,
      degradedReason: null,
      reviewerVersion: "ddr-reviewer-v1",
      publicWarning: "review warning",
      assessedEventCount: 1,
      reviewedEventCount: 1,
      pendingEventCount: 1,
      durationScoredCount: 2,
      verdictScoredCount: 4,
      assessmentRowLimit: 20_000,
      assessmentRowsTruncated: false,
      publicRowLimit: 100,
      publicRowsTruncated: false,
      methodologyVersions: ["1.0"],
    },
    summary,
    rows: [row],
    methodology: {
      version: "1.0",
      versionLabel: "v1.0",
      currentVersion: "1.0",
      currentVersionLabel: "v1.0",
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: 1,
      isCurrent: true,
    },
    ...overrides,
  };
}

describe("DepegResolverReviewerModule", () => {
  it("surfaces recovery likelihood and recovery duration headline stats", () => {
    render(<DepegResolverReviewerModule data={response()} />);

    expect(screen.getByText("Recovery likelihood")).toBeTruthy();
    expect(screen.getByText("Recovery duration")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getAllByText("+1h").length).toBeGreaterThan(0);
    expect(screen.getByText("2/4 scored DDR recovery verdicts")).toBeTruthy();
    expect(screen.getByText(/mean absolute miss 1h 30m/)).toBeTruthy();
  });

  it("keeps loading and empty states distinct", () => {
    const { rerender } = render(<DepegResolverReviewerModule data={undefined} />);
    expect(screen.getByText("Reviewer data is loading.")).toBeTruthy();

    rerender(<DepegResolverReviewerModule data={response({ rows: [], summary })} />);
    expect(screen.getByText("No DDR assessments have matured into reviewable outcomes yet.")).toBeTruthy();
  });

  it("surfaces endpoint errors without rendering N/A headline stats", () => {
    render(<DepegResolverReviewerModule data={undefined} error={new Error("missing endpoint")} />);

    expect(screen.getByText("Reviewer data is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByText("Recovery likelihood")).toBeNull();
    expect(screen.queryByText("Recovery duration")).toBeNull();
    expect(screen.queryByText("N/A")).toBeNull();
  });
});
