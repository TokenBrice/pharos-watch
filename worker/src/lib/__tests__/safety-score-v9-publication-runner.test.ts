import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import * as fixedInputCodec from "../report-cards-fixed-input-cache-codec";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { currentInput } from "./safety-score-v9-publication-store.test-support";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY } from "../safety-score-v9/publication-codec";
import type * as PublicationStore from "../safety-score-v9/publication-store";
import type * as AcceptedProjectionReaders from "../safety-score-v9/accepted-projection-readers";
import { buildSafetyScoreV9AcceptedBaselineProjection } from "../safety-score-v9/accepted-projections";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";

const mocks = vi.hoisted(() => ({
  assess: vi.fn(),
  build: vi.fn(),
  loadBaseline: vi.fn(),
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
vi.mock("../safety-score-v9/publication-store", async (importOriginal) => ({
  ...await importOriginal<typeof PublicationStore>(),
  persistSafetyScoreV9Publication: mocks.persist,
  persistSafetyScoreV9PublicationAttempt: mocks.persistAttempt,
}));
vi.mock("../safety-score-v9/accepted-projection-readers", async (importOriginal) => ({
  ...await importOriginal<typeof AcceptedProjectionReaders>(),
  loadSafetyScoreV9AcceptedBaselineState: mocks.loadBaseline,
}));

const { runSafetyScoreV9Publication } = await import(
  "../safety-score-v9/publication-runner"
);
const fixedInput = makeV9FixedInput({ assetId: "usdc-circle" });

function acceptedBaseline(publication: SafetyScoreV9CurrentResponse, held = false) {
  return {
    kind: "accepted" as const,
    projection: buildSafetyScoreV9AcceptedBaselineProjection(publication),
    health: {
      ...currentInput(publication).publicationHealth,
      ...(held ? { status: "held" as const, heldSinceSec: publication.publishedAtSec, reasons: [{ code: "dex-stale" as const }] } : {}),
    },
  };
}

describe("Safety Score V9 publication runner", () => {
  it("does not roll back accepted cards when the journal D1 read throws", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    try {
      sqlite.exec("DROP TABLE safety_score_publication_journal");
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      const result = await runSafetyScoreV9Publication({ db, fixedInput, nowSec: fixedInput.clockSec });
      expect(result).toMatchObject({ status: "published", journal: { status: "failed", reason: "journal-write-failed", rows: 0 } });
      expect((await store.loadSafetyScoreV9Publication(db))?.publishedAtSec).toBe(fixedInput.clockSec);
      expect((await store.loadSafetyScoreV9PublicationHealth(db))?.status).toBe("current");
    } finally { sqlite.close(); }
  });
  it("publishes despite replay serialization failure and retains the previous generation pair", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const prior = makeWorkerSafetyScoreV9Publication({ publishedAtSec: fixedInput.clockSec - 100, publicationGenerationId: "report-cards:v9:prior" });
    const serialization = vi.spyOn(fixedInputCodec, "buildFixedInputCacheEntry").mockRejectedValueOnce(new Error("Replay delta exceeds byte ceiling"));
    const put = vi.fn().mockResolvedValue({ key: "stored" });
    try {
      await store.persistSafetyScoreV9Publication(db, { ...currentInput(prior), publicationReplayCaptureValue: "prior-delta", publicationReplayBaseValue: "prior-base" });
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      const result = await runSafetyScoreV9Publication({ db, fixedInput, fixedInputCacheValue: "current-base",
        nowSec: fixedInput.clockSec, captureArchiveBucket: { put } as unknown as R2Bucket });
      expect(result).toMatchObject({ status: "published", captureArchive: {
        status: "skipped", reason: "accepted-replay-unavailable",
      } });
      expect(put).not.toHaveBeenCalled();
      expect((await store.loadSafetyScoreV9Publication(db))?.publishedAtSec).toBe(fixedInput.clockSec);
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY)?.value).toBe("prior-delta");
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY)?.value).toBe("prior-base");
    } finally {
      serialization.mockRestore();
      sqlite.close();
    }
  });
  it.each(["upload", "index"] as const)("never rolls back accepted publication on archive %s failure", async failure => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const put = vi.fn().mockResolvedValue({ key: "stored" });
    try {
      if (failure === "upload") put.mockRejectedValue(new Error("R2 unavailable"));
      else sqlite.exec("DROP TABLE safety_score_capture_archive");
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      const result = await runSafetyScoreV9Publication({
        db, fixedInput, fixedInputCacheValue: "exact-base", nowSec: fixedInput.clockSec,
        captureArchiveBucket: { put } as unknown as R2Bucket,
      });
      expect(result).toMatchObject({ status: "published", captureArchive: {
        status: "failed", reason: failure === "upload" ? "capture-upload-failed" : "capture-index-write-failed",
      } });
      expect((await store.loadSafetyScoreV9Publication(db))?.publishedAtSec).toBe(fixedInput.clockSec);
      expect((await store.loadSafetyScoreV9PublicationHealth(db))?.status).toBe("current");
      expect(put).toHaveBeenCalledOnce();
    } finally { sqlite.close(); }
  });

  it.each(["held", "failed"] as const)("archives nothing when publication is %s", async outcome => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const put = vi.fn().mockResolvedValue({ key: "stored" });
    try {
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      if (outcome === "held") mocks.assess.mockReturnValue({
        decision: "hold", reasons: [{ code: "dex-stale" }], affectedAssetIds: [],
      });
      else mocks.persist.mockRejectedValue(new Error("canonical write failed"));
      const result = await runSafetyScoreV9Publication({
        db, fixedInput, fixedInputCacheValue: "exact-base", nowSec: fixedInput.clockSec,
        captureArchiveBucket: { put } as unknown as R2Bucket,
      });
      expect(result).toMatchObject({ status: outcome, captureArchive: {
        status: "skipped", reason: `publication-${outcome}`,
      } });
      expect(put).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
    } finally { sqlite.close(); }
  });
  it("archives the newly accepted cache transports even when the journal fails", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const put = vi.fn().mockResolvedValue({ key: "stored" });
    try {
      sqlite.exec("DROP TABLE safety_score_publication_journal");
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      const result = await runSafetyScoreV9Publication({
        db, fixedInput, fixedInputCacheValue: "exact-base", nowSec: fixedInput.clockSec,
        captureArchiveBucket: { put } as unknown as R2Bucket,
      });
      expect(result).toMatchObject({ status: "published", journal: { status: "failed" },
        captureArchive: { status: "written" } });
      const object = JSON.parse(put.mock.calls[0]![1]);
      for (const row of [object.base, object.delta, object.cards]) {
        expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(row.key))
          .toEqual({ value: row.value, updated_at: row.updatedAt });
      }
      expect(sqlite.prepare("SELECT generation_id FROM safety_score_capture_archive").get())
        .toEqual({ generation_id: result.status === "published" ? result.publicationGenerationId : null });
    } finally { sqlite.close(); }
  });
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
    mocks.loadBaseline.mockReset().mockResolvedValue({ kind: "bootstrap", health: null });
    mocks.persist.mockReset().mockResolvedValue(null);
    mocks.persistAttempt.mockReset().mockResolvedValue(undefined);
    mocks.persistAlertEnvelope.mockReset().mockResolvedValue(undefined);
  });

  it("fails before compiling when the accepted publication is missing its baseline projection", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const prior = makeWorkerSafetyScoreV9Publication({ publishedAtSec: fixedInput.clockSec - 100 });
    try {
      await store.persistSafetyScoreV9Publication(db, currentInput(prior));
      sqlite.prepare("DELETE FROM cache WHERE key = ?").run(store.SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline);
      const before = sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all();
      const readers = await vi.importActual<typeof AcceptedProjectionReaders>("../safety-score-v9/accepted-projection-readers");
      mocks.loadBaseline.mockImplementation(readers.loadSafetyScoreV9AcceptedBaselineState);
      mocks.persistAttempt.mockImplementation(store.persistSafetyScoreV9PublicationAttempt);
      const result = await runSafetyScoreV9Publication({ db, fixedInput, nowSec: fixedInput.clockSec });
      expect(result).toMatchObject({ status: "failed", stage: "publication-gate",
        code: "safety-score-v9-accepted-baseline-projection-missing" });
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
      expect((await store.loadSafetyScoreV9FailedPublicationAttempt(db))?.failure?.code).toBe(
        "safety-score-v9-accepted-baseline-projection-missing",
      );
      for (const row of before) {
        if (row.key === store.SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt) continue;
        expect(sqlite.prepare("SELECT key, value, updated_at FROM cache WHERE key = ?").get(row.key)).toEqual(row);
      }
    } finally { sqlite.close(); }
  });

  it("uses the retained baseline while publication health is held", async () => {
    const accepted = makeWorkerSafetyScoreV9Publication({ publishedAtSec: fixedInput.clockSec - 100 });
    const state = acceptedBaseline(accepted, true);
    mocks.loadBaseline.mockResolvedValue(state);
    const result = await runSafetyScoreV9Publication({ db: {} as D1Database, fixedInput });
    expect(result.status).toBe("published");
    expect(mocks.assess).toHaveBeenCalledWith(expect.objectContaining({ acceptedPublication: state.projection.baseline }));
  });

  it.each([
    ["projection-missing", "missing"],
    ["projection-invalid", "invalid"],
    ["publication-invalid", "invalid"],
    ["publication-mismatch", "publication-mismatch"],
    ["health-unavailable", "invalid"],
    ["health-mismatch", "publication-mismatch"],
    ["read-failed", "read-failed"],
  ] as const)("records a named pre-compile failure for %s", async (reason, suffix) => {
    mocks.loadBaseline.mockResolvedValue({ kind: "unavailable", reason });
    const code = `safety-score-v9-accepted-baseline-projection-${suffix}`;
    const result = await runSafetyScoreV9Publication({ db: {} as D1Database, fixedInput });
    expect(result).toMatchObject({ status: "failed", stage: "publication-gate", code });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.persistAttempt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      publicationAttempt: expect.objectContaining({
        outcome: "failed", failure: expect.objectContaining({ stage: "publication-gate", code }),
      }),
    }));
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
    mocks.loadBaseline.mockImplementation(async () => {
      order.push("accepted-loaded");
      return acceptedBaseline(accepted);
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
            }),
          ]),
        }),
      }),
    );
  });

  it("holds an empty but fulfilled independent live-reserve map", async () => {
    const { assessV9Publication } = await vi.importActual<
      typeof import("../safety-score-v9/publication-assessment")
    >("../safety-score-v9/publication-assessment");
    mocks.assess.mockImplementation(assessV9Publication);
    const { baseInputGenerationId: _baseId, ...draft } =
      createSafetyScoreV9FullRegistryInput();
    draft.liveReserveMap = {};
    draft.v9PublicationInputHealth = {
      dex: {
        state: "current",
        generationId: draft.dexGenerationId,
        updatedAtSec: draft.clockSec,
      },
      redemption: {
        state: "not-applicable",
        generationId: null,
        updatedAtSec: null,
      },
      liveReserves: { state: "available", coverageRatio: 0 },
    };
    const emptyReserveInput = createReportCardsFixedInput(draft);
    const cards = draft.activeAssetIds.map((id) => makeWorkerV9Card({ id }));
    mocks.build.mockReturnValue({
      candidate: makeWorkerSafetyScoreV9Publication({
        cards,
        baseInputGenerationId: emptyReserveInput.baseInputGenerationId,
        publishedAtSec: emptyReserveInput.clockSec,
        sourceGenerations: { dex: emptyReserveInput.dexGenerationId },
      }),
      compilerFactSchemaDigest: "1".repeat(64),
      producerCapabilityDigest: "2".repeat(64),
      quarantines: [],
      quarantineAffectedAssetIds: [],
      bridgeJoinDiagnostics: [],
    });

    await expect(
      runSafetyScoreV9Publication({
        db: {} as D1Database,
        fixedInput: emptyReserveInput,
      }),
    ).resolves.toMatchObject({
      status: "held",
      reasons: [{ code: "live-reserves-coverage-below-floor" }],
    });
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
      liveReserves: { state: "available", coverageRatio: 1 },
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
    mocks.loadBaseline.mockResolvedValue(acceptedBaseline(accepted));
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
        { assetId: "alpha", code: "evaluation-failed", message: "fixture evaluation quarantine" },
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

  it("still rejects a mutated base input when preparation declares itself pre-normalized", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: fixedInput.clockSec,
      // The composition shortcut only skips re-parsing the base payload; the
      // base-identity assertion must still reject a moved generation.
      preparedFixedInputAlreadyNormalized: true,
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
  });

  it("accepts a pre-normalized prepared input that keeps the base identity", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database,
      fixedInput,
      nowSec: fixedInput.clockSec,
      preparedFixedInputAlreadyNormalized: true,
      prepareFixedInput: async (input) => ({
        ...input,
        evidenceJournalById: { "usdc-circle": [] },
      }),
    });

    expect(result.status).toBe("published");
    expect(mocks.persist).toHaveBeenCalledTimes(1);
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


  it("holds with the retained identity when assessment itself fails", async () => {
    const accepted = makeWorkerSafetyScoreV9Publication({
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: "report-cards:v9:accepted",
      publishedAtSec: fixedInput.clockSec - 30,
    });
    mocks.loadBaseline.mockResolvedValue(acceptedBaseline(accepted));
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
