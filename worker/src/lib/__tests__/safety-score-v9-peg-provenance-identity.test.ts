import { computePegScore } from "@shared/lib/peg-score";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { DepegEvent, PegSummaryCoin } from "@shared/types/market";
import { describe, expect, it } from "vitest";
import {
  buildReportCardsFixedInputCacheEntry,
  buildReportCardsSnapshotFromFixedInput,
  createReportCardsFixedInput,
  normalizeFixedInput,
  serializeNormalizedReportCardsReplay,
} from "../report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9-candidate";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  buildSafetyScoreV9PegProvenanceSummary,
  parseSafetyScoreV9PegProvenanceSeed,
  projectSafetyScoreV9PegScoreResult,
} from "../safety-score-v9-peg-provenance";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const ASSET_ID = "usdg-paxos";
const TRACKING_START_SEC = 1_730_419_200;
const DIGEST = "a".repeat(64);

const USDG_LEGACY_ROWS = [
  [26637, 153, 1731330362, 1731333917],
  [26638, 121, 1731348371, 1731351959],
  [26639, 165, 1731557457, 1731560995],
  [26640, -403, 1731902932, 1731906479],
  [26641, 538, 1732195745, 1732213901],
  [26642, 499, 1732705785, 1732709445],
  [26643, 434, 1734026615, 1734037416],
  [26644, 102, 1734609836, 1734613431],
  [26645, 6544, 1738195431, 1738199030],
  [26646, 2961, 1738263698, 1738267293],
  [26647, 480, 1738339433, 1738343312],
  [26648, 435, 1738454574, 1738458185],
  [26649, -680, 1740769483, 1740773147],
] as const;

function legacyEvents(): DepegEvent[] {
  return USDG_LEGACY_ROWS.map(
    ([id, peakDeviationBps, startedAt, endedAt]) => {
      const pegReference = 1;
      const startPrice = pegReference * (1 + peakDeviationBps / 10_000);
      return {
        id,
        stablecoinId: ASSET_ID,
        symbol: "USDG",
        pegType: "peggedUSD",
        direction: peakDeviationBps > 0 ? "above" : "below",
        peakDeviationBps,
        startedAt,
        endedAt,
        startPrice,
        peakPrice: startPrice,
        recoveryPrice: pegReference,
        pegReference,
        source: "backfill",
        constituentEventCount: 1,
        confirmationSources: null,
        pendingReason: null,
        closeReason: null,
        provenance: null,
      };
    },
  );
}

function pegSummary(events: readonly DepegEvent[], clockSec: number): PegSummaryCoin {
  const result = computePegScore([...events], TRACKING_START_SEC, clockSec);
  return {
    id: ASSET_ID,
    symbol: "USDG",
    name: "Global Dollar",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 0,
    pegScore: result.pegScore,
    pegPct: result.pegPct,
    severityScore: result.severityScore,
    spreadPenalty: result.spreadPenalty,
    eventCount: result.eventCount,
    worstDeviationBps: result.worstDeviationBps,
    activeDepeg: result.activeDepeg,
    lastEventAt: result.lastEventAt,
    trackingSpanDays: result.trackingSpanDays,
    historyCoverage: {
      startedAt: TRACKING_START_SEC,
      source: "asset-age",
      status: "assumed",
    },
    methodologyVersion: "peg-score:identity-fixture-v1",
  };
}

function selected<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const value = record[ASSET_ID];
  return value === undefined ? {} : { [ASSET_ID]: value };
}

function singleAssetFixedInput(events: readonly DepegEvent[]) {
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
    pegDataById: { [ASSET_ID]: pegSummary(events, full.clockSec) },
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
            sourceKind: "market",
            replayRunId: "replay:identity-fixture",
            replayVersion: "depeg-backfill-v6.0",
            sourcePriceProviders: ["provider-a", "provider-b"],
            quoteMode: "native-peg",
            pegReferenceSource: "native-peg-history",
            supplySource: "defillama-history",
            confirmationPolicy: "two-point-36h-or-extreme",
            confirmationPointCount: 2,
            confidenceTier: "high",
            auditVerdict: "confirmed",
            pegScoreEligible: true,
            updatedAt: clockSec - 1,
          },
        }
      : event,
  );
}

describe("diagnostic V9 peg provenance identity boundary", () => {
  it("round-trips a compact publication-exact provenance seed and rejects tampering", () => {
    const events = legacyEvents();
    const fixedInput = singleAssetFixedInput(events);
    const pegProvenanceById = {
      [ASSET_ID]: summary(events, fixedInput),
    };
    const safetyScoreIdentity = {
      model: "v9-input" as const,
      schemaVersion: 1 as const,
      methodologyVersion: fixedInput.methodologyVersion,
      evaluationBuildDigest: DIGEST,
      baseInputGenerationId: fixedInput.baseInputGenerationId.replace(
        "report-cards-input:v1:",
        "report-cards-input:v2:",
      ),
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
    const events = legacyEvents();
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

    expect(legacySummary.legacyInclusive.result.pegScore).toBe(84);
    expect(verifiedSummary.legacyInclusive.result).toEqual(
      legacySummary.legacyInclusive.result,
    );
    expect(legacySummary.classes["legacy-backfill-unprovenanced"].eventCount).toBe(13);
    expect(verifiedSummary.classes["legacy-backfill-unprovenanced"].eventCount).toBe(12);
    expect(verifiedSummary.classes["provenance-high"].eventCount).toBe(1);
    expect(verifiedSummary.contentSha256).not.toBe(legacySummary.contentSha256);
    expect(legacyDiagnostic.baseInputGenerationId).toBe(base.baseInputGenerationId);
    expect(verifiedDiagnostic.baseInputGenerationId).toBe(base.baseInputGenerationId);

    const publicBase = serializeNormalizedReportCardsReplay(
      buildReportCardsSnapshotFromFixedInput(base, { allowRegistryMismatch: true }),
    );
    const publicLegacy = serializeNormalizedReportCardsReplay(
      buildReportCardsSnapshotFromFixedInput(legacyDiagnostic, {
        allowRegistryMismatch: true,
      }),
    );
    const publicVerified = serializeNormalizedReportCardsReplay(
      buildReportCardsSnapshotFromFixedInput(verifiedDiagnostic, {
        allowRegistryMismatch: true,
      }),
    );
    expect(publicLegacy).toBe(publicBase);
    expect(publicVerified).toBe(publicBase);
    expect(publicVerified).not.toContain("pegProvenanceById");
    expect(publicVerified).not.toContain("startPrice");
    expect(publicVerified).not.toContain("provider-a");

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
    const events = legacyEvents();
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
