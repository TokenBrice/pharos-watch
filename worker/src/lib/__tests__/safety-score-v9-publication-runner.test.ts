import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

const mocks = vi.hoisted(() => ({
  assess: vi.fn(),
  build: vi.fn(),
  loadHealth: vi.fn(),
  loadPublication: vi.fn(),
  persist: vi.fn(),
}));

vi.mock("../safety-score-v9-candidate", () => ({
  buildSafetyScoreV9PublicationFromNormalizedInput: mocks.build,
}));
vi.mock("../safety-score-v9-publication-assessment", async (importOriginal) => ({
  ...await importOriginal<
    typeof import("../safety-score-v9-publication-assessment")
  >(),
  assessV9Publication: mocks.assess,
}));
vi.mock("../safety-score-v9-publication-store", () => ({
  loadSafetyScoreV9Publication: mocks.loadPublication,
  loadSafetyScoreV9PublicationHealth: mocks.loadHealth,
  persistSafetyScoreV9Publication: mocks.persist,
}));

const { runSafetyScoreV9Publication } = await import(
  "../safety-score-v9-publication-runner"
);
const fixedInput = createSafetyScoreV9FullRegistryInput();

describe("Safety Score V9 publication runner", () => {
  beforeEach(() => {
    const publication = makeWorkerSafetyScoreV9Publication({
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      publishedAtSec: fixedInput.clockSec,
    });
    mocks.assess.mockReset().mockReturnValue({
      decision: "publish",
      reasons: [],
      affectedAssetIds: [],
    });
    mocks.build.mockReset().mockReturnValue({
      candidate: publication,
      compilerFactSchemaDigest: "1".repeat(64),
      producerCapabilityDigest: "2".repeat(64),
      quarantines: [],
      quarantineAffectedAssetIds: [],
    });
    mocks.loadHealth.mockReset().mockResolvedValue(null);
    mocks.loadPublication.mockReset().mockResolvedValue(null);
    mocks.persist.mockReset().mockResolvedValue(undefined);
  });

  it("publishes an accepted canonical candidate", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: 2_000_000_000,
    });

    expect(result.status).toBe("published");
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publication: expect.objectContaining({
          model: "v9-critical-path",
        }),
        publicationHealth: expect.objectContaining({
          status: "current",
        }),
        publicationAttempt: expect.objectContaining({
          outcome: "published-clean",
        }),
      }),
    );
  });

  it("updates only publication health when the assessment holds", async () => {
    mocks.assess.mockReturnValue({
      decision: "hold",
      reasons: [{ code: "dex-stale" }],
      affectedAssetIds: [],
    });

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: 2_000_000_000,
    });

    expect(result).toMatchObject({
      status: "held",
      reasons: [{ code: "dex-stale" }],
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ publication: expect.anything() }),
    );
  });

  it("publishes a bounded quarantine as a productive partial attempt", async () => {
    mocks.build.mockReturnValue({
      candidate: makeWorkerSafetyScoreV9Publication({
        baseInputGenerationId: fixedInput.baseInputGenerationId,
        publishedAtSec: fixedInput.clockSec,
      }),
      compilerFactSchemaDigest: "1".repeat(64),
      producerCapabilityDigest: "2".repeat(64),
      quarantines: [
        { assetId: "alpha", code: "fact-build-failed" },
      ],
      quarantineAffectedAssetIds: ["alpha"],
    });
    mocks.assess.mockReturnValue({
      decision: "publish",
      reasons: [],
      affectedAssetIds: ["alpha"],
    });

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
    });

    expect(result).toMatchObject({
      status: "published",
      outcome: "partial",
      affectedAssetIds: ["alpha"],
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicationAttempt: expect.objectContaining({
          outcome: "published-partial",
          affectedAssetIds: ["alpha"],
        }),
      }),
    );
  });
});
