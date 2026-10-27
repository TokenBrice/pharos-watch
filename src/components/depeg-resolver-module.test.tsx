// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DepegResolverModule } from "@/components/depeg-resolver-module";
import { StablecoinDepegResolverRows } from "@/components/depeg-resolver-row-card-parts";
import { compareResolverUrgency, summarizeResolverBook } from "@/components/depeg-resolver-book-summary";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import {
  DdrV2ResponseRowSchema,
  type DdrPredictionMeta,
  type DdrResponse,
  type DdrRow,
  type DdrV2ResponseRow,
} from "@shared/types/depeg-resolver";
import { DDR_TEST_META, makeDdrSourceRow, makeFrozenDdrV2Row } from "./depeg-resolver-test-support";

vi.mock("@/lib/feature-flags", () => ({
  isDepegResolverEnabled: () => true,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: () => <span data-testid="logo" />,
}));

const meta = DDR_TEST_META;
const makeSourceRow = makeDdrSourceRow;

function predictionMeta(
  state: DdrPredictionMeta["state"],
  overrides: Partial<DdrPredictionMeta> = {},
): DdrPredictionMeta {
  return {
    state,
    publicPredictionId:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 7,
    incidentKey: "ddr2:test",
    predictionPolicyVersion: "sticky-24h-v1",
    predictionMethodologyVersion: DDR_METHODOLOGY_VERSION,
    predictionMethodologyVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
    resolutionRubricVersion: "resolution-rubric-v1",
    durationModelVersion: "duration-landmark-v1",
    incidentGroupingVersion: "incident-group-v1",
    supportRulesVersion: "support-rules-v1",
    eligibleAt: 86_400,
    policyDelaySec: 86_400,
    lockedAt:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 86_401,
    publishedAt:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 86_500,
    publicationSnapshotToken:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending"
        ? null
        : "ddrpub:test",
    snapshotGeneration:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 2,
    eventAgeAtLockSec:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending" ? null : 86_400,
    lockTiming:
      state === "lock_deferred"
        ? "deferred"
        : state === "pending_lock" || state === "publication_retry_pending"
          ? null
          : "on_time",
    lockTrigger: "scheduled_24h",
    readiness: null,
    backstop: null,
    source:
      state === "invalidated"
        ? "erratum"
        : state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending"
          ? "pending"
          : "public_prediction",
    deferralReason: null,
    deferralCount: null,
    rowHash:
      state === "pending_lock" || state === "lock_deferred" || state === "publication_retry_pending"
        ? null
        : "a".repeat(64),
    lineage: null,
    modelAsOf: 86_401,
    latestErratum: null,
    errataCount: 0,
    errataHistory: [],
    ...overrides,
  };
}

function baseV2Row(source: DdrRow) {
  return {
    stablecoinId: source.stablecoinId,
    symbol: source.symbol,
    name: source.name,
    pegCurrency: source.pegCurrency,
    governance: source.governance,
    status: source.status,
    eventId: source.eventId,
    incidentKey: "ddr2:test",
    startedAt: source.startedAt,
    direction: source.direction,
  };
}

function liveOverlay(source: DdrRow, overrides: Record<string, unknown> = {}) {
  return {
    currentEventId: source.eventId,
    ageSec: source.ageSec,
    peakDeviationBps: source.peakDeviationBps,
    currentDeviationBps: source.currentDeviationBps,
    eventState: "active",
    updatedAt: source.startedAt + source.ageSec,
    stale: false,
    degradedReason: null,
    ...overrides,
  };
}

function makePredictionRow(source = makeSourceRow(), liveOverrides: Record<string, unknown> = {}): DdrV2ResponseRow {
  return makeFrozenDdrV2Row(source, { live: liveOverlay(source, liveOverrides) });
}

function makePendingRow(
  state: "pending_lock" | "lock_deferred" | "publication_retry_pending",
  overrides: Partial<DdrPredictionMeta> = {},
): DdrV2ResponseRow {
  const source = makeSourceRow();
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source),
    kind: "pending",
    prediction: predictionMeta(state, overrides),
    frozen: null,
    live: liveOverlay(source),
  });
}

function makeNoCallRow(): DdrV2ResponseRow {
  const source = makeSourceRow();
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source),
    kind: "no_call",
    prediction: predictionMeta("no_call"),
    noCall: {
      lockedAt: 86_401,
      eventAgeAtLockSec: 86_400,
      missingReasons: ["no usable live price"],
      relatedContext: makeSourceRow().relatedContext,
    },
    frozen: null,
    live: liveOverlay(source),
  });
}

function makeInvalidatedRow(originalKind: "prediction" | "no_call" = "prediction"): DdrV2ResponseRow {
  const source = makeSourceRow({ resolution: { tier: "recovery_likely", factors: [] } });
  const original = makePredictionRow(source);
  if (original.kind !== "prediction") throw new Error("Expected prediction fixture");
  const noCall = {
    lockedAt: 86_401,
    eventAgeAtLockSec: 86_400,
    missingReasons: ["no usable live price"],
    relatedContext: source.relatedContext,
  };
  const erratum = {
    id: 1,
    state: "invalidated" as const,
    publicPredictionId: 7,
    incidentKey: "ddr2:test",
    eventId: 1,
    assessmentId: 1,
    reason: "event_identity_error" as const,
    createdAt: 86_500,
    operatorNote: "Source event repaired after publication",
    rowHashBefore: "a".repeat(64),
    replacementAssessmentId: null,
    replacementRowHash: null,
    createdBy: "test",
  };
  return DdrV2ResponseRowSchema.parse({
    ...baseV2Row(source),
    kind: "invalidated_prediction",
    prediction: predictionMeta("invalidated", {
      latestErratum: erratum,
      errataCount: 1,
      errataHistory: [erratum],
    }),
    originalKind,
    originalOutcome: originalKind === "prediction" ? original.frozen : noCall,
    frozen: originalKind === "prediction" ? original.frozen : null,
    noCall: originalKind === "no_call" ? noCall : null,
    live: liveOverlay(source, { eventState: "event_invalidated" }),
  });
}

const row = makePredictionRow();

/** Re-stamps a fixture as locked under another methodology (null = predates version stamping). */
function lockedUnder(version: string | null, source: DdrV2ResponseRow): DdrV2ResponseRow {
  return DdrV2ResponseRowSchema.parse({
    ...source,
    prediction: {
      ...source.prediction,
      predictionMethodologyVersion: version,
      predictionMethodologyVersionLabel: version == null ? null : `v${version}`,
    },
  });
}

function response(overrides: Partial<DdrResponse> = {}): DdrResponse {
  return {
    _meta: meta,
    rows: [],
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: 1,
      isCurrent: true,
    },
    ...overrides,
  };
}

describe("DepegResolverModule", () => {
  it.each(["GOLD", "USD"] as const)(
    "labels the %s peg-relative ratio without publishing a synthetic currency price",
    (pegCurrency) => {
      const ratioRow = makePredictionRow(makeSourceRow({ pegCurrency }), { currentDeviationBps: -500 });
      render(<DepegResolverModule data={response({ rows: [ratioRow] })} />);
      expect(screen.getByText("95.00% of peg")).toBeTruthy();
      expect(screen.queryByText("$0.9500")).toBeNull();
      expect(screen.queryByText("€0.9500")).toBeNull();
    },
  );

  it("counts only valid frozen predictions in the current forecast book", () => {
    const mixed = [row, makeInvalidatedRow(), makeNoCallRow(), makePendingRow("pending_lock"),
      makePendingRow("lock_deferred"), makePendingRow("publication_retry_pending")];
    const book = summarizeResolverBook(mixed);
    expect(book.total).toBe(1);
    expect(book.rowCount).toBe(6);
    expect(book.tierCounts.at_risk).toBe(1);
    expect(book.tierCounts.recovery_likely).toBe(0);
    expect(book.tierCounts.insufficient_signal).toBe(0);
    expect(summarizeResolverBook(mixed.slice(1)).total).toBe(0);
    render(<DepegResolverModule data={response({ rows: mixed })} />);
    expect(screen.getByText(/forecast.*across 6 incident rows/).textContent).toContain("1 forecast across 6 incident rows");
    expect(screen.getByText("Prediction invalidated by erratum")).toBeTruthy();
  });

  describe("new-worst flag compares live deviation with the live event peak", () => {
    function peakRow(
      id: string,
      frozenPeak: number | null,
      live: { peak: number | null; current: number | null },
    ): DdrV2ResponseRow {
      const frozen = makeFrozenDdrV2Row(makeSourceRow({ stablecoinId: id, symbol: id.toUpperCase(), peakDeviationBps: frozenPeak ?? -1, currentDeviationBps: frozenPeak }));
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
      const book = summarizeResolverBook([peakRow("a", frozenPeak, { peak: livePeak, current })]);
      expect(book.pastPeakCount).toBe(expected ? 1 : 0);
    });

    it("ranks by the corrected flag, then live deviation, then identity", () => {
      const falseFlag = peakRow("alusd", -380, { peak: -825, current: -425 });
      const realFlag = peakRow("usda", -800, { peak: -300, current: -350 });
      const wider = peakRow("wide", -100, { peak: -2_000, current: -1_500 });
      const tieA = peakRow("tie-a", -100, { peak: -2_000, current: -500 });
      const tieB = peakRow("tie-b", -100, { peak: -2_000, current: -500 });
      const order = [tieB, falseFlag, wider, tieA, realFlag].sort(compareResolverUrgency).map((r) => r.stablecoinId);
      expect(order).toEqual(["usda", "wide", "tie-a", "tie-b", "alusd"]);
    });

    it("captions the count as a new worst, never as past their worst", () => {
      render(<DepegResolverModule data={response({ rows: [
        peakRow("a", -300, { peak: -400, current: -900 }),
        peakRow("b", -300, { peak: -400, current: -900 }),
      ] })} />);
      expect(screen.getByText(/2 at a new worst/)).toBeTruthy();
      expect(screen.queryByText(/past their worst/)).toBeNull();
    });

    it("leaves the locked frozen peak in the payload untouched", () => {
      const r = peakRow("a", -380, { peak: -825, current: -425 });
      summarizeResolverBook([r]);
      expect(r.kind === "prediction" ? r.frozen.sourceRow.peakDeviationBps : null).toBe(-380);
    });
  });

  describe("calibration lineage caption", () => {
    const lineage = (incidentCount: number, coinCount: number) => ({
      trainingWindow: { start: 1, end: 2 }, eventCount: 99_999, incidentCount, coinCount, quarantinedCoins: 0,
    });

    it.each([[8_466, 41, "8,466"], [0, 0, "0"]] as const)("states %s producer historical incidents", (incidents, coins, shown) => {
      // One visible row: the count comes from lineage, never from visible forecasts.
      render(<DepegResolverModule data={response({ _meta: { ...meta, lineage: lineage(incidents, coins) }, rows: [row] })} />);
      const caption = screen.getByText(/^Calibrated on/);
      expect(caption.textContent).toBe(`Calibrated on ${shown} historical incidents · ${coins} coins`);
      expect(screen.queryByText(/recovered\s+incidents/)).toBeNull();
    });

    it("omits the caption without lineage", () => {
      render(<DepegResolverModule data={response({ rows: [row] })} />);
      expect(screen.queryByText(/^Calibrated on/)).toBeNull();
    });
  });

  it("does not claim there are no active depegs before data loads", () => {
    render(<DepegResolverModule data={undefined} />);

    expect(screen.getByText("Resolver data is loading.")).toBeTruthy();
    expect(screen.queryByText(/No active confirmed depegs/)).toBeNull();
  });

  it("shows unavailable copy for degraded empty snapshots", () => {
    render(
      <DepegResolverModule data={response({ _meta: { ...meta, degraded: true, degradedReason: "missing-cache" } })} />,
    );

    expect(screen.getByText("Resolver data is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No active confirmed depegs/)).toBeNull();
  });

  it("keeps empty stale snapshots unavailable rather than claiming no depegs", () => {
    render(<DepegResolverModule data={response({ _meta: { ...meta, degraded: true, degradedReason: "stale-cache" } })} />);
    expect(screen.getByText("Resolver data is temporarily unavailable.")).toBeTruthy();
    expect(screen.queryByText(/No active confirmed depegs|Whole book/)).toBeNull();
  });

  it("preserves the observed empty state for a healthy snapshot", () => {
    render(<DepegResolverModule data={response()} />);
    expect(screen.getByText("No active confirmed depegs.")).toBeTruthy();
    expect(screen.queryByText("Resolver data is temporarily unavailable.")).toBeNull();
  });

  it("retains the whole-book summary for a stale-cache frozen forecast without a private stale notice", () => {
    render(<DepegResolverModule data={response({
      _meta: { ...meta, degraded: true, degradedReason: "stale-cache" }, rows: [row],
    })} />);
    expect(screen.getByText(/Whole book/).textContent).toContain("1 forecast across 1 incident rows");
    // Age admission belongs to the route's shared freshness notice (ADR-42).
    expect(screen.queryByText(/live overlay is stale/i)).toBeNull();
    expect(screen.getByText("Stress signals")).toBeTruthy();
  });

  it.each(["unknown-failure"])(
    "withholds whole-book claims when retained forecasts are unavailable because of %s",
    (degradedReason) => {
      render(<DepegResolverModule data={response({
        _meta: { ...meta, degraded: true, degradedReason },
        rows: [row],
      })} />);

      expect(screen.getByText("Resolver data is temporarily unavailable.")).toBeTruthy();
      expect(screen.queryByText(/Whole book/)).toBeNull();
      expect(screen.queryByText(/showing all|most urgent/)).toBeNull();
      expect(screen.queryByText("Stress signals")).toBeNull();
    },
  );

  it("states the terminal recovery outlook clearly for a pre-v5 lock in its published vocabulary", () => {
    const terminalRow = lockedUnder("4.3", makePredictionRow(
      makeSourceRow({
        resolution: {
          tier: "recovery_unlikely",
          factors: [],
        },
        duration: {
          suppressed: true,
          suppressedReason: "verdict_terminal",
          stratum: null,
          medianSec: null,
          iqrSec: null,
          ageStatus: null,
          horizons: [],
        },
      }),
    ));
    render(
      <DepegResolverModule
        data={response({
          rows: [terminalRow],
        })}
      />,
    );

    expect(screen.getByText("Recovery unlikely")).toBeTruthy();
    expect(screen.queryByText("Terminal evidence")).toBeNull();
    expect(screen.getByText("DDR does not expect this depeg to recover.")).toBeTruthy();
    expect(
      screen.getByText("Comparable structural failures did not return to peg, so no duration estimate is shown."),
    ).toBeTruthy();
    expect(screen.queryByText(/Duration not estimated/)).toBeNull();
  });

  it("labels a v5 terminal call as terminal evidence without claiming it will not recover", () => {
    const terminalRow = makePredictionRow(
      makeSourceRow({
        resolution: { tier: "recovery_unlikely", factors: [] },
        duration: {
          suppressed: true,
          suppressedReason: "verdict_terminal",
          stratum: null,
          medianSec: null,
          iqrSec: null,
          ageStatus: null,
          horizons: [],
          estimand: "cumulative_incidence",
          unresolvedShare30d: null,
        },
      }),
    );
    render(<DepegResolverModule data={response({ rows: [terminalRow] })} />);

    expect(screen.getByText("Terminal evidence")).toBeTruthy();
    expect(screen.getByText("Terminal evidence fired for this break.")).toBeTruthy();
    expect(screen.getByText(/Hard evidence that this break may not recover/)).toBeTruthy();
    expect(screen.queryByText("DDR does not expect this depeg to recover.")).toBeNull();
    expect(screen.getByRole("img", { name: /verdict Terminal evidence; may not recover/ })).toBeTruthy();
  });

  it.each([
    ["5.0", "Stress signals", "At risk"],
    ["4.3", "At risk", "Stress signals"],
    [null, "At risk", "Stress signals"],
  ] as const)("labels a lock under methodology %s with its own tier vocabulary", (version, shown, hidden) => {
    render(<DepegResolverModule data={response({ rows: [lockedUnder(version, row)] })} />);
    expect(screen.getByText(shown)).toBeTruthy();
    expect(screen.queryByText(hidden)).toBeNull();
    // Only evidence classes lead with the base-rate blurb; legacy cards render as before.
    expect(Boolean(screen.queryByText(/most comparable breaks still recovered/))).toBe(version === "5.0");
  });

  it("leads a v5 duration with horizon odds and keeps unreached quantiles absent", () => {
    const horizon = (h: "6h" | "24h" | "7d" | "30d", state: "benchmarked" | "not_informative", probability: number | null) => ({
      horizon: h, state, probability, probabilityDisplay: null, probabilityInterval: null,
      rawAtRisk: 10, uniqueCoins: 8, intervalClosures: 4, intervalNonClosures: 6,
    });
    const v5Row = makePredictionRow(makeSourceRow({
      duration: {
        suppressed: false,
        suppressedReason: null,
        stratum: "below · deep · USD",
        medianSec: null,
        iqrSec: null,
        ageStatus: "ordinary",
        horizons: [
          horizon("6h", "not_informative", 0.12),
          horizon("24h", "benchmarked", 0.31),
          horizon("7d", "benchmarked", 0.42),
          horizon("30d", "benchmarked", 0.47),
        ],
        estimand: "cumulative_incidence",
        unresolvedShare30d: 0.53,
      },
    }));
    render(<DepegResolverModule data={response({ rows: [v5Row] })} />);

    expect(screen.getByText("31%")).toBeTruthy();
    expect(screen.queryByText("12%")).toBeNull();
    expect(screen.getByText("6h odds: Not informative at this age")).toBeTruthy();
    expect(screen.getByText("~55%").parentElement?.textContent).toBe("~55% may not resolve within 30 days");
    expect(screen.queryByText(/Half of comparable incidents/)).toBeNull();
    expect(screen.queryByText(/Typical range|typical range/)).toBeNull();
    expect(screen.queryByText("anchored duration")).toBeNull();
  });

  it("shows a reached v5 median as a coarse secondary readout", () => {
    const v5Row = makePredictionRow(makeSourceRow({
      duration: {
        suppressed: false,
        suppressedReason: null,
        stratum: null,
        medianSec: 3 * 86_400 + 5 * 3600,
        iqrSec: [5 * 3600 + 1200, 9 * 86_400],
        ageStatus: "ordinary",
        horizons: [],
        estimand: "cumulative_incidence",
        unresolvedShare30d: 0.02,
      },
    }));
    render(<DepegResolverModule data={response({ rows: [v5Row] })} />);

    expect(screen.getByText(/Half of comparable incidents recovered within/).textContent).toBe(
      "Half of comparable incidents recovered within ~3d",
    );
    expect(screen.getByText("5h–9d")).toBeTruthy();
    expect(screen.getByText("<5%")).toBeTruthy();
    expect(screen.getByText("~3d (5h-9d)")).toBeTruthy();
    expect(screen.getByRole("img", { name: /half of comparable incidents recovered within about 3d after lock/ })).toBeTruthy();
  });

  it("does not render verdict or duration for pending, deferred, and retry-pending v2 rows", () => {
    const { rerender } = render(
      <DepegResolverModule
        data={response({
          rows: [makePendingRow("pending_lock")],
        })}
      />,
    );

    expect(screen.getByText("Prediction lock pending")).toBeTruthy();
    expect(screen.queryByText("Stress signals")).toBeNull();
    expect(screen.queryByText(/~resolve/)).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [makePendingRow("lock_deferred", { deferralReason: "stablecoins cache stale" })],
        })}
      />,
    );
    expect(screen.getByText("Health deferral")).toBeTruthy();
    expect(screen.getByText("Deferral reason: stablecoins cache stale")).toBeTruthy();
    expect(screen.queryByText("Stress signals")).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [makePendingRow("publication_retry_pending")],
        })}
      />,
    );
    expect(screen.getByText("Forecast publication delayed")).toBeTruthy();
    expect(screen.queryByText("Stress signals")).toBeNull();
  });

  it("shows frozen prediction lock metadata separately from live status", () => {
    const sourceRow = makeSourceRow({
      ageSec: 86_400,
      currentDeviationBps: -250,
      duration: {
        suppressed: false,
        suppressedReason: null,
        stratum: "below · moderate · USD",
        medianSec: 7200,
        iqrSec: [3600, 10_800],
        ageStatus: "ordinary",
        horizons: [],
      },
    });
    render(
      <DepegResolverModule
        data={response({
          rows: [
            makePredictionRow(sourceRow, {
              ageSec: 90_000,
              peakDeviationBps: -320,
              currentDeviationBps: -180,
              updatedAt: 90_000,
            }),
          ],
        })}
      />,
    );

    // The chip renders twice (mobile Sheet trigger + desktop Popover trigger).
    expect(screen.getAllByText("Prediction frozen").length).toBeGreaterThan(0);
    expect(screen.getByText("anchored duration")).toBeTruthy();
    expect(screen.getByText("~2h (1h-3h)")).toBeTruthy();
    expect(screen.getByRole("img", { name: /lock deviation -250 bps/i })).toBeTruthy();
    expect(screen.getByText("From lock")).toBeTruthy();
    expect(screen.getByText("98.20% of peg")).toBeTruthy();
    expect(screen.queryByText("97.50% of peg")).toBeNull();
    // Live overlay deviation (-180) renders in the Live incident strip, distinct from the frozen lock-side value.
    expect(screen.getByText("-180 bps")).toBeTruthy();
    expect(screen.queryByText("Projected")).toBeNull();
    expect(screen.getByText("Live incident")).toBeTruthy();
    expect(screen.getByText("on time")).toBeTruthy();
  });

  it("renders no-call and invalidated v2 rows as accountability states", () => {
    const { rerender } = render(
      <DepegResolverModule
        data={response({
          rows: [makeNoCallRow()],
        })}
      />,
    );

    expect(screen.getByText("No-call at lock")).toBeTruthy();
    expect(screen.getByText("no usable live price")).toBeTruthy();
    expect(screen.queryByText("DDR does not expect this depeg to recover.")).toBeNull();

    rerender(
      <DepegResolverModule
        data={response({
          rows: [makeInvalidatedRow()],
        })}
      />,
    );

    expect(screen.getByText("Prediction invalidated by erratum")).toBeTruthy();
    expect(screen.getByText("Erratum and original outcome")).toBeTruthy();
  });

  it("labels an invalidated no-call from its authoritative original kind", () => {
    render(
      <DepegResolverModule
        data={response({
          rows: [makeInvalidatedRow("no_call")],
        })}
      />,
    );

    expect(screen.getByText("no-call")).toBeTruthy();
    expect(screen.queryByText("published prediction")).toBeNull();
  });

});

describe("StablecoinDepegResolverRows", () => {
  it("stays hidden when the DDR snapshot has no row for the current stablecoin", () => {
    render(<StablecoinDepegResolverRows stablecoinId="usdc-circle" data={response({ rows: [row] })} />);

    expect(screen.queryByText("Stress signals")).toBeNull();
    expect(screen.queryByLabelText(/Depeg Duration Resolver/)).toBeNull();
  });

  it.each(["resolver list", "stablecoin detail"] as const)(
    "retains the frozen duration over a stale-cache overlay without a private notice on the %s surface",
    (surface) => {
      const sourceRow = makeSourceRow({
        duration: {
          suppressed: false,
          suppressedReason: null,
          stratum: "below · moderate · USD",
          medianSec: 7200,
          iqrSec: [3600, 10_800],
          ageStatus: "ordinary",
          horizons: [],
        },
      });
      const predictionRow = makePredictionRow(sourceRow, { stale: true, degradedReason: "stale-cache" });
      const data = response({
        _meta: { ...meta, degraded: true, degradedReason: "stale-cache" },
        rows: [predictionRow],
      });
      render(surface === "resolver list"
        ? <DepegResolverModule data={data} />
        : <StablecoinDepegResolverRows stablecoinId="lusd-liquity" data={data} />);

      expect(screen.queryByText(/live overlay is stale/i)).toBeNull();
      expect(screen.queryByText(/Live overlay:/)).toBeNull();
      expect(screen.getByText("anchored duration")).toBeTruthy();
      expect(screen.getByText("~2h (1h-3h)")).toBeTruthy();
      expect(screen.queryByText(/duration estimates are suppressed/i)).toBeNull();
    },
  );

  it.each([
    "stale-cache",
    "errata-overlay-read-failed",
    "lock-deferral-overlay-read-failed",
    "manifest-fallback:missing-cache",
  ])("keeps the infrastructure reason %s out of the live-incident caption", (degradedReason) => {
    render(<StablecoinDepegResolverRows
      stablecoinId="lusd-liquity"
      data={response({ rows: [makePredictionRow(makeSourceRow(), { degradedReason })] })}
    />);
    expect(screen.getByText("Live incident")).toBeTruthy();
    expect(screen.queryByText(/Live overlay:/)).toBeNull();
  });

  it.each([
    ["duration-exceeded", "Live overlay: past its forecast window."],
    ["closed-pending-review", "Live overlay: closed, pending review."],
    ["lock-deferred", "Live overlay: lock deferred."],
  ])("keeps the incident reason %s in the live-incident caption", (degradedReason, caption) => {
    render(<StablecoinDepegResolverRows
      stablecoinId="lusd-liquity"
      data={response({ rows: [makePredictionRow(makeSourceRow(), { degradedReason })] })}
    />);
    expect(screen.getByText(caption)).toBeTruthy();
  });

  it("stays hidden for degraded snapshots whose reason is not stale-cache", () => {
    render(
      <StablecoinDepegResolverRows
        stablecoinId="lusd-liquity"
        data={response({ _meta: { ...meta, degraded: true, degradedReason: "missing-cache" }, rows: [row] })}
      />,
    );

    expect(screen.queryByLabelText(/Depeg Duration Resolver/)).toBeNull();
    expect(screen.queryByText("Stress signals")).toBeNull();
    expect(screen.queryByText(/Resolver snapshot is stale/)).toBeNull();
  });

  it("renders only the row matching the requested stablecoin when others are present", () => {
    const other = makePredictionRow(makeSourceRow({ stablecoinId: "usdc-circle", symbol: "USDC", eventId: 2 }));
    render(<StablecoinDepegResolverRows stablecoinId="lusd-liquity" data={response({ rows: [other, row] })} />);

    expect(screen.getAllByLabelText(/Depeg Duration Resolver for /)).toHaveLength(1);
    expect(screen.getByLabelText("Depeg Duration Resolver for LUSD")).toBeTruthy();
    expect(screen.queryByText("USDC")).toBeNull();
  });
});

