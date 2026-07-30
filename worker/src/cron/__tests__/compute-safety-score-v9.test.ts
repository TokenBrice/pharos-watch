import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSafetyScoreV9InputIdentity,
} from "@shared/lib/safety-score-v9-input-identity";
import { createSafetyScoreV9FullRegistryInput } from "../../lib/__tests__/fixtures/safety-score-v9-full-registry-input";

const mocks = vi.hoisted(() => ({
  getCaches: vi.fn(),
  loadDexGeneration: vi.fn(),
  parseFixedInput: vi.fn(),
  parsePegSeed: vi.fn(),
  parseSupplyGeneration: vi.fn(),
  supplyGenerationCadenceDeferred: vi.fn(),
  runPublication: vi.fn(),
}));

vi.mock("../../lib/db-cache", () => ({
  getCaches: mocks.getCaches,
}));

vi.mock("../../lib/report-cards-snapshot", () => ({
  loadExactDexPublicationGeneration: mocks.loadDexGeneration,
}));

vi.mock("../../lib/report-cards-fixed-input", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../lib/report-cards-fixed-input")
    >();
  return {
    ...original,
    parseReportCardsFixedInputCacheArtifact: mocks.parseFixedInput,
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
      parseSafetyScoreV9SupplyAttributionGeneration:
        mocks.parseSupplyGeneration,
      isSafetyScoreV9SupplyAttributionGenerationCadenceDeferred:
        mocks.supplyGenerationCadenceDeferred,
    };
  },
);

vi.mock("../../lib/safety-score-v9-publication-runner", () => ({
  runSafetyScoreV9Publication: mocks.runPublication,
}));

const { computeSafetyScoreV9 } = await import("../compute-safety-score-v9");

describe("computeSafetyScoreV9", () => {
  beforeEach(() => {
    const fixedInput = {
      ...createSafetyScoreV9FullRegistryInput(),
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
});
