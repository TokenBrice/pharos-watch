import "../../test-helpers/reviewed-deployment-catalog.test-support";
import { describe, expect, it } from "vitest";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { makeV9FixedInput, withV9WmReviewedDeploymentAttribution } from "../../test-helpers/v9-fixed-input";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY } from "../safety-score-v9/publication-codec";
import {
  buildSafetyScoreV9PublicationReplayCapture,
  buildSafetyScoreV9ReplayLaneScreening,
  parseSafetyScoreV9PublicationReplayCapture,
  parseSafetyScoreV9PublicationReplayCacheRows,
  parseSafetyScoreV9ReplayLaneScreening,
  replayLaneIncidentCertificates,
  SafetyScoreV9ReplayCaptureIdentityError,
  SafetyScoreV9ReplayLaneScreeningBudgetError,
  SAFETY_SCORE_V9_REPLAY_LANE_CERTIFICATE_MAX,
} from "../safety-score-v9/publication-replay-capture";
import {
  V9LaneEmitterDescriptorSchema,
  V9LaneIncidentCertificateSchema,
} from "@shared/types/safety-score-v9-incidents";
import { createRuntimeGapVerdict } from "../safety-score-v9/fact-set-context";
import { normalizeSafetyScoreV9CompilerInput } from "../safety-score-v9/native-input";
import { buildFixedInputCacheEntry, REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES } from "../report-cards-fixed-input-cache-codec";
import { buildSafetyScoreV9AcceptedPublicationBaseline } from "../safety-score-v9/publication-assessment";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { sha256Hex } from "@shared/lib/sha256";

const base = makeV9FixedInput({ assetId: "wm-m0", clockSec: 1_800_000_000, aggregateCirculating: { peggedUSD: 87_020_618.58982982 } });
const enriched = withV9WmReviewedDeploymentAttribution(base);
const publication = makeWorkerSafetyScoreV9Publication({
  baseInputGenerationId: enriched.baseInputGenerationId,
  publishedAtSec: enriched.clockSec,
  publicationGenerationId: "report-cards:v9:accepted",
});

describe("Safety Score V9 accepted-publication replay capture", () => {
  const retainedRows = () => [
    { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY, value: "base", updated_at: base.clockSec },
    { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, value: "delta", updated_at: base.clockSec },
  ];

  it("selects the atomic retained pair by key, not SQL row order", () => {
    expect(parseSafetyScoreV9PublicationReplayCacheRows([{ success: true, results: retainedRows().reverse() }]))
      .toEqual({ baseValue: "base", deltaValue: "delta", retainedAtSec: base.clockSec });
  });

  it.each([
    ["missing delta", () => retainedRows().slice(0, 1), "requires-one-base-and-delta"],
    ["duplicate base", () => [...retainedRows(), retainedRows()[0]!], "requires-one-base-and-delta"],
    ["mixed retention clocks", () => retainedRows().map((row, index) => ({ ...row, updated_at: row.updated_at + index })), "retention-clock-mismatch"],
  ])("rejects %s in a retained-row export", (_label, rows, reason) => {
    expect(() => parseSafetyScoreV9PublicationReplayCacheRows([{ success: true, results: rows() }])).toThrow(reason);
  });

  it("requires one successful query result rather than independently acquired rows", () => {
    expect(() => parseSafetyScoreV9PublicationReplayCacheRows([
      { success: true, results: retainedRows().slice(0, 1) },
      { success: true, results: retainedRows().slice(1) },
    ])).toThrow();
    expect(() => parseSafetyScoreV9PublicationReplayCacheRows([{ success: false, results: retainedRows() }])).toThrow();
  });

  it("restores the compute-time enrichment the stripped base cache lacks", async () => {
    expect(base.safetyScoreV9SupplyAttributionById["wm-m0"]).toBeUndefined();
    const entry = await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null, null);
    expect(entry.key).toBe(SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY);

    const capture = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
    expect(capture.publicationGenerationId).toBe("report-cards:v9:accepted");
    expect(capture.transferMaterialityGeneration).toBeNull();
    expect(capture.fixedInput.safetyScoreV9SupplyAttributionById).toEqual(enriched.safetyScoreV9SupplyAttributionById);
    expect(capture.fixedInput.baseInputGenerationId).toBe(enriched.baseInputGenerationId);
  });

  it("captures the lane witnesses the publication read so replay reproduces closures", async () => {
    const subject = "ethereum:0x1111111111111111111111111111111111111111";
    const certificate = V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1, certificateId: `lane-cert:${subject}:100-200:abcdef`, evidenceClass: "explorer-events",
      subjectDeploymentKey: subject, fromBlock: 100, toBlock: 200, toBlockHash: `0x${"1".repeat(64)}`,
      windowStartSec: enriched.clockSec - 86_400, windowEndSec: enriched.clockSec - 3_600, observedAtSec: enriched.clockSec - 1_800,
      screeningPolicyDigest: "c".repeat(64), logDigest: "d".repeat(64),
      emitters: [{ address: `0x${"e".repeat(40)}`, expectedRuntimeCodeSha256: "a".repeat(64), runtimeCodeSha256: "a".repeat(64), families: ["OwnershipTransferred"] }],
      screenedTopics: [{ family: "OwnershipTransferred", topic0: `0x${"2".repeat(64)}`, signature: "OwnershipTransferred(address,address)" }],
      eventCounts: { OwnershipTransferred: 0 }, finding: "no-material-admin-event",
    });
    const descriptor = V9LaneEmitterDescriptorSchema.parse({
      schemaVersion: 1, subjectDeploymentKey: subject, assetId: "wm-m0", contributorControlIds: ["alpha"],
      screeningPolicyDigest: "c".repeat(64), screeningSetId: "set-1",
      emitters: [{ address: `0x${"e".repeat(40)}`, reviewedRuntimePin: `sha256-decoded-runtime-bytes:${"a".repeat(64)}`, families: ["OwnershipTransferred"] }],
    });
    const entry = await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null, null, {
      certificates: new Map([[subject, { screeningSetId: "set-1", certificate }]]),
      descriptors: [descriptor],
    });
    const capture = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
    expect(capture.laneScreening).toMatchObject({
      certificates: [{ deploymentKey: subject, screeningSetId: "set-1", certificate: { certificateId: certificate.certificateId } }],
      descriptors: [{ subjectDeploymentKey: subject, screeningSetId: "set-1" }],
    });
    expect(capture.laneScreening!.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(replayLaneIncidentCertificates(capture.laneScreening!).get(subject)?.screeningSetId).toBe("set-1");
  });

  it("records an explicit empty read and keeps pre-M6 captures readable", async () => {
    const explicit = await parseSafetyScoreV9PublicationReplayCapture(
      (await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null, null)).value, base);
    expect(explicit.laneScreening).toBeNull();
    const legacy = await buildFixedInputCacheEntry({
      schemaVersion: 2, sourceGeneration: publication.publicationGenerationId,
      payload: {
        schemaVersion: 3, publicationGenerationId: publication.publicationGenerationId,
        sourceAdmissionBaseline: null, pipelineGapDigest: null,
        baseInputGenerationId: enriched.baseInputGenerationId,
        enrichment: {
          safetyScoreV9SupplyAttributionById: base.safetyScoreV9SupplyAttributionById,
          evidenceJournalById: base.evidenceJournalById,
          supplyAttributionJournalById: base.supplyAttributionJournalById,
          pegProvenanceById: base.pegProvenanceById,
        },
        transferMaterialityGeneration: null,
      },
      label: "Accepted Safety Score V9 replay delta",
    });
    const restored = await parseSafetyScoreV9PublicationReplayCapture(legacy.value, base);
    expect(restored).not.toHaveProperty("laneScreening");
  });

  it("rejects a tampered or inconsistent lane screening block", () => {
    const subject = "ethereum:0x1111111111111111111111111111111111111111";
    const block = buildSafetyScoreV9ReplayLaneScreening({
      certificates: new Map([[subject, {
        screeningSetId: "set-1",
        certificate: V9LaneIncidentCertificateSchema.parse({
          schemaVersion: 1, certificateId: `lane-cert:${subject}`, evidenceClass: "explorer-events",
          subjectDeploymentKey: subject, fromBlock: 1, toBlock: 2, toBlockHash: `0x${"1".repeat(64)}`,
          windowStartSec: 10, windowEndSec: 20, observedAtSec: 30, screeningPolicyDigest: "c".repeat(64),
          logDigest: "d".repeat(64),
          emitters: [{ address: `0x${"e".repeat(40)}`, expectedRuntimeCodeSha256: "a".repeat(64), runtimeCodeSha256: "a".repeat(64), families: ["OwnershipTransferred"] }],
          screenedTopics: [{ family: "OwnershipTransferred", topic0: `0x${"2".repeat(64)}`, signature: "OwnershipTransferred(address,address)" }],
          eventCounts: { OwnershipTransferred: 0 }, finding: "no-material-admin-event",
        }),
      }]]),
      descriptors: [],
    });
    expect(() => parseSafetyScoreV9ReplayLaneScreening({ ...block, digest: "f".repeat(64) })).toThrow(/digest mismatch/);
    expect(() => parseSafetyScoreV9ReplayLaneScreening({
      ...block,
      certificates: block.certificates.map((row) => ({ ...row, deploymentKey: "base:0x2222222222222222222222222222222222222222" })),
    })).toThrow(/does not name/);
  });

  it("keeps a full lane block inside the replay envelope budgets", async () => {
    const template = V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1, certificateId: "lane-cert:template", evidenceClass: "explorer-events",
      subjectDeploymentKey: "ethereum:0x1111111111111111111111111111111111111111", fromBlock: 1, toBlock: 2,
      toBlockHash: `0x${"1".repeat(64)}`, windowStartSec: 10, windowEndSec: 20, observedAtSec: 30,
      screeningPolicyDigest: "c".repeat(64), logDigest: "d".repeat(64),
      emitters: [
        { address: `0x${"e".repeat(40)}`, expectedRuntimeCodeSha256: "a".repeat(64), runtimeCodeSha256: "a".repeat(64), families: ["OwnershipTransferred"] },
        { address: `0x${"f".repeat(40)}`, expectedRuntimeCodeSha256: "b".repeat(64), runtimeCodeSha256: "b".repeat(64), families: ["UlnConfigSet"] },
      ],
      screenedTopics: [
        { family: "OwnershipTransferred", topic0: `0x${"2".repeat(64)}`, signature: "OwnershipTransferred(address,address)" },
        { family: "UlnConfigSet", topic0: `0x${"3".repeat(64)}`, signature: "UlnConfigSet(address,address,uint32,bytes)" },
      ],
      eventCounts: { OwnershipTransferred: 0, UlnConfigSet: 0 }, finding: "no-material-admin-event",
    });
    const certificates = new Map<string, { screeningSetId: string; certificate: typeof template }>();
    for (let index = 0; index < 1_000; index += 1) {
      const subject = `ethereum:${(index + 0x1000).toString(16).padStart(40, "0")}`;
      certificates.set(subject, {
        screeningSetId: "set-1",
        certificate: { ...template, subjectDeploymentKey: subject, certificateId: `lane-cert:${subject}` },
      });
    }
    const entry = await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null, null, {
      certificates, descriptors: [],
    });
    expect(entry.storedBytes).toBeLessThanOrEqual(1_900_000);
    expect(entry.uncompressedBytes).toBeLessThanOrEqual(REPORT_CARDS_FIXED_INPUT_MAX_UNCOMPRESSED_BYTES);
    const capture = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
    expect(capture.laneScreening?.certificates).toHaveLength(1_000);
  });

  it("bounds the lane screening block a capture may carry", () => {
    const template = V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1, certificateId: "lane-cert:template", evidenceClass: "explorer-events",
      subjectDeploymentKey: "ethereum:0x1111111111111111111111111111111111111111", fromBlock: 1, toBlock: 2,
      toBlockHash: `0x${"1".repeat(64)}`, windowStartSec: 10, windowEndSec: 20, observedAtSec: 30,
      screeningPolicyDigest: "c".repeat(64), logDigest: "d".repeat(64),
      emitters: [{ address: `0x${"e".repeat(40)}`, expectedRuntimeCodeSha256: "a".repeat(64), runtimeCodeSha256: "a".repeat(64), families: ["OwnershipTransferred"] }],
      screenedTopics: [{ family: "OwnershipTransferred", topic0: `0x${"2".repeat(64)}`, signature: "OwnershipTransferred(address,address)" }],
      eventCounts: { OwnershipTransferred: 0 }, finding: "no-material-admin-event",
    });
    const certificates = new Map<string, { screeningSetId: string; certificate: typeof template }>();
    for (let index = 0; index <= SAFETY_SCORE_V9_REPLAY_LANE_CERTIFICATE_MAX; index += 1) {
      const subject = `ethereum:${(index + 0x1000).toString(16).padStart(40, "0")}`;
      certificates.set(subject, { screeningSetId: "set-1", certificate: { ...template, subjectDeploymentKey: subject } });
    }
    expect(() => buildSafetyScoreV9ReplayLaneScreening({ certificates, descriptors: [] }))
      .toThrow(SafetyScoreV9ReplayLaneScreeningBudgetError);
  });

  it("rejects a captured certificate whose subject is not its map key", () => {
    const subject = "ethereum:0x1111111111111111111111111111111111111111";
    const certificate = V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1, certificateId: `lane-cert:${subject}`, evidenceClass: "explorer-events",
      subjectDeploymentKey: "base:0x2222222222222222222222222222222222222222", fromBlock: 1, toBlock: 2,
      toBlockHash: `0x${"1".repeat(64)}`, windowStartSec: 10, windowEndSec: 20, observedAtSec: 30,
      screeningPolicyDigest: "c".repeat(64), logDigest: "d".repeat(64),
      emitters: [{ address: `0x${"e".repeat(40)}`, expectedRuntimeCodeSha256: "a".repeat(64), runtimeCodeSha256: "a".repeat(64), families: ["OwnershipTransferred"] }],
      screenedTopics: [{ family: "OwnershipTransferred", topic0: `0x${"2".repeat(64)}`, signature: "OwnershipTransferred(address,address)" }],
      eventCounts: { OwnershipTransferred: 0 }, finding: "no-material-admin-event",
    });
    expect(() => buildSafetyScoreV9ReplayLaneScreening({
      certificates: new Map([[subject, { screeningSetId: "set-1", certificate }]]),
      descriptors: [],
    })).toThrow(`Lane certificate ${certificate.certificateId} does not name ${subject}`);
  });

  it("refuses a canonical lane block over the byte budget on write and read", () => {
    const subject = "ethereum:0x1111111111111111111111111111111111111111";
    const oversized = V9LaneIncidentCertificateSchema.parse({
      schemaVersion: 1, certificateId: `a${"a".repeat(3_300_000)}`, evidenceClass: "explorer-events",
      subjectDeploymentKey: subject, fromBlock: 1, toBlock: 2, toBlockHash: `0x${"1".repeat(64)}`,
      windowStartSec: 10, windowEndSec: 20, observedAtSec: 30, screeningPolicyDigest: "c".repeat(64),
      logDigest: "d".repeat(64),
      emitters: [{ address: `0x${"e".repeat(40)}`, expectedRuntimeCodeSha256: "a".repeat(64), runtimeCodeSha256: "a".repeat(64), families: ["OwnershipTransferred"] }],
      screenedTopics: [{ family: "OwnershipTransferred", topic0: `0x${"2".repeat(64)}`, signature: "OwnershipTransferred(address,address)" }],
      eventCounts: { OwnershipTransferred: 0 }, finding: "no-material-admin-event",
    });
    expect(() => buildSafetyScoreV9ReplayLaneScreening({
      certificates: new Map([[subject, { screeningSetId: "set-1", certificate: oversized }]]),
      descriptors: [],
    })).toThrow(SafetyScoreV9ReplayLaneScreeningBudgetError);
    const body = {
      certificates: [{ deploymentKey: subject, screeningSetId: "set-1", certificate: oversized }],
      descriptors: [],
    };
    expect(() => parseSafetyScoreV9ReplayLaneScreening({
      digest: sha256Hex(stableJsonStringifyV1(body)), ...body,
    })).toThrow(/Replay lane-screening capture exceeds its budget: \d+ canonical bytes/u);
  });

  it.each([
    ["base input generation", { baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}` }],
    ["publication clock", { publishedAtSec: enriched.clockSec + 1 }],
  ] as const)("refuses to bind a delta whose %s differs from the compiled input", async (_label, override) => {
    await expect(buildSafetyScoreV9PublicationReplayCapture({ ...publication, ...override }, enriched, null, null))
      .rejects.toBeInstanceOf(SafetyScoreV9ReplayCaptureIdentityError);
  });

  it("rejects pairing the delta with a different retained base generation", async () => {
    const entry = await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null, null);
    const otherBase = makeV9FixedInput({ assetId: "wm-m0", clockSec: base.clockSec + 1800 });
    await expect(parseSafetyScoreV9PublicationReplayCapture(entry.value, otherBase))
      .rejects.toThrow("accepted-publication-replay-base-generation-mismatch");
  });

  it("reads a historical delta without inventing pipeline evidence for its retained base", async () => {
    const entry = await buildFixedInputCacheEntry({
      schemaVersion: 2, sourceGeneration: publication.publicationGenerationId,
      payload: { schemaVersion: 1, publicationGenerationId: publication.publicationGenerationId,
        baseInputGenerationId: base.baseInputGenerationId,
        enrichment: { safetyScoreV9SupplyAttributionById: base.safetyScoreV9SupplyAttributionById,
          evidenceJournalById: base.evidenceJournalById, supplyAttributionJournalById: base.supplyAttributionJournalById, pegProvenanceById: base.pegProvenanceById },
        transferMaterialityGeneration: null },
      label: "Historical enrichment-only delta",
    });
    const restored = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
    expect(restored.fixedInput.pipelineGapByAssetId).toBeUndefined();
  });

  it("preserves base-bound pipeline proofs and refuses proof substitution under the accepted identity", async () => {
    const failure = createRuntimeGapVerdict({
      assetId: "wm-m0",
      scope: { pillar: "backing", componentKey: "reserve-composition", factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      sourceId: "fixture:reserve-reader", sourceGenerationId: "attempt:failed",
      observedAtSec: base.clockSec, asOfSec: base.clockSec, producerState: "producer-failed",
      rejectionCode: "read-failed", reason: "The captured reserve read failed.",
    });
    const captured = normalizeSafetyScoreV9CompilerInput({
      ...base, baseInputGenerationId: undefined, pipelineGapByAssetId: { "wm-m0": [failure] },
    });
    const accepted = { ...publication, baseInputGenerationId: captured.baseInputGenerationId };
    const entry = await buildSafetyScoreV9PublicationReplayCapture(accepted, captured, null, null);
    const restored = await parseSafetyScoreV9PublicationReplayCapture(entry.value, captured);
    expect(restored.fixedInput.pipelineGapByAssetId).toEqual(captured.pipelineGapByAssetId);
    const substituted = structuredClone(captured);
    substituted.pipelineGapByAssetId!["wm-m0"]![0]!.evidence.rejection!.reason = "A different failure.";
    await expect(parseSafetyScoreV9PublicationReplayCapture(entry.value, substituted))
      .rejects.toThrow("accepted-publication-replay-pipeline-gap-identity-mismatch");
  });

  describe("v3 source admission baseline (10.35)", () => {
    const prior = buildSafetyScoreV9AcceptedPublicationBaseline(makeWorkerSafetyScoreV9Publication({
      baseInputGenerationId: enriched.baseInputGenerationId, publishedAtSec: base.clockSec - 1800,
      publicationGenerationId: "report-cards:v9:prior",
    }));
    const admission = (baseline = prior) => ({ sha256: sha256Hex(stableJsonStringifyV1(baseline)), baseline });
    const v3Entry = (extra: Record<string, unknown>) => buildFixedInputCacheEntry({
      schemaVersion: 2, sourceGeneration: publication.publicationGenerationId,
      payload: { schemaVersion: 3, publicationGenerationId: publication.publicationGenerationId,
        baseInputGenerationId: base.baseInputGenerationId, pipelineGapDigest: null,
        enrichment: { safetyScoreV9SupplyAttributionById: base.safetyScoreV9SupplyAttributionById,
          evidenceJournalById: base.evidenceJournalById, supplyAttributionJournalById: base.supplyAttributionJournalById, pegProvenanceById: base.pegProvenanceById },
        transferMaterialityGeneration: null, ...extra },
      label: "v3 delta fixture",
    });

    it("writes v3 and round-trips the checksummed prior baseline, and null only as an explicit bootstrap", async () => {
      for (const [baseline, expected] of [[prior, admission()], [null, null]] as const) {
        const entry = await buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null, baseline);
        const capture = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
        expect(capture).toHaveProperty("sourceAdmissionBaseline", expected);
      }
    });

    it("keeps legacy v2 deltas readable without inferring a bootstrap", async () => {
      const entry = await buildFixedInputCacheEntry({
        schemaVersion: 2, sourceGeneration: publication.publicationGenerationId,
        payload: { schemaVersion: 2, publicationGenerationId: publication.publicationGenerationId,
          baseInputGenerationId: base.baseInputGenerationId, pipelineGapDigest: null,
          enrichment: { safetyScoreV9SupplyAttributionById: base.safetyScoreV9SupplyAttributionById,
            evidenceJournalById: base.evidenceJournalById, supplyAttributionJournalById: base.supplyAttributionJournalById, pegProvenanceById: base.pegProvenanceById },
          transferMaterialityGeneration: null },
        label: "Legacy v2 delta",
      });
      const capture = await parseSafetyScoreV9PublicationReplayCapture(entry.value, base);
      expect(capture).not.toHaveProperty("sourceAdmissionBaseline");
    });

    it.each([
      ["the publication itself", { ...prior, publicationGenerationId: publication.publicationGenerationId }],
      ["a baseline published after the capture", { ...prior, publishedAtSec: enriched.clockSec + 1 }],
    ])("refuses to write %s as the admission baseline", async (_label, baseline) => {
      await expect(buildSafetyScoreV9PublicationReplayCapture(publication, enriched, null, baseline))
        .rejects.toBeInstanceOf(SafetyScoreV9ReplayCaptureIdentityError);
    });

    it("binds every retained grade hold to the named baseline", async () => {
      const held = structuredClone(publication);
      held.cards[0] = { ...held.cards[0]!, gradeHold: { rawGrade: "B", heldFromGenerationId: prior.publicationGenerationId } };
      await expect(buildSafetyScoreV9PublicationReplayCapture(held, enriched, null, prior)).resolves.toBeDefined();
      await expect(buildSafetyScoreV9PublicationReplayCapture(held, enriched, null, null))
        .rejects.toBeInstanceOf(SafetyScoreV9ReplayCaptureIdentityError);
      held.cards[0]!.gradeHold!.heldFromGenerationId = "report-cards:v9:substituted";
      await expect(buildSafetyScoreV9PublicationReplayCapture(held, enriched, null, prior))
        .rejects.toBeInstanceOf(SafetyScoreV9ReplayCaptureIdentityError);
    });

    it.each([
      ["a missing required-nullable baseline", () => ({}), "sourceAdmissionBaseline"],
      ["a tampered baseline", () => ({ sourceAdmissionBaseline: { ...admission(), baseline: { ...prior, publicationGenerationId: "accepted-forged" } } }), "accepted-publication-replay-baseline-checksum-mismatch"],
      ["a baseline newer than the capture clock", () => admission({ ...prior, publishedAtSec: base.clockSec + 1 }), "accepted-publication-replay-baseline-clock-after-capture"],
      ["a self-referencing baseline", () => admission({ ...prior, publicationGenerationId: publication.publicationGenerationId }), "accepted-publication-replay-source-baseline-identity-mismatch"],
      ["duplicate prior IDs", () => admission({ ...prior, cards: [prior.cards[0]!, prior.cards[0]!] }), "unique and sorted"],
    ] as const)("rejects %s", async (_label, extra, reason) => {
      const value = extra();
      const payload = "sha256" in value ? { sourceAdmissionBaseline: value } : value;
      await expect(parseSafetyScoreV9PublicationReplayCapture((await v3Entry(payload)).value, base)).rejects.toThrow(reason);
    });
  });
});
