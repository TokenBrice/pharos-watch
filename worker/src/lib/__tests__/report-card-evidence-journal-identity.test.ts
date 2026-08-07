import { describe, expect, it } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  createReportCardEvidenceJournalV1,
  type ReserveEvidenceSourceOriginClass,
} from "@shared/lib/report-card-evidence-journal";
import {
  buildReportCardsFixedInputCacheEntry,
  createReportCardsFixedInput,
  normalizeFixedInput,
  parseReportCardsFixedInputCacheValue,
} from "../report-cards-fixed-input";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9-candidate";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9-extension";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const ASSET_ID = "usdc-circle";
const DIGEST = "a".repeat(64);

function singleAssetFixedInput() {
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
    pegDataById: { [ASSET_ID]: full.pegDataById[ASSET_ID]! },
    activeDepegPeakBpsById: {},
    dexLiqMap: { [ASSET_ID]: full.dexLiqMap[ASSET_ID]! },
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: { [ASSET_ID]: full.resolvedBlacklistStatuses[ASSET_ID]! },
    liveReserveMap: { [ASSET_ID]: full.liveReserveMap[ASSET_ID]! },
    liveReserveProvenanceMap: {
      [ASSET_ID]: full.liveReserveProvenanceMap[ASSET_ID]!,
    },
    chainCirculatingById: {
      [ASSET_ID]: full.chainCirculatingById[ASSET_ID]!,
    },
    aggregateCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function journalRecord(
  clockSec: number,
  sourceOriginClass: ReserveEvidenceSourceOriginClass = "onchain-observation",
) {
  return createReportCardEvidenceJournalV1({
    schemaVersion: 1,
    lane: "reserve",
    assetId: ASSET_ID,
    attemptId: "reserve-fixture:accepted",
    sourceId: "fixture-reserve-adapter",
    sourceOriginClass,
    attemptCode: "reserve.collector.attempted",
    admissionCode: "reserve.admission.accepted",
    fallbackCode: "reserve.fallback.not-used",
    attemptedAtSec: clockSec - 2,
    completedAtSec: clockSec - 1,
    sourceTimestampSec: clockSec - 2,
    sourceBlock: null,
    contentSha256: DIGEST,
    sidecarMaterializationSha256: null,
  });
}

describe("diagnostic reserve evidence journal identity boundary", () => {
  it("defaults legacy inputs to an empty journal", () => {
    const input = singleAssetFixedInput();
    const { evidenceJournalById: _journal, ...legacy } = input;

    expect(normalizeFixedInput(legacy).evidenceJournalById).toEqual({});
    expect(normalizeFixedInput(legacy).baseInputGenerationId).toBe(input.baseInputGenerationId);
  });

  it("changes only the private fixed envelope, not score or public identities", async () => {
    const base = singleAssetFixedInput();
    const journaled = normalizeFixedInput({
      ...base,
      evidenceJournalById: {
        [ASSET_ID]: [journalRecord(base.clockSec)],
      },
    });

    expect(journaled.baseInputGenerationId).toBe(base.baseInputGenerationId);

    const publishedAtSec = base.clockSec + 1;
    const basePipeline = buildSafetyScoreV9Candidate({
      fixedInput: base,
      extension: buildSafetyScoreV9BaselineExtension(base),
      publishedAtSec,
    });
    const journaledPipeline = buildSafetyScoreV9Candidate({
      fixedInput: journaled,
      extension: buildSafetyScoreV9BaselineExtension(journaled),
      publishedAtSec,
    });
    expect(journaledPipeline.compiledFacts.v9FactSetDigest).toBe(
      basePipeline.compiledFacts.v9FactSetDigest,
    );
    expect(journaledPipeline.evaluatedSet.scoreResultDigest).toBe(
      basePipeline.evaluatedSet.scoreResultDigest,
    );
    expect(journaledPipeline.candidate.factSetDigest).toBe(basePipeline.candidate.factSetDigest);
    expect(journaledPipeline.candidate.resultDigest).toBe(basePipeline.candidate.resultDigest);
    expect(stableJsonStringifyV1(journaledPipeline.candidate)).toBe(
      stableJsonStringifyV1(basePipeline.candidate),
    );
    expect(stableJsonStringifyV1(journaledPipeline.candidate)).not.toContain(
      "reserve-fixture:accepted",
    );
    expect(stableJsonStringifyV1(journaledPipeline.candidate)).not.toContain("evidenceJournalById");

    const identity = {
      model: "v8" as const,
      schemaVersion: 1 as const,
      methodologyVersion: base.methodologyVersion,
      evaluationBuildDigest: DIGEST,
      baseInputGenerationId: base.baseInputGenerationId,
      publicationGenerationId: base.sourceGeneration,
    };
    const [baseV8, journaledV8] = await Promise.all([
      buildReportCardsFixedInputCacheEntry(base, identity),
      buildReportCardsFixedInputCacheEntry(journaled, identity),
    ]);
    const baseV8Envelope = JSON.parse(baseV8.value) as { payloadSha256: string };
    const journaledV8Envelope = JSON.parse(journaledV8.value) as { payloadSha256: string };
    expect(journaledV8Envelope.payloadSha256).toBe(baseV8Envelope.payloadSha256);
    expect(journaledV8.value).toBe(baseV8.value);
    await expect(parseReportCardsFixedInputCacheValue(journaledV8.value)).resolves.toMatchObject({
      evidenceJournalById: {},
    });
  });

  it("keeps adapter source-origin corrections outside public and score identities", () => {
    const base = singleAssetFixedInput();
    const withOrigin = (sourceOriginClass: ReserveEvidenceSourceOriginClass) =>
      normalizeFixedInput({
        ...base,
        evidenceJournalById: {
          [ASSET_ID]: [journalRecord(base.clockSec, sourceOriginClass)],
        },
      });
    const onchain = withOrigin("onchain-observation");
    const issuer = withOrigin("issuer-attested");

    expect(issuer.evidenceJournalById[ASSET_ID]?.[0]?.journalId).not.toBe(
      onchain.evidenceJournalById[ASSET_ID]?.[0]?.journalId,
    );
    expect(issuer.baseInputGenerationId).toBe(onchain.baseInputGenerationId);

    const publishedAtSec = base.clockSec + 1;
    const issuerPipeline = buildSafetyScoreV9Candidate({
      fixedInput: issuer,
      extension: buildSafetyScoreV9BaselineExtension(issuer),
      publishedAtSec,
    });
    const onchainPipeline = buildSafetyScoreV9Candidate({
      fixedInput: onchain,
      extension: buildSafetyScoreV9BaselineExtension(onchain),
      publishedAtSec,
    });
    expect(issuerPipeline.compiledFacts.v9FactSetDigest).toBe(
      onchainPipeline.compiledFacts.v9FactSetDigest,
    );
    expect(issuerPipeline.evaluatedSet.scoreResultDigest).toBe(
      onchainPipeline.evaluatedSet.scoreResultDigest,
    );
    expect(stableJsonStringifyV1(issuerPipeline.candidate)).toBe(
      stableJsonStringifyV1(onchainPipeline.candidate),
    );
  });
});
