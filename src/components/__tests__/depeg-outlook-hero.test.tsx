// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { DepegOutlookHero } from "../depeg/depeg-outlook-hero";
import { rankOpenIncidents, type OpenIncidentRow } from "../depeg/depeg-resolver-book-summary";
import type { DepegEvent, OpenIncidentSnapshot, PegSummaryStats } from "@shared/types/peg";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
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
    expect(html).toContain("pharos-hero-kpi"); expect(html).not.toContain("0 / 0"); expect(html).not.toContain("0 bps");
    expect(html).not.toContain("coins with open confirmed incidents");
  });
  it("renders an unavailable median independently of observed cohort and historical counts", () => {
    const html = renderHero({ ...observedZero, medianDeviationBps: null, depegEventsToday: 2 }, 0, 0);
    expect(html).toContain("live peg status unavailable");
    expect(html).toMatch(/Median deviation<\/p><p[^>]*><span[^>]*>—<\/span>/);
    expect(html).toContain("0 / 0"); expect(html).not.toContain("0 bps"); expect(html).not.toContain("null bps"); expect(html).not.toContain("peg summary unavailable");
  });
  it.each([false, true])("distinguishes pending/unavailable and latches first-show slots without DDR/DDRR (%s)", (loading) => {
    const html = renderHero(observedZero, null, null, loading);
    expect(html).toContain(loading ? "Loading event data…" : "event data unavailable");
    expect(html).toContain(loading ? "Loading DEWS…" : "DEWS or peg catalog unavailable");
    expect(html).not.toMatch(/Recovery outlook|Forecast track record|Loading DDR/);
    expect(html).toContain("0 / 0"); expect(html).toContain("0 bps");
    const v = render(<DepegOutlookHero {...baseProps} pendingSources={pending(loading)} />);
    for (let i = 0; i < 2; i++) {
      expect(v.container.querySelectorAll('[class*="min-h-"]:not(button)')).toHaveLength(loading ? 8 : 0);
      for (const slot of ["min-h-20", "min-h-88 sm:min-h-76", "border-t border-border/60 px-5 py-4 sm:px-6 min-h-84 sm:min-h-76 lg:min-h-40"]) expect(v.container.innerHTML.includes(`class="${slot}"`)).toBe(loading);
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
    expect(html).toContain("coins with open confirmed incidents"); expect(html).not.toContain("all pegs holding");
    expect(html).toContain("crossings"); expect(html).toContain("of the peg catalog"); expect(html).not.toContain("unavailable");
  });
});

describe("DepegOutlookHero open-incident wording and clickable worst move", () => {
  it("counts coins with open confirmed incidents, independent of current recovery evidence", () => {
    const one = markup({ stats: { ...observedZero, activeDepegCount: 1 }, activeDepegIds: new Set(["a"]) });
    expect(one).toContain("coin with an open confirmed incident");
    expect(one).toContain("halo marks an elevated coin with an open confirmed incident");
    expect(one).not.toContain("right now");
    expect(renderHero({ ...observedZero, activeDepegCount: 3 }, 0, 0)).toContain("coins with open confirmed incidents");
  });
  it("renders a clickable signed worst-deviation callout linking to the affected coin", () => {
    const neg = markup({ stats: { ...observedZero, activeDepegCount: 1, worstCurrent: { id: "idrt-rupiah-token", symbol: "IDRT", bps: -3407 } }, activeDepegIds: new Set(["idrt-rupiah-token"]) });
    expect(neg).toContain("-3407 bps"); expect(neg).toContain("IDRT"); expect(neg).toContain('href="/stablecoin/idrt-rupiah-token#depeg-resolver"');
    const pos = markup({ stats: { ...observedZero, worstCurrent: { id: "eurc-circle", symbol: "EURC", bps: 145 } } });
    expect(pos).toContain("+145 bps"); expect(pos).toContain('href="/stablecoin/eurc-circle"');
  });
});

describe("DepegOutlookHero open incidents", () => {
  it("names the census top five with deviation, verdict (including sealed insufficient signal) and cap", () => {
    const frozen = makeFrozenDdrV2Row(makeDdrSourceRow({ resolution: { tier: "recovery_unlikely", factors: [] } }));
    if (frozen.kind !== "prediction") throw new Error("Expected frozen fixture");
    const noCall = DdrV2ResponseRowSchema.parse({ ...frozen, kind: "no_call", prediction: { ...frozen.prediction, state: "no_call" }, frozen: null, noCall: { lockedAt: frozen.prediction.lockedAt, eventAgeAtLockSec: frozen.prediction.eventAgeAtLockSec, missingReasons: [], relatedContext: frozen.frozen.relatedContext } });
    const rows: OpenIncidentRow[] = Array.from({ length: 7 }, (_, i) => ({
      id: `coin-${i}`, symbol: `C${i}`, pegCurrency: "USD", deviationBps: i === 0 ? -4_510 : null, bps: i === 0 ? -4_510 : null,
      referenceNote: i === 1 ? "Reference market closed" : i === 2 ? "Reference not yet updated" : null, marketCapUsd: i === 0 ? 49e6 : null,
      exposureUsd: i === 0 ? (49e6 * 4_510) / 10_000 : null, evidence: "unconfirmed", evidenceRead: true, ageSec: null, tier: null, ddr: i === 0 ? frozen : i === 3 ? noCall : null,
    }));
    const html = markup({ openIncidents: rows, stats: { ...observedZero, activeDepegCount: 7 } });
    expect(html).toContain("Top 5 of 7 by materiality, then holder exposure"); expect(html).toContain('href="/stablecoin/coin-0#depeg-resolver"');
    for (const text of ["−4510 bps", "Terminal", "Insufficient signal", "$49.0M", "Reference market closed", "Reference not yet updated"]) expect(html).toContain(text);
    expect(html).not.toContain("No-call locked"); expect(html).not.toContain("C5<"); expect(html).toContain("Awaiting confirmation");
    expect(markup({ openIncidents: [] })).not.toContain("Open incidents");
  });

  it("splits recent/>30d, falls back at zero recent, and checks rankOpenIncidents M2/L2", () => {
    const D = 86_400, now = 1_700_000_000 + 120 * D;
    const snap = (eventId: number, d: number, e?: number): OpenIncidentSnapshot => ({ eventId, startedAt: now - d * D, escalatedAt: e ? now - e * D : null, coverage: null });
    const inc = (id: string, bps: number | null, d: number, tier: OpenIncidentRow["tier"], ev: OpenIncidentRow["evidence"] = "outside"): OpenIncidentRow => ({ id, symbol: id.toUpperCase(), pegCurrency: "USD", deviationBps: bps == null ? null : Math.round(bps), bps, referenceNote: null, marketCapUsd: null, exposureUsd: null, evidence: ev, evidenceRead: true, ageSec: d * D, tier, ddr: null });
    const rows = [inc("esc", -800, 45, "escalating"), inc("edge", -50.4, 2, "recent", "unconfirmed"), inc("unp", null, 2, "recent", "unconfirmed"), inc("near", -10, 2, "recent", "unconfirmed"), inc("old", -2500, 90, "long_running")];
    const v = render(<DepegOutlookHero {...baseProps} stats={{ ...observedZero, activeDepegCount: 5 }} openIncidents={rows} openIncidentMap={{ esc: snap(1, 45, 2), edge: snap(4, 2), unp: snap(5, 2), near: snap(2, 2), old: snap(3, 90) }} clockSec={now} />);
    expect(v.container.textContent).toContain("4 recent · 1 long-running (>30d)");
    expect([screen.getByRole("link", { name: /^ESC:/ }).textContent, screen.getByRole("link", { name: /^NEAR:/ }).textContent, screen.getByRole("link", { name: /^EDGE:/ }).textContent]).toEqual([expect.stringContaining("Escalating"), expect.stringContaining("Near par"), expect.stringContaining("Unconfirmed")]);
    expect(screen.getByRole("link", { name: /^EDGE:/ }).textContent).not.toContain("Near par");
    expect(screen.getByRole("link", { name: /^UNP:/ }).textContent).not.toMatch(/Near par|Unconfirmed/);
    fireEvent.click(screen.getByRole("button", { name: ">30d (1)" }));
    expect(screen.getByRole("link", { name: /^OLD:/ }).textContent).toContain("90d");
    v.rerender(<DepegOutlookHero {...baseProps} stats={{ ...observedZero, activeDepegCount: 1 }} openIncidents={[rows[4]!]} openIncidentMap={{ old: snap(3, 90) }} clockSec={now} />);
    expect(v.container.textContent).toContain("No recent open incidents · 1 >30d by materiality, then holder exposure");
    fireEvent.click(screen.getByRole("button", { name: "Recent (0)" }));
    expect(v.container.textContent).toContain("No open incidents started in the last 30d or re-escalated in the last 7d");
    v.rerender(<DepegOutlookHero {...baseProps} stats={{ ...observedZero, activeDepegCount: 1 }} openIncidents={[{ ...rows[3]!, evidenceRead: false }]} openIncidentMap={{ near: snap(2, 2) }} clockSec={now} />);
    expect(screen.getByRole("link", { name: /^NEAR:/ }).textContent).not.toMatch(/Near par|Unconfirmed/);
    v.unmount();
    // Age reads the live clock while the horizon clock fails closed (0).
    expect(rankOpenIncidents([makePegSummaryCoin({ id: "near", activeDepeg: true })], [], null, { near: snap(2, 2) }, now, undefined, 0)[0]).toMatchObject({ ageSec: 2 * D, tier: null, evidenceRead: true });

    const ev = (id: number, stablecoinId: string, k: "trusted-off-peg" | "trusted-at-par") => ({
      id, stablecoinId, endedAt: null, priceCoverage: { intervals: k === "trusted-off-peg" ? [[now - 600, now - 60]] : [], atParIntervals: k === "trusted-at-par" ? [[now - 600, now - 60]] : [], lastObservationKind: k, lastTrustedObservationAt: now - 60, gapStartedAt: k === "trusted-at-par" ? now - 600 : null },
    }) as unknown as DepegEvent;
    expect(rankOpenIncidents([makePegSummaryCoin({ id: "near", activeDepeg: true, currentDeviationBps: -10 }), makePegSummaryCoin({ id: "edge", activeDepeg: true, currentDeviationBps: -50.4 })], [], new Map([["near", 500e6], ["edge", 10e6]])).map((r) => [r.id, r.deviationBps, r.evidenceRead])).toEqual([["edge", -50, false], ["near", -10, false]]);
    expect(rankOpenIncidents([makePegSummaryCoin({ id: "off", activeDepeg: true, currentDeviationBps: -200 }), makePegSummaryCoin({ id: "par", activeDepeg: true, currentDeviationBps: -5 })], [], null, undefined, now, [ev(1, "off", "trusted-off-peg"), ev(2, "par", "trusted-at-par")]).map((r) => [r.id, r.evidence])).toEqual([["off", "outside"], ["par", "inside"]]);
    // Expired FX quote at clockSec returns null deviation + "Reference not yet updated" (Tier 1 unpriced, never Tier 0 Near par).
    const fxRow = rankOpenIncidents([makePegSummaryCoin({ id: "eur-stasis", symbol: "EURS", pegCurrency: "EUR", activeDepeg: true, priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg("admitted", 25, FX_REOPEN_QUOTE_AT) } as never)], [], null, undefined, FX_REOPEN_QUOTE_AT + 7_141)[0]!;
    expect([fxRow.deviationBps, fxRow.referenceNote]).toEqual([null, "Reference not yet updated"]);
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
