// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";
import { DepegOutlookHero } from "../depeg/depeg-outlook-hero";
import type { PegSummaryStats } from "@shared/types/peg";
import { summarizeResolverBook } from "../depeg/depeg-resolver-book-summary";
import { makeDdrSourceRow, makeFrozenDdrV2Row } from "../depeg-resolver-test-support";
import { DdrV2ResponseRowSchema } from "@shared/types/depeg-resolver";

vi.mock("@/components/dews/dews-summary", () => ({ DEWSRadarPanel: () => null }));
vi.mock("@/components/methodology-hint", () => ({ MethodologyLabel: ({ children }: { children: string }) => children }));

const observedZero: PegSummaryStats = {
  activeDepegCount: 0, medianDeviationBps: 0, worstCurrent: null,
  coinsAtPeg: 0, totalTracked: 0, depegEventsToday: 0, depegEventsYesterday: 0,
};

const baseProps = { stats: observedZero, pendingCount: 0, dewsAlertCount: 0, activeDepegIds: new Set<string>() };

function markup(props: Partial<Parameters<typeof DepegOutlookHero>[0]>) {
  return renderToStaticMarkup(<DepegOutlookHero {...baseProps} {...props} />);
}

const pending = (loading = false) => ({ peg: loading, dews: loading, events: loading, resolver: loading, review: loading });

function renderHero(stats: PegSummaryStats | undefined, pendingCount: number | null, dewsAlertCount: number | null, loading = false) {
  return markup({ stats, pendingCount, dewsAlertCount, pendingSources: pending(loading) });
}

describe("DepegOutlookHero source availability", () => {
  it.each([false, true])("renders missing peg summary without zero observations (pending=%s)", (loading) => {
    const markup = renderHero(undefined, 2, 3, loading);
    expect(markup).toContain(loading ? "Loading peg summary…" : "peg summary unavailable");
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

  it.each([false, true])("distinguishes pending/unavailable and latches first-show slots (%s)", (loading) => {
    const markup = renderHero(observedZero, null, null, loading);
    expect(markup).toContain(loading ? "Loading event data…" : "event data unavailable");
    expect(markup).toContain(loading ? "Loading DEWS…" : "DEWS or peg catalog unavailable");
    for (const source of ["DDR", "DDRR"]) expect(markup.includes(`Loading ${source}…`)).toBe(loading);
    expect(markup).toContain("0 / 0");
    expect(markup).toContain("0 bps");
    const v = render(<DepegOutlookHero {...baseProps} pendingSources={pending(loading)} />);
    for (let i = 0; i < 2; i++) {
      expect(v.container.querySelectorAll('[class*="min-h-"]:not(button)')).toHaveLength(loading ? 9 : 0);
      for (const slot of ["min-h-20", "min-h-32", "min-h-28", "border-t border-border/60 pt-3 min-h-84 sm:min-h-76"])
        expect(v.container.innerHTML.includes(`class="${slot}"`)).toBe(loading);
      v.rerender(<DepegOutlookHero {...baseProps} />);
    }
    expect(v.container.innerHTML).not.toMatch(/Recovery outlook|Forecast track record/);
    v.unmount();
  });

  it("names a pending peg catalog after DEWS answered", () => {
    expect(markup({ stats: undefined, dewsAlertCount: null, pendingSources: { ...pending(), peg: true, pegCatalog: true } })).toContain("Loading peg catalog…");
  });

  it("preserves successful zero counts rather than treating zero as unavailable", () => {
    const markup = renderHero(observedZero, 0, 0);
    expect(markup).toContain("coins with open confirmed incidents");
    expect(markup).not.toContain("all pegs holding");
    expect(markup).toContain("crossings");
    expect(markup).toContain("of the peg catalog");
    expect(markup).not.toContain("unavailable");
  });
});

describe("DepegOutlookHero open-incident wording", () => {
  it("counts coins with open confirmed incidents, independent of current recovery evidence", () => {
    const one = markup({ stats: { ...observedZero, activeDepegCount: 1 }, activeDepegIds: new Set(["a"]) });
    expect(one).toContain("coin with an open confirmed incident");
    expect(one).toContain("halo marks an elevated coin with an open confirmed incident");
    expect(one).not.toContain("right now");
    const many = renderHero({ ...observedZero, activeDepegCount: 3 }, 0, 0);
    expect(many).toContain("coins with open confirmed incidents");
  });
});

describe("DepegOutlookHero universe chip", () => {
  it("names the peg catalog size when the summary was read, and only the set otherwise", () => {
    const read = markup({ catalogCount: 249 });
    expect(read).toContain("249 coins");
    const unread = markup({ stats: undefined, catalogCount: null });
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
    const mixed = markup({ book: summarizeResolverBook([valid, invalidated, pending, noCall]) });
    expect(mixed).toContain("1 open forecast");
    expect(mixed).toContain("no break signals");
    expect(mixed).not.toContain("recovery likely");
    expect(mixed).not.toContain("4 open forecasts");
    const auditOnly = markup({ book: summarizeResolverBook([invalidated, pending, noCall]) });
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
    const html = markup({ book: book(count) });
    expect(html).toContain(caption);
    expect(html).not.toContain("past their worst");
  });

  it.each([[8_466, "calibrated on 8,466 historical incidents"], [0, "calibrated on 0 historical incidents"]] as const)(
    "passes the producer lineage count %s through as historical incidents",
    (incidentCount, caption) => {
      const html = markup({ book: book(0), lineage: { incidentCount, coinCount: 41 } });
      expect(html).toContain(caption);
      expect(html).not.toContain("recovered incidents");
    },
  );

  it.each([null, undefined])("falls back to forecast count without lineage (%s), omitting zero new-worst", (lineage) => {
    const html = markup({ book: book(0), lineage });
    expect(html).toContain("3 open forecasts");
    expect(html).not.toContain("calibrated on");
    expect(html).not.toContain("new worst");
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
    const html = markup({ review: review(70, [["2.0", 6], ["3.04", 49], ["4.6", 19]]) });
    expect(html).toContain("Recovery calls correct: 61/74");
    expect(html).not.toContain("Always-recover baseline");
    expect(html).not.toContain("Graded calls");
    expect(html).toContain("see the grading");
  });
});
