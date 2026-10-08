import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSafetyScoreV9InputIdentity,
} from "@shared/lib/safety-score-v9-input-identity";
import { createNativeSafetyScoreV9FullRegistryInput } from "../../lib/__tests__/fixtures/safety-score-v9-full-registry-input";
import { compactCronMetadataForPersistence } from "../../lib/cron-metadata-persistence";
import type { NativeSafetyScoreV9Input } from "../../lib/safety-score-v9/native-input";
import { normalizeNativeV9Input } from "../../lib/safety-score-v9/native-input";
import { createRuntimeGapVerdict } from "../../lib/safety-score-v9/fact-set-context";
import { afterEach } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  buildSafetyScoreV9CaptureControl, SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY,
} from "../../lib/safety-score-v9/capture-control";
import type { SafetyScoreV9CaptureControl } from "@shared/types/safety-score-v9-capture-control";
import { createReportCardsFixedInput, buildReportCardsFixedInputCacheEntry } from "../../test-helpers/report-cards-fixed-input";
import type * as NativeInputModule from "../../lib/safety-score-v9/native-input";

const mocks = vi.hoisted(() => ({
  getCaches: vi.fn(),
  getCacheUpdatedAt: vi.fn(),
  loadDexGeneration: vi.fn(),
  parseFixedInput: vi.fn(),
  parsePegSeed: vi.fn(),
  parseSupplyGeneration: vi.fn(),
  applySupplyGeneration: vi.fn(),
  loadEvidenceJournalById: vi.fn(),
  loadSupplyAttributionJournalById: vi.fn(),
  runPublication: vi.fn(),
}));

vi.mock("../../lib/db-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/db-cache")>(),
  getCaches: mocks.getCaches,
  getCacheUpdatedAt: mocks.getCacheUpdatedAt,
}));

vi.mock("../../lib/report-cards-snapshot", () => ({
  loadExactDexPublicationGeneration: mocks.loadDexGeneration,
}));

vi.mock("../../lib/safety-score-v9/native-input", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../lib/safety-score-v9/native-input")
    >();
  return {
    ...original,
    parseNativeV9InputCacheArtifact: mocks.parseFixedInput,
  };
});

vi.mock("../../lib/safety-score-v9/peg-provenance", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../lib/safety-score-v9/peg-provenance")
    >();
  return {
    ...original,
    parseSafetyScoreV9PegProvenanceSeed: mocks.parsePegSeed,
  };
});

vi.mock(
  "../../lib/safety-score-v9/supply-attribution-generation",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../lib/safety-score-v9/supply-attribution-generation")
      >();
    return {
      ...original,
      applySafetyScoreV9SupplyAttributionGeneration:
        mocks.applySupplyGeneration,
      parseSafetyScoreV9SupplyAttributionGeneration:
        mocks.parseSupplyGeneration,
    };
  },
);

vi.mock("../../lib/report-card-evidence-journal-store", () => ({
  loadReportCardEvidenceJournalByIdV1:
    mocks.loadEvidenceJournalById,
}));

vi.mock("../../lib/safety-score-v9/supply-attribution-journal-store", () => ({
  loadSupplyAttributionJournalByIdV1:
    mocks.loadSupplyAttributionJournalById,
}));

vi.mock("../../lib/safety-score-v9/publication-runner", () => ({
  runSafetyScoreV9Publication: mocks.runPublication,
}));

const { computeSafetyScoreV9 } = await import("../compute-safety-score-v9");

// Parsers/publication are mocked in gate cases; build the valid transport control only once.
const validNativeInput = createNativeSafetyScoreV9FullRegistryInput();
let fixedInput: NativeSafetyScoreV9Input;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });

function captureControlFixture() {
  return buildSafetyScoreV9CaptureControl({
    safetyScoreIdentity: buildSafetyScoreV9InputIdentity({
      methodologyVersion: fixedInput.methodologyVersion, baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: fixedInput.sourceGeneration,
    }),
    baseInputGenerationId: fixedInput.baseInputGenerationId, sourceGeneration: fixedInput.sourceGeneration,
    clockSec: fixedInput.clockSec, registryFingerprint: fixedInput.registryFingerprint,
    workerVersion: "worker-old", workerUploadedAtSec: fixedInput.clockSec - 60,
  }, fixedInput.clockSec);
}

async function installControl(control: SafetyScoreV9CaptureControl) {
  const caches = await mocks.getCaches();
  caches.set(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, { value: JSON.stringify(control) });
  mocks.getCaches.mockImplementation(async () => new Map(caches));
}

function mockPublishedPreparation() {
  mocks.runPublication.mockImplementation(async (input: {
    fixedInput: NativeSafetyScoreV9Input;
    prepareFixedInput: (input: NativeSafetyScoreV9Input, signal: AbortSignal) => Promise<NativeSafetyScoreV9Input>;
  }) => {
    const prepared = await input.prepareFixedInput(input.fixedInput, new AbortController().signal);
    expect(prepared.baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
    return { status: "published", attemptId: "attempt", publicationGenerationId: fixedInput.sourceGeneration,
      candidateId: "candidate", outcome: "full", quarantines: [], affectedAssetIds: [], bridgeJoinDiagnostics: [] };
  });
}
describe("computeSafetyScoreV9", () => {
  beforeEach(() => {
    fixedInput = {
      ...validNativeInput,
      pegDataById: {},
    };
    const safetyScoreIdentity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: fixedInput.methodologyVersion,
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: fixedInput.sourceGeneration,
    });
    const generation = {
      generationId:
        `safety-score-v9-supply-attribution:v1:${"a".repeat(64)}`,
      sourceClockSec: fixedInput.clockSec,
      captureClockSec: fixedInput.clockSec,
      capturedAtSec: fixedInput.clockSec + 60,
      acceptedAssetIds: ["xaut-tether"],
      rejectedAssetIds: [],
    };

    mocks.getCaches.mockReset().mockImplementation(async () =>
      new Map([
        ["report-cards:fixed-input:exact", { value: "fixed-input" }],
        [
          "report-cards:v9-peg-provenance-seed:exact",
          { value: "peg-seed" },
        ],
        [
          "safety-score-v9:supply-attribution-generation:v1",
          { value: "supply-generation" },
        ],
      ]),
    );
    mocks.getCacheUpdatedAt
      .mockReset()
      .mockResolvedValue(fixedInput.updatedAt);
    mocks.loadDexGeneration
      .mockReset()
      .mockResolvedValue({ generationId: fixedInput.dexGenerationId });
    mocks.parseFixedInput.mockReset().mockResolvedValue({
      input: fixedInput,
      safetyScoreIdentity,
    });
    mocks.parsePegSeed.mockReset().mockReturnValue({
      sourceGeneration: fixedInput.sourceGeneration,
      clockSec: fixedInput.clockSec,
      safetyScoreIdentity,
      pegProvenanceById: {},
    });
    mocks.parseSupplyGeneration
      .mockReset()
      .mockReturnValue(generation);
    mocks.applySupplyGeneration
      .mockReset()
      .mockReturnValue({
        status: "applied",
        generationId: generation.generationId,
        fixedInput,
        acceptedAssetIds: ["xaut-tether"],
        rejectedAssetIds: [],
        invalidAssetIds: [],
      });
    mocks.loadEvidenceJournalById
      .mockReset()
      .mockResolvedValue({});
    mocks.loadSupplyAttributionJournalById
      .mockReset()
      .mockResolvedValue({});
    mocks.runPublication.mockReset();
  });

  it.each([true, false])("retains accepted replay only when requested (%s)", async (retainAcceptedReplay) => {
    mocks.runPublication.mockResolvedValue({
      status: "failed", attemptId: "attempt", stage: "compile", code: "fixture", message: "fixture",
    });
    await computeSafetyScoreV9({} as D1Database, undefined, undefined,
      retainAcceptedReplay ? undefined : { retainAcceptedReplay: false });
    expect(mocks.runPublication.mock.calls[0][0].fixedInputCacheValue)
      .toBe(retainAcceptedReplay ? "fixed-input" : undefined);
  });

  it.each([
    { status: "written", bytes: 680_000 },
    { status: "failed", reason: "capture-upload-failed", bytes: 680_000 },
    { status: "skipped", reason: "capture-too-large", bytes: 8_000_001 },
  ])("forwards archive binding and preserves $status metadata without changing publication health", async captureArchive => {
    const captureArchiveBucket = { put: vi.fn() } as unknown as R2Bucket;
    const captureArchiveContext = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const executionWindow = { slotStartedAtSec: fixedInput.clockSec, deadlineMs: Date.now() + 60_000, minimumRemainingMs: 10_000 };
    mocks.runPublication.mockImplementationOnce(async (input: {
      fixedInput: NativeSafetyScoreV9Input;
      prepareFixedInput: (input: NativeSafetyScoreV9Input, signal: AbortSignal) => Promise<NativeSafetyScoreV9Input>;
    }) => {
      await input.prepareFixedInput(input.fixedInput, new AbortController().signal);
      return { status: "published", attemptId: "attempt", publicationGenerationId: fixedInput.sourceGeneration,
        candidateId: "candidate", outcome: "clean", quarantines: [], affectedAssetIds: [],
        bridgeJoinDiagnostics: [], journal: { status: "written", rows: 1 }, captureArchive };
    });
    const result = await computeSafetyScoreV9({} as D1Database, undefined, undefined,
      { captureArchiveBucket, captureArchiveContext, executionWindow });
    expect(result.status).toBe("ok");
    expect(mocks.runPublication.mock.calls[0][0].captureArchiveBucket).toBe(captureArchiveBucket);
    expect(mocks.runPublication.mock.calls[0][0].captureArchiveContext).toBe(captureArchiveContext);
    expect(mocks.runPublication.mock.calls[0][0].publicationDeadlineMs).toBe(executionWindow.deadlineMs);
    expect(JSON.parse(result.metadata!)).toMatchObject({ captureArchive });
    expect(compactCronMetadataForPersistence(result.metadata!).metadata).toContain('"captureArchive"');
  });

  it("keeps accepted publication/archive metadata when the caller aborts during post-commit archiving", async () => {
    const caller = new AbortController();
    mocks.runPublication.mockImplementationOnce(async (input: {
      fixedInput: NativeSafetyScoreV9Input;
      prepareFixedInput: (input: NativeSafetyScoreV9Input, signal: AbortSignal) => Promise<NativeSafetyScoreV9Input>;
    }) => {
      await input.prepareFixedInput(input.fixedInput, new AbortController().signal);
      caller.abort(new Error("post-commit cancellation"));
      return { status: "published", attemptId: "attempt", publicationGenerationId: fixedInput.sourceGeneration,
        candidateId: "candidate", outcome: "clean", quarantines: [], affectedAssetIds: [],
        bridgeJoinDiagnostics: [], journal: { status: "written", rows: 1 },
        captureArchive: { status: "failed", reason: "capture-aborted", outcome: "pending-continuation" } };
    });
    const result = await computeSafetyScoreV9({} as D1Database, caller.signal);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      publication: { status: "published" },
      captureArchive: { status: "failed", reason: "capture-aborted", outcome: "pending-continuation" },
    });
  });

  it("v10.01 second preparation keeps captured proof identity and rejects subsequent proof substitution", async () => {
    const failure = createRuntimeGapVerdict({
      assetId: "usdc-circle", scope: { pillar: "backing", componentKey: "reserve-composition",
        factorKey: null, routeKey: null, exposureId: null, requiredDatum: "reserve-composition" },
      sourceId: "fixture-reserve-reader", sourceGenerationId: "attempt:second-prepare",
      observedAtSec: fixedInput.clockSec, asOfSec: fixedInput.clockSec, producerState: "producer-failed",
      rejectionCode: "read-failed", reason: "A captured reserve read failed.",
    });
    fixedInput = normalizeNativeV9Input({ ...fixedInput, baseInputGenerationId: undefined,
      pipelineGapByAssetId: { "usdc-circle": [failure] } });
    mocks.applySupplyGeneration.mockReturnValue({ status: "applied", generationId: "fixture-supply-generation",
      fixedInput, acceptedAssetIds: [], rejectedAssetIds: [], invalidAssetIds: [] });
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: fixedInput.methodologyVersion, baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: fixedInput.sourceGeneration,
    });
    mocks.parseFixedInput.mockResolvedValue({ input: fixedInput, safetyScoreIdentity: identity });
    mocks.parsePegSeed.mockReturnValue({ sourceGeneration: fixedInput.sourceGeneration, clockSec: fixedInput.clockSec,
      safetyScoreIdentity: identity, pegProvenanceById: {} });
    mocks.runPublication.mockImplementationOnce(async (input: {
      fixedInput: NativeSafetyScoreV9Input;
      prepareFixedInput: (input: NativeSafetyScoreV9Input, signal: AbortSignal) => Promise<NativeSafetyScoreV9Input>;
    }) => {
      const prepared = await input.prepareFixedInput(input.fixedInput, new AbortController().signal);
      expect(normalizeNativeV9Input(prepared).baseInputGenerationId).toBe(fixedInput.baseInputGenerationId);
      const substituted = structuredClone(prepared);
      substituted.pipelineGapByAssetId!["usdc-circle"]![0]!.evidence.rejection!.reason = "Uncaptured current-store failure";
      expect(() => normalizeNativeV9Input(substituted)).toThrow(/does not match payload/);
      return { status: "published", attemptId: "attempt", publicationGenerationId: fixedInput.sourceGeneration,
        candidateId: "candidate", outcome: "full", quarantines: [], affectedAssetIds: [], bridgeJoinDiagnostics: [] };
    });
    const result = await computeSafetyScoreV9({} as D1Database);
    expect(result.status).toBe("ok");
  });

  it("publishes aggregate-only input with bounded pending provenance instead of admitting future packets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedInput.clockSec * 1_000);
    const control = buildSafetyScoreV9CaptureControl({
      safetyScoreIdentity: buildSafetyScoreV9InputIdentity({
        methodologyVersion: fixedInput.methodologyVersion, baseInputGenerationId: fixedInput.baseInputGenerationId,
        publicationGenerationId: fixedInput.sourceGeneration,
      }),
      baseInputGenerationId: fixedInput.baseInputGenerationId, sourceGeneration: fixedInput.sourceGeneration,
      clockSec: fixedInput.clockSec, registryFingerprint: fixedInput.registryFingerprint,
      workerVersion: "capture-worker", workerUploadedAtSec: fixedInput.clockSec - 60,
    }, fixedInput.clockSec);
    await installControl(control);
    mocks.applySupplyGeneration.mockReturnValue({
      status: "incompatible", reason: "capture-clock-after-consumer", generationId: "future",
      fixedInput: { ...fixedInput, safetyScoreV9SupplyAttributionById: {} },
    });
    mockPublishedPreparation();
    const result = await computeSafetyScoreV9({} as D1Database);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      supplyAttributionGeneration: {
        status: "pending", reason: "attribution-pending",
        pendingUntilSec: control.attribution.pendingUntilSec,
        targetBaseInputGenerationId: fixedInput.baseInputGenerationId,
      },
    });
    expect(mocks.runPublication).toHaveBeenCalledOnce();
    expect(mocks.loadSupplyAttributionJournalById).toHaveBeenCalledOnce();
  });

  it("rejects a fixed input captured from an older stablecoin cache generation", async () => {
    mocks.getCacheUpdatedAt.mockResolvedValueOnce(
      fixedInput.updatedAt + 900,
    );

    const result = await computeSafetyScoreV9({} as D1Database);

    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
      productivity: {
        productive: false,
        reason: "v9-publication-source-unavailable",
      },
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      stage: "input-load",
      reason: "stablecoins-generation-mismatch",
      latestStablecoinsUpdatedAt:
        fixedInput.updatedAt + 900,
    });
    expect(mocks.loadDexGeneration).not.toHaveBeenCalled();
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });

  it("degrades without publishing when the fixed-input cache row is still a v1 envelope (deploy-window overlap)", async () => {
    const actualNativeInput = await vi.importActual<
      typeof import("../../lib/safety-score-v9/native-input")
    >("../../lib/safety-score-v9/native-input");
    const validInput = validNativeInput;
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: validInput.methodologyVersion,
      baseInputGenerationId: validInput.baseInputGenerationId,
      publicationGenerationId: validInput.sourceGeneration,
    });
    const entry = await actualNativeInput.buildNativeV9InputCacheEntry(validInput, identity);
    expect(await actualNativeInput.parseNativeV9InputCacheArtifact(entry.value)).toMatchObject({
      input: { baseInputGenerationId: validInput.baseInputGenerationId },
      safetyScoreIdentity: identity,
    });
    const legacyEnvelope = { ...JSON.parse(entry.value), schemaVersion: 1 };
    await expect(actualNativeInput.parseNativeV9InputCacheArtifact(JSON.stringify(legacyEnvelope)))
      .rejects.toMatchObject({ issues: [{ path: ["schemaVersion"], code: "invalid_value", values: [2] }] });
    mocks.parseFixedInput.mockImplementationOnce(actualNativeInput.parseNativeV9InputCacheArtifact);
    mocks.getCaches.mockResolvedValueOnce(
      new Map([
        [
          "report-cards:fixed-input:exact",
          {
            value: JSON.stringify(legacyEnvelope),
          },
        ],
        [
          "report-cards:v9-peg-provenance-seed:exact",
          { value: "peg-seed" },
        ],
        [
          "safety-score-v9:supply-attribution-generation:v1",
          { value: "supply-generation" },
        ],
      ]),
    );

    const result = await computeSafetyScoreV9({} as D1Database);

    expect(result.status).toBe("degraded");
    expect(result.productivity).toMatchObject({
      productive: false,
      reason: "v9-publication-source-unavailable",
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      stage: "input-load",
      reason: "exact-input-invalid",
    });
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });

  it.each(["raw", "envelope"] as const)("rejects valid offline V3 %s input on live publication", async (format) => {
    const actualNativeInput = await vi.importActual<typeof NativeInputModule>(
      "../../lib/safety-score-v9/native-input",
    );
    const { baseInputGenerationId: _nativeGeneration, ...legacyDraft } = fixedInput;
    const legacy = createReportCardsFixedInput({
      ...legacyDraft,
      captureKind: "exact-publication-inputs",
      bluechipMap: {},
      resolvedBlacklistStatuses: Object.fromEntries(fixedInput.activeAssetIds.map((id) => [id, false])),
      chainCirculatingById: {},
      collateralDriftCoins: [],
      dexLiqMap: Object.fromEntries(fixedInput.activeAssetIds.map((id) => [id, {
        liquidityScore: null, concentrationHhi: null, poolCount: 0, chainCount: 0,
        methodologyVersion: "1.0", updatedAt: fixedInput.dexLiqMap[id]!.updatedAt,
      }])),
    });
    const value = format === "raw" ? JSON.stringify(legacy)
      : (await buildReportCardsFixedInputCacheEntry(legacy)).value;
    const offlineInput = format === "raw"
      ? actualNativeInput.normalizeSafetyScoreV9CompilerInput(JSON.parse(value))
      : await actualNativeInput.parseSafetyScoreV9InputCacheValue(value);
    expect(offlineInput).toMatchObject({ schemaVersion: 3 });
    mocks.parseFixedInput.mockImplementationOnce(actualNativeInput.parseNativeV9InputCacheArtifact);
    mocks.getCaches.mockResolvedValueOnce(new Map([
      ["report-cards:fixed-input:exact", { value }],
      ["report-cards:v9-peg-provenance-seed:exact", { value: "peg-seed" }],
      ["safety-score-v9:supply-attribution-generation:v1", { value: "supply-generation" }],
    ]));
    const result = await computeSafetyScoreV9({} as D1Database);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({ stage: "input-load", reason: "exact-input-invalid" });
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });

  it("keeps tolerated partial V9 publications green when supply attribution applied", async () => {
    mocks.runPublication.mockImplementationOnce(async (input: {
      fixedInput: unknown;
      prepareFixedInput?: (fixedInput: unknown, signal: AbortSignal) => Promise<unknown>;
    }) => {
      await input.prepareFixedInput?.(
        input.fixedInput,
        new AbortController().signal,
      );
      return {
        status: "published",
        attemptId: "attempt",
        publicationGenerationId: "report-cards:v9:test",
        candidateId: "candidate",
        outcome: "partial",
        quarantines: [],
        affectedAssetIds: ["wm-m0"],
        bridgeJoinDiagnostics: [],
      };
    });

    const result = await computeSafetyScoreV9({} as D1Database);

    expect(result.status).toBe("ok");
    expect(result.productivity?.reason).toBe(
      "v9-publication-published-partial",
    );
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      supplyAttributionGeneration: {
        status: "applied",
        acceptedCount: 1,
        rejectedCount: 0,
      },
      publication: {
        status: "published",
        outcome: "partial",
      },
    });
  });

  it("bounds published bridge-join diagnostics under the persistence cap", async () => {
    mocks.runPublication.mockImplementationOnce(async (input: {
      fixedInput: unknown;
      prepareFixedInput?: (fixedInput: unknown, signal: AbortSignal) => Promise<unknown>;
    }) => {
      await input.prepareFixedInput?.(
        input.fixedInput,
        new AbortController().signal,
      );
      return {
        status: "published",
        attemptId: "attempt",
        publicationGenerationId: "report-cards:v9:test",
        candidateId: "candidate",
        outcome: "clean",
        quarantines: [],
        affectedAssetIds: [],
        // Per-asset detail on the real roster is large enough to cross the
        // 64 KiB cap on its own; the emitted row must carry counts instead.
        bridgeJoinDiagnostics: Array.from({ length: 600 }, (_, index) => ({
          assetId: `asset-${index}`,
          profileRouteCount: 2,
          canonicalSupplyRowCount: 1,
          unmatchedRowIdentities: [`unmatched-${index}`, index % 2 === 0 ? `alt-${index}` : ""].filter(Boolean),
          reviewedNativeCoverage: {
            reviewedRowCount: 1,
            canonicalSupplyRowCount: 1,
            supplyShare: 1,
            complete: true,
          },
          bridgeClaimControls: ["control"],
          applicabilityBranch: index % 3 === 0 ? ("native-only-not-applicable" as const) : ("applicable" as const),
          unprovenRouteJoins: index % 4 === 0
            ? [{
                deploymentRouteKey: `route-${index}`,
                joinedControlSemanticsResolved: null,
                joinedControlSupplyShare: null,
              }]
            : [],
        })),
      };
    });

    const result = await computeSafetyScoreV9({} as D1Database);

    expect(result.status).toBe("ok");
    const metadata = result.metadata ?? "";
    expect(metadata.length).toBeLessThan(64 * 1_024);
    const parsed = JSON.parse(metadata) as {
      publication?: {
        status?: string;
        bridgeJoinDiagnostics?: Record<string, number>;
      };
    };
    expect(parsed.publication?.status).toBe("published");
    expect(parsed.publication?.bridgeJoinDiagnostics).toEqual({
      assetCount: 600,
      applicableAssetCount: 400,
      unmatchedRowIdentityCount: 900,
      unprovenRouteJoinCount: 150,
    });
  });

  it("keeps the coverage-floor verdict readable after metadata compaction", async () => {
    mocks.runPublication.mockImplementationOnce(async (input: {
      fixedInput: unknown;
      prepareFixedInput?: (fixedInput: unknown, signal: AbortSignal) => Promise<unknown>;
    }) => {
      await input.prepareFixedInput?.(
        input.fixedInput,
        new AbortController().signal,
      );
      return {
        status: "held",
        attemptId: "safety-score-v9-publication:1790124736",
        attemptedPublicationGenerationId: "report-cards:v9:v1:6d64205b",
        reasons: [
          { code: "coverage-floor-failed", floorIds: ["minimum-rateable-assets"] },
          { code: "producer-failed-pipeline-gap", assetId: "usdc-circle", source: "reason",
            reasonCode: "missing-pillar-evidence", path: "asset-compilation", effect: "pipeline-gap" },
        ],
        coverageFloors: [
          {
            id: "active-result-count",
            status: "pass",
            observed: 332,
            required: "= 332",
            detail: "one result per active asset",
          },
          {
            id: "minimum-rateable-assets",
            status: "fail",
            observed: 264,
            required: ">= 271",
            detail: "below the active-asset rateability floor",
          },
        ],
        quarantines: [],
        affectedAssetIds: [],
        bridgeJoinDiagnostics: [],
      };
    });

    const result = await computeSafetyScoreV9({} as D1Database);

    expect(result.status).toBe("degraded");
    expect(result.productivity).toMatchObject({
      productive: false,
      reason: "v9-publication-held",
    });

    // Production metadata for this producer is far past the 64 KiB cap, where the
    // compactor rewrites every array diagnostic as a `<key>Count` scalar. Pad the
    // payload to force that path and assert the floor verdict survives it.
    const padded = JSON.stringify({
      ...JSON.parse(result.metadata ?? "{}"),
      bridgeJoinDiagnostics: Array.from({ length: 400 }, (_, index) => ({
        assetId: `asset-${index}`,
        path: "x".repeat(140),
      })),
    });
    const compacted = compactCronMetadataForPersistence(padded);
    expect(compacted.compacted).toBe(true);
    const envelope = JSON.parse(compacted.metadata ?? "{}") as {
      diagnostics?: { publication?: Record<string, unknown> };
    };
    expect(envelope.diagnostics?.publication).toMatchObject({
      coverageFloorVerdicts:
        "active-result-count:pass:observed=332,required== 332;minimum-rateable-assets:fail:observed=264,required=>= 271",
      holdReasonCodes: "coverage-floor-failed:minimum-rateable-assets,producer-failed-pipeline-gap:usdc-circle:missing-pillar-evidence:pipeline-gap",
    });
  });

  it("degrades a published V9 attempt when supply attribution is incompatible", async () => {
    mocks.applySupplyGeneration.mockReturnValueOnce({
      status: "incompatible",
      generationId:
        `safety-score-v9-supply-attribution:v1:${"a".repeat(64)}`,
      fixedInput,
      reason: "generation-stale",
    });
    mocks.runPublication.mockImplementationOnce(async (input: {
      fixedInput: unknown;
      prepareFixedInput?: (fixedInput: unknown, signal: AbortSignal) => Promise<unknown>;
    }) => {
      await input.prepareFixedInput?.(
        input.fixedInput,
        new AbortController().signal,
      );
      return {
        status: "published",
        attemptId: "attempt",
        publicationGenerationId: "report-cards:v9:test",
        candidateId: "candidate",
        outcome: "clean",
        quarantines: [],
        affectedAssetIds: [],
        bridgeJoinDiagnostics: [],
      };
    });

    const result = await computeSafetyScoreV9({} as D1Database);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      supplyAttributionGeneration: {
        status: "incompatible",
        reason: "generation-stale",
      },
      publication: {
        status: "published",
        outcome: "clean",
      },
    });
  });

  it("fails closed when DEX publication advances or cannot be loaded", async () => {
    for (const unavailable of [false, true]) {
      if (unavailable) mocks.loadDexGeneration.mockRejectedValueOnce(new Error("DEX unavailable"));
      else mocks.loadDexGeneration.mockResolvedValueOnce({ generationId: "dex-newer" });
      const result = await computeSafetyScoreV9({} as D1Database);
      expect(result.status).toBe("degraded");
      expect(JSON.parse(result.metadata!)).toMatchObject({
        reason: unavailable ? "latest-dex-generation-unavailable" : "dex-generation-advanced",
      });
      expect(mocks.runPublication).not.toHaveBeenCalled();
      // The consumer removes loaded cache entries; each run needs its own map.
      mocks.getCaches.mockResolvedValue(new Map([
        ["report-cards:fixed-input:exact", { value: "fixed-input" }],
        ["report-cards:v9-peg-provenance-seed:exact", { value: "peg-seed" }],
      ]));
    }
  });

  it.each(["base", "seed"] as const)("rejects mismatched %s identity independently", async (owner) => {
    const identity = buildSafetyScoreV9InputIdentity({
      methodologyVersion: fixedInput.methodologyVersion,
      baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
      publicationGenerationId: fixedInput.sourceGeneration,
    });
    if (owner === "base") mocks.parseFixedInput.mockResolvedValueOnce({ input: fixedInput, safetyScoreIdentity: identity });
    else mocks.parsePegSeed.mockReturnValueOnce({
      sourceGeneration: fixedInput.sourceGeneration, clockSec: fixedInput.clockSec,
      safetyScoreIdentity: identity, pegProvenanceById: {},
    });
    const result = await computeSafetyScoreV9({} as D1Database);
    expect(JSON.parse(result.metadata!)).toMatchObject({ reason: "base-v9-exact-identity-mismatch" });
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });

  it("rejects seed clock or source drift despite matching identity objects", async () => {
    for (const field of ["clockSec", "sourceGeneration"] as const) {
      const seed = mocks.parsePegSeed.getMockImplementation()!();
      mocks.parsePegSeed.mockReturnValueOnce({
        ...seed, [field]: field === "clockSec" ? fixedInput.clockSec + 1 : "report-cards:other",
      });
      mocks.getCaches.mockResolvedValueOnce(new Map([
        ["report-cards:fixed-input:exact", { value: "fixed-input" }],
        ["report-cards:v9-peg-provenance-seed:exact", { value: "peg-seed" }],
      ]));
      const result = await computeSafetyScoreV9({} as D1Database);
      expect(JSON.parse(result.metadata!)).toMatchObject({ reason: "base-v9-exact-identity-mismatch" });
      expect(mocks.runPublication).not.toHaveBeenCalled();
    }
  });

  it("rejects missing, extra and equal-sized different provenance key sets", async () => {
    fixedInput.pegDataById = { alpha: {} as never };
    const seed = mocks.parsePegSeed.getMockImplementation()!();
    for (const ids of [[], ["alpha", "extra"], ["other"]]) {
      mocks.parsePegSeed.mockReturnValueOnce({ ...seed,
        pegProvenanceById: Object.fromEntries(ids.map((id) => [id, {}])),
      });
      mocks.getCaches.mockResolvedValueOnce(new Map([
        ["report-cards:fixed-input:exact", { value: "fixed-input" }],
        ["report-cards:v9-peg-provenance-seed:exact", { value: "peg-seed" }],
      ]));
      const result = await computeSafetyScoreV9({} as D1Database);
      expect(JSON.parse(result.metadata!)).toMatchObject({ reason: "v9-peg-provenance-incomplete",
        expectedCount: 1, presentCount: ids.length });
      expect(mocks.runPublication).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["new", 1, true], ["same", 1, false], ["older", -1, false], ["missing", null, false],
  ] as const)("classifies only a strictly newer deployed Worker (%s)", async (kind, uploadOffset, neutral) => {
    const control = captureControlFixture();
    const identity = { ...control.capture.safetyScoreIdentity, evaluationBuildDigest: "0".repeat(64) };
    control.capture.safetyScoreIdentity = identity;
    mocks.parseFixedInput.mockResolvedValue({ input: fixedInput, safetyScoreIdentity: identity });
    mocks.parsePegSeed.mockReturnValue({ sourceGeneration: fixedInput.sourceGeneration, clockSec: fixedInput.clockSec,
      safetyScoreIdentity: identity, pegProvenanceById: {} });
    await installControl(control);
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache (key,value,updated_at) VALUES (?,?,?)")
      .run(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, JSON.stringify(control), fixedInput.clockSec);
    const workerMetadata = kind === "missing" ? undefined : {
      id: kind === "same" ? control.capture.workerVersion! : `worker-${kind}`,
      timestamp: new Date((control.capture.workerUploadedAtSec! + uploadOffset!) * 1_000).toISOString(),
    };
    const result = await computeSafetyScoreV9(db, undefined, undefined, { workerMetadata });
    expect(result.status).toBe(neutral ? "skipped_neutral" : "degraded");
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.reason).toBe(neutral ? "v9-evaluator-changed-recapture-pending" : "base-v9-exact-identity-mismatch");
    expect(metadata.identityMismatch.changedFields).toContain("evaluationBuildDigest");
    expect(JSON.stringify(metadata.identityMismatch).length).toBeLessThan(1_200);
    const persisted = JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key=?")
      .get(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY)!.value));
    expect(persisted.recaptureRequest !== null).toBe(neutral);
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });

  it("does not make a newer deployment neutral when seed provenance is corrupt", async () => {
    const control = captureControlFixture();
    control.capture.safetyScoreIdentity.evaluationBuildDigest = "0".repeat(64);
    mocks.parseFixedInput.mockResolvedValue({ input: fixedInput, safetyScoreIdentity: control.capture.safetyScoreIdentity });
    await installControl(control);
    const result = await computeSafetyScoreV9({} as D1Database, undefined, undefined, {
      workerMetadata: { id: "new", timestamp: new Date(fixedInput.clockSec * 1_000).toISOString() },
    });
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!).identityMismatch.changedFields).toContain("capture-pair");
  });

  it.each(["expired", "non-ok", "malformed"] as const)("keeps %s attribution requests fail-closed", async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedInput.clockSec * 1_000);
    const control = captureControlFixture();
    if (kind === "expired") vi.setSystemTime(control.attribution.pendingUntilSec * 1_000);
    if (kind === "non-ok") control.attribution = { ...control.attribution, status: "settled", outcome: "degraded" };
    if (kind === "malformed") mocks.parseSupplyGeneration.mockImplementation(() => { throw new Error("bad generation"); });
    await installControl(control);
    mocks.applySupplyGeneration.mockReturnValue({
      status: "unavailable", reason: "generation-missing", generationId: null,
      fixedInput: { ...fixedInput, safetyScoreV9SupplyAttributionById: {} },
    });
    mockPublishedPreparation();
    const result = await computeSafetyScoreV9({} as D1Database);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!).supplyAttributionGeneration.status).toBe(kind === "malformed" ? "incompatible" : "unavailable");
  });

  it("throws instead of claiming a neutral recapture when marker persistence fails", async () => {
    const control = captureControlFixture();
    control.capture.safetyScoreIdentity.evaluationBuildDigest = "0".repeat(64);
    const identity = control.capture.safetyScoreIdentity;
    mocks.parseFixedInput.mockResolvedValue({ input: fixedInput, safetyScoreIdentity: identity });
    mocks.parsePegSeed.mockReturnValue({ sourceGeneration: fixedInput.sourceGeneration, clockSec: fixedInput.clockSec,
      safetyScoreIdentity: identity, pegProvenanceById: {} });
    await installControl(control);
    const { db, sqlite } = fixtures.open();
    sqlite.prepare("INSERT INTO cache(key,value,updated_at) VALUES (?,?,?)")
      .run(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, JSON.stringify(control), fixedInput.clockSec);
    sqlite.exec("CREATE TRIGGER fail_request BEFORE UPDATE ON cache BEGIN SELECT RAISE(ABORT,'marker write failed'); END");
    await expect(computeSafetyScoreV9(db, undefined, undefined, {
      workerMetadata: { id: "new", timestamp: new Date(fixedInput.clockSec * 1_000).toISOString() },
    })).rejects.toThrow("marker write failed");
  });
  it.each([397, 398])("admits complete active inventory within its reviewed boundary (%s)", async count => {
    fixedInput = { ...fixedInput, activeAssetIds: Array.from({ length: count }, (_, index) => `asset-${index}`) };
    mocks.parseFixedInput.mockResolvedValue({ input: fixedInput, safetyScoreIdentity: captureControlFixture().capture.safetyScoreIdentity });
    mockPublishedPreparation();
    const result = await computeSafetyScoreV9({} as D1Database);
    expect(result.status).toBe(count === 397 ? "ok" : "degraded");
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.resourcePressure).toMatchObject({ inputCapBytes: 8_000_000, catalogMaxAssets: 488, catalogAssets: 488 });
    if (count === 398) {
      expect(metadata.reason).toBe("resource-budget-exceeded");
      expect(mocks.runPublication).not.toHaveBeenCalled();
    } else expect(result.itemCount).toBe(397);
  });

  it("rejects expanded-byte overflow before decompression while retaining accepted publication", async () => {
    mocks.getCaches.mockResolvedValue(new Map([
      ["report-cards:fixed-input:exact", { value: '{"uncompressedBytes":8000001,"payload":"unparsed"}' }],
      ["report-cards:v9-peg-provenance-seed:exact", { value: "seed" }],
    ]));
    const result = await computeSafetyScoreV9({} as D1Database);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "resource-budget-exceeded", resourcePressure: { inputBytes: 8_000_001, inputCapBytes: 8_000_000 },
    });
    expect(mocks.parseFixedInput).not.toHaveBeenCalled();
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });
});
