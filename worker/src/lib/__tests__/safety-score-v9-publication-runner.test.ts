import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { createReportCardsFixedInput } from "../report-cards-fixed-input";
import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const mocks = vi.hoisted(() => ({
  assess: vi.fn(),
  build: vi.fn(),
  loadHealth: vi.fn(),
  loadPublication: vi.fn(),
  persist: vi.fn(),
  persistAttempt: vi.fn(),
  persistAlertEnvelope: vi.fn(),
}));

vi.mock("../alert-safety-source-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../alert-safety-source-cache")>(),
  persistAlertSafetyV9SourceEnvelope: mocks.persistAlertEnvelope,
}));

vi.mock("../safety-score-v9/candidate", () => ({
  buildSafetyScoreV9PublicationFromNormalizedInput: mocks.build,
}));
vi.mock("../safety-score-v9/publication-assessment", async (importOriginal) => ({
  ...await importOriginal<
    typeof import("../safety-score-v9/publication-assessment")
  >(),
  assessV9Publication: mocks.assess,
}));
vi.mock("../safety-score-v9/publication-store", () => ({
  loadSafetyScoreV9Publication: mocks.loadPublication,
  loadSafetyScoreV9PublicationHealth: mocks.loadHealth,
  persistSafetyScoreV9Publication: mocks.persist,
  persistSafetyScoreV9PublicationAttempt: mocks.persistAttempt,
}));

const { runSafetyScoreV9Publication } = await import(
  "../safety-score-v9/publication-runner"
);
const fixedInput = makeV9FixedInput({ assetId: "usdc-circle" });

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
      bridgeJoinDiagnostics: [],
    });
    mocks.loadHealth.mockReset().mockResolvedValue(null);
    mocks.loadPublication.mockReset().mockResolvedValue(null);
    mocks.persist.mockReset().mockResolvedValue(undefined);
    mocks.persistAttempt.mockReset().mockResolvedValue(undefined);
    mocks.persistAlertEnvelope.mockReset().mockResolvedValue(undefined);
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
    expect(mocks.persistAlertEnvelope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publishedAt: fixedInput.clockSec,
        safetyScoreIdentity: expect.objectContaining({ model: "v9" }),
        cards: expect.any(Array),
      }),
      expect.anything(),
    );
  });

  it("projects the accepted publication before compiling the next candidate", async () => {
    const order: string[] = [];
    const accepted = makeWorkerSafetyScoreV9Publication({
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: "report-cards:v9:accepted",
      publishedAtSec: fixedInput.clockSec - 30,
    });
    mocks.loadPublication.mockImplementation(async () => {
      order.push("accepted-loaded");
      return accepted;
    });
    mocks.build.mockImplementation(() => {
      order.push("candidate-compiled");
      return {
        candidate: makeWorkerSafetyScoreV9Publication({
          baseInputGenerationId: fixedInput.baseInputGenerationId,
          publishedAtSec: fixedInput.clockSec,
        }),
        compilerFactSchemaDigest: "1".repeat(64),
        producerCapabilityDigest: "2".repeat(64),
        quarantines: [],
        quarantineAffectedAssetIds: [],
        bridgeJoinDiagnostics: [],
      };
    });

    await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
    });

    expect(order).toEqual(["accepted-loaded", "candidate-compiled"]);
    expect(mocks.assess).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptedPublication: expect.objectContaining({
          publicationGenerationId: accepted.publicationGenerationId,
          policyId: accepted.policy.id,
          cards: expect.arrayContaining([
            expect.objectContaining({
              id: accepted.cards[0]!.id,
              producerFailedBindings: expect.any(Array),
            }),
          ]),
        }),
      }),
    );
  });

  it("does not persist an alert source envelope when the assessment holds", async () => {
    mocks.assess.mockReturnValue({
      decision: "hold",
      reasons: [{ code: "coverage-floor-failed", floorIds: ["minimum-rateable-assets"] }],
      affectedAssetIds: [],
    });

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: 2_000_000_000,
    });

    expect(result.status).toBe("held");
    expect(mocks.persistAlertEnvelope).not.toHaveBeenCalled();
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

  it("holds expired measured evidence without replacing accepted grades or alerts, then publishes recovered evidence", async () => {
    const { assessV9Publication } = await vi.importActual<
      typeof import("../safety-score-v9/publication-assessment")
    >("../safety-score-v9/publication-assessment");
    mocks.assess.mockImplementation(assessV9Publication);
    const { baseInputGenerationId: _baseId, ...draft } = createSafetyScoreV9FullRegistryInput();
    const assetId = draft.activeAssetIds[0]!;
    const observation = draft.dexLiqMap[assetId]!.exitRouteObservations![0]!;
    draft.v9PublicationInputHealth = {
      dex: { state: "current", generationId: draft.dexGenerationId, updatedAtSec: draft.clockSec },
      redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
      liveReserves: { state: "available" },
    };
    observation.evidenceKind = "measured-executable-depth";
    observation.confidence = "high";
    observation.observationHistory = {
      completeProducerCycleCount: 2,
      successfulObservationCount: 2,
      consecutiveSuccessCount: 2,
      observationWindowStartedAt: draft.clockSec - 12_601,
      observationWindowEndedAt: draft.clockSec - 10_801,
      latestOperationalFailureAt: null,
      conservativeStatistic: "pointwise-minimum",
      conservativeCapacityCurve: observation.capacityCurve ?? [],
    };
    const expiredInput = createReportCardsFixedInput(draft);
    const card = makeWorkerV9Card({ id: assetId, grade: "A-", score: 81 });
    card.breakdowns!.exit.primaryRoute!.key = canonicalV9RouteKey("dex", expiredInput.dexGenerationId, observation.routeId);
    const cards = draft.activeAssetIds.map((id) => id === assetId ? card : makeWorkerV9Card({ id }));
    const accepted = makeWorkerSafetyScoreV9Publication({
      cards,
      publishedAtSec: draft.clockSec - 1_800,
      sourceGenerations: { dex: expiredInput.dexGenerationId },
      publicationGenerationId: "report-cards:v9:accepted",
    });
    mocks.loadPublication.mockResolvedValue(accepted);
    const buildCandidate = (input: typeof expiredInput, expired: boolean) => mocks.build.mockReturnValue({
      candidate: makeWorkerSafetyScoreV9Publication({
        cards: cards.map((row) => expired && row.id === assetId ? { ...row, grade: "B", score: 72 } : row),
        completeness: { ...accepted.completeness, ratedCount: cards.length },
        baseInputGenerationId: input.baseInputGenerationId,
        publishedAtSec: input.clockSec,
        sourceGenerations: { dex: input.dexGenerationId },
      }),
      compilerFactSchemaDigest: "1".repeat(64),
      producerCapabilityDigest: "2".repeat(64),
      quarantines: [], quarantineAffectedAssetIds: [], bridgeJoinDiagnostics: [],
    });
    buildCandidate(expiredInput, true);
    expect(await runSafetyScoreV9Publication({ db: {} as D1Database, fixedInput: expiredInput })).toMatchObject({
      status: "held", reasons: [{ code: "dex-stale" }], affectedAssetIds: [assetId],
    });
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    const heldWrite = mocks.persist.mock.calls[0]![1];
    expect(heldWrite).not.toHaveProperty("publication");
    expect(heldWrite.publicationHealth).toMatchObject({
      status: "held", acceptedPublicationGenerationId: accepted.publicationGenerationId,
    });
    expect(mocks.persistAlertEnvelope).not.toHaveBeenCalled();

    observation.observationHistory.observationWindowEndedAt = draft.clockSec;
    const recoveredInput = createReportCardsFixedInput(draft);
    buildCandidate(recoveredInput, false);
    mocks.persist.mockClear();
    expect(await runSafetyScoreV9Publication({ db: {} as D1Database, fixedInput: recoveredInput })).toMatchObject({
      status: "published", outcome: "clean",
    });
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      publication: expect.objectContaining({ baseInputGenerationId: recoveredInput.baseInputGenerationId }),
      publicationHealth: expect.objectContaining({ status: "current" }),
    }));
    expect(mocks.persistAlertEnvelope).toHaveBeenCalledTimes(1);
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
      bridgeJoinDiagnostics: [],
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

  it("fails before mutation when the override clock is invalid", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: -1,
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "base-input",
      code: "safety-score-v9-publication-base-input-Error",
    });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.persistAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicationClockSec: expect.any(Number),
        publicationAttempt: expect.objectContaining({
          outcome: "failed",
          publicationGenerationId: null,
          failure: expect.objectContaining({
            stage: "base-input",
          }),
        }),
      }),
    );
  });

  it("fails when preparation mutates the authoritative base input", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: fixedInput.clockSec,
      prepareFixedInput: async (input) => ({
        ...input,
        sourceGeneration: "mutated-source-generation",
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "v9-enrichment",
    });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persistAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicationClockSec: fixedInput.clockSec,
        publicationAttempt: expect.objectContaining({
          attemptedAtSec: fixedInput.clockSec,
          outcome: "failed",
          failure: expect.objectContaining({
            stage: "v9-enrichment",
          }),
        }),
      }),
    );
  });

  it("rejects changed base content even when preparation preserves the claimed generation id", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: fixedInput.clockSec,
      prepareFixedInput: async (input) => ({
        ...input,
        clockSec: input.clockSec + 1,
      }),
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "v9-enrichment",
    });
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("records a failed attempt when compilation fails", async () => {
    mocks.build.mockImplementation(() => {
      throw new Error("compiler fixture failure");
    });

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: fixedInput.clockSec,
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "compile",
      message: "compiler fixture failure",
    });
    expect(mocks.persistAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicationClockSec: fixedInput.clockSec,
        publicationAttempt: expect.objectContaining({
          outcome: "failed",
          failure: expect.objectContaining({
            stage: "compile",
            message: "compiler fixture failure",
          }),
        }),
      }),
    );
  });

  it("preserves accepted state when publication assessment loading fails", async () => {
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
      bridgeJoinDiagnostics: [],
    });
    mocks.loadPublication.mockRejectedValue(new Error("read failed"));

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "publication-gate",
      message: "read failed",
    });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.persistAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicationAttempt: expect.objectContaining({
          outcome: "failed",
          failure: expect.objectContaining({
            stage: "publication-gate",
            message: "read failed",
          }),
        }),
      }),
    );
  });

  it("holds with the retained identity when assessment itself fails", async () => {
    const accepted = makeWorkerSafetyScoreV9Publication({
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: "report-cards:v9:accepted",
      publishedAtSec: fixedInput.clockSec - 30,
    });
    mocks.loadPublication.mockResolvedValue(accepted);
    mocks.loadHealth.mockResolvedValue({
      schemaVersion: 1,
      status: "current",
      acceptedPublicationGenerationId: accepted.publicationGenerationId,
      acceptedAtSec: accepted.publishedAtSec,
      attemptedAtSec: accepted.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    });
    mocks.assess.mockImplementation(() => {
      throw new Error("assessment failed");
    });

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
    });

    expect(result).toMatchObject({
      status: "held",
      reasons: [expect.objectContaining({ code: "assessment-failed" })],
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicationHealth: expect.objectContaining({
          status: "held",
          acceptedPublicationGenerationId: accepted.publicationGenerationId,
          acceptedAtSec: accepted.publishedAtSec,
        }),
      }),
    );
    expect(mocks.persistAttempt).not.toHaveBeenCalled();
  });

  it("records a failed attempt when publication writing fails", async () => {
    mocks.persist.mockRejectedValue(new Error("write failed"));

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "publication-write",
      message: "write failed",
    });
    expect(mocks.persistAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicationAttempt: expect.objectContaining({
          outcome: "failed",
          failure: expect.objectContaining({
            stage: "publication-write",
            message: "write failed",
          }),
        }),
      }),
    );
  });

  it("returns an aborted failure without attempting a follow-up ledger write", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      signal: controller.signal,
      prepareFixedInput: async (_input, signal) => {
        throw signal.reason;
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      stage: "aborted",
    });
    expect(mocks.persistAttempt).not.toHaveBeenCalled();
  });
});
