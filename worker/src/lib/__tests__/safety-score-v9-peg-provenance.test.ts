import { computePegScore } from "@shared/lib/peg-score";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { DepegEvent } from "@shared/types/peg";
import type { DepegAuditVerdict } from "@shared/types/depeg-audit";
import { isPegScoreExcludedAuditVerdict } from "@shared/lib/depeg-audit";
import { describe, expect, it } from "vitest";
import { normalizeFixedInput } from "../safety-score-v9/report-cards-fixed-input";
import { buildReportCardsFixedInputCacheEntry, createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  buildSafetyScoreV9PegProvenanceSummary,
  captureSafetyScoreV9PegProvenanceById,
  parseSafetyScoreV9PegProvenanceSeed,
  projectSafetyScoreV9PegScoreResult,
  SafetyScoreV9PegProvenanceSummarySchema,
} from "../safety-score-v9/peg-provenance";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import {
  event,
  legacyEvents,
  pegSummary as buildPegSummary,
  replayProvenance as identityReplayProvenance,
  replayProvenance as buildReplayProvenance,
} from "./safety-score-v9-peg-provenance.test-support";

const DAY_SEC = 86_400;
const CLOCK_SEC = 1_784_869_388;
const TRACKING_START_SEC = 1_730_419_200;
const ASSET_ID = "usdg-paxos";

const replayProvenance = (confidence: "high" | "medium" | "low", providers?: string[]) =>
  buildReplayProvenance(CLOCK_SEC, confidence, providers);

function auditProvenance(
  auditVerdict: DepegAuditVerdict,
  confidenceTier: "high" | "medium" | "low",
): NonNullable<DepegEvent["provenance"]> {
  return {
    confidenceTier,
    auditVerdict,
    pegScoreEligible: !isPegScoreExcludedAuditVerdict(auditVerdict),
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
  it("projects summary and score results to identical narrow bytes", () => {
    const summary = pegSummary(USDG_LEGACY_EVENTS);
    const result = computePegScore(USDG_LEGACY_EVENTS, TRACKING_START_SEC, CLOCK_SEC);
    const projected = projectSafetyScoreV9PegScoreResult(summary);
    expect(JSON.stringify(projected)).toBe(JSON.stringify(projectSafetyScoreV9PegScoreResult(result)));
    expect(Object.keys(projected)).toHaveLength(9);
    expect(projected).not.toHaveProperty("id");
    expect(projected).not.toHaveProperty("scoredEventCount");
  });

  it("keeps the USDG-shaped legacy-inclusive score unchanged and isolates the backfill-excluded scenario", () => {
    const before = structuredClone(USDG_LEGACY_EVENTS);
    const summary = build(USDG_LEGACY_EVENTS);

    expect(summary.legacyInclusive).toMatchObject({
      disposition: "score-preserving",
      result: {
        pegScore: 97,
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

  it("accepts the erratum's verdict-only quarantine of a live event as audit-excluded", () => {
    // docs/runbooks/depeg-artifact-removal.md: the input-corruption erratum
    // records only an excluding audit verdict on a live event that had no
    // replay provenance (production 2026-10-30, CEUR 90775 and three others).
    const quarantined = event({
      id: 51,
      startedAt: CLOCK_SEC - 10 * DAY_SEC,
      peakDeviationBps: -900,
      source: "live",
      // The production public provenance JSON of the quarantined rows.
      provenance: JSON.parse('{"auditVerdict":"disputed"}') as NonNullable<DepegEvent["provenance"]>,
    });
    const dated = event({
      id: 53,
      startedAt: CLOCK_SEC - 9 * DAY_SEC,
      peakDeviationBps: -700,
      source: "live",
      provenance: { sourceKind: "live", auditVerdict: "disputed", updatedAt: CLOCK_SEC - DAY_SEC },
    });

    const summary = build([quarantined, dated]);

    expect(summary.classes["audit-excluded"].eventCount).toBe(2);
    expect(summary.legacyInclusive.result.scoredEventCount).toBe(0);
  });

  it("still rejects a verdict-only quarantine dated after the scoring clock", () => {
    const future = event({
      id: 54,
      startedAt: CLOCK_SEC - 9 * DAY_SEC,
      peakDeviationBps: -700,
      source: "live",
      provenance: { auditVerdict: "disputed", updatedAt: CLOCK_SEC + 1 },
    });

    expect(() => build([future])).toThrow(/partial provenance/);
  });

  it.each([
    { label: "a non-excluding verdict", source: "live" as const, auditVerdict: "confirmed" as const },
    { label: "a backfill event", source: "backfill" as const, auditVerdict: "disputed" as const },
  ])("still rejects verdict-only provenance on $label", ({ source, auditVerdict }) => {
    const partial = event({
      id: 52,
      startedAt: CLOCK_SEC - 10 * DAY_SEC,
      peakDeviationBps: -900,
      source,
      provenance: { sourceKind: source, auditVerdict, updatedAt: CLOCK_SEC - DAY_SEC },
    });

    expect(() => build([partial])).toThrow(/partial provenance/);
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
      legacyInclusive: { result: { pegScore: 97 } },
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
      expected: { ...expected, pegPct: expected.pegPct! - 0.01 },
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

const DIGEST = "a".repeat(64);

// Match the production peg-analytics query's newest-first accumulation order.
const publicationEvents = () => legacyEvents().sort((left, right) => right.startedAt - left.startedAt);

const identityPegSummary = (events: readonly DepegEvent[], clockSec: number) =>
  buildPegSummary(events, clockSec, TRACKING_START_SEC, "peg-score:identity-fixture-v1");

function selected<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const value = record[ASSET_ID];
  return value === undefined ? {} : { [ASSET_ID]: value };
}

function selectedTemplate() {
  const full = createSafetyScoreV9FullRegistryInput();
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds: [ASSET_ID],
    capturedAt: full.capturedAt,
    sourceGeneration: full.sourceGeneration,
    dexGenerationId: full.dexGenerationId,
    redemptionGenerationId: full.redemptionGenerationId,
    registryRevision: full.registryRevision,
    methodologyVersion: full.methodologyVersion,
    clockSec: full.clockSec,
    updatedAt: full.updatedAt,
    liquidityStale: full.liquidityStale,
    redemptionStale: full.redemptionStale,
    inputFreshness: full.inputFreshness,
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: selected(full.dexLiqMap),
    redemptionBackstopMap: selected(full.redemptionBackstopMap),
    bluechipMap: selected(full.bluechipMap),
    resolvedBlacklistStatuses: selected(full.resolvedBlacklistStatuses),
    liveReserveMap: selected(full.liveReserveMap),
    liveReserveProvenanceMap: selected(full.liveReserveProvenanceMap),
    chainCirculatingById: selected(full.chainCirculatingById),
    aggregateCirculatingById: selected(full.aggregateCirculatingById),
    dexDeploymentSupplyCoverageById: selected(
      full.dexDeploymentSupplyCoverageById,
    ),
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

const SINGLE_ASSET_TEMPLATE = selectedTemplate();

function singleAssetFixedInput(events: readonly DepegEvent[]) {
  const { baseInputGenerationId: _baseInputGenerationId, ...draft } = structuredClone(SINGLE_ASSET_TEMPLATE);
  return createReportCardsFixedInput({
    ...draft,
    pegDataById: { [ASSET_ID]: identityPegSummary(events, draft.clockSec) },
  });
}

function summary(
  events: readonly DepegEvent[],
  fixedInput: ReturnType<typeof singleAssetFixedInput>,
) {
  return buildSafetyScoreV9PegProvenanceSummary({
    assetId: ASSET_ID,
    events,
    trackingStartSec: TRACKING_START_SEC,
    clockSec: fixedInput.clockSec,
    expectedLegacyInclusive: projectSafetyScoreV9PegScoreResult(
      computePegScore([...events], TRACKING_START_SEC, fixedInput.clockSec),
    ),
  });
}

function withOneVerifiedReplay(
  events: readonly DepegEvent[],
  clockSec: number,
): DepegEvent[] {
  return events.map((event, index) =>
    index === 0
      ? {
          ...event,
          provenance: {
            ...identityReplayProvenance(clockSec, "high"),
            replayRunId: "replay:identity-fixture",
            updatedAt: clockSec - 1,
          },
        }
      : event,
  );
}

describe("diagnostic V9 peg provenance identity boundary", () => {
  it.each(["protocol-par", "protocol-redeem"])(
    "rejects nominal replay provenance without reclassifying legacy redemption: %s",
    (source) => {
      const events = publicationEvents();
      const fixedInput = singleAssetFixedInput(events);
      const verified = withOneVerifiedReplay(events, fixedInput.clockSec);
      verified[0]!.provenance!.sourcePriceProviders = [source];
      if (source === "protocol-par") {
        expect(() => summary(verified, fixedInput)).toThrow("non-observed price provenance");
      } else {
        expect(summary(verified, fixedInput).classes["provenance-high"].eventCount).toBe(1);
      }
    },
  );
  it("round-trips a compact publication-exact provenance seed and rejects tampering", () => {
    const events = publicationEvents();
    const fixedInput = singleAssetFixedInput(events);
    const pegProvenanceById = {
      [ASSET_ID]: summary(events, fixedInput),
    };
    const safetyScoreIdentity = {
      model: "v9-input" as const,
      schemaVersion: 1 as const,
      methodologyVersion: fixedInput.methodologyVersion,
      evaluationBuildDigest: DIGEST,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: fixedInput.sourceGeneration,
    };
    const entry =
      buildSafetyScoreV9PegProvenanceSeedCacheEntry({
        sourceGeneration: fixedInput.sourceGeneration,
        clockSec: fixedInput.clockSec,
        safetyScoreIdentity,
        pegProvenanceById,
      });

    expect(entry.key).toBe(
      "report-cards:v9-peg-provenance-seed:exact",
    );
    expect(
      parseSafetyScoreV9PegProvenanceSeed(entry.value),
    ).toMatchObject({
      sourceGeneration: fixedInput.sourceGeneration,
      clockSec: fixedInput.clockSec,
      safetyScoreIdentity,
      pegProvenanceById,
    });

    const tampered = JSON.parse(entry.value);
    tampered.clockSec += 1;
    expect(() =>
      parseSafetyScoreV9PegProvenanceSeed(
        JSON.stringify(tampered),
      ),
    ).toThrow(/seed digest|summary clock/);
  });

  it("changes USDG diagnostics without changing score or candidate bytes", async () => {
    const events = publicationEvents();
    const base = singleAssetFixedInput(events);
    const legacySummary = summary(events, base);
    const verifiedEvents = withOneVerifiedReplay(events, base.clockSec);
    const verifiedSummary = summary(verifiedEvents, base);
    const legacyDiagnostic = normalizeFixedInput({
      ...base,
      pegProvenanceById: { [ASSET_ID]: legacySummary },
    });
    const verifiedDiagnostic = normalizeFixedInput({
      ...base,
      pegProvenanceById: { [ASSET_ID]: verifiedSummary },
    });

    expect(legacySummary.legacyInclusive.result.pegScore).toBe(97);
    expect(verifiedSummary.legacyInclusive.result).toEqual(
      legacySummary.legacyInclusive.result,
    );
    expect(legacySummary.classes["legacy-backfill-unprovenanced"].eventCount).toBe(13);
    expect(verifiedSummary.classes["legacy-backfill-unprovenanced"].eventCount).toBe(12);
    expect(verifiedSummary.classes["provenance-high"].eventCount).toBe(1);
    expect(verifiedSummary.contentSha256).not.toBe(legacySummary.contentSha256);
    expect(legacyDiagnostic.baseInputGenerationId).toBe(base.baseInputGenerationId);
    expect(verifiedDiagnostic.baseInputGenerationId).toBe(base.baseInputGenerationId);

    const publishedAtSec = base.clockSec + 1;
    const pipelines = [base, legacyDiagnostic, verifiedDiagnostic].map(
      (fixedInput) =>
        buildSafetyScoreV9Candidate({
          fixedInput,
          extension: buildSafetyScoreV9BaselineExtension(fixedInput),
          publishedAtSec,
        }),
    );
    const [basePipeline, legacyPipeline, verifiedPipeline] = pipelines;
    expect(legacyPipeline.compiledFacts.v9FactSetDigest).toBe(
      basePipeline.compiledFacts.v9FactSetDigest,
    );
    expect(verifiedPipeline.evaluatedSet.scoreResultDigest).toBe(
      basePipeline.evaluatedSet.scoreResultDigest,
    );
    expect(legacyPipeline.candidate.factSetDigest).toBe(
      basePipeline.candidate.factSetDigest,
    );
    expect(verifiedPipeline.candidate.resultDigest).toBe(
      basePipeline.candidate.resultDigest,
    );
    expect(stableJsonStringifyV1(legacyPipeline.candidate)).toBe(
      stableJsonStringifyV1(basePipeline.candidate),
    );
    expect(stableJsonStringifyV1(verifiedPipeline.candidate)).toBe(
      stableJsonStringifyV1(basePipeline.candidate),
    );

    const identity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: base.methodologyVersion,
      evaluationBuildDigest: DIGEST,
      baseInputGenerationId: base.baseInputGenerationId,
      publicationGenerationId: base.sourceGeneration,
    };
    const [baseV8, legacyV8, verifiedV8] =
      await Promise.all([
        buildReportCardsFixedInputCacheEntry(base, identity),
        buildReportCardsFixedInputCacheEntry(legacyDiagnostic, identity),
        buildReportCardsFixedInputCacheEntry(verifiedDiagnostic, identity),
      ]);
    expect(legacyV8.value).toBe(baseV8.value);
    expect(verifiedV8.value).toBe(baseV8.value);
  });

  it("rejects raw events and tampered summaries at normalization", () => {
    const events = publicationEvents();
    const base = singleAssetFixedInput(events);
    const diagnostic = summary(events, base);

    expect(() =>
      normalizeFixedInput({
        ...base,
        pegProvenanceById: {
          [ASSET_ID]: { ...diagnostic, rawEvents: events },
        },
      }),
    ).toThrow();
    expect(() =>
      normalizeFixedInput({
        ...base,
        pegProvenanceById: {
          [ASSET_ID]: {
            ...diagnostic,
            legacyInclusive: {
              ...diagnostic.legacyInclusive,
              result: {
                ...diagnostic.legacyInclusive.result,
                pegScore: 85,
              },
            },
          },
        },
      }),
    ).toThrow(/summary digest does not match|score does not match/);
  });
});
