// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DepegResolverModule } from "@/components/depeg/depeg-resolver-module";
import { StablecoinDepegResolverRows } from "@/components/depeg/depeg-resolver-row-card-parts";
import { compareResolverUrgency, rankOpenIncidents, summarizeResolverBook } from "@/components/depeg/depeg-resolver-book-summary";
import { getDisplayedLivePeakDeviationBps, getLiveCurrentDeviationBps, isLiveCurrentDeviationHeld } from "@/components/depeg/depeg-resolver-row-card-model";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import { DdrV2ResponseRowSchema, type DdrPredictionMeta, type DdrResolutionTier, type DdrResponse, type DdrRow, type DdrV2ResponseRow } from "@shared/types/depeg-resolver";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { DDR_TEST_META, makeDdrSourceRow, makeFrozenDdrV2Row } from "./depeg-resolver-test-support";

vi.mock("@/lib/feature-flags", () => ({ isDepegResolverEnabled: () => true }));
vi.mock("@/components/stablecoin-logo", () => ({ StablecoinLogo: () => <span data-testid="logo" /> }));

const meta = DDR_TEST_META;
const makeSourceRow = makeDdrSourceRow;
const parseRow = DdrV2ResponseRowSchema.parse;
const gt = (m: Parameters<typeof screen.getByText>[0]) => screen.getByText(m);
const qt = (m: Parameters<typeof screen.queryByText>[0]) => screen.queryByText(m);
const LUSD = "lusd-liquity";
const frozenBase = makeFrozenDdrV2Row();

function predictionMeta(state: DdrPredictionMeta["state"], overrides: Partial<DdrPredictionMeta> = {}): DdrPredictionMeta {
  const unlocked = state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending";
  return {
    ...frozenBase.prediction, state,
    ...(unlocked ? { publicPredictionId: null, lockedAt: null, publishedAt: null, publicationSnapshotToken: null, snapshotGeneration: null, eventAgeAtLockSec: null, rowHash: null } : {}),
    lockTiming: state === "lock_deferred" ? "deferred" : unlocked ? null : "on_time",
    source: state === "invalidated" ? "erratum" : unlocked ? "pending" : "public_prediction",
    ...overrides,
  };
}

const makePredictionRow = (source = makeSourceRow(), liveOverrides: Record<string, unknown> = {}): DdrV2ResponseRow => {
  const base = makeFrozenDdrV2Row(source);
  return parseRow({ ...base, live: { ...base.live, ...liveOverrides } });
};
const predRow = (src: Partial<DdrRow> = {}, live: Record<string, unknown> = {}) => makePredictionRow(makeSourceRow(src), live);

const makePendingRow = (state: "pending_lock" | "lock_deferred" | "publication_retry_pending", overrides: Partial<DdrPredictionMeta> = {}): DdrV2ResponseRow =>
  parseRow({ ...frozenBase, kind: "pending", prediction: predictionMeta(state, overrides), frozen: null });

const noCallPayload = (relatedContext: DdrRow["relatedContext"]) => ({ lockedAt: 86_401, eventAgeAtLockSec: 86_400, missingReasons: ["no usable live price"], relatedContext });

const makeNoCallRow = (): DdrV2ResponseRow =>
  parseRow({ ...frozenBase, kind: "no_call", prediction: predictionMeta("no_call"), noCall: noCallPayload(makeSourceRow().relatedContext), frozen: null });

function makeInvalidatedRow(originalKind: "prediction" | "no_call" = "prediction"): DdrV2ResponseRow {
  const source = makeSourceRow({ resolution: { tier: "recovery_likely", factors: [] } });
  const original = makePredictionRow(source);
  if (original.kind !== "prediction") throw new Error("Expected prediction fixture");
  const noCall = noCallPayload(source.relatedContext);
  const erratum = { id: 1, state: "invalidated" as const, publicPredictionId: 7, incidentKey: "ddr2:test", eventId: 1, assessmentId: 1, reason: "event_identity_error" as const, createdAt: 86_500, operatorNote: "Source event repaired after publication", rowHashBefore: "a".repeat(64), replacementAssessmentId: null, replacementRowHash: null, createdBy: "test" };
  return parseRow({
    ...original, kind: "invalidated_prediction",
    prediction: predictionMeta("invalidated", { latestErratum: erratum, errataCount: 1, errataHistory: [erratum] }),
    originalKind, originalOutcome: originalKind === "prediction" ? original.frozen : noCall,
    frozen: originalKind === "prediction" ? original.frozen : null, noCall: originalKind === "no_call" ? noCall : null,
    live: { ...original.live, eventState: "event_invalidated" },
  });
}

const row = frozenBase;
const lockedUnder = (version: string | null, source: DdrV2ResponseRow): DdrV2ResponseRow =>
  parseRow({ ...source, prediction: { ...source.prediction, predictionMethodologyVersion: version, predictionMethodologyVersionLabel: version == null ? null : `v${version}` } });
const terminalDuration = (extra: Record<string, unknown> = {}) => ({ suppressed: true, suppressedReason: "verdict_terminal", stratum: null, medianSec: null, iqrSec: null, ageStatus: null, horizons: [], ...extra });
const activeDuration = (extra: Record<string, unknown> = {}) => ({ suppressed: false, suppressedReason: null, stratum: "below · moderate · USD", medianSec: 7200, iqrSec: [3600, 10_800] as [number, number], ageStatus: "ordinary" as const, horizons: [], ...extra });
const degMeta = (degradedReason: string) => ({ ...meta, degraded: true, degradedReason });

const response = (overrides: Partial<DdrResponse> = {}): DdrResponse => ({
  _meta: meta, rows: [],
  methodology: { version: DDR_METHODOLOGY_VERSION, versionLabel: DDR_METHODOLOGY_VERSION_LABEL, currentVersion: DDR_METHODOLOGY_VERSION, currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL, changelogPath: "/methodology/depeg-resolver-changelog/", asOf: 1, isCurrent: true },
  ...overrides,
});

function renderResolver(overrides: Partial<DdrResponse> = {}, extra: Omit<Parameters<typeof DepegResolverModule>[0], "data"> = {}) {
  const view = render(<DepegResolverModule data={response(overrides)} {...extra} />);
  return { ...view, re: (o: Partial<DdrResponse> = {}) => view.rerender(<DepegResolverModule data={response(o)} {...extra} />) };
}
function renderCoinRows(overrides: Partial<DdrResponse>, stablecoinId = LUSD) {
  const view = render(<StablecoinDepegResolverRows stablecoinId={stablecoinId} data={response(overrides)} />);
  return { ...view, re: (o: Partial<DdrResponse>, id = LUSD) => view.rerender(<StablecoinDepegResolverRows stablecoinId={id} data={response(o)} />) };
}

describe("DepegResolverModule", () => {
  it.each(["GOLD", "USD"] as const)("labels the %s peg-relative ratio without publishing a synthetic currency price", (pegCurrency) => {
    renderResolver({ rows: [predRow({ pegCurrency, startedAt: 1_795_017_600 }, { currentDeviationBps: -500 })] });
    expect(gt("95.00% of peg")).toBeTruthy();
    expect(qt("$0.9500")).toBeNull();
    expect(qt("€0.9500")).toBeNull();
  });

  it("counts only valid frozen predictions in the current forecast book", () => {
    const mixed = [row, makeInvalidatedRow(), makeNoCallRow(), makePendingRow("pending_lock"), makePendingRow("lock_deferred"), makePendingRow("publication_retry_pending")];
    expect(summarizeResolverBook(mixed)).toMatchObject({ total: 1, rowCount: 6, tierCounts: { at_risk: 1, recovery_likely: 0, insufficient_signal: 0 } });
    expect(summarizeResolverBook(mixed.slice(1)).total).toBe(0);
    renderResolver({ rows: mixed });
    expect(gt(/forecast.*across 6 incident rows/).textContent).toContain("1 forecast across 6 incident rows");
    fireEvent.click(screen.getByRole("button", { name: "Show all 6 incident rows" }));
    expect(gt("Prediction invalidated by erratum")).toBeTruthy();
  });

  describe("new-worst flag compares live deviation with the live event peak", () => {
    const tiered = (id: string, tier: DdrResolutionTier, current: number, eventState = "active") =>
      predRow({ stablecoinId: id, symbol: id.toUpperCase(), resolution: { tier, factors: [] }, peakDeviationBps: -10_000, currentDeviationBps: current }, { eventState });

    function peakRow(id: string, frozenPeak: number | null, live: { peak: number | null; current: number | null }): DdrV2ResponseRow {
      const frozen = makeFrozenDdrV2Row(makeSourceRow({ stablecoinId: id, symbol: id.toUpperCase(), peakDeviationBps: frozenPeak ?? -1, currentDeviationBps: frozenPeak }));
      if (frozen.frozen === null) throw new Error("Expected frozen fixture");
      if (frozenPeak == null) frozen.frozen.sourceRow.peakDeviationBps = null as unknown as number;
      return { ...frozen, live: { ...frozen.live, peakDeviationBps: live.peak, currentDeviationBps: live.current } } as DdrV2ResponseRow;
    }

    it.each([
      ["ALUSD-like: lock -380, live peak -825, now -425", -380, -825, -425, false],
      ["genuine exceedance of the live peak", -380, -400, -600, true],
      ["live peak shallower than the frozen lock peak, then crossed", -800, -300, -500, true],
      ["equality at the noise margin is not exceedance", -300, -1_000, -1_025, false],
      ["just past the noise margin", -300, -1_000, -1_026, true],
      ["above-peg direction uses magnitudes", 200, 300, 400, true],
      ["null current", -300, -300, null, false],
      ["null live peak", -300, null, -900, false],
      ["zero live peak", -300, 0, -900, false],
    ] as const)("%s", (_label, frozenPeak, livePeak, current, expected) => {
      const r = peakRow("a", frozenPeak, { peak: livePeak, current });
      expect(summarizeResolverBook([r]).pastPeakCount).toBe(expected ? 1 : 0);
      if (frozenPeak === -380 && livePeak === -825) expect(r.kind === "prediction" ? r.frozen.sourceRow.peakDeviationBps : null).toBe(-380);
    });

    it("ranks by flag, deviation, verdict, exposure, and confirmed census exposure", () => {
      const order = [peakRow("tie-b", -100, { peak: -2_000, current: -500 }), peakRow("alusd", -380, { peak: -825, current: -425 }), peakRow("wide", -100, { peak: -2_000, current: -1_500 }), peakRow("tie-a", -100, { peak: -2_000, current: -500 }), peakRow("usda", -800, { peak: -300, current: -350 })]
        .sort(compareResolverUrgency).map((r) => r.stablecoinId);
      expect(order).toEqual(["usda", "wide", "tie-a", "tie-b", "alusd"]);

      const caps = new Map<string, number | null>([["terminal", 1e6], ["small", 1e6], ["large", 1e9], ["likely", 1e10], ["nocap", null]]);
      const rows = [tiered("likely", "recovery_likely", -5_000), tiered("nocap", "at_risk", -9_000), tiered("small", "at_risk", -1_000), tiered("large", "at_risk", -100), { ...makePendingRow("pending_lock"), stablecoinId: "unlocked" }, tiered("closed", "recovery_unlikely", -9_000, "closed_pending_review"), tiered("terminal", "recovery_unlikely", -50)];
      expect([...rows].sort((a, b) => compareResolverUrgency(a, b, caps)).map((r) => r.stablecoinId))
        .toEqual(["terminal", "large", "small", "nocap", "unlocked", "likely", "closed"]);
      renderResolver({ rows: rows.slice(0, 2) }, { marketCaps: caps });
      gt("$10.0B market cap");
      gt("Market cap unavailable");

      const coin = (id: string, bps: number, activeDepeg = true) => makePegSummaryCoin({ id, symbol: id, currentDeviationBps: bps, activeDepeg });
      expect(rankOpenIncidents([coin("calm", -10, false), coin("big", -14), coin("nocap", -9_000), coin("small", -4_500)],
        [tiered("big", "at_risk", -14), tiered("small", "recovery_likely", -4_500, "closed_pending_review")], new Map([["small", 49e6], ["big", 1.5e9]])))
        .toMatchObject([{ id: "small", ddr: null }, { id: "nocap", ddr: null, marketCapUsd: null }, { id: "big", ddr: { stablecoinId: "big" } }]);

      const fx = (id: string, status: "admitted" | "stale-reference") => makePegSummaryCoin({ id, activeDepeg: true, pegCurrency: "EUR", priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg(status, status === "admitted" ? 0 : null) });
      expect(rankOpenIncidents([fx("stale", "stale-reference"), fx("live", "admitted")], [], new Map([["stale", 1e9], ["live", 1e6]])))
        .toMatchObject([{ id: "stale", deviationBps: null, referenceNote: "Reference not yet updated" }, { id: "live", deviationBps: 0, referenceNote: null }]);
    });

    it("ranks verdict > horizon, recent > >30d on equal verdict, and badges by eventId", () => {
      const D = 86_400, now = 1_700_000_000 + 120 * D;
      const s = (eventId: number, d: number, e?: number) => ({ eventId, startedAt: now - d * D, escalatedAt: e ? now - e * D : null, coverage: null });
      const r = (id: string, eventId: number, tier: DdrResolutionTier) => predRow({ stablecoinId: id, symbol: id.toUpperCase(), eventId, resolution: { tier, factors: [] }, peakDeviationBps: -1e4, currentDeviationBps: -500 }, { currentEventId: eventId });
      const openIncidents = { term: s(11, 60), insuff: s(12, 2), old: s(13, 90), rec: s(14, 3), esc: s(15, 50, 2), miss: s(99, 80) };
      expect([r("insuff", 12, "insufficient_signal"), r("old", 13, "at_risk"), r("term", 11, "recovery_unlikely"), r("rec", 14, "at_risk"), r("esc", 15, "at_risk")]
        .sort((a, b) => compareResolverUrgency(a, b, null, { openIncidents, clockSec: now })).map((x) => x.stablecoinId)).toEqual(["term", "esc", "rec", "old", "insuff"]);
      // Transitivity across equal-verdict active recent, active >30d, and terminal rows regardless of exposure order.
      const tRow: ReturnType<typeof r> = { ...r("closed", 17, "at_risk"), live: { ...r("closed", 17, "at_risk").live, eventState: "closed_pending_review" } };
      const caps = new Map<string, number | null>([["old", 300e6], ["closed", 200e6], ["rec", 100e6]]);
      const cmp = (a: ReturnType<typeof r>, b: ReturnType<typeof r>) => compareResolverUrgency(a, b, caps, { openIncidents, clockSec: now });
      expect([cmp(r("rec", 14, "at_risk"), r("old", 13, "at_risk")) < 0, cmp(r("old", 13, "at_risk"), tRow) < 0, cmp(r("rec", 14, "at_risk"), tRow) < 0]).toEqual([true, true, true]);
      const { container } = renderResolver({ rows: [r("esc", 15, "at_risk"), r("old", 13, "at_risk"), r("miss", 16, "at_risk")] }, { openIncidents, clockSec: now });
      expect([container.querySelector('[data-incident-tier="escalating"]')?.textContent?.includes("Escalating"), container.querySelector('[data-incident-tier="long_running"]')?.textContent?.includes(">30d"), container.querySelectorAll("[data-incident-tier]").length]).toEqual([true, true, 2]);
    });

    it("captions the count as a new worst, never as past their worst", () => {
      renderResolver({ rows: [peakRow("a", -300, { peak: -400, current: -900 }), peakRow("b", -300, { peak: -400, current: -900 })] });
      expect(gt(/2 at a new worst/)).toBeTruthy();
      expect(qt(/past their worst/)).toBeNull();
    });
  });

  describe("calibration lineage caption", () => {
    const lineage = (incidentCount: number, coinCount: number, quarantinedCoins = 0) => ({ trainingWindow: { start: 1, end: 2 }, eventCount: 99_999, incidentCount, coinCount, quarantinedCoins });

    it.each([
      [8_466, 41, 0, "Calibrated on 8,466 historical incidents · 41 coins"],
      [0, 0, 0, "Calibrated on 0 historical incidents · 0 coins"],
      [8_466, 41, 1, "Calibrated on 8,466 historical incidents · 41 coins (1 excluded)"],
      [8_466, 41, 3, "Calibrated on 8,466 historical incidents · 41 coins (3 excluded)"],
    ] as const)("renders lineage caption (%s, %s, %s)", (incidents, coins, quarantined, expected) => {
      renderResolver({ _meta: { ...meta, lineage: lineage(incidents, coins, quarantined) }, rows: [row] });
      expect(gt(/^Calibrated on/).textContent).toBe(expected);
      expect(qt(/recovered\s+incidents|coins? excluded/)).toBeNull();
    });

    it("omits the caption without lineage", () => {
      renderResolver({ rows: [row] });
      expect(qt(/^Calibrated on/)).toBeNull();
    });
  });

  it("distinguishes loading, healthy empty, degraded empty, stale-cache retained, and unknown-failure states", () => {
    const { rerender } = render(<DepegResolverModule data={undefined} />);
    const re = (o: Partial<DdrResponse> = {}) => rerender(<DepegResolverModule data={response(o)} />);
    const unavail = "Resolver data is temporarily unavailable.";
    expect(gt("Resolver data is loading.")).toBeTruthy();
    expect(qt(/No active confirmed depegs/)).toBeNull();
    for (const r of ["missing-cache", "stale-cache"]) {
      re({ _meta: degMeta(r) });
      expect(gt(unavail)).toBeTruthy();
      expect(qt(/No active confirmed depegs|Whole book/)).toBeNull();
    }
    re();
    expect(gt("No active confirmed depegs.")).toBeTruthy();
    expect(qt(unavail)).toBeNull();
    re({ _meta: degMeta("stale-cache"), rows: [row] });
    expect(gt(/Whole book/).textContent).toContain("1 forecast across 1 incident rows");
    expect(qt(/live overlay is stale/i)).toBeNull();
    expect(gt("Stress signals")).toBeTruthy();
    re({ _meta: degMeta("unknown-failure"), rows: [row] });
    expect(gt(unavail)).toBeTruthy();
    expect(qt(/Whole book|showing all|most urgent|Stress signals/)).toBeNull();
  });

  it("renders pre-v5 terminal, v5 terminal, inline terminal kill signals, and above-peg kill signals accurately", () => {
    const term = (factors: DdrRow["resolution"]["factors"] = [], durExtra: Record<string, unknown> = {}) =>
      predRow({ resolution: { tier: "recovery_unlikely", factors }, duration: terminalDuration(durExtra) as DdrRow["duration"] });
    const { re, container } = renderResolver({ rows: [lockedUnder("4.3", term())] });
    expect(gt("No recovery expected")).toBeTruthy();
    expect(qt("Terminal evidence")).toBeNull();
    expect(gt("DDR does not expect this depeg to recover.")).toBeTruthy();
    expect(gt("Comparable structural failures did not return to peg, so no duration estimate is shown.")).toBeTruthy();
    expect(qt(/Duration not estimated/)).toBeNull();

    re({ rows: [term([], { estimand: "cumulative_incidence", unresolvedShare30d: null })] });
    expect(gt("Terminal evidence")).toBeTruthy();
    expect(gt("Terminal evidence fired for this break.")).toBeTruthy();
    expect(gt(/Hard evidence that this break may not recover/)).toBeTruthy();
    expect(qt("DDR does not expect this depeg to recover.")).toBeNull();
    expect(screen.getByRole("img", { name: /verdict Terminal evidence; may not recover/ })).toBeTruthy();

    re({ rows: [lockedUnder("4.3", term([{ code: "K6_wind_down", kind: "kill", severity: "severe", label: "Issuer announced orderly wind-down" }]))] });
    const inline = container.querySelector("[data-ddr-terminal-signals]");
    expect(inline?.textContent).toContain("Fired kill signal");
    expect(inline?.textContent).toContain("Issuer announced orderly wind-down");
    expect(inline?.textContent).toContain("Severe");
    expect(qt("Will it recover?")).toBeNull();

    re({ rows: [predRow({ direction: "above", peakDeviationBps: 1_500, currentDeviationBps: 900, resolution: { tier: "recovery_likely", factors: [{ code: "K2_backing_impairment", kind: "kill", severity: "severe", label: "Depends on a frozen/dead collateral asset" }] } })] });
    expect(gt("No break signals")).toBeTruthy();
    expect(qt(/No kill signal fired/)).toBeNull();
    expect(gt("Will it recover?").parentElement?.textContent).toContain("1 kill signal · 0 anchors");
  });

  it.each([["5.0", "Stress signals", "At risk"], ["4.3", "At risk", "Stress signals"], [null, "At risk", "Stress signals"]] as const)(
    "labels a lock under methodology %s with its own tier vocabulary",
    (version, shown, hidden) => {
      renderResolver({ rows: [lockedUnder(version, row)] });
      expect(gt(shown)).toBeTruthy();
      expect(qt(hidden)).toBeNull();
      expect(Boolean(qt(/most comparable breaks still recovered/))).toBe(version === "5.0");
    },
  );

  it("renders v5 horizon odds without unreached quantiles and renders a reached v5 median", () => {
    const hz = (horizon: "6h" | "24h" | "7d" | "30d", state: "benchmarked" | "not_informative", probability: number | null) =>
      ({ horizon, state, probability, probabilityDisplay: null, probabilityInterval: null, rawAtRisk: 10, uniqueCoins: 8, intervalClosures: 4, intervalNonClosures: 6 });
    const { re } = renderResolver({ rows: [predRow({ duration: activeDuration({ stratum: "below · deep · USD", medianSec: null, iqrSec: null, horizons: [hz("6h", "not_informative", 0.12), hz("24h", "benchmarked", 0.31), hz("7d", "benchmarked", 0.42), hz("30d", "benchmarked", 0.47)], estimand: "cumulative_incidence", unresolvedShare30d: 0.53 }) as DdrRow["duration"] })] });
    expect(gt("31%")).toBeTruthy();
    expect(qt("12%")).toBeNull();
    expect(gt("6h odds: Not informative at this age")).toBeTruthy();
    expect(gt("~55%").parentElement?.textContent).toBe("~55% may not resolve within 30 days");
    expect(qt(/Half of comparable incidents|Typical range|typical range|anchored duration/)).toBeNull();

    re({ rows: [predRow({ duration: activeDuration({ stratum: null, medianSec: 3 * 86_400 + 5 * 3600, iqrSec: [5 * 3600 + 1200, 9 * 86_400], estimand: "cumulative_incidence", unresolvedShare30d: 0.02 }) as DdrRow["duration"] })] });
    expect(gt(/Half of comparable incidents recovered within/).textContent).toBe("Half of comparable incidents recovered within ~3d");
    expect(gt("5h–9d")).toBeTruthy();
    expect(gt("<5%")).toBeTruthy();
    expect(gt("~3d (5h-9d)")).toBeTruthy();
    expect(screen.getByRole("img", { name: /half of comparable incidents recovered within about 3d after lock/ })).toBeTruthy();
  });

  it("renders pending, deferred, retry-pending, no-call, and invalidated rows cleanly", () => {
    const { re } = renderResolver({ rows: [makePendingRow("pending_lock")] });
    expect(gt("Forecast not locked yet")).toBeTruthy();
    expect(qt(/Stress signals|~resolve/)).toBeNull();
    re({ rows: [makePendingRow("lock_deferred", { deferralReason: "stablecoins cache stale" })] });
    expect(gt("Health deferral")).toBeTruthy();
    expect(gt("Deferral reason: stablecoins cache stale")).toBeTruthy();
    expect(qt("Stress signals")).toBeNull();
    re({ rows: [makePendingRow("publication_retry_pending")] });
    expect(gt("Forecast publication delayed")).toBeTruthy();
    expect(qt("Stress signals")).toBeNull();
    re({ rows: [makeNoCallRow()] });
    expect(gt("No-call at lock")).toBeTruthy();
    expect(gt("Insufficient signal (sealed)")).toBeTruthy();
    expect(qt("No-call locked")).toBeNull();
    expect(gt("no usable live price")).toBeTruthy();
    expect(qt("DDR does not expect this depeg to recover.")).toBeNull();
    re({ rows: [makeInvalidatedRow()] });
    expect(gt("Prediction invalidated by erratum")).toBeTruthy();
    expect(gt("Erratum and original outcome")).toBeTruthy();
    re({ rows: [makeInvalidatedRow("no_call")] });
    expect(gt("no-call")).toBeTruthy();
    expect(qt("published prediction")).toBeNull();
  });

  it("shows frozen prediction lock metadata separately from live status", () => {
    renderResolver({ rows: [predRow({ ageSec: 86_400, currentDeviationBps: -250, duration: activeDuration() }, { ageSec: 90_000, peakDeviationBps: -320, currentDeviationBps: -180, updatedAt: 90_000 })] });
    expect(screen.getAllByText("Prediction frozen").length).toBeGreaterThan(0);
    for (const t of ["anchored duration", "~2h (1h-3h)", "From lock", "98.20% of peg", "-180 bps", "Live incident", "on time"]) expect(gt(t)).toBeTruthy();
    expect(screen.getByRole("img", { name: /lock deviation -250 bps/i })).toBeTruthy();
    expect(qt("97.50% of peg")).toBeNull();
    expect(qt("Projected")).toBeNull();
  });

  it("normalizes mixed v5 and pre-v5 tier counts in the header and renders DDRR track record", () => {
    const mk = (id: string, eventId: number, legacy = false) => {
      const r = predRow({ stablecoinId: id, eventId, resolution: { tier: "recovery_likely", factors: [] } });
      return legacy ? lockedUnder("4.3", r) : r;
    };
    const review = {
      headlineScope: "current_policy", headlineLabel: "Current public prediction policy",
      headline: { recoveryLikelihoodCorrectCount: 61, recoveryLikelihoodScoredCount: 74, recoveryLikelihoodAccuracyPct: 61 / 74, accuracyDenominatorLabel: "scored" },
      byPredictionPolicy: [],
    } as unknown as Parameters<typeof DepegResolverModule>[0]["review"];
    const { container } = renderResolver({ rows: [mk("v5-a", 11), mk("v5-b", 12), mk("leg-a", 13, true), mk("leg-b", 14, true)] }, { review });
    for (const t of ["Recovery outlook · DDR", "Forecast track record · DDRR", "Recovery calls correct: 61/74", "see the grading"]) expect(gt(t)).toBeTruthy();
    expect(screen.getByTitle(/2 no break signals \(current\) · 2 recovery likely \(pre-v5\)/).textContent).toBe("4no break signals");
    expect(container.textContent).not.toContain("2no break signals");
  });
});

describe("displayed live peak", () => {
  it("uses the admitted DDR observation clock to show weekend gold divergence", () => {
    const weekend = Date.parse("2026-11-14T14:00:00Z") / 1000;
    const legacy = { ...predRow({}, { updatedAt: weekend, currentDeviationBps: -400 }), pegCurrency: "GOLD" };
    const admitted = parseRow({ ...legacy, live: { ...legacy.live, currentDeviationObservedAtSec: weekend - 60 } });
    expect([isLiveCurrentDeviationHeld(legacy), getLiveCurrentDeviationBps(legacy)]).toEqual([true, null]);
    expect([isLiveCurrentDeviationHeld(admitted), getLiveCurrentDeviationBps(admitted)]).toEqual([false, -400]);
  });

  it.each([
    ["active and deeper", "active", "below", -129, -742, -742],
    ["active but shallower", "active", "below", -320, -180, -320],
    ["closed", "closed_pending_review", "below", -129, -742, -129],
    ["opposite direction", "active", "below", -129, 742, -129],
  ] as const)("%s", (_label, eventState, direction, peakDeviationBps, currentDeviationBps, expected) => {
    expect(getDisplayedLivePeakDeviationBps(predRow({ direction, peakDeviationBps, currentDeviationBps }, { eventState, peakDeviationBps, currentDeviationBps }))).toBe(expected);
  });
});

describe("StablecoinDepegResolverRows", () => {
  it("filters rows to the requested stablecoin, shows live peak floor, and hides on non-stale degradation", () => {
    const { re } = renderCoinRows({ rows: [row] }, "usdc-circle");
    expect(qt("Stress signals")).toBeNull();
    expect(screen.queryByLabelText(/Depeg Duration Resolver/)).toBeNull();

    re({ rows: [predRow({ stablecoinId: "usdc-circle", symbol: "USDC", eventId: 2 }), row] });
    expect(screen.getAllByLabelText(/Depeg Duration Resolver for /)).toHaveLength(1);
    expect(screen.getByLabelText("Depeg Duration Resolver for LUSD")).toBeTruthy();
    expect(qt("USDC")).toBeNull();

    const observedAt = Date.parse("2026-11-24T13:15:00Z") / 1000;
    re({ rows: [predRow({ peakDeviationBps: -129, currentDeviationBps: -742 }, { peakDeviationBps: -129, currentDeviationBps: -742, currentDeviationObservedAtSec: observedAt })] });
    const liveFacts = gt("Live incident").parentElement;
    expect(liveFacts?.textContent).toContain("Peak -742 bps");
    expect(liveFacts?.textContent).toContain("Now -742 bps (as of 2026-11-24 13:15 UTC)");

    re({ _meta: degMeta("missing-cache"), rows: [row] });
    expect(screen.queryByLabelText(/Depeg Duration Resolver/)).toBeNull();
    expect(qt(/Stress signals|Resolver snapshot is stale/)).toBeNull();
  });

  it.each(["resolver list", "stablecoin detail"] as const)("retains frozen duration over stale-cache overlay without private notice (%s)", (surface) => {
    const data = response({ _meta: degMeta("stale-cache"), rows: [predRow({ duration: activeDuration() }, { stale: true, degradedReason: "stale-cache" })] });
    render(surface === "resolver list" ? <DepegResolverModule data={data} /> : <StablecoinDepegResolverRows stablecoinId={LUSD} data={data} />);
    expect(qt(/live overlay is stale|Live overlay:|duration estimates are suppressed/i)).toBeNull();
    expect(gt("anchored duration")).toBeTruthy();
    expect(gt("~2h (1h-3h)")).toBeTruthy();
  });

  it.each(["stale-cache", "errata-overlay-read-failed", "lock-deferral-overlay-read-failed", "manifest-fallback:missing-cache"])(
    "keeps infrastructure reason %s out of the live-incident caption",
    (degradedReason) => {
      renderCoinRows({ rows: [predRow({}, { degradedReason })] });
      expect(gt("Live incident")).toBeTruthy();
      expect(qt(/Live overlay:/)).toBeNull();
    },
  );

  it.each([
    ["duration-exceeded", "Live overlay: past its forecast window."],
    ["closed-pending-review", "Live overlay: closed, pending review."],
    ["lock-deferred", "Live overlay: lock deferred."],
  ])("keeps incident reason %s in the live-incident caption", (degradedReason, caption) => {
    renderCoinRows({ rows: [predRow({}, { degradedReason })] });
    expect(gt(caption)).toBeTruthy();
  });
});
