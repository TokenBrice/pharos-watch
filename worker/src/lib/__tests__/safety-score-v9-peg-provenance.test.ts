import { computePegScore } from "@shared/lib/peg-score";
import type { DepegEvent } from "@shared/types/market";
import { describe, expect, it } from "vitest";
import {
  buildSafetyScoreV9PegProvenanceSummary,
  captureSafetyScoreV9PegProvenanceById,
  projectSafetyScoreV9PegScoreResult,
  SafetyScoreV9PegProvenanceSummarySchema,
} from "../safety-score-v9/peg-provenance";
import { event, legacyEvents, pegSummary as buildPegSummary, replayProvenance as buildReplayProvenance } from "./safety-score-v9-peg-provenance.test-support";

const DAY_SEC = 86_400;
const CLOCK_SEC = 1_784_869_388;
const TRACKING_START_SEC = 1_730_419_200;
const ASSET_ID = "usdg-paxos";

const replayProvenance = (confidence: "high" | "medium" | "low", providers?: string[]) =>
  buildReplayProvenance(CLOCK_SEC, confidence, providers);

function auditProvenance(
  auditVerdict: "confirmed" | "disputed" | "false_positive" | "no_data" | "repaired",
  confidenceTier: "high" | "medium" | "low",
): NonNullable<DepegEvent["provenance"]> {
  return {
    confidenceTier,
    auditVerdict,
    pegScoreEligible: auditVerdict !== "false_positive" && auditVerdict !== "disputed",
    updatedAt: CLOCK_SEC - DAY_SEC,
  };
}

function expectedFor(
  events: readonly DepegEvent[],
  trackingStartSec: number | null = TRACKING_START_SEC,
) {
  return projectSafetyScoreV9PegScoreResult(
    computePegScore([...events], trackingStartSec, CLOCK_SEC),
  );
}

const pegSummary = (events: readonly DepegEvent[]) =>
  buildPegSummary(events, CLOCK_SEC, TRACKING_START_SEC, "6.098");

function build(
  events: readonly DepegEvent[],
  options: {
    assetId?: string;
    trackingStartSec?: number | null;
    expected?: ReturnType<typeof expectedFor>;
  } = {},
) {
  const trackingStartSec =
    options.trackingStartSec === undefined
      ? TRACKING_START_SEC
      : options.trackingStartSec;
  return buildSafetyScoreV9PegProvenanceSummary({
    assetId: options.assetId ?? ASSET_ID,
    events,
    trackingStartSec,
    clockSec: CLOCK_SEC,
    expectedLegacyInclusive:
      options.expected ?? expectedFor(events, trackingStartSec),
  });
}

const USDG_LEGACY_EVENTS = legacyEvents();

describe("Safety Score V9 peg provenance", () => {
  it("keeps the USDG-shaped legacy-inclusive score unchanged and isolates the upper-bound diagnostic", () => {
    const before = structuredClone(USDG_LEGACY_EVENTS);
    const summary = build(USDG_LEGACY_EVENTS);

    expect(summary.legacyInclusive).toMatchObject({
      disposition: "score-preserving",
      result: {
        pegScore: 84,
        eventCount: 13,
        scoredEventCount: 13,
        worstDeviationBps: 6544,
      },
    });
    expect(summary.classes["legacy-backfill-unprovenanced"]).toEqual({
      eventCount: 13,
      worstDeviationBps: 6544,
      latestEventAtSec: 1740769483,
    });
    expect(summary.hasUnprovenancedLegacyBackfill).toBe(true);
    expect(summary.verifiedOnlyDiagnostic).toMatchObject({
      disposition: "diagnostic-only",
      result: { pegScore: 100, eventCount: 0 },
    });
    expect(summary.eventSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(USDG_LEGACY_EVENTS).toEqual(before);
  });

  it("classifies every evidence class and omits only legacy backfill from the diagnostic", () => {
    const baseStart = CLOCK_SEC - 30 * DAY_SEC;
    const events = [
      event({ id: 1, startedAt: baseStart, peakDeviationBps: -200, provenance: replayProvenance("high") }),
      event({ id: 2, startedAt: baseStart + DAY_SEC, peakDeviationBps: 300, provenance: replayProvenance("medium") }),
      event({ id: 3, startedAt: baseStart + 2 * DAY_SEC, peakDeviationBps: -400, provenance: replayProvenance("low") }),
      event({ id: 4, startedAt: baseStart + 3 * DAY_SEC, peakDeviationBps: 500 }),
      event({
        id: 5,
        startedAt: baseStart + 4 * DAY_SEC,
        peakDeviationBps: -600,
        source: "live",
        confirmationSources: "temporal:15m+defillama-confirm",
      }),
      event({
        id: 6,
        startedAt: baseStart + 5 * DAY_SEC,
        peakDeviationBps: 700,
        source: "live",
      }),
      event({
        id: 7,
        startedAt: baseStart + 6 * DAY_SEC,
        peakDeviationBps: -800,
        source: "live",
        provenance: auditProvenance("false_positive", "medium"),
      }),
    ];

    const summary = build(events);

    expect(Object.fromEntries(
      Object.entries(summary.classes).map(([key, value]) => [key, value.eventCount]),
    )).toEqual({
      "provenance-high": 1,
      "provenance-medium": 1,
      "provenance-low": 1,
      "legacy-backfill-unprovenanced": 1,
      "live-confirmed": 1,
      "legacy-live-unprovenanced": 1,
      "audit-excluded": 1,
    });
    expect(summary.legacyInclusive.result.eventCount).toBe(7);
    expect(summary.legacyInclusive.result.scoredEventCount).toBe(6);
    expect(summary.verifiedOnlyDiagnostic.result.eventCount).toBe(6);
    expect(summary.verifiedOnlyDiagnostic.result.scoredEventCount).toBe(5);
    expect(summary.verifiedOnlyDiagnostic.omittedClasses).toEqual([
      "legacy-backfill-unprovenanced",
    ]);
  });

  it("canonicalizes event and provider ordering while content-binding material changes", () => {
    const first = event({
      id: 11,
      startedAt: CLOCK_SEC - 20 * DAY_SEC,
      peakDeviationBps: -250,
      provenance: replayProvenance("medium", ["provider-b", "provider-a"]),
    });
    const second = event({
      id: 12,
      startedAt: CLOCK_SEC - 10 * DAY_SEC,
      peakDeviationBps: 550,
      source: "live",
      confirmationSources: "temporal:15m",
    });
    const ordered = build([first, second]);
    const shuffled = build([
      second,
      {
        ...first,
        provenance: replayProvenance("medium", ["provider-a", "provider-b"]),
      },
    ]);
    const changedEvents = [{ ...first, peakDeviationBps: -251 }, second];
    const changed = build(changedEvents);

    expect(shuffled).toEqual(ordered);
    expect(changed.eventSetSha256).not.toBe(ordered.eventSetSha256);
    expect(changed.contentSha256).not.toBe(ordered.contentSha256);
  });

  it("uses only events intersecting the fixed-clock score window", () => {
    const beforeCoverage = event({
      id: 21,
      startedAt: TRACKING_START_SEC - 2 * DAY_SEC,
      endedAt: TRACKING_START_SEC,
      peakDeviationBps: -9_000,
    });
    const observed = event({
      id: 22,
      startedAt: TRACKING_START_SEC + DAY_SEC,
      peakDeviationBps: -250,
    });
    const summary = build([beforeCoverage, observed]);
    const observedOnly = build([observed]);

    expect(summary.eventCount).toBe(1);
    expect(summary.eventSetSha256).toBe(observedOnly.eventSetSha256);
    expect(summary.contentSha256).toBe(observedOnly.contentSha256);
    expect(summary.legacyInclusive.result).toEqual(observedOnly.legacyInclusive.result);
  });

  it("binds legacy direction metadata without changing the signed-peak score", () => {
    const inconsistentDirection = event({
      id: 23,
      startedAt: TRACKING_START_SEC + DAY_SEC,
      peakDeviationBps: -250,
      direction: "above",
    });
    const correctedDirection = { ...inconsistentDirection, direction: "below" as const };

    const inconsistent = build([inconsistentDirection]);
    const corrected = build([correctedDirection]);

    expect(inconsistent.legacyInclusive.result).toEqual(corrected.legacyInclusive.result);
    expect(inconsistent.eventSetSha256).not.toBe(corrected.eventSetSha256);
    expect(inconsistent.classes["legacy-backfill-unprovenanced"].eventCount).toBe(1);
  });

  it("captures compact summaries without retaining raw event fields", () => {
    const captured = captureSafetyScoreV9PegProvenanceById(
      {
        clockSec: CLOCK_SEC,
        pegDataById: { [ASSET_ID]: pegSummary(USDG_LEGACY_EVENTS) },
      },
      {
        clockSec: CLOCK_SEC,
        eventsByCoin: new Map([[ASSET_ID, USDG_LEGACY_EVENTS]]),
      },
    );
    const serialized = JSON.stringify(captured);

    expect(captured[ASSET_ID]).toMatchObject({
      assetId: ASSET_ID,
      eventCount: 13,
      legacyInclusive: { result: { pegScore: 84 } },
    });
    expect(serialized).not.toContain('"events"');
    expect(serialized).not.toContain('"startPrice"');
    expect(serialized).not.toContain('"peakPrice"');
    expect(serialized).not.toContain('"recoveryPrice"');
    expect(serialized).not.toContain('"confirmationSources"');
  });

  it("rejects summary tampering and raw-event attachment", () => {
    const summary = build(USDG_LEGACY_EVENTS);

    expect(() => SafetyScoreV9PegProvenanceSummarySchema.parse({
      ...summary,
      legacyInclusive: {
        ...summary.legacyInclusive,
        result: { ...summary.legacyInclusive.result, pegScore: 85 },
      },
    })).toThrow(/summary digest does not match|score projections do not reconcile/);
    expect(() => SafetyScoreV9PegProvenanceSummarySchema.parse({
      ...summary,
      rawEvents: USDG_LEGACY_EVENTS,
    })).toThrow();
    expect(() => captureSafetyScoreV9PegProvenanceById(
      {
        clockSec: CLOCK_SEC,
        pegDataById: { [ASSET_ID]: pegSummary(USDG_LEGACY_EVENTS) },
      },
      {
        clockSec: CLOCK_SEC + 1,
        eventsByCoin: new Map([[ASSET_ID, USDG_LEGACY_EVENTS]]),
      },
    )).toThrow(/source clock does not match/);
  });

  it("fails closed when the recomputed legacy-inclusive summary differs", () => {
    const events = [event({
      id: 31,
      startedAt: CLOCK_SEC - 10 * DAY_SEC,
      peakDeviationBps: -400,
    })];
    const expected = expectedFor(events);

    expect(() => build(events, {
      expected: { ...expected, pegPct: expected.pegPct - 0.01 },
    })).toThrow(/Legacy-inclusive peg summary mismatch.*pegPct/);
  });

  it.each([
    {
      label: "mixed assets",
      mutate: (base: DepegEvent) => ({ ...base, stablecoinId: "other-asset" }),
      error: /Mixed asset event/,
    },
    {
      label: "future event",
      mutate: (base: DepegEvent) => ({
        ...base,
        startedAt: CLOCK_SEC + 1,
        endedAt: CLOCK_SEC + 3_601,
      }),
      error: /later than the scoring clock/,
    },
    {
      label: "partial provenance",
      mutate: (base: DepegEvent) => ({
        ...base,
        provenance: { confidenceTier: "high" },
      }),
      error: /partial provenance/,
    },
    {
      label: "cross-source replay provenance",
      mutate: (base: DepegEvent) => ({
        ...base,
        source: "live" as const,
        provenance: replayProvenance("high"),
      }),
      error: /replay provenance for a non-replay source/,
    },
    {
      label: "contradictory audit eligibility",
      mutate: (base: DepegEvent) => ({
        ...base,
        provenance: {
          ...auditProvenance("false_positive", "medium"),
          pegScoreEligible: true,
        },
      }),
      error: /contradictory peg-score eligibility/,
    },
    {
      label: "future provenance",
      mutate: (base: DepegEvent) => ({
        ...base,
        provenance: {
          ...auditProvenance("confirmed", "high"),
          updatedAt: CLOCK_SEC + 1,
        },
      }),
      error: /future-dated provenance/,
    },
  ])("rejects $label", ({ mutate, error }) => {
    const malformed = mutate(event({
      id: 41,
      startedAt: CLOCK_SEC - 10 * DAY_SEC,
      peakDeviationBps: -400,
    }));

    expect(() => build([malformed])).toThrow(error);
  });

  it("rejects duplicate event identities", () => {
    const duplicate = event({
      id: 51,
      startedAt: CLOCK_SEC - 10 * DAY_SEC,
      peakDeviationBps: -400,
    });

    expect(() => build([duplicate, { ...duplicate }])).toThrow(/Duplicate event ID 51/);
  });
});
