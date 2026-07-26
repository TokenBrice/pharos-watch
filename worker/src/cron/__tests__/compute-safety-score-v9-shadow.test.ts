import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";

const mockGetCaches = vi.fn();
const mockSetCacheMany = vi.fn();
const mockParseFixedInput = vi.fn();
const mockParsePegProvenanceSeed = vi.fn();
const mockBuildSnapshotFromFixedInput = vi.fn();
const mockBuildV9FixedInputCacheEntry = vi.fn();
const mockBuildPublicationPlan = vi.fn();
const mockRunShadow = vi.fn();
const mockApplySupplyGeneration = vi.fn();
const mockParseSupplyGeneration = vi.fn();
const mockLoadEvidenceJournal = vi.fn();
const mockLoadSupplyJournal = vi.fn();

vi.mock("../../lib/db-cache", () => ({
  getCaches: mockGetCaches,
  setCacheMany: mockSetCacheMany,
}));

vi.mock("../../lib/report-cards-fixed-input", () => ({
  REPORT_CARDS_FIXED_INPUT_CACHE_KEY: "report-cards:fixed-input:exact",
  parseReportCardsFixedInputCacheArtifact: mockParseFixedInput,
  buildReportCardsSnapshotFromFixedInput:
    mockBuildSnapshotFromFixedInput,
  buildSafetyScoreV9FixedInputCacheEntry:
    mockBuildV9FixedInputCacheEntry,
}));

vi.mock("../../lib/safety-score-v9-peg-provenance", () => ({
  SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY:
    "report-cards:v9-peg-provenance-seed:exact",
  parseSafetyScoreV9PegProvenanceSeed:
    mockParsePegProvenanceSeed,
}));

vi.mock("../../lib/report-card-publication", () => ({
  buildReportCardPublicationPlan: mockBuildPublicationPlan,
}));

vi.mock("../../lib/safety-score-v9-shadow-runner", () => ({
  runSafetyScoreV9ShadowAfterV8Publication: mockRunShadow,
}));

vi.mock("../../lib/safety-score-v9-supply-attribution", () => ({
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_ASSET_IDS: ["usdc-circle"],
}));

vi.mock(
  "../../lib/safety-score-v9-supply-attribution-generation",
  () => ({
    SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY:
      "safety-score-v9:supply-attribution-generation:v1",
    applySafetyScoreV9SupplyAttributionGeneration:
      mockApplySupplyGeneration,
    parseSafetyScoreV9SupplyAttributionGeneration:
      mockParseSupplyGeneration,
  }),
);

vi.mock("../../lib/report-card-evidence-journal-store", () => ({
  loadReportCardEvidenceJournalByIdV1: mockLoadEvidenceJournal,
}));

vi.mock(
  "../../lib/safety-score-v9-supply-attribution-journal-store",
  () => ({
    loadSupplyAttributionJournalByIdV1: mockLoadSupplyJournal,
  }),
);

const { computeSafetyScoreV9Shadow } = await import(
  "../compute-safety-score-v9-shadow"
);

const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${"a".repeat(
  64,
)}`;
const SOURCE_GENERATION =
  "report-cards:v8.11:1785067200";

function exactInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    methodologyVersion: "v8.11",
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    sourceGeneration: SOURCE_GENERATION,
    clockSec: 1_785_067_200,
    updatedAt: 1_785_067_200,
    activeAssetIds: ["usdc-circle", "nav-token"],
    pegDataById: {
      "usdc-circle": { id: "usdc-circle" },
    },
    pegProvenanceById: {},
    ...overrides,
  };
}

function identity() {
  return buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: "v8.11",
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    publicationGenerationId: SOURCE_GENERATION,
  });
}

function installExactArtifacts(
  overrides: {
    v8Identity?: ReturnType<typeof identity> | null;
    v9Identity?: ReturnType<typeof identity> | null;
    v9Input?: Record<string, unknown>;
    includeSeed?: boolean;
  } = {},
) {
  const v8Input = exactInput();
  const v9Input =
    overrides.v9Input ??
    exactInput({
      pegProvenanceById: {
        "usdc-circle": { contentSha256: "peg-summary" },
      },
    });
  const caches = new Map<string, { value: string; updatedAt: number }>([
    [
      "report-cards:fixed-input:exact",
      { value: "v8-artifact", updatedAt: 1_785_067_200 },
    ],
  ]);
  if (overrides.includeSeed !== false) {
    caches.set("report-cards:v9-peg-provenance-seed:exact", {
      value: "v9-artifact",
      updatedAt: 1_785_067_200,
    });
  }
  mockGetCaches.mockResolvedValue(caches);
  mockParseFixedInput.mockResolvedValue({
    input: v8Input,
    safetyScoreIdentity:
      overrides.v8Identity === undefined
        ? identity()
        : overrides.v8Identity,
  });
  mockParsePegProvenanceSeed.mockReturnValue({
    schemaVersion: 1,
    kind: "safety-score-v9-peg-provenance-exact-seed",
    sourceGeneration: v9Input.sourceGeneration,
    clockSec: v9Input.clockSec,
    safetyScoreIdentity:
      overrides.v9Identity === undefined
        ? identity()
        : overrides.v9Identity,
    pegProvenanceById: v9Input.pegProvenanceById,
    contentSha256: "c".repeat(64),
  });
}

describe("computeSafetyScoreV9Shadow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installExactArtifacts();
    mockBuildSnapshotFromFixedInput.mockReturnValue({
      cards: [{ id: "usdc-circle", overallScore: 90 }],
    });
    mockBuildPublicationPlan.mockReturnValue({
      activeCards: [{ id: "usdc-circle", overallScore: 90 }],
      completeness: {
        generationId: SOURCE_GENERATION,
        expectedCount: 1,
      },
    });
    mockApplySupplyGeneration.mockImplementation((input) => ({
      status: "unavailable",
      generationId: null,
      reason: "generation-missing",
      fixedInput: input,
    }));
    mockLoadEvidenceJournal.mockResolvedValue({});
    mockLoadSupplyJournal.mockResolvedValue({});
    mockBuildV9FixedInputCacheEntry.mockResolvedValue({
      key: "report-cards:v9-fixed-input:exact",
      value: "compiled-input",
      storedBytes: 300,
      uncompressedBytes: 600,
    });
    mockSetCacheMany.mockResolvedValue(undefined);
    mockRunShadow.mockImplementation(async (options) => {
      await options.prepareFixedInput(
        options.fixedInput,
        new AbortController().signal,
      );
      return {
        status: "published",
        publicationGenerationId: "v9-generation",
        pendingReviewCount: 0,
      };
    });
  });

  it("compiles from the publication-exact seed and persists the prepared V9 input", async () => {
    const result = await computeSafetyScoreV9Shadow(
      {} as D1Database,
    );

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(1);
    expect(mockBuildSnapshotFromFixedInput).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceGeneration: SOURCE_GENERATION,
        pegProvenanceById: {},
      }),
    );
    expect(mockRunShadow).toHaveBeenCalledWith(
      expect.objectContaining({
        fixedInput: expect.objectContaining({
          pegProvenanceById: {
            "usdc-circle": {
              contentSha256: "peg-summary",
            },
          },
        }),
        v8MethodologyVersion: "v8.11",
      }),
    );
    expect(mockSetCacheMany).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          key: "report-cards:v9-fixed-input:exact",
        }),
      ],
      expect.any(AbortSignal),
    );
  });

  it("rejects a seed whose full V8 identity has a different evaluation build", async () => {
    installExactArtifacts({
      v9Identity: {
        ...identity(),
        evaluationBuildDigest: "b".repeat(64),
      },
    });

    const result = await computeSafetyScoreV9Shadow(
      {} as D1Database,
    );

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "v8-v9-exact-identity-mismatch",
    });
    expect(mockRunShadow).not.toHaveBeenCalled();
  });

  it("rejects provenance with the right count but the wrong asset set", async () => {
    installExactArtifacts({
      v9Input: exactInput({
        pegProvenanceById: {
          "wrong-asset": { contentSha256: "peg-summary" },
        },
      }),
    });

    const result = await computeSafetyScoreV9Shadow(
      {} as D1Database,
    );

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "v9-peg-provenance-incomplete",
      expectedCount: 1,
      presentCount: 1,
    });
    expect(mockRunShadow).not.toHaveBeenCalled();
  });

  it("does not require peg provenance for an active NAV token without a peg row", async () => {
    installExactArtifacts({
      v9Input: exactInput({
        activeAssetIds: ["usdc-circle", "nav-token"],
        pegProvenanceById: {
          "usdc-circle": { contentSha256: "peg-summary" },
        },
      }),
    });
    mockBuildSnapshotFromFixedInput.mockReturnValue({
      cards: [
        { id: "usdc-circle", overallScore: 90 },
        { id: "nav-token", overallScore: 80 },
      ],
    });
    mockBuildPublicationPlan.mockReturnValue({
      activeCards: [
        { id: "usdc-circle", overallScore: 90 },
        { id: "nav-token", overallScore: 80 },
      ],
      completeness: {
        generationId: SOURCE_GENERATION,
        expectedCount: 2,
      },
    });

    const result = await computeSafetyScoreV9Shadow(
      {} as D1Database,
    );

    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(2);
    expect(mockRunShadow).toHaveBeenCalledTimes(1);
  });

  it("fails closed without a publication-exact V9 seed", async () => {
    installExactArtifacts({ includeSeed: false });

    const result = await computeSafetyScoreV9Shadow(
      {} as D1Database,
    );

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!)).toMatchObject({
      reason: "v9-exact-seed-missing",
    });
    expect(mockParseFixedInput).not.toHaveBeenCalled();
    expect(mockParsePegProvenanceSeed).not.toHaveBeenCalled();
    expect(mockRunShadow).not.toHaveBeenCalled();
  });
});
