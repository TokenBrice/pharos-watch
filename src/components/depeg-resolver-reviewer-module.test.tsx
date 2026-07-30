// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  DepegResolverReviewerModule,
  DepegResolverReviewerSkeleton,
} from "@/components/depeg-resolver-reviewer-module";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
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

function makeSummary(headline: Partial<DdrrSummary["headline"]> = {}): DdrrSummary {
  const base = summarizeDdrrRows([]);
  return {
    ...base,
    headline: {
      ...base.headline,
      ...headline,
    },
  };
}

const summary: DdrrSummary = makeSummary({
  recoveryLikelihoodCorrectCount: 2,
  recoveryLikelihoodScoredCount: 4,
  recoveryLikelihoodAccuracyPct: 0.5,
  durationScoredCount: 2,
  meanSignedDurationErrorSec: 3600,
  meanAbsoluteDurationErrorSec: 5400,
  pendingLockCount: 1,
});

const row: DdrrRow = {
  kind: "prediction_review",
  eventId: 42,
  currentEventId: 42,
  incidentKey: "lusd-liquity:below:1",
  stablecoinId: "lusd-liquity",
  symbol: "LUSD",
  name: "Liquity USD",
  pegCurrency: "USD",
  governance: "decentralized",
  direction: "below",
  startedAt: 1,
  eligibleAt: 1,
  sourceEventState: "recovered",
  terminalEvidenceAt: null,
  terminalEvidenceInterval: null,
  terminalEvidencePrecision: null,
  publicPredictionId: 7,
  assessmentId: 9,
  predictionState: "frozen",
  predictionMethodologyVersion: "1.0",
  predictionPolicyVersion: "sticky-24h-v1",
  lockedAt: 2,
  publishedAt: 3,
  publicationSnapshotToken: "snapshot-1",
  frozen: {
    resolutionTier: "recovery_likely",
    predictedRemainingSec: 3600,
    iqrRemainingSec: [1800, 7200],
    horizonCells: [],
    stratum: "below - moderate - robust - USD",
    factors: [],
  },
  actual: {
    kind: "recovered",
    actualEndedAt: 7202,
    actualRemainingSec: 7200,
    terminalEvidenceAt: null,
    terminalEvidenceInterval: null,
    terminalEvidencePrecision: null,
    reviewedAt: 7202,
  },
  verdictReview: "correct_recoverable",
  durationReview: "inside_band",
  horizonReviews: [],
  predictedRemainingSec: 3600,
  actualRemainingSec: 7200,
  medianReview: "median_late_by",
  signedDurationErrorSec: 3600,
  absoluteDurationErrorSec: 3600,
  withinIqr: true,
};

const coverageRow: DdrrRow = {
  kind: "coverage",
  eventId: 43,
  currentEventId: 43,
  incidentKey: "lusd-liquity:below:2",
  stablecoinId: "lusd-liquity",
  symbol: "LUSD",
  name: "Liquity USD",
  pegCurrency: "USD",
  governance: "decentralized",
  direction: "below",
  startedAt: 1,
  eligibleAt: 1,
  sourceEventState: "recovered",
  terminalEvidenceAt: null,
  terminalEvidenceInterval: null,
  terminalEvidencePrecision: null,
  predictionState: "missed_lock_recovered",
  actualEndedAt: 7202,
  terminalEvidenceSourceDate: null,
  coverageCause: "lock_missed",
  operationalCoverageCause: "lock_missed",
  outcomeQualityState: "classified",
  reason: null,
  failedPublication: null,
};

function response(overrides: Partial<DdrrResponse> = {}): DdrrResponse {
  return {
    _meta: {
      computedAt: 1,
      expiresAt: 2,
      degraded: false,
      degradedReason: null,
      reviewerVersion: "ddr-reviewer-v3",
      publicWarning: "review warning",
      assessedEventCount: 1,
      reviewedEventCount: 1,
      pendingEventCount: 1,
      durationScoredCount: 2,
      verdictScoredCount: 4,
      assessmentRowLimit: 20_000,
      assessmentRowsTruncated: false,
      incidentRowLimit: 20_000,
      incidentRowsTruncated: false,
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
    // With fewer than two scored majors, the version strip stays hidden.
    expect(screen.queryByText("Accuracy by version")).toBeNull();
  });

  it("consolidates per-version accuracy into methodology majors", () => {
    const template = summarizeDdrrRows([]).byPredictionPolicy.find(
      (candidate) => candidate.segmentKind === "all",
    )!.metrics;
    const segment = (
      version: string,
      scored: number,
      correct: number,
      durationScored = 0,
      meanSignedDurationErrorSec: number | null = null,
      meanAbsoluteDurationErrorSec: number | null = null,
    ) => ({
      segmentKind: "prediction_policy" as const,
      predictionMethodologyVersion: version,
      predictionPolicyVersion: "sticky-24h-v1",
      metrics: {
        ...template,
        recoveryLikelihoodScoredCount: scored,
        recoveryLikelihoodCorrectCount: correct,
        durationScoredCount: durationScored,
        meanSignedDurationErrorSec,
        meanAbsoluteDurationErrorSec,
      },
    });
    render(
      <DepegResolverReviewerModule
        data={response({
          summary: {
            ...summary,
            byPredictionPolicy: [
              segment("2.0", 6, 5, 5, 3600, 5400),
              segment("3.02", 13, 11, 10, 7200, 10800),
              segment("3.04", 21, 20, 20, -3600, 7200),
              ...summary.byPredictionPolicy,
            ],
          },
        })}
      />,
    );

    expect(screen.getByText("Accuracy by version")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
    expect(screen.getByText("83.3% · 6 scored")).toBeTruthy();
    expect(screen.getByText("+1h ±1h 30m miss")).toBeTruthy();
    // 3.02 and 3.04 consolidate into the v3 major: 31/34 correct; duration
    // means recombine weighted by scored counts: (10·2h + 20·(−1h)) / 30 = 0s.
    expect(screen.getByText("91.2% · 34 scored")).toBeTruthy();
    expect(screen.getByText("0s ±2h 20m miss")).toBeTruthy();
    // The current major always renders, as maturing until its first rows score.
    expect(screen.getByText("v4")).toBeTruthy();
    expect(screen.getByText("maturing · 0 scored")).toBeTruthy();
    expect(screen.getByText("— miss")).toBeTruthy();
  });

  it("promotes the percentage once enough verdicts are scored", () => {
    render(
      <DepegResolverReviewerModule
        data={response({
          summary: {
            ...summary,
            headline: {
              ...summary.headline,
              recoveryLikelihoodCorrectCount: 5,
              recoveryLikelihoodScoredCount: 5,
              recoveryLikelihoodAccuracyPct: 1,
            },
          },
        })}
      />,
    );

    expect(screen.getByText("5 / 5")).toBeTruthy();
    expect(screen.getByText(/100%/)).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.queryByText("Calibrating")).toBeNull();
  });

  it("shows DDRv2 coverage accountability metrics and coverage-row labels", () => {
    render(
      <DepegResolverReviewerModule
        data={response({
          summary: {
            ...summary,
            headline: {
              ...summary.headline,
              policyUniverseIncidentCount: 20,
              recoveryLikelihoodScoredCount: 8,
              predictionRatePct: 0.65,
              lockedPredictionCount: 9,
              publicationRetryPendingCount: 1,
              publicationFailedCount: 0,
              noCallRatePct: 0.1,
              invalidatedPct: 0.05,
            },
          },
          rows: [row, coverageRow],
        })}
      />,
    );

    expect(screen.getByText("Coverage accountability")).toBeTruthy();
    expect(screen.getByText("20 policy-universe incidents")).toBeTruthy();
    expect(screen.getByText("Scoreable coverage")).toBeTruthy();
    expect(screen.getByText("Prediction coverage")).toBeTruthy();
    expect(screen.getByText("Publication success")).toBeTruthy();
    expect(screen.getByText("No-call share")).toBeTruthy();
    expect(screen.getByText("Invalidation rate")).toBeTruthy();
    expect(screen.getByText("missed recovered")).toBeTruthy();
    expect(screen.getByText("Coverage · recovered")).toBeTruthy();
    expect(screen.getByText(/frozen outcomes only after first public publication/)).toBeTruthy();
    expect(screen.getByRole("img", { name: /Track record across 1 graded DDR outcomes/ })).toBeTruthy();
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

  it("renders a busy skeleton fallback that reserves the section layout", () => {
    const { container } = render(<DepegResolverReviewerSkeleton />);

    const section = screen.getByLabelText("Depeg Duration Resolver Reviewer");
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    // No real stats should leak into the placeholder.
    expect(screen.queryByText("Recovery calls")).toBeNull();
  });
});
