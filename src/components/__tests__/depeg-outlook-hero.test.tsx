// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";
import { DepegOutlookHero } from "../depeg/depeg-outlook-hero";
import type { PegSummaryStats } from "@shared/types/peg";
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

const pending = (loading = false) => ({ peg: loading, dews: loading, events: loading });

function renderHero(stats: PegSummaryStats | undefined, pendingCount: number | null, dewsAlertCount: number | null, loading = false) {
  return markup({ stats, pendingCount, dewsAlertCount, pendingSources: pending(loading) });
}

describe("DepegOutlookHero source availability", () => {
  it.each([false, true])("renders missing peg summary without zero observations (pending=%s)", (loading) => {
    const html = renderHero(undefined, 2, 3, loading);
    expect(html).toContain(loading ? "Loading peg summary…" : "peg summary unavailable");
    expect(html).toContain("pharos-hero-kpi");
    expect(html).not.toContain("0 / 0");
    expect(html).not.toContain("0 bps");
    expect(html).not.toContain("coins with open confirmed incidents");
  });

  it("renders an unavailable median independently of observed cohort and historical counts", () => {
    const html = renderHero({ ...observedZero, medianDeviationBps: null, depegEventsToday: 2 }, 0, 0);
    expect(html).toContain("live peg status unavailable");
    expect(html).toMatch(/Median deviation<\/p><p[^>]*><span[^>]*>—<\/span>/);
    expect(html).toContain("0 / 0");
    expect(html).not.toContain("0 bps");
    expect(html).not.toContain("null bps");
    expect(html).not.toContain("peg summary unavailable");
  });

  it.each([false, true])("distinguishes pending/unavailable and latches first-show slots without DDR/DDRR (%s)", (loading) => {
    const html = renderHero(observedZero, null, null, loading);
    expect(html).toContain(loading ? "Loading event data…" : "event data unavailable");
    expect(html).toContain(loading ? "Loading DEWS…" : "DEWS or peg catalog unavailable");
    expect(html).not.toMatch(/Recovery outlook|Forecast track record|Loading DDR/);
    expect(html).toContain("0 / 0");
    expect(html).toContain("0 bps");
    const v = render(<DepegOutlookHero {...baseProps} pendingSources={pending(loading)} />);
    for (let i = 0; i < 2; i++) {
      expect(v.container.querySelectorAll('[class*="min-h-"]:not(button)')).toHaveLength(loading ? 8 : 0);
      for (const slot of ["min-h-20", "min-h-67 sm:min-h-52", "border-t border-border/60 pt-3 min-h-84 sm:min-h-76"])
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
    const html = renderHero(observedZero, 0, 0);
    expect(html).toContain("coins with open confirmed incidents");
    expect(html).not.toContain("all pegs holding");
    expect(html).toContain("crossings");
    expect(html).toContain("of the peg catalog");
    expect(html).not.toContain("unavailable");
  });
});

describe("DepegOutlookHero open-incident wording and clickable worst move", () => {
  it("counts coins with open confirmed incidents, independent of current recovery evidence", () => {
    const one = markup({ stats: { ...observedZero, activeDepegCount: 1 }, activeDepegIds: new Set(["a"]) });
    expect(one).toContain("coin with an open confirmed incident");
    expect(one).toContain("halo marks an elevated coin with an open confirmed incident");
    expect(one).not.toContain("right now");
    const many = renderHero({ ...observedZero, activeDepegCount: 3 }, 0, 0);
    expect(many).toContain("coins with open confirmed incidents");
  });

  it("renders a clickable signed worst-deviation callout linking to the affected coin", () => {
    const negative = markup({
      stats: { ...observedZero, activeDepegCount: 1, worstCurrent: { id: "idrt-rupiah-token", symbol: "IDRT", bps: -3407 } },
      activeDepegIds: new Set(["idrt-rupiah-token"]),
    });
    expect(negative).toContain("-3407 bps");
    expect(negative).toContain("IDRT");
    expect(negative).toContain('href="/stablecoin/idrt-rupiah-token#depeg-resolver"');

    const positive = markup({
      stats: { ...observedZero, worstCurrent: { id: "eurc-circle", symbol: "EURC", bps: 145 } },
    });
    expect(positive).toContain("+145 bps");
    expect(positive).toContain('href="/stablecoin/eurc-circle"');
  });
});

describe("DepegOutlookHero open incidents", () => {
  it("names the census top five with deviation, verdict (including sealed insufficient signal) and cap", () => {
    const frozen = makeFrozenDdrV2Row(makeDdrSourceRow({ resolution: { tier: "recovery_unlikely", factors: [] } }));
    if (frozen.kind !== "prediction") throw new Error("Expected frozen fixture");
    const noCall = DdrV2ResponseRowSchema.parse({
      ...frozen,
      kind: "no_call",
      prediction: { ...frozen.prediction, state: "no_call" },
      frozen: null,
      noCall: {
        lockedAt: frozen.prediction.lockedAt,
        eventAgeAtLockSec: frozen.prediction.eventAgeAtLockSec,
        missingReasons: [],
        relatedContext: frozen.frozen.relatedContext,
      },
    });
    const rows = Array.from({ length: 7 }, (_, i) => ({
      id: `coin-${i}`, symbol: `C${i}`, deviationBps: i === 0 ? -4_510 : null,
      referenceNote: i === 1 ? "Reference market closed" : i === 2 ? "Reference not yet updated" : null,
      marketCapUsd: i === 0 ? 49e6 : null, ddr: i === 0 ? frozen : i === 3 ? noCall : null,
    }));
    const html = markup({ openIncidents: rows, stats: { ...observedZero, activeDepegCount: 7 } });
    expect(html).toContain("Top 5 of 7 by holder exposure");
    expect(html).toContain('href="/stablecoin/coin-0#depeg-resolver"');
    for (const text of ["−4510 bps", "Terminal", "Insufficient signal (sealed)", "$49.0M", "Reference market closed", "Reference not yet updated"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("No-call locked");
    expect(html).not.toContain("C5<");
    expect(html).toContain("Awaiting confirmation");
    expect(markup({ openIncidents: [] })).not.toContain("Open incidents");
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
