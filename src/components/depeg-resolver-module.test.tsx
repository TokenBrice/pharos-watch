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

function predictionMeta(state: DdrPredictionMeta["state"], overrides: Partial<DdrPredictionMeta> = {}): DdrPredictionMeta {
  const unlocked = state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending";
  return {
    state, publicPredictionId: unlocked ? null : 7, incidentKey: "ddr2:test",
    predictionPolicyVersion: "sticky-24h-v1", predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
    predictionMethodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL, resolutionRubricVersion: "resolution-rubric-v1",
    durationModelVersion: "duration-landmark-v1", incidentGroupingVersion: "incident-group-v1",
    supportRulesVersion: "support-rules-v1", eligibleAt: 86_400, policyDelaySec: 86_400,
    lockedAt: unlocked ? null : 86_401, publishedAt: unlocked ? null : 86_500,
    publicationSnapshotToken: unlocked ? null : "ddrpub:test", snapshotGeneration: unlocked ? null : 2,
    eventAgeAtLockSec: unlocked ? null : 86_400,
    lockTiming: state === "lock_deferred" ? "deferred" : unlocked ? null : "on_time",
    lockTrigger: "scheduled_24h", readiness: null, backstop: null,
    source: state === "invalidated" ? "erratum" : unlocked ? "pending" : "public_prediction",
    deferralReason: null, deferralCount: null, rowHash: unlocked ? null : "a".repeat(64),
    lineage: null, modelAsOf: 86_401, latestErratum: null, errataCount: 0, errataHistory: [], ...overrides,
  };
}

const baseV2Row = (s: DdrRow) => ({
  stablecoinId: s.stablecoinId, symbol: s.symbol, name: s.name, pegCurrency: s.pegCurrency,
  governance: s.governance, status: s.status, eventId: s.eventId, incidentKey: "ddr2:test",
  startedAt: s.startedAt, direction: s.direction,
});

const liveOverlay = (s: DdrRow, overrides: Record<string, unknown> = {}) => ({
  currentEventId: s.eventId, ageSec: s.ageSec, peakDeviationBps: s.peakDeviationBps,
  currentDeviationBps: s.currentDeviationBps, eventState: "active", updatedAt: s.startedAt + s.ageSec,
  stale: false, degradedReason: null, ...overrides,
});

const makePredictionRow = (source = makeSourceRow(), liveOverrides: Record<string, unknown> = {}): DdrV2ResponseRow =>
  makeFrozenDdrV2Row(source, { live: liveOverlay(source, liveOverrides) });

function makePendingRow(state: "pending_lock" | "lock_deferred" | "publication_retry_pending", overrides: Partial<DdrPredictionMeta> = {}): DdrV2ResponseRow {
  const source = makeSourceRow();
  return DdrV2ResponseRowSchema.parse({ ...baseV2Row(source), kind: "pending", prediction: predictionMeta(state, overrides), frozen: null, live: liveOverlay(source) });
}

function makeNoCallRow(): DdrV2ResponseRow {
  const source = makeSourceRow();
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source), kind: "no_call", prediction: predictionMeta("no_call"),
    noCall: { lockedAt: 86_401, eventAgeAtLockSec: 86_400, missingReasons: ["no usable live price"], relatedContext: source.relatedContext },
    frozen: null, live: liveOverlay(source),
  });
}

function makeInvalidatedRow(originalKind: "prediction" | "no_call" = "prediction"): DdrV2ResponseRow {
  const source = makeSourceRow({ resolution: { tier: "recovery_likely", factors: [] } });
  const original = makePredictionRow(source);
  if (original.kind !== "prediction") throw new Error("Expected prediction fixture");
  const noCall = { lockedAt: 86_401, eventAgeAtLockSec: 86_400, missingReasons: ["no usable live price"], relatedContext: source.relatedContext };
  const erratum = {
    id: 1, state: "invalidated" as const, publicPredictionId: 7, incidentKey: "ddr2:test", eventId: 1, assessmentId: 1,
    reason: "event_identity_error" as const, createdAt: 86_500, operatorNote: "Source event repaired after publication",
    rowHashBefore: "a".repeat(64), replacementAssessmentId: null, replacementRowHash: null, createdBy: "test",
  };
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source), kind: "invalidated_prediction",
    prediction: predictionMeta("invalidated", { latestErratum: erratum, errataCount: 1, errataHistory: [erratum] }),
    originalKind, originalOutcome: originalKind === "prediction" ? original.frozen : noCall,
    frozen: originalKind === "prediction" ? original.frozen : null, noCall: originalKind === "no_call" ? noCall : null,
    live: liveOverlay(source, { eventState: "event_invalidated" }),
  });
}

const row = makePredictionRow();
const lockedUnder = (version: string | null, source: DdrV2ResponseRow): DdrV2ResponseRow => DdrV2ResponseRowSchema.parse({
  ...source, prediction: { ...source.prediction, predictionMethodologyVersion: version, predictionMethodologyVersionLabel: version == null ? null : `v${version}` },
});

const terminalDuration = (extra: Record<string, unknown> = {}) => ({
  suppressed: true, suppressedReason: "verdict_terminal", stratum: null, medianSec: null, iqrSec: null, ageStatus: null, horizons: [], ...extra,
});

function response(overrides: Partial<DdrResponse> = {}): DdrResponse {
  return {
    _meta: meta, rows: [],
    methodology: { version: DDR_METHODOLOGY_VERSION, versionLabel: DDR_METHODOLOGY_VERSION_LABEL, currentVersion: DDR_METHODOLOGY_VERSION, currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL, changelogPath: "/methodology/depeg-resolver-changelog/", asOf: 1, isCurrent: true },
    ...overrides,
  };
}

const renderResolver = (overrides: Partial<DdrResponse> = {}, extra: Omit<Parameters<typeof DepegResolverModule>[0], "data"> = {}) =>
  render(<DepegResolverModule data={response(overrides)} {...extra} />);
const renderCoinRows = (overrides: Partial<DdrResponse>, stablecoinId = "lusd-liquity") =>
  render(<StablecoinDepegResolverRows stablecoinId={stablecoinId} data={response(overrides)} />);

describe("DepegResolverModule", () => {
  it.each(["GOLD", "USD"] as const)("labels the %s peg-relative ratio without publishing a synthetic currency price", (pegCurrency) => {
    renderResolver({ rows: [makePredictionRow(makeSourceRow({ pegCurrency, startedAt: 1_795_017_600 }), { currentDeviationBps: -500 })] });
    expect(screen.getByText("95.00% of peg")).toBeTruthy();
    expect(screen.queryByText("$0.9500")).toBeNull();
    expect(screen.queryByText("€0.9500")).toBeNull();
  });

  it("counts only valid frozen predictions in the current forecast book", () => {
    const mixed = [row, makeInvalidatedRow(), makeNoCallRow(), makePendingRow("pending_lock"), makePendingRow("lock_deferred"), makePendingRow("publication_retry_pending")];
    const book = summarizeResolverBook(mixed);
    expect(book).toMatchObject({ total: 1, rowCount: 6, tierCounts: { at_risk: 1, recovery_likely: 0, insufficient_signal: 0 } });
    expect(summarizeResolverBook(mixed.slice(1)).total).toBe(0);
    renderResolver({ rows: mixed });
    expect(screen.getByText(/forecast.*across 6 incident rows/).textContent).toContain("1 forecast across 6 incident rows");
    fireEvent.click(screen.getByRole("button", { name: "Show all 6 incident rows" }));
    expect(screen.getByText("Prediction invalidated by erratum")).toBeTruthy();
  });

  describe("new-worst flag compares live deviation with the live event peak", () => {
    const tiered = (id: string, tier: DdrResolutionTier, current: number, eventState = "active"): DdrV2ResponseRow =>
      makePredictionRow(makeSourceRow({ stablecoinId: id, symbol: id.toUpperCase(), resolution: { tier, factors: [] }, peakDeviationBps: -10_000, currentDeviationBps: current }), { eventState });

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
      screen.getByText("$10.0B market cap");
      screen.getByText("Market cap unavailable");

      const coin = (id: string, bps: number, activeDepeg = true) => makePegSummaryCoin({ id, symbol: id, currentDeviationBps: bps, activeDepeg });
      expect(rankOpenIncidents([coin("calm", -10, false), coin("big", -14), coin("nocap", -9_000), coin("small", -4_500)],
        [tiered("big", "at_risk", -14), tiered("small", "recovery_likely", -4_500, "closed_pending_review")], new Map([["small", 49e6], ["big", 1.5e9]])))
        .toMatchObject([{ id: "small", ddr: null }, { id: "big", ddr: { stablecoinId: "big" } }, { id: "nocap", ddr: null, marketCapUsd: null }]);

      const fx = (id: string, status: "admitted" | "stale-reference") => makePegSummaryCoin({ id, activeDepeg: true, pegCurrency: "EUR", priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg(status, status === "admitted" ? 0 : null) });
      expect(rankOpenIncidents([fx("stale", "stale-reference"), fx("live", "admitted")], [], new Map([["stale", 1e9], ["live", 1e6]])))
        .toMatchObject([{ id: "live", deviationBps: 0, referenceNote: null }, { id: "stale", deviationBps: null, referenceNote: "Reference not yet updated" }]);
    });

    it("captions the count as a new worst, never as past their worst", () => {
      renderResolver({ rows: [peakRow("a", -300, { peak: -400, current: -900 }), peakRow("b", -300, { peak: -400, current: -900 })] });
      expect(screen.getByText(/2 at a new worst/)).toBeTruthy();
      expect(screen.queryByText(/past their worst/)).toBeNull();
    });
  });

  describe("calibration lineage caption", () => {
    const lineage = (incidentCount: number, coinCount: number, quarantinedCoins = 0) => ({
      trainingWindow: { start: 1, end: 2 }, eventCount: 99_999, incidentCount, coinCount, quarantinedCoins,
    });

    it.each([
      [8_466, 41, 0, "Calibrated on 8,466 historical incidents · 41 coins"],
      [0, 0, 0, "Calibrated on 0 historical incidents · 0 coins"],
      [8_466, 41, 1, "Calibrated on 8,466 historical incidents · 41 coins (1 excluded)"],
      [8_466, 41, 3, "Calibrated on 8,466 historical incidents · 41 coins (3 excluded)"],
    ] as const)("renders lineage caption (%s, %s, %s)", (incidents, coins, quarantined, expected) => {
      renderResolver({ _meta: { ...meta, lineage: lineage(incidents, coins, quarantined) }, rows: [row] });
      expect(screen.getByText(/^Calibrated on/).textContent).toBe(expected);
      expect(screen.queryByText(/recovered\s+incidents|coins? excluded/)).toBeNull();
    });

    it("omits the caption without lineage", () => {
      renderResolver({ rows: [row] });
      expect(screen.queryByText(/^Calibrated on/)).toBeNull();
    });
  });

  it("distinguishes loading, healthy empty, degraded empty, stale-cache retained, and unknown-failure states", () => {
    const { rerender } = render(<DepegResolverModule data={undefined} />);
    expect(screen.getByText("Resolver data is loading.")).toBeTruthy();
    expect(screen.queryByText(/No active confirmed depegs/)).toBeNull();

    for (const degradedReason of ["missing-cache", "stale-cache"]) {
      rerender(<DepegResolverModule data={response({ _meta: { ...meta, degraded: true, degradedReason } })} />);
      expect(screen.getByText("Resolver data is temporarily unavailable.")).toBeTruthy();
      expect(screen.queryByText(/No active confirmed depegs|Whole book/)).toBeNull();
    }

    rerender(<DepegResolverModule data={response()} />);
    expect(screen.getByText("No active confirmed depegs.")).toBeTruthy();
    expect(screen.queryByText("Resolver data is temporarily unavailable.")).toBeNull();

    rerender(<DepegResolverModule data={response({ _meta: { ...meta, degraded: true, degradedReason: "stale-cache" }, rows: [row] })} />);
    expect(screen.getByText(/Whole book/).textContent).toContain("1 forecast across 1 incident rows");
    expect(screen.queryByText(/live overlay is stale/i)).toBeNull();
    expect(screen.getByText("Stress signals")).toBeTruthy();

    rerender(<DepegResolverModule data={response({ _meta: { ...meta, degraded: true, degradedReason: "unknown-failure" }, rows: [row] })} />);
    expect(screen.getByText("Resolver data is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByText(/Whole book|showing all|most urgent|Stress signals/)).toBeNull();
  });

  it("renders pre-v5 terminal, v5 terminal, inline terminal kill signals, and above-peg kill signals accurately", () => {
    const preV5 = lockedUnder("4.3", makePredictionRow(makeSourceRow({ resolution: { tier: "recovery_unlikely", factors: [] }, duration: terminalDuration() })));
    const { rerender, container } = renderResolver({ rows: [preV5] });
    expect(screen.getByText("No recovery expected")).toBeTruthy();
    expect(screen.queryByText("Terminal evidence")).toBeNull();
    expect(screen.getByText("DDR does not expect this depeg to recover.")).toBeTruthy();
    expect(screen.getByText("Comparable structural failures did not return to peg, so no duration estimate is shown.")).toBeTruthy();
    expect(screen.queryByText(/Duration not estimated/)).toBeNull();

    const v5Term = makePredictionRow(makeSourceRow({ resolution: { tier: "recovery_unlikely", factors: [] }, duration: terminalDuration({ estimand: "cumulative_incidence", unresolvedShare30d: null }) }));
    rerender(<DepegResolverModule data={response({ rows: [v5Term] })} />);
    expect(screen.getByText("Terminal evidence")).toBeTruthy();
    expect(screen.getByText("Terminal evidence fired for this break.")).toBeTruthy();
    expect(screen.getByText(/Hard evidence that this break may not recover/)).toBeTruthy();
    expect(screen.queryByText("DDR does not expect this depeg to recover.")).toBeNull();
    expect(screen.getByRole("img", { name: /verdict Terminal evidence; may not recover/ })).toBeTruthy();

    const killTerm = lockedUnder("4.3", makePredictionRow(makeSourceRow({
      resolution: { tier: "recovery_unlikely", factors: [{ code: "K6_wind_down", kind: "kill", severity: "severe", label: "Issuer announced orderly wind-down" }] },
      duration: terminalDuration(),
    })));
    rerender(<DepegResolverModule data={response({ rows: [killTerm] })} />);
    const inlineBlock = container.querySelector("[data-ddr-terminal-signals]");
    expect(inlineBlock?.textContent).toContain("Fired kill signal");
    expect(inlineBlock?.textContent).toContain("Issuer announced orderly wind-down");
    expect(inlineBlock?.textContent).toContain("Severe");
    expect(screen.queryByText("Will it recover?")).toBeNull();

    const abovePeg = makePredictionRow(makeSourceRow({
      direction: "above", peakDeviationBps: 1_500, currentDeviationBps: 900,
      resolution: { tier: "recovery_likely", factors: [{ code: "K2_backing_impairment", kind: "kill", severity: "severe", label: "Depends on a frozen/dead collateral asset" }] },
    }));
    rerender(<DepegResolverModule data={response({ rows: [abovePeg] })} />);
    expect(screen.getByText("No break signals")).toBeTruthy();
    expect(screen.queryByText(/No kill signal fired/)).toBeNull();
    expect(screen.getByText("Will it recover?").parentElement?.textContent).toContain("1 kill signal · 0 anchors");
  });

  it.each([["5.0", "Stress signals", "At risk"], ["4.3", "At risk", "Stress signals"], [null, "At risk", "Stress signals"]] as const)(
    "labels a lock under methodology %s with its own tier vocabulary",
    (version, shown, hidden) => {
      renderResolver({ rows: [lockedUnder(version, row)] });
      expect(screen.getByText(shown)).toBeTruthy();
      expect(screen.queryByText(hidden)).toBeNull();
      expect(Boolean(screen.queryByText(/most comparable breaks still recovered/))).toBe(version === "5.0");
    },
  );

  it("renders v5 horizon odds without unreached quantiles and renders a reached v5 median", () => {
    const horizon = (h: "6h" | "24h" | "7d" | "30d", state: "benchmarked" | "not_informative", probability: number | null) => ({
      horizon: h, state, probability, probabilityDisplay: null, probabilityInterval: null, rawAtRisk: 10, uniqueCoins: 8, intervalClosures: 4, intervalNonClosures: 6,
    });
    const { rerender } = renderResolver({ rows: [makePredictionRow(makeSourceRow({
      duration: { suppressed: false, suppressedReason: null, stratum: "below · deep · USD", medianSec: null, iqrSec: null, ageStatus: "ordinary", horizons: [horizon("6h", "not_informative", 0.12), horizon("24h", "benchmarked", 0.31), horizon("7d", "benchmarked", 0.42), horizon("30d", "benchmarked", 0.47)], estimand: "cumulative_incidence", unresolvedShare30d: 0.53 },
    }))] });
    expect(screen.getByText("31%")).toBeTruthy();
    expect(screen.queryByText("12%")).toBeNull();
    expect(screen.getByText("6h odds: Not informative at this age")).toBeTruthy();
    expect(screen.getByText("~55%").parentElement?.textContent).toBe("~55% may not resolve within 30 days");
    expect(screen.queryByText(/Half of comparable incidents|Typical range|typical range|anchored duration/)).toBeNull();

    rerender(<DepegResolverModule data={response({ rows: [makePredictionRow(makeSourceRow({
      duration: { suppressed: false, suppressedReason: null, stratum: null, medianSec: 3 * 86_400 + 5 * 3600, iqrSec: [5 * 3600 + 1200, 9 * 86_400], ageStatus: "ordinary", horizons: [], estimand: "cumulative_incidence", unresolvedShare30d: 0.02 },
    }))] })} />);
    expect(screen.getByText(/Half of comparable incidents recovered within/).textContent).toBe("Half of comparable incidents recovered within ~3d");
    expect(screen.getByText("5h–9d")).toBeTruthy();
    expect(screen.getByText("<5%")).toBeTruthy();
    expect(screen.getByText("~3d (5h-9d)")).toBeTruthy();
    expect(screen.getByRole("img", { name: /half of comparable incidents recovered within about 3d after lock/ })).toBeTruthy();
  });

  it("renders pending, deferred, retry-pending, no-call, and invalidated rows cleanly", () => {
    const { rerender } = renderResolver({ rows: [makePendingRow("pending_lock")] });
    expect(screen.getByText("Forecast not locked yet")).toBeTruthy();
    expect(screen.queryByText(/Stress signals|~resolve/)).toBeNull();

    rerender(<DepegResolverModule data={response({ rows: [makePendingRow("lock_deferred", { deferralReason: "stablecoins cache stale" })] })} />);
    expect(screen.getByText("Health deferral")).toBeTruthy();
    expect(screen.getByText("Deferral reason: stablecoins cache stale")).toBeTruthy();
    expect(screen.queryByText("Stress signals")).toBeNull();

    rerender(<DepegResolverModule data={response({ rows: [makePendingRow("publication_retry_pending")] })} />);
    expect(screen.getByText("Forecast publication delayed")).toBeTruthy();
    expect(screen.queryByText("Stress signals")).toBeNull();

    rerender(<DepegResolverModule data={response({ rows: [makeNoCallRow()] })} />);
    expect(screen.getByText("No-call at lock")).toBeTruthy();
    expect(screen.getByText("Insufficient signal (sealed)")).toBeTruthy();
    expect(screen.queryByText("No-call locked")).toBeNull();
    expect(screen.getByText("no usable live price")).toBeTruthy();
    expect(screen.queryByText("DDR does not expect this depeg to recover.")).toBeNull();

    rerender(<DepegResolverModule data={response({ rows: [makeInvalidatedRow()] })} />);
    expect(screen.getByText("Prediction invalidated by erratum")).toBeTruthy();
    expect(screen.getByText("Erratum and original outcome")).toBeTruthy();

    rerender(<DepegResolverModule data={response({ rows: [makeInvalidatedRow("no_call")] })} />);
    expect(screen.getByText("no-call")).toBeTruthy();
    expect(screen.queryByText("published prediction")).toBeNull();
  });

  it("shows frozen prediction lock metadata separately from live status", () => {
    const sourceRow = makeSourceRow({ ageSec: 86_400, currentDeviationBps: -250, duration: { suppressed: false, suppressedReason: null, stratum: "below · moderate · USD", medianSec: 7200, iqrSec: [3600, 10_800], ageStatus: "ordinary", horizons: [] } });
    renderResolver({ rows: [makePredictionRow(sourceRow, { ageSec: 90_000, peakDeviationBps: -320, currentDeviationBps: -180, updatedAt: 90_000 })] });
    expect(screen.getAllByText("Prediction frozen").length).toBeGreaterThan(0);
    for (const t of ["anchored duration", "~2h (1h-3h)", "From lock", "98.20% of peg", "-180 bps", "Live incident", "on time"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByRole("img", { name: /lock deviation -250 bps/i })).toBeTruthy();
    expect(screen.queryByText("97.50% of peg")).toBeNull();
    expect(screen.queryByText("Projected")).toBeNull();
  });

  it("normalizes mixed v5 and pre-v5 tier counts in the header and renders DDRR track record", () => {
    const mk = (id: string, eventId: number, legacy = false) => {
      const r = makePredictionRow(makeSourceRow({ stablecoinId: id, eventId, resolution: { tier: "recovery_likely", factors: [] } }));
      return legacy ? lockedUnder("4.3", r) : r;
    };
    const review = {
      headlineScope: "current_policy", headlineLabel: "Current public prediction policy",
      headline: { recoveryLikelihoodCorrectCount: 61, recoveryLikelihoodScoredCount: 74, recoveryLikelihoodAccuracyPct: 61 / 74, accuracyDenominatorLabel: "scored" },
      byPredictionPolicy: [],
    } as unknown as Parameters<typeof DepegResolverModule>[0]["review"];
    const { container } = renderResolver({ rows: [mk("v5-a", 11), mk("v5-b", 12), mk("leg-a", 13, true), mk("leg-b", 14, true)] }, { review });
    for (const t of ["Recovery outlook · DDR", "Forecast track record · DDRR", "Recovery calls correct: 61/74", "see the grading"]) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByTitle(/2 no break signals \(current\) · 2 recovery likely \(pre-v5\)/).textContent).toBe("4no break signals");
    expect(container.textContent).not.toContain("2no break signals");
  });
});

describe("displayed live peak", () => {
  it("uses the admitted DDR observation clock to show weekend gold divergence", () => {
    const weekend = Date.parse("2026-11-14T14:00:00Z") / 1000;
    const legacy = { ...makePredictionRow(makeSourceRow(), { updatedAt: weekend, currentDeviationBps: -400 }), pegCurrency: "GOLD" };
    const admitted = DdrV2ResponseRowSchema.parse({ ...legacy, live: { ...legacy.live, currentDeviationObservedAtSec: weekend - 60 } });
    expect([isLiveCurrentDeviationHeld(legacy), getLiveCurrentDeviationBps(legacy)]).toEqual([true, null]);
    expect([isLiveCurrentDeviationHeld(admitted), getLiveCurrentDeviationBps(admitted)]).toEqual([false, -400]);
  });

  it.each([
    ["active and deeper", "active", "below", -129, -742, -742],
    ["active but shallower", "active", "below", -320, -180, -320],
    ["closed", "closed_pending_review", "below", -129, -742, -129],
    ["opposite direction", "active", "below", -129, 742, -129],
  ] as const)("%s", (_label, eventState, direction, peakDeviationBps, currentDeviationBps, expected) => {
    expect(getDisplayedLivePeakDeviationBps(makePredictionRow(makeSourceRow({ direction, peakDeviationBps, currentDeviationBps }), { eventState, peakDeviationBps, currentDeviationBps }))).toBe(expected);
  });
});

describe("StablecoinDepegResolverRows", () => {
  it("filters rows to the requested stablecoin, shows live peak floor, and hides on non-stale degradation", () => {
    const { rerender } = renderCoinRows({ rows: [row] }, "usdc-circle");
    expect(screen.queryByText("Stress signals")).toBeNull();
    expect(screen.queryByLabelText(/Depeg Duration Resolver/)).toBeNull();

    const other = makePredictionRow(makeSourceRow({ stablecoinId: "usdc-circle", symbol: "USDC", eventId: 2 }));
    rerender(<StablecoinDepegResolverRows stablecoinId="lusd-liquity" data={response({ rows: [other, row] })} />);
    expect(screen.getAllByLabelText(/Depeg Duration Resolver for /)).toHaveLength(1);
    expect(screen.getByLabelText("Depeg Duration Resolver for LUSD")).toBeTruthy();
    expect(screen.queryByText("USDC")).toBeNull();

    const source = makeSourceRow({ peakDeviationBps: -129, currentDeviationBps: -742 });
    const observedAt = Date.parse("2026-11-24T13:15:00Z") / 1000;
    rerender(<StablecoinDepegResolverRows stablecoinId="lusd-liquity" data={response({ rows: [makePredictionRow(source, { peakDeviationBps: -129, currentDeviationBps: -742, currentDeviationObservedAtSec: observedAt })] })} />);
    const liveFacts = screen.getByText("Live incident").parentElement;
    expect(liveFacts?.textContent).toContain("Peak -742 bps");
    expect(liveFacts?.textContent).toContain("Now -742 bps (as of 2026-11-24 13:15 UTC)");

    rerender(<StablecoinDepegResolverRows stablecoinId="lusd-liquity" data={response({ _meta: { ...meta, degraded: true, degradedReason: "missing-cache" }, rows: [row] })} />);
    expect(screen.queryByLabelText(/Depeg Duration Resolver/)).toBeNull();
    expect(screen.queryByText(/Stress signals|Resolver snapshot is stale/)).toBeNull();
  });

  it.each(["resolver list", "stablecoin detail"] as const)("retains frozen duration over stale-cache overlay without private notice (%s)", (surface) => {
    const sourceRow = makeSourceRow({ duration: { suppressed: false, suppressedReason: null, stratum: "below · moderate · USD", medianSec: 7200, iqrSec: [3600, 10_800], ageStatus: "ordinary", horizons: [] } });
    const data = response({ _meta: { ...meta, degraded: true, degradedReason: "stale-cache" }, rows: [makePredictionRow(sourceRow, { stale: true, degradedReason: "stale-cache" })] });
    render(surface === "resolver list" ? <DepegResolverModule data={data} /> : <StablecoinDepegResolverRows stablecoinId="lusd-liquity" data={data} />);
    expect(screen.queryByText(/live overlay is stale|Live overlay:|duration estimates are suppressed/i)).toBeNull();
    expect(screen.getByText("anchored duration")).toBeTruthy();
    expect(screen.getByText("~2h (1h-3h)")).toBeTruthy();
  });

  it.each(["stale-cache", "errata-overlay-read-failed", "lock-deferral-overlay-read-failed", "manifest-fallback:missing-cache"])(
    "keeps infrastructure reason %s out of the live-incident caption",
    (degradedReason) => {
      renderCoinRows({ rows: [makePredictionRow(makeSourceRow(), { degradedReason })] });
      expect(screen.getByText("Live incident")).toBeTruthy();
      expect(screen.queryByText(/Live overlay:/)).toBeNull();
    },
  );

  it.each([
    ["duration-exceeded", "Live overlay: past its forecast window."],
    ["closed-pending-review", "Live overlay: closed, pending review."],
    ["lock-deferred", "Live overlay: lock deferred."],
  ])("keeps incident reason %s in the live-incident caption", (degradedReason, caption) => {
    renderCoinRows({ rows: [makePredictionRow(makeSourceRow(), { degradedReason })] });
    expect(screen.getByText(caption)).toBeTruthy();
  });
});
