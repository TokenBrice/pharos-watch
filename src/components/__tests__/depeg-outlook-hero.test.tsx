import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DepegOutlookHero } from "../depeg-outlook-hero";
import type { PegSummaryStats } from "@shared/types";
import { summarizeResolverBook } from "../depeg-resolver-book-summary";
import { makeDdrSourceRow, makeFrozenDdrV2Row } from "../depeg-resolver-test-support";
import { DdrV2ResponseRowSchema } from "@shared/types/depeg-resolver";

vi.mock("@/components/dews-summary", () => ({ DEWSRadarPanel: () => null }));
vi.mock("@/components/methodology-hint", () => ({ MethodologyLabel: ({ children }: { children: string }) => children }));

const observedZero: PegSummaryStats = {
  activeDepegCount: 0, medianDeviationBps: 0, worstCurrent: null,
  coinsAtPeg: 0, totalTracked: 0, depegEventsToday: 0, depegEventsYesterday: 0,
};

function renderHero(stats: PegSummaryStats | undefined, pendingCount: number | null, dewsAlertCount: number | null) {
  return renderToStaticMarkup(<DepegOutlookHero stats={stats} pendingCount={pendingCount} dewsAlertCount={dewsAlertCount} activeDepegIds={new Set()} />);
}

describe("DepegOutlookHero source availability", () => {
  it("renders missing peg summary as placeholders rather than zero observations", () => {
    const markup = renderHero(undefined, 2, 3);
    expect(markup).toContain("peg summary unavailable");
    expect(markup).not.toContain("0 / 0");
    expect(markup).not.toContain("0 bps");
    expect(markup).not.toContain("coins with open confirmed incidents");
  });

  it("renders an unavailable median independently of observed cohort and historical counts", () => {
    const markup = renderHero({ ...observedZero, medianDeviationBps: null, depegEventsToday: 2 }, 0, 0);
    expect(markup).toContain("live peg status unavailable");
    expect(markup).toMatch(/Median deviation<\/p><p[^>]*><span[^>]*>—<\/span>/);
    expect(markup).toContain("0 / 0");
    expect(markup).not.toContain("0 bps");
    expect(markup).not.toContain("null bps");
    expect(markup).not.toContain("peg summary unavailable");
  });

  it("renders independently unavailable event and DEWS counts with reasons", () => {
    const markup = renderHero(observedZero, null, null);
    expect(markup).toContain("event data unavailable");
    expect(markup).toContain("DEWS or peg catalog unavailable");
    expect(markup).toContain("0 / 0");
    expect(markup).toContain("0 bps");
  });

  it("preserves successful zero counts rather than treating zero as unavailable", () => {
    const markup = renderHero(observedZero, 0, 0);
    // Zero open incidents is not a claim that every peg holds.
    expect(markup).toContain("coins with open confirmed incidents");
    expect(markup).not.toContain("all pegs holding");
    expect(markup).toContain("crossings");
    expect(markup).toContain("of the peg catalog");
    expect(markup).not.toContain("unavailable");
  });
});

describe("DepegOutlookHero open-incident wording", () => {
  it("counts coins with open confirmed incidents, independent of current recovery evidence", () => {
    const one = renderToStaticMarkup(
      <DepegOutlookHero stats={{ ...observedZero, activeDepegCount: 1 }} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set(["a"])} />,
    );
    expect(one).toContain("coin with an open confirmed incident");
    expect(one).toContain("halo marks an elevated coin with an open confirmed incident");
    expect(one).not.toContain("right now");
    const many = renderHero({ ...observedZero, activeDepegCount: 3 }, 0, 0);
    expect(many).toContain("coins with open confirmed incidents");
  });
});

describe("DepegOutlookHero universe chip", () => {
  it("names the peg catalog size when the summary was read, and only the set otherwise", () => {
    const read = renderToStaticMarkup(
      <DepegOutlookHero stats={observedZero} catalogCount={249} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set()} />,
    );
    expect(read).toContain("249 coins");
    const unread = renderToStaticMarkup(
      <DepegOutlookHero stats={undefined} catalogCount={null} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set()} />,
    );
    expect(unread).toContain("Peg catalog");
    expect(unread).not.toContain("coins<");
  });
});

describe("DepegOutlookHero current forecast posture", () => {
  it("excludes invalidated original outcomes and non-prediction rows from recovery outlook", () => {
    const valid = makeFrozenDdrV2Row(makeDdrSourceRow({ resolution: { tier: "recovery_likely", factors: [] } }));
    if (valid.kind !== "prediction") throw new Error("Expected frozen fixture");
    const invalidated = DdrV2ResponseRowSchema.parse({
      ...valid, kind: "invalidated_prediction", prediction: { ...valid.prediction, state: "invalidated" },
      originalKind: "prediction", originalOutcome: valid.frozen, noCall: null,
    });
    const pending = DdrV2ResponseRowSchema.parse({
      ...valid, kind: "pending", prediction: { ...valid.prediction, state: "pending_lock" }, frozen: null,
    });
    const noCall = DdrV2ResponseRowSchema.parse({
      ...valid, kind: "no_call", prediction: { ...valid.prediction, state: "no_call" }, frozen: null,
      noCall: { lockedAt: valid.prediction.lockedAt, eventAgeAtLockSec: valid.prediction.eventAgeAtLockSec,
        missingReasons: [], relatedContext: valid.frozen.relatedContext },
    });
    const props = { stats: observedZero, pendingCount: 0, dewsAlertCount: 0, activeDepegIds: new Set<string>() };
    const mixed = renderToStaticMarkup(<DepegOutlookHero {...props} book={summarizeResolverBook([valid, invalidated, pending, noCall])} />);
    expect(mixed).toContain("1 open forecast");
    expect(mixed).toContain("no break signals");
    expect(mixed).not.toContain("recovery likely");
    expect(mixed).not.toContain("4 open forecasts");
    const auditOnly = renderToStaticMarkup(<DepegOutlookHero {...props} book={summarizeResolverBook([invalidated, pending, noCall])} />);
    expect(auditOnly).not.toContain("Recovery outlook");
    expect(auditOnly).not.toContain("recovery likely");
  });
});

describe("DepegOutlookHero recovery outlook caption", () => {
  const book = (pastPeakCount: number) => ({
    total: 3, rowCount: 3, tierGroups: [], pastPeakCount,
    tierCounts: { recovery_likely: 0, at_risk: 3, recovery_unlikely: 0, insufficient_signal: 0 },
  });

  it.each([[1, "1 at a new worst"], [3, "3 at a new worst"]] as const)("states %s live new-worst incidents", (count, caption) => {
    const markup = renderToStaticMarkup(
      <DepegOutlookHero stats={observedZero} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set()} book={book(count)} />,
    );
    expect(markup).toContain(caption);
    expect(markup).not.toContain("past their worst");
  });

  it.each([[8_466, "calibrated on 8,466 historical incidents"], [0, "calibrated on 0 historical incidents"]] as const)(
    "passes the producer lineage count %s through as historical incidents",
    (incidentCount, caption) => {
      const markup = renderToStaticMarkup(
        <DepegOutlookHero stats={observedZero} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set()} book={book(0)}
          lineage={{ incidentCount, coinCount: 41 }} />,
      );
      expect(markup).toContain(caption);
      expect(markup).not.toContain("recovered incidents");
    },
  );

  it("falls back to the open forecast count without lineage", () => {
    const markup = renderToStaticMarkup(
      <DepegOutlookHero stats={observedZero} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set()} book={book(0)} lineage={null} />,
    );
    expect(markup).toContain("3 open forecasts");
    expect(markup).not.toContain("calibrated on");
  });

  it("omits the new-worst clause at zero", () => {
    const markup = renderToStaticMarkup(
      <DepegOutlookHero stats={observedZero} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set()} book={book(0)} />,
    );
    expect(markup).not.toContain("new worst");
  });
});

describe("DepegOutlookHero forecast track record", () => {
  const review = (baseline: number | undefined, segments: Array<[string, number]>) => ({
    headlineScope: "current_policy",
    headlineLabel: "Current DDRv2 public prediction policy",
    headline: {
      recoveryLikelihoodCorrectCount: 61, recoveryLikelihoodScoredCount: 74, recoveryLikelihoodAccuracyPct: 61 / 74,
      baselineRecoverableCorrectCount: baseline, accuracyDenominatorLabel: "scored",
    },
    byPredictionPolicy: segments.map(([version, scored]) => ({
      segmentKind: "prediction_policy", predictionMethodologyVersion: version, predictionPolicyVersion: "sticky-24h-v1",
      metrics: { recoveryLikelihoodScoredCount: scored },
    })),
  }) as unknown as Parameters<typeof DepegOutlookHero>[0]["review"];

  it("shows the captured fraction with no sub-text under the figure", () => {
    const markup = renderToStaticMarkup(
      <DepegOutlookHero stats={observedZero} pendingCount={0} dewsAlertCount={0} activeDepegIds={new Set()}
        review={review(70, [["2.0", 6], ["3.04", 49], ["4.6", 19]])} />,
    );
    expect(markup).toContain("Recovery calls correct: 61/74 (82.4%)");
    expect(markup).not.toContain("Always-recover baseline");
    expect(markup).not.toContain("Graded calls");
    expect(markup).toContain("see the grading");
  });
});
