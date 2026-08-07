import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSafetyScoreV9InputIdentity,
} from "@shared/lib/safety-score-v9-input-identity";
import { createNativeSafetyScoreV9FullRegistryInput } from "../../lib/__tests__/fixtures/safety-score-v9-full-registry-input";

const mocks = vi.hoisted(() => ({
  getCaches: vi.fn(),
  getCacheUpdatedAt: vi.fn(),
  loadDexGeneration: vi.fn(),
  parseFixedInput: vi.fn(),
  parsePegSeed: vi.fn(),
  parseSupplyGeneration: vi.fn(),
  supplyGenerationCadenceDeferred: vi.fn(),
  applySupplyGeneration: vi.fn(),
  loadEvidenceJournalById: vi.fn(),
  loadSupplyAttributionJournalById: vi.fn(),
  runPublication: vi.fn(),
}));

vi.mock("../../lib/db-cache", () => ({
  getCaches: mocks.getCaches,
  getCacheUpdatedAt: mocks.getCacheUpdatedAt,
}));

vi.mock("../../lib/report-cards-snapshot", () => ({
  loadExactDexPublicationGeneration: mocks.loadDexGeneration,
}));

vi.mock("../../lib/safety-score-v9-native-input", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../lib/safety-score-v9-native-input")
    >();
  return {
    ...original,
    parseNativeV9InputCacheArtifact: mocks.parseFixedInput,
  };
});

vi.mock("../../lib/safety-score-v9-peg-provenance", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../lib/safety-score-v9-peg-provenance")
    >();
  return {
    ...original,
    parseSafetyScoreV9PegProvenanceSeed: mocks.parsePegSeed,
  };
});

vi.mock(
  "../../lib/safety-score-v9-supply-attribution-generation",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../lib/safety-score-v9-supply-attribution-generation")
      >();
    return {
      ...original,
      applySafetyScoreV9SupplyAttributionGeneration:
        mocks.applySupplyGeneration,
      parseSafetyScoreV9SupplyAttributionGeneration:
        mocks.parseSupplyGeneration,
      isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred:
        mocks.supplyGenerationCadenceDeferred,
    };
  },
);

vi.mock("../../lib/report-card-evidence-journal-store", () => ({
  loadReportCardEvidenceJournalByIdV1:
    mocks.loadEvidenceJournalById,
}));

vi.mock("../../lib/safety-score-v9-supply-attribution-journal-store", () => ({
  loadSupplyAttributionJournalByIdV1:
    mocks.loadSupplyAttributionJournalById,
}));

vi.mock("../../lib/safety-score-v9-publication-runner", () => ({
  runSafetyScoreV9Publication: mocks.runPublication,
}));

const { computeSafetyScoreV9 } = await import("../compute-safety-score-v9");

describe("computeSafetyScoreV9", () => {
  beforeEach(() => {
    const fixedInput = {
      ...createNativeSafetyScoreV9FullRegistryInput(),
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

    mocks.getCaches.mockReset().mockResolvedValue(
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
    mocks.supplyGenerationCadenceDeferred
      .mockReset()
      .mockReturnValue(true);
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

  it("skips neutrally when the only supply attribution generation belongs to a later cadence phase", async () => {
    const result = await computeSafetyScoreV9({} as D1Database);

    expect(result).toMatchObject({
      status: "skipped_neutral",
      itemCount: 1,
      productivity: {
        productive: false,
        reason: "supply-attribution-generation-cadence-deferred",
      },
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      stage: "supply-generation",
      reason: "supply-attribution-generation-cadence-deferred",
      acceptedCount: 1,
      rejectedCount: 0,
    });
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });

  it("rejects a fixed input captured from an older stablecoin cache generation", async () => {
    mocks.getCacheUpdatedAt.mockResolvedValueOnce(
      createNativeSafetyScoreV9FullRegistryInput().updatedAt + 900,
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
        createNativeSafetyScoreV9FullRegistryInput().updatedAt + 900,
    });
    expect(mocks.loadDexGeneration).not.toHaveBeenCalled();
    expect(mocks.runPublication).not.toHaveBeenCalled();
  });

  it("degrades without publishing when the fixed-input cache row is still a v1 envelope (deploy-window overlap)", async () => {
    const actualNativeInput = await vi.importActual<
      typeof import("../../lib/safety-score-v9-native-input")
    >("../../lib/safety-score-v9-native-input");
    mocks.parseFixedInput.mockImplementationOnce(
      actualNativeInput.parseNativeV9InputCacheArtifact,
    );
    mocks.getCaches.mockResolvedValueOnce(
      new Map([
        [
          "report-cards:fixed-input:exact",
          {
            value: JSON.stringify({
              schemaVersion: 1,
              kind: "report-cards-fixed-input-exact",
              encoding: "gzip-base64",
              sourceGeneration: "report-cards:9.06:1783891200",
              payloadSha256: "a".repeat(64),
              uncompressedBytes: 1,
              payload: "x",
            }),
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

  it("keeps tolerated partial V9 publications green when supply attribution applied", async () => {
    mocks.supplyGenerationCadenceDeferred.mockReturnValue(false);
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

  it("degrades a published V9 attempt when supply attribution is incompatible", async () => {
    mocks.supplyGenerationCadenceDeferred.mockReturnValue(false);
    mocks.applySupplyGeneration.mockReturnValueOnce({
      status: "incompatible",
      generationId:
        `safety-score-v9-supply-attribution:v1:${"a".repeat(64)}`,
      fixedInput: createNativeSafetyScoreV9FullRegistryInput(),
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
});
