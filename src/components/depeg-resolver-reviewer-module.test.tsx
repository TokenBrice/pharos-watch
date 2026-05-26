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
  it("shows the calibration ledger as fractions while the scored sample is thin", () => {
    render(<DepegResolverReviewerModule data={response()} />);

    expect(screen.getByText("Recovery calls")).toBeTruthy();
    expect(screen.getByText("Duration calls")).toBeTruthy();
    // Scored sample (4) is below the promotion threshold, so the call is a raw fraction…
    expect(screen.getByText("2 / 4")).toBeTruthy();
    expect(screen.getByText("correct so far")).toBeTruthy();
    // …and the percentage is deliberately withheld to avoid overstating a thin sample.
    expect(screen.queryByText("50%")).toBeNull();
    expect(screen.getByText("Calibrating")).toBeTruthy();
    // Duration miss + scored-vs-maturing progress captions.
    expect(screen.getAllByText("+1h").length).toBeGreaterThan(0);
    expect(screen.getByText(/1h 30m/)).toBeTruthy();
    expect(screen.getByText("4 scored · 1 maturing")).toBeTruthy();
    expect(screen.getByText("2 scored · 1 maturing")).toBeTruthy();
    // Reviewed readout row renders with its verdict.
    expect(screen.getByText("LUSD")).toBeTruthy();
    expect(screen.getByText("Correct recoverable")).toBeTruthy();
  });

  it("promotes the percentage once enough verdicts are scored", () => {
    render(
      <DepegResolverReviewerModule
        data={response({
          summary: {
            ...summary,
            recoveryLikelihoodCorrectCount: 5,
            recoveryLikelihoodScoredCount: 5,
            recoveryLikelihoodAccuracyPct: 1,
          },
        })}
      />,
    );

    expect(screen.getByText("5 / 5")).toBeTruthy();
    expect(screen.getByText(/100%/)).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.queryByText("Calibrating")).toBeNull();
  });

  it("keeps loading and empty states distinct", () => {
    const { rerender } = render(<DepegResolverReviewerModule data={undefined} />);
    expect(screen.getByText("Reviewer data is loading.")).toBeTruthy();

    rerender(<DepegResolverReviewerModule data={response({ rows: [], summary })} />);
    expect(screen.getByText("No readouts have matured yet.")).toBeTruthy();
  });

  it("surfaces endpoint errors without rendering misleading stats", () => {
    render(<DepegResolverReviewerModule data={undefined} error={new Error("missing endpoint")} />);

    expect(screen.getByText("Reviewer data is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByText("Recovery calls")).toBeNull();
    expect(screen.queryByText("Duration calls")).toBeNull();
    expect(screen.queryByText("N/A")).toBeNull();
  });
});
