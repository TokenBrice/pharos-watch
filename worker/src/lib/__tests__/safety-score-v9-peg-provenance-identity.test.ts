import { computePegScore } from "@shared/lib/peg-score";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { DepegEvent } from "@shared/types/market";
import { describe, expect, it } from "vitest";
import {
  buildReportCardsFixedInputCacheEntry,
  createReportCardsFixedInput,
  normalizeFixedInput,
} from "../report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  buildSafetyScoreV9PegProvenanceSummary,
  parseSafetyScoreV9PegProvenanceSeed,
  projectSafetyScoreV9PegScoreResult,
} from "../safety-score-v9/peg-provenance";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { legacyEvents, pegSummary as buildPegSummary, replayProvenance } from "./safety-score-v9-peg-provenance.test-support";

const ASSET_ID = "usdg-paxos";
const TRACKING_START_SEC = 1_730_419_200;
const DIGEST = "a".repeat(64);

const pegSummary = (events: readonly DepegEvent[], clockSec: number) =>
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
    pegDataById: { [ASSET_ID]: pegSummary(events, draft.clockSec) },
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
            ...replayProvenance(clockSec, "high"),
            replayRunId: "replay:identity-fixture",
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
