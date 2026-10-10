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
    expect(markup).not.toContain("all pegs holding");
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
    expect(markup).toContain("all pegs holding");
    expect(markup).toContain("crossings");
    expect(markup).toContain("of the peg catalog");
    expect(markup).not.toContain("unavailable");
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
    expect(mixed).not.toContain("4 open forecasts");
    const auditOnly = renderToStaticMarkup(<DepegOutlookHero {...props} book={summarizeResolverBook([invalidated, pending, noCall])} />);
    expect(auditOnly).not.toContain("Recovery outlook");
    expect(auditOnly).not.toContain("recovery likely");
  });
});
