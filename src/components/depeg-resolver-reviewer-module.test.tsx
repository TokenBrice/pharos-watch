// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DepegResolverReviewerModule,
} from "@/components/depeg-resolver-reviewer-module";
import {
  coverageRow,
  makePredictionPolicySegment,
  predictionRow as row,
} from "@/components/depeg-resolver-review-test-support";
import { summarizeDdrrRows } from "@shared/lib/depeg-resolver-review";
import type { DdrrResponse, DdrrResponseRow, DdrrSummary } from "@shared/types";
import { RatioSchema } from "@shared/types/ratio";
import { DdrrResponseSchema } from "@shared/types/depeg-resolver-review";

vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverReviewerEnabled: () => true,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: () => <span data-testid="logo" />,
}));


function makeSummary(headline: Partial<DdrrSummary["headline"]> = {}): DdrrSummary {
  const base = summarizeDdrrRows([]);
  return {
    ...base,
    headline: {
      ...base.headline,
      ...headline,
    },
    byPredictionPolicy: base.byPredictionPolicy.map((segment) => segment.segmentKind === "all"
      ? { ...segment, metrics: { ...segment.metrics, ...headline } }
      : segment),
  };
}

const summary: DdrrSummary = makeSummary({
  recoveryLikelihoodCorrectCount: 2,
  recoveryLikelihoodScoredCount: 4,
  recoveryLikelihoodAccuracyPct: RatioSchema.parse(0.5),
  durationScoredCount: 2,
  meanSignedDurationErrorSec: 3600,
  meanAbsoluteDurationErrorSec: 5400,
  pendingRecoveryLikelihoodCount: 1,
});

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

function pendingPrediction(overrides: Partial<typeof row> = {}): typeof row {
  return {
    ...row,
    incidentKey: "pending-forecast",
    sourceEventState: "active",
    verdictReview: "pending",
    actual: { ...row.actual, kind: "still_open", actualEndedAt: null, actualRemainingSec: null },
    durationReview: "duration_unscored",
    actualRemainingSec: null,
    medianReview: null,
    signedDurationErrorSec: null,
    absoluteDurationErrorSec: null,
    withinIqr: null,
    ...overrides,
  };
}

describe("DepegResolverReviewerModule", () => {
  it.each([false, true])("counts only published pending forecasts with browse truncation=%s", (truncated) => {
    const pending = pendingPrediction();
    const cohort = [row, pending];
    const data = response({ summary: summarizeDdrrRows(cohort), rows: truncated ? [row] : cohort });
    data._meta.publicRowLimit = truncated ? 1 : 100;
    data._meta.publicRowsTruncated = truncated;
    render(<DepegResolverReviewerModule data={data} />);
    expect(screen.getByRole("img", { name: "1 scored of 2, 1 still maturing" })).toBeTruthy();
    expect(screen.getByText("1 scored · 1 maturing")).toBeTruthy();
  });

  it("keeps an unpublished pending lock out of maturing forecasts and in coverage", () => {
    const pendingLock: DdrrResponseRow = { ...coverageRow, predictionState: "pending_lock",
      coverageCause: "active_pending_lock", operationalCoverageCause: null,
      sourceEventState: "active", actualOutcome: "still_open", actualEndedAt: null };
    const fullSummary = summarizeDdrrRows([pendingLock]);
    render(<DepegResolverReviewerModule data={response({ summary: fullSummary, rows: [pendingLock] })} />);
    expect(screen.getByRole("img", { name: "0 scored of 0, 0 still maturing" })).toBeTruthy();
    expect(screen.getByText("1 policy-universe incidents")).toBeTruthy();
    expect(fullSummary.headline.pendingLockCount).toBe(1);
  });

  it.each([19, 20])("keeps maturing counts in the headline accuracy scope at %i outcomes", (count) => {
    const current = Array.from({ length: count }, (_, index) => ({
      ...row, incidentKey: `current-${index}`, eventId: index + 1,
    }));
    const old = { ...row, incidentKey: "old-scored", predictionPolicyVersion: "legacy-policy" };
    const cohort = [...current, old, pendingPrediction(),
      pendingPrediction({ incidentKey: "old-pending", predictionPolicyVersion: "legacy-policy" })];
    const fullSummary = summarizeDdrrRows(cohort);
    render(<DepegResolverReviewerModule data={response({ summary: fullSummary, rows: [row] })} />);
    expect(fullSummary.headlineScope).toBe(count === 20 ? "current_policy" : "all_ddrv2");
    expect(screen.getByRole("img", { name: count === 20
      ? "20 scored of 21, 1 still maturing" : "20 scored of 22, 2 still maturing" })).toBeTruthy();
    expect(fullSummary.byStablecoin?.[0].pendingCount).toBe(2);
  });

  it("admits old and new cached bodies while withholding an absent maturing count", () => {
    const current = DdrrResponseSchema.parse(response());
    expect(current.summary.headline.pendingRecoveryLikelihoodCount).toBe(1);
    const { rerender } = render(<DepegResolverReviewerModule data={current} />);
    expect(screen.getByRole("img", { name: "4 scored of 5, 1 still maturing" })).toBeTruthy();
    const retainedBody = JSON.parse(JSON.stringify(response(), (key, value) =>
      key === "pendingRecoveryLikelihoodCount" ? undefined : value));
    const retained = DdrrResponseSchema.parse(retainedBody);
    expect(retained.summary.headline.pendingRecoveryLikelihoodCount).toBeUndefined();
    rerender(<DepegResolverReviewerModule data={retained} />);
    expect(screen.getByText("4 scored · maturing unavailable")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /scored of/ })).toBeNull();
    expect(screen.queryByText("4 scored · 0 maturing")).toBeNull();
  });

  it("renders full-summary breakdowns when an incorrect outcome is beyond the 400-row browse cap", () => {
    const predictions = Array.from({ length: 401 }, (_, index): DdrrResponseRow => ({
      ...row,
      eventId: index + 1,
      incidentKey: `incident-${index}`,
      publicPredictionId: index + 1,
      verdictReview: index === 400 ? "false_terminal" : "correct_recoverable",
      withinIqr: index !== 400,
    }));
    const fullSummary = summarizeDdrrRows(predictions);
    render(<DepegResolverReviewerModule data={response({ summary: fullSummary, rows: predictions.slice(0, 400) })} />);

    expect(screen.getByText("false terminal").parentElement?.textContent).toBe("1false terminal");
    expect(screen.getByText("inside typical range").parentElement?.textContent).toBe("400/401inside typical range");
  });

  it("uses the headline policy scope rather than mixed-policy public rows for calibration breakdowns", () => {
    const current = Array.from({ length: 20 }, (_, index): DdrrResponseRow => ({ ...row, eventId: index + 1, incidentKey: `current-${index}` }));
    const old: DdrrResponseRow = { ...row, eventId: 500, incidentKey: "legacy", predictionPolicyVersion: "legacy-policy",
      verdictReview: "false_recoverable", withinIqr: false };
    const fullSummary = summarizeDdrrRows([...current, old]);
    render(<DepegResolverReviewerModule data={response({ summary: fullSummary, rows: [...current, old] })} />);

    expect(fullSummary.headlineScope).toBe("current_policy");
    expect(screen.getByText("false recoverable").parentElement?.textContent).toBe("0false recoverable");
    expect(screen.getByText("inside typical range").parentElement?.textContent).toBe("20/20inside typical range");
  });

  it("shows unavailable breakdowns for an older summary instead of recomputing from rows", () => {
    const oldSummary = makeSummary({ falseTerminalCount: undefined, falseRecoverableCount: undefined,
      withinIqrCount: undefined, iqrScoredCount: undefined });
    render(<DepegResolverReviewerModule data={response({ summary: oldSummary })} />);
    expect(screen.getByText("false terminal").parentElement?.textContent).toBe("—false terminal");
    expect(screen.getByText("inside typical range").parentElement?.textContent).toBe("—inside typical range");
  });

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
    // Reviewed readout row renders with its verdict.
    expect(screen.getByText("LUSD")).toBeTruthy();
    expect(screen.getByText("Correct recoverable")).toBeTruthy();
    // With fewer than two scored majors, the version strip stays hidden.
    expect(screen.queryByText("Accuracy by version")).toBeNull();
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
              recoveryLikelihoodAccuracyPct: RatioSchema.parse(1),
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
          summary: makeSummary({
            policyUniverseIncidentCount: 20,
            recoveryLikelihoodScoredCount: 8,
            predictionRatePct: RatioSchema.parse(0.65),
            lockedPredictionCount: 9,
            publicationRetryPendingCount: 1,
            publicationFailedCount: 0,
            noCallRatePct: RatioSchema.parse(0.1),
            invalidatedPct: RatioSchema.parse(0.05),
          }),
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

  it.each([19, 20])("retains the full coverage universe with %i current-policy outcomes", (count) => {
    const predictions = Array.from({ length: count }, (_, index) => ({
      ...row,
      incidentKey: `current-${index}`,
      eventId: index + 1,
      publicPredictionId: index + 1,
    }));
    const debt = [
      coverageRow,
      { ...coverageRow, incidentKey: "failed", predictionState: "publication_failed" as const, coverageCause: "publication_failed" as const },
      { ...coverageRow, incidentKey: "retry", predictionState: "publication_retry_pending" as const, coverageCause: "publication_retry_pending" as const, sourceEventState: "active" as const, actualOutcome: "still_open" as const, actualEndedAt: null },
      { ...coverageRow, incidentKey: "pending", predictionState: "pending_lock" as const, coverageCause: "active_pending_lock" as const, sourceEventState: "active" as const, actualOutcome: "still_open" as const, actualEndedAt: null },
    ];
    const fullSummary = summarizeDdrrRows([...predictions, ...debt]);
    render(<DepegResolverReviewerModule data={response({ summary: fullSummary, rows: [...predictions, ...debt] })} />);

    expect(screen.getByText(`${count + 4} policy-universe incidents`)).toBeTruthy();
    const ledger = screen.getByText("Coverage accountability").closest(".pharos-card-shell")!;
    expect(ledger.textContent).toContain(count === 20 ? "90.9%" : "90.5%");
    expect(ledger.textContent).toContain(count === 20 ? "83.3%" : "82.6%");
  });

  it("shows reviewer v5 skill, terminal precision, duration ratio, and horizon skill when present", () => {
    const v5Summary = makeSummary({
      recoveryLikelihoodCorrectCount: 71,
      recoveryLikelihoodScoredCount: 74,
      recoveryLikelihoodAccuracyPct: RatioSchema.parse(71 / 74),
      baselineRecoverableCorrectCount: 70,
      terminalCallCount: 3,
      terminalCallCorrectCount: 2,
      durationScoredCount: 10,
      meanSignedDurationErrorSec: 3600,
      meanAbsoluteDurationErrorSec: 5400,
      medianLog2DurationRatio: Math.log2(1.4),
      within2xCount: 7,
      overdueOpenCount: 2,
      horizonSkill: [
        { horizon: "24h", scored: 12, brier: 0.15, baseRateBrier: 0.2, brierSkill: 0.25 },
        { horizon: "7d", scored: 0, brier: null, baseRateBrier: null, brierSkill: null },
      ],
    });
    render(<DepegResolverReviewerModule data={response({ summary: v5Summary })} />);

    // A calibrated sample leads with the aggregate track record, as on the homepage.
    expect(screen.getByText("95.9%")).toBeTruthy();
    expect(screen.getByText("71 / 74").parentElement?.textContent).toBe("recovery-call accuracy · 71 / 74 correct");
    expect(screen.getByText("Always-recover baseline 70 / 74")).toBeTruthy();
    expect(screen.getByText("Terminal calls: 2 / 3 correct")).toBeTruthy();
    expect(screen.getByText("1.4× slower").parentElement?.textContent).toBe("typically1.4× slowerthan forecast");
    expect(screen.getByText(/7 \/ 10 within 2×/).textContent).toBe("7 / 10 within 2× · mean miss +1h ±1h 30m");
    expect(screen.getByText("open past band").parentElement?.textContent).toBe("2open past band");
    expect(screen.getByText("Horizon odds skill")).toBeTruthy();
    expect(screen.getByText("+0.25")).toBeTruthy();
  });

  it("renders absent reviewer v5 metrics as unavailable rather than zero", () => {
    const retained: DdrrSummary = { ...summary, headline: { ...summary.headline } };
    for (const key of ["baselineRecoverableCorrectCount", "terminalCallCount", "terminalCallCorrectCount",
      "medianLog2DurationRatio", "within2xCount", "overdueOpenCount", "horizonSkill"] as const) {
      delete retained.headline[key];
    }
    render(<DepegResolverReviewerModule data={response({ summary: retained })} />);

    expect(screen.getByText("Always-recover baseline unavailable")).toBeTruthy();
    expect(screen.getByText("Terminal calls: unavailable")).toBeTruthy();
    expect(screen.getByText("open past band").parentElement?.textContent).toBe("—open past band");
    expect(screen.queryByText("Horizon odds skill")).toBeNull();
    expect(screen.queryByText(/within 2×/)).toBeNull();
    expect(screen.getAllByText("+1h").length).toBeGreaterThan(0);
  });

  it("labels terminal-at-lock rows as unscored curation debt", () => {
    const atLock: DdrrResponseRow = { ...row, verdictReview: "terminal_at_lock", durationReview: "duration_unscored" };
    render(<DepegResolverReviewerModule data={response({ rows: [atLock] })} />);

    const badge = screen.getByText("Terminal at lock");
    expect(badge.getAttribute("title")).toMatch(/registry curation lag, not scored/);
    expect(screen.getByText(/v5 relabels tiers as evidence classes: No break signals · Stress signals · Terminal evidence/))
      .toBeTruthy();
  });

  it("lists every methodology major with n and a 90% interval, keeping thin samples visible", () => {
    const template = makeSummary().byPredictionPolicy.find((segment) => segment.segmentKind === "all")!.metrics;
    const versioned = {
      ...summary,
      byPredictionPolicy: [
        ...summary.byPredictionPolicy,
        makePredictionPolicySegment(template, "4.3", 6, 5),
      ],
    };
    render(<DepegResolverReviewerModule data={response({ summary: versioned })} />);

    expect(screen.getByText("Accuracy by version")).toBeTruthy();
    expect(screen.getByText("83.3% · 90% CI 50–96% · n 6")).toBeTruthy();
    expect(screen.getByText("maturing · n 0")).toBeTruthy();
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
