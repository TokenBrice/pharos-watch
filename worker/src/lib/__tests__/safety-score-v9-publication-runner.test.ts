import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorkerSafetyScoreV9Publication, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { createReportCardsFixedInput } from "../../test-helpers/report-cards-fixed-input";
import { canonicalV9RouteKey } from "@shared/lib/safety-score-v9/facts";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import * as fixedInputCodec from "../report-cards-fixed-input-cache-codec";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { currentInput } from "./safety-score-v9-publication-store.test-support";
import * as publicMaterialization from "../report-cards-v9-materialization";
import { materializeV9AcceptedPublication } from "../report-cards-v9-materialization";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY } from "../safety-score-v9/publication-codec";
import type * as PublicationStore from "../safety-score-v9/publication-store";
import { loadSafetyScoreV9PublicationStoredRow } from "../safety-score-v9/publication-chunks";
import * as publicationHealth from "../safety-score-v9/publication-health";
import * as publicationAttempts from "../safety-score-v9/publication-attempts";
import type * as AcceptedProjectionReaders from "../safety-score-v9/accepted-projection-readers";
import { buildSafetyScoreV9AcceptedBaselineProjection } from "../safety-score-v9/accepted-projections";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { runSafetyScoreV9Publication, getSafetyScoreV9PublicationBudgetMs, retryPendingSafetyScoreV9PublicMaterialization, recoverSafetyScoreV9PublicMaterialization } from "../safety-score-v9/publication-runner";
import { V9_PUBLIC_MATERIALIZATION_CACHE_KEY } from "@shared/types/report-cards-v9-materialization";
import * as publicationCodec from "../safety-score-v9/publication-codec";
import * as evaluateSet from "@shared/lib/safety-score-v9/evaluate-set";

const mocks = vi.hoisted(() => ({
  assess: vi.fn(),
  build: vi.fn(),
  loadBaseline: vi.fn(),
  loadIdentity: vi.fn(),
  loadHealth: vi.fn(),
  persist: vi.fn(),
  persistAttempt: vi.fn(),
  persistAlertEnvelope: vi.fn(),
}));

vi.mock("../alert-safety-source-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../alert-safety-source-cache")>(),
  persistAlertSafetyV9SourceEnvelope: mocks.persistAlertEnvelope,
}));

vi.mock("../safety-score-v9/candidate", () => ({
  buildSafetyScoreV9PublicationFromOwnedInput: mocks.build,
}));
vi.mock("../safety-score-v9/publication-assessment", async (importOriginal) => ({
  ...await importOriginal<
    typeof import("../safety-score-v9/publication-assessment")
  >(),
  assessV9Publication: mocks.assess,
}));
vi.mock("../safety-score-v9/publication-store", async (importOriginal) => {
  const original = await importOriginal<typeof PublicationStore>();
  mocks.loadIdentity.mockImplementation(original.loadSafetyScoreV9PublicationIdentityEnvelope);
  return {
    ...original,
    persistSafetyScoreV9Publication: mocks.persist,
    persistSafetyScoreV9PublicationAttempt: mocks.persistAttempt,
    loadSafetyScoreV9PublicationIdentityEnvelope: mocks.loadIdentity,
  };
});
vi.mock("../safety-score-v9/publication-health", async (importOriginal) => {
  const original = await importOriginal<typeof publicationHealth>();
  mocks.loadHealth.mockImplementation(original.loadSafetyScoreV9PublicationHealth);
  return { ...original, loadSafetyScoreV9PublicationHealth: mocks.loadHealth };
});
vi.mock("../safety-score-v9/accepted-projection-readers", async (importOriginal) => ({
  ...await importOriginal<typeof AcceptedProjectionReaders>(),
  loadSafetyScoreV9AcceptedBaselineState: mocks.loadBaseline,
}));

const fixedInput = makeV9FixedInput({ assetId: "usdc-circle" });
const noMeasuredExitExpiry = { assetIds: [], witnessesByAssetId: {} };

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
  it("retries an unselected acceptance without changing canonical bytes", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const publication = makeWorkerSafetyScoreV9Publication();
    try {
      await store.persistSafetyScoreV9Publication(db, { ...currentInput(publication), deferPublicMaterialization: true });
      const acceptedRows = sqlite.prepare("SELECT * FROM cache ORDER BY key").all();
      vi.useFakeTimers({ toFake: ["Date"] });
      const retry = await retryPendingSafetyScoreV9PublicMaterialization(db, undefined, Date.now() + 180_000);
      expect(retry).toMatchObject({ status: "materialized", publicationGenerationId: publication.publicationGenerationId, budgetMs: 175_000 });
      expect(Object.values(retry!).every(value => value === null || typeof value === "string" || typeof value === "number")).toBe(true);
      for (const row of acceptedRows) expect(sqlite.prepare("SELECT * FROM cache WHERE key = ?").get(row.key)).toEqual(row);
      const decode = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
      const materialize = vi.spyOn(publicMaterialization, "materializeV9AcceptedPublication");
      try {
        expect(await retryPendingSafetyScoreV9PublicMaterialization(db, undefined, Date.now() + 180_000)).toBeNull();
        expect(decode).not.toHaveBeenCalled();
        expect(materialize).not.toHaveBeenCalled();
      } finally { decode.mockRestore(); materialize.mockRestore(); }
    } finally { vi.useRealTimers(); sqlite.close(); }
  });

  it.each(["aborted", "ambiguous", "deadline"])("confirms committed selection after a late %s outcome", async mode => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const publication = makeWorkerSafetyScoreV9Publication();
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadlineMs = Date.now() + 180_000;
    try {
      await store.persistSafetyScoreV9Publication(db, { ...currentInput(publication), deferPublicMaterialization: true });
      const batch = db.batch.bind(db);
      const spy = vi.spyOn(db, "batch").mockImplementation(async statements => {
        const results = await batch(statements);
        if (sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)) {
          if (mode === "deadline") vi.setSystemTime(deadlineMs + 1);
          else controller.abort(new DOMException("Late abort", "AbortError"));
          if (mode === "ambiguous") throw new Error("Acknowledgement lost after commit");
        }
        return results;
      });
      const result = await recoverSafetyScoreV9PublicMaterialization(db, controller.signal, deadlineMs);
      expect(result.status).toBe("ok");
      expect(JSON.parse(result.metadata!)).toMatchObject({ reason: "v9-public-materialization-retry-materialized" });
      spy.mockRestore();
    } finally { vi.useRealTimers(); sqlite.close(); }
  });

  it.each(["failed", "timeout"])("records %s recovery without a candidate computation", async mode => {
    const error = mode === "timeout" ? new DOMException("Timeout", "TimeoutError") : new Error("D1 unavailable");
    const db = makeNoopD1({ prepare: () => { throw error; } });
    const result = await recoverSafetyScoreV9PublicMaterialization(db, new AbortController().signal, Date.now() + 180_000);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!)).toMatchObject({ reason: `v9-public-materialization-retry-${mode}` });
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it.each([
    { remainingMs: 180_000, budgetMs: 175_000 },
    { remainingMs: 140_000, budgetMs: 135_000 },
    { remainingMs: 5_000, budgetMs: 0 },
  ])("caps retry at $budgetMs ms with $remainingMs ms remaining", async ({ remainingMs, budgetMs }) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    vi.useFakeTimers({ toFake: ["Date"] });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const prepare = vi.spyOn(db, "prepare");
    try {
      const result = await retryPendingSafetyScoreV9PublicMaterialization(db, undefined, Date.now() + remainingMs);
      if (budgetMs === 0) {
        expect(result).toMatchObject({ status: "skipped", budgetMs: 0, reason: "v9-public-materialization-retry-insufficient-budget" });
        expect(prepare).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ status: "skipped", reason: "v9-public-materialization-retry-source-unavailable" });
        expect(timeout).toHaveBeenCalledWith(budgetMs);
        expect(remainingMs - budgetMs).toBe(5_000);
      }
    } finally { timeout.mockRestore(); prepare.mockRestore(); vi.useRealTimers(); sqlite.close(); }
  });

  it("stops before decode when metadata IO consumes the retry budget before its timer fires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const decode = vi.spyOn(publicationCodec, "parseSafetyScoreV9Publication");
    const db = makeNoopD1({ prepare: () => ({ bind: () => ({ first: async () => {
      vi.setSystemTime(now + 175_001);
      return null;
    } }) }) });
    try {
      await expect(retryPendingSafetyScoreV9PublicMaterialization(db, undefined, now + 180_000)).rejects.toMatchObject({ name: "TimeoutError" });
      expect(decode).not.toHaveBeenCalled();
    } finally { decode.mockRestore(); vi.useRealTimers(); }
  });

  it("does not roll back accepted cards when the journal D1 read throws", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    try {
      sqlite.exec("DROP TABLE safety_score_publication_journal");
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      const result = await runSafetyScoreV9Publication({ db, fixedInput, nowSec: fixedInput.clockSec });
      expect(result).toMatchObject({ status: "published", journal: { status: "failed", reason: "journal-write-failed", rows: 0 } });
      expect((await store.loadSafetyScoreV9Publication(db))?.publishedAtSec).toBe(fixedInput.clockSec);
      expect((await publicationHealth.loadSafetyScoreV9PublicationHealth(db))?.status).toBe("current");
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
      expect((await publicationHealth.loadSafetyScoreV9PublicationHealth(db))?.status).toBe("current");
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
      for (const row of [object.base, object.delta]) {
        expect(sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(row.key))
          .toEqual({ value: row.value, updated_at: row.updatedAt });
      }
      // The canonical row is a sharded envelope; the archive keeps the reassembled stored value.
      expect(await loadSafetyScoreV9PublicationStoredRow(db)).toEqual({ value: object.cards.value, updatedAt: object.cards.updatedAt });
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
      bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry,
    });
    mocks.loadBaseline.mockReset().mockResolvedValue({ kind: "bootstrap", health: null });
    mocks.loadIdentity.mockClear();
    mocks.loadHealth.mockClear();
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
      sqlite.prepare("DELETE FROM cache WHERE key = ?").run(publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline);
      const before = sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all();
      const readers = await vi.importActual<typeof AcceptedProjectionReaders>("../safety-score-v9/accepted-projection-readers");
      mocks.loadBaseline.mockImplementation(readers.loadSafetyScoreV9AcceptedBaselineState);
      mocks.persistAttempt.mockImplementation(store.persistSafetyScoreV9PublicationAttempt);
      const result = await runSafetyScoreV9Publication({ db, fixedInput, nowSec: fixedInput.clockSec });
      expect(result).toMatchObject({ status: "failed", stage: "publication-gate",
        code: "safety-score-v9-accepted-baseline-projection-missing" });
      expect(mocks.build).not.toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
      expect((await publicationAttempts.loadSafetyScoreV9FailedPublicationAttempt(db))?.failure?.code).toBe(
        "safety-score-v9-accepted-baseline-projection-missing",
      );
      for (const row of before) {
        if (row.key === publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt) continue;
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

  it("transfers input ownership and reloads complete retry facts without mutating the caller", async () => {
    const { normalizeSafetyScoreV9CompilerInput } = await import("../safety-score-v9/native-input");
    const original = normalizeSafetyScoreV9CompilerInput(fixedInput);
    const expected = structuredClone(original);
    const owner = { value: original as typeof original | null };
    const pipeline = mocks.build.getMockImplementation()!();
    mocks.build.mockImplementationOnce(({ fixedInputOwner }) => {
      expect(owner.value).toBeNull();
      expect(fixedInputOwner.value).toBe(original);
      fixedInputOwner.value = null;
      const reloaded = fixedInputOwner.reload();
      expect(reloaded).not.toBe(original);
      expect(reloaded).toEqual(expected);
      return pipeline;
    });
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database, fixedInput: null, fixedInputOwner: owner,
      nowSec: original.clockSec,
    });
    expect(result.status).toBe("published");
    expect(original).toEqual(expected);
    expect(owner.value).toBeNull();
    expect(() => mocks.build.mock.calls[0]![0].fixedInputOwner.reload()).toThrow("compilation already completed");
  });

  it.each(["pegProvenanceById", "safetyScoreV9SupplyAttributionById", "dexDeploymentSupplyCoverageById"])(
    "preserves prepared %s admission and record order when reloading",
    async (field) => {
      const pipeline = mocks.build.getMockImplementation()!();
      mocks.build.mockImplementationOnce(({ fixedInputOwner }) => {
        const prepared = fixedInputOwner.value;
        fixedInputOwner.value = null;
        const reloaded = fixedInputOwner.reload();
        expect(reloaded).toStrictEqual(prepared);
        expect(JSON.stringify(reloaded)).toBe(JSON.stringify(prepared));
        return pipeline;
      });
      const result = await runSafetyScoreV9Publication({
        db: {} as D1Database, fixedInput, nowSec: fixedInput.clockSec,
        preparedFixedInputAlreadyNormalized: true,
        prepareFixedInput: async (input) => ({
          ...input,
          [field]: { "usdc-circle": { malformed: true } },
          evidenceJournalById: { "usdt-tether": [], "usdc-circle": [] },
        }),
      });
      expect(result.status).toBe("published");
    },
  );

  it("keeps malformed enrichment asset-local when an evaluation failure forces a retry", async () => {
    const candidate = await vi.importActual<typeof import("../safety-score-v9/candidate")>("../safety-score-v9/candidate");
    mocks.build.mockImplementation(candidate.buildSafetyScoreV9PublicationFromOwnedInput);
    const evaluate = vi.spyOn(evaluateSet, "evaluateValidatedV9FactSetForPublication")
      .mockImplementationOnce((owner) => {
        expect(owner.factSet?.assets.find((asset) => asset.assetId === "audd-novatti")?.evidence)
          .toEqual(expect.arrayContaining([expect.objectContaining({
            sourceId: "safety-score-v9-compiler", disposition: "rejected",
          })]));
        throw new evaluateSet.V9AssetEvaluationError("brz-transfero", { issues: [{ path: ["structuralSignals"] }] });
      });
    const input = createSafetyScoreV9FullRegistryInput();
    // This logic test does not exercise the wall-clock publication window, so
    // isolate the clock and timeout signal from full-registry recompilation time.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    try {
      const result = await runSafetyScoreV9Publication({
        db: {} as D1Database, fixedInput: input, nowSec: input.clockSec,
        preparedFixedInputAlreadyNormalized: true,
        prepareFixedInput: async (base) => ({
          ...base,
          safetyScoreV9SupplyAttributionById: {
            "audd-novatti": { model: "reviewed-economic-deployment-partition-v1" },
          },
        }),
      });
      // Print the complete result (including abortCause) when the status differs.
      expect(result, JSON.stringify(result)).toMatchObject({ status: "published" });
      expect(evaluate).toHaveBeenCalledTimes(2);
      const pipeline = mocks.build.mock.results[0]!.value;
      expect(pipeline.quarantines).toEqual(expect.arrayContaining([
        expect.objectContaining({ assetId: "audd-novatti" }),
        expect.objectContaining({ assetId: "brz-transfero", code: "evaluation-failed" }),
      ]));
      for (const id of ["audd-novatti", "brz-transfero"]) {
        expect(pipeline.candidate.cards.find((card: { id: string }) => card.id === id))
          .toMatchObject({ ratingStatus: "pipeline-gap", score: null, grade: null });
      }
      expect(mocks.persist).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
      clock.mockRestore();
      timeout.mockRestore();
    }
  }, 120_000);

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
        bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry,
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

  it("retains the accepted grade for a one-publication band change before assessment and persistence (10.26)", async () => {
    const accepted = makeWorkerSafetyScoreV9Publication({
      cards: [makeWorkerV9Card({ id: "xaut-tether", score: 55 })],
      baseInputGenerationId: fixedInput.baseInputGenerationId,
      publicationGenerationId: "report-cards:v9:accepted",
      publishedAtSec: fixedInput.clockSec - 30,
    });
    mocks.loadBaseline.mockResolvedValue(acceptedBaseline(accepted));
    mocks.build.mockReturnValue({
      candidate: makeWorkerSafetyScoreV9Publication({
        cards: [makeWorkerV9Card({ id: "xaut-tether", score: 50 })],
        baseInputGenerationId: fixedInput.baseInputGenerationId,
        publishedAtSec: fixedInput.clockSec,
      }),
      compilerFactSchemaDigest: "1".repeat(64),
      producerCapabilityDigest: "2".repeat(64),
      quarantines: [],
      quarantineAffectedAssetIds: [],
      bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry,
    });

    await runSafetyScoreV9Publication({ db: {} as D1Database, fixedInput });

    const held = { score: 50, grade: "C", gradeHold: { rawGrade: "C-", heldFromGenerationId: "report-cards:v9:accepted" } };
    expect(mocks.assess).toHaveBeenCalledWith(expect.objectContaining({
      candidate: expect.objectContaining({ cards: [expect.objectContaining(held)] }),
    }));
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      publication: expect.objectContaining({ cards: [expect.objectContaining(held)] }),
    }));
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
      bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry,
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
  it("quarantines expired measured evidence per asset, retains its witness, and fails closed when compilation missed it (10.35)", async () => {
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
    const stub = makeWorkerV9Card({ id: assetId, score: null, grade: null, ratingStatus: "pipeline-gap" });
    const witness = {
      routeId: observation.routeId, dexGenerationId: expiredInput.dexGenerationId,
      observationWindowEndedAt: draft.clockSec - 10_801, freshnessMaxSec: 10_800,
    };
    const candidateFor = (input: typeof expiredInput, row: typeof card) => makeWorkerSafetyScoreV9Publication({
      cards: cards.map((other) => other.id === assetId ? row : other),
      completeness: {
        ...accepted.completeness,
        ratedCount: cards.length - (row.ratingStatus === "pipeline-gap" ? 1 : 0),
        pipelineGapCount: row.ratingStatus === "pipeline-gap" ? 1 : 0,
        pipelineGapIds: row.ratingStatus === "pipeline-gap" ? [assetId] : [],
      },
      baseInputGenerationId: input.baseInputGenerationId,
      publishedAtSec: input.clockSec,
      sourceGenerations: { dex: input.dexGenerationId },
    });
    mocks.build.mockReturnValue({
      candidate: candidateFor(expiredInput, stub),
      compilerFactSchemaDigest: "1".repeat(64),
      producerCapabilityDigest: "2".repeat(64),
      quarantines: [{ assetId, code: "evaluation-failed", message: "dex-stale: fixture" }],
      quarantineAffectedAssetIds: [assetId], bridgeJoinDiagnostics: [],
      measuredExitExpiry: { assetIds: [assetId], witnessesByAssetId: { [assetId]: [witness] } },
    });

    // One expired root among the full registry no longer holds unrelated ratings.
    expect(await runSafetyScoreV9Publication({ db: {} as D1Database, fixedInput: expiredInput })).toMatchObject({
      status: "published", outcome: "partial", affectedAssetIds: [assetId],
    });
    expect(mocks.build.mock.calls[0]![0].measuredExitExpiry).toMatchObject({
      acceptedPublication: { publicationGenerationId: accepted.publicationGenerationId },
      routes: { dexGenerationId: expiredInput.dexGenerationId, clockSec: expiredInput.clockSec },
    });
    const write = mocks.persist.mock.calls[0]![1];
    const projected = JSON.parse(write.buildAcceptedProjections(write.publication).baseline);
    expect(projected.baseline.dexExpiryByAssetId).toEqual({ [assetId]: [witness] });

    // A compiler that left the expired contributor rated fails closed.
    mocks.persist.mockClear();
    mocks.build.mockReturnValue({
      candidate: candidateFor(expiredInput, { ...card, grade: "B", score: 72 }),
      compilerFactSchemaDigest: "1".repeat(64),
      producerCapabilityDigest: "2".repeat(64),
      quarantines: [], quarantineAffectedAssetIds: [], bridgeJoinDiagnostics: [],
      measuredExitExpiry: noMeasuredExitExpiry,
    });
    expect(await runSafetyScoreV9Publication({ db: {} as D1Database, fixedInput: expiredInput })).toMatchObject({
      status: "held", reasons: [{ code: "assessment-failed", detail: expect.stringContaining(`${assetId} is not quarantined`) }],
    });
    expect(mocks.persist.mock.calls[0]![1].publicationHealth).toMatchObject({
      status: "held", acceptedPublicationGenerationId: accepted.publicationGenerationId,
    });
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
      bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry,
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

  it("retains caller cancellation and persists the failed attempt with an independent signal", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    mocks.persistAttempt.mockImplementation(store.persistSafetyScoreV9PublicationAttempt);
    try {
      const result = await runSafetyScoreV9Publication({ db, fixedInput, signal: controller.signal });
      expect(result).toMatchObject({
        status: "failed", stage: "base-input",
        abortCause: { source: "caller", name: "AbortError", message: "cancelled" },
      });
      expect(mocks.persistAttempt.mock.calls[0]![1].signal.aborted).toBe(false);
      expect(await publicationAttempts.loadSafetyScoreV9FailedPublicationAttempt(db)).toMatchObject({
        outcome: "failed", failure: {
          stage: "base-input", abortCause: { source: "caller", name: "AbortError" },
          phaseElapsedMs: { compile: null },
        },
      });
    } finally { sqlite.close(); }
  });

  it("does not mislabel a string caller cancellation as a publication timeout", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database, fixedInput, signal: AbortSignal.abort("caller cancelled"),
    });
    expect(result).toMatchObject({
      status: "failed", stage: "base-input",
      abortCause: { source: "caller", name: "AbortError", message: "caller cancelled" },
    });
  });

  it.each([
    [undefined, 120_000],
    [240_000, 225_000],
    [180_000, 165_000],
    [25_000, 10_000],
    [24_999, 0],
    [0, 0],
    [-1, 0],
  ])("derives the usable budget from remaining %s ms without extending the floor", (remaining, expected) => {
    expect(getSafetyScoreV9PublicationBudgetMs(1_000, remaining === undefined ? undefined : 1_000 + remaining)).toBe(expected);
  });

  it.each([
    { latencyMs: 400, expected: "published" },
    { latencyMs: 20_000, expected: "failed" },
  ] as const)("without deferral, keeps real 397-card staging $expected with $latencyMs ms D1 latency inside the inherited lane", async ({ latencyMs, expected }) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const prior = makeWorkerSafetyScoreV9Publication({
      publishedAtSec: fixedInput.clockSec - 100, publicationGenerationId: "report-cards:v9:prior",
    });
    const candidate = makeWorkerSafetyScoreV9Publication({
      baseInputGenerationId: fixedInput.baseInputGenerationId, publishedAtSec: fixedInput.clockSec,
      publicationGenerationId: "report-cards:v9:large-cohort",
      cards: Array.from({ length: 397 }, (_, index) => makeWorkerV9Card({
        id: index === 0 ? "usdc-circle" : `v9-staging-coin-${String(index).padStart(3, "0")}`,
        evidence: { level: "adequate", freshness: "current", reasons: [{
          code: "unresolved-control-identity", message: "\u00e9".repeat(6_000), path: "control:incidentState",
        }] },
      })),
    });
    const start = Date.now();
    let elapsedMs = 0;
    let stagingCalls = 0;
    const deadline = new AbortController();
    const stagingStatements = new WeakSet<D1PreparedStatement>();
    const delayedDb: D1Database = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (sql.startsWith("INSERT OR IGNORE INTO safety_score_")) {
          const bind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            const bound = bind(...values);
            stagingStatements.add(bound);
            return bound;
          };
        }
        return statement;
      },
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const result = await db.batch<T>(statements);
        if (statements.every(statement => stagingStatements.has(statement))) {
          stagingCalls++;
          // Model elapsed I/O and its real abort signal without sleeping for
          // three minutes. A completed staged write still cannot select itself.
          elapsedMs += latencyMs;
          if (elapsedMs >= getSafetyScoreV9PublicationBudgetMs(start, start + 180_000)) {
            deadline.abort(new DOMException("Staging exhausted the publication window", "TimeoutError"));
          }
        }
        return result;
      },
    };
    try {
      await store.persistSafetyScoreV9Publication(db, currentInput(prior));
      const acceptedRows = sqlite.prepare(`SELECT key, value, updated_at FROM cache
        WHERE key IN (?, ?, ?, ?, ?) ORDER BY key`);
      const acceptedKeys = [
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.publication,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral,
      ];
      const before = acceptedRows.all(...acceptedKeys);
      mocks.loadBaseline.mockResolvedValue(acceptedBaseline(prior));
      mocks.build.mockImplementationOnce(() => {
        elapsedMs = 16_000;
        return { candidate, quarantines: [], quarantineAffectedAssetIds: [], bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry };
      });
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      mocks.persistAttempt.mockImplementation(store.persistSafetyScoreV9PublicationAttempt);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => start + elapsedMs);
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      try {
        const result = await runSafetyScoreV9Publication({
          db: delayedDb, fixedInput, nowSec: fixedInput.clockSec, publicationDeadlineMs: start + 180_000,
        });
        expect(timeout).toHaveBeenNthCalledWith(1, 165_000);
        expect(stagingCalls).toBeGreaterThan(0);
        expect(result.status).toBe(expected);
        if (expected === "published") {
          expect(stagingCalls).toBeLessThanOrEqual(40);
          expect(elapsedMs).toBeLessThan(165_000);
          expect(result).toMatchObject({
            publicationGenerationId: candidate.publicationGenerationId, abortCause: null,
            phaseElapsedMs: { persist: expect.any(Number) },
          });
          expect(result.phaseElapsedMs.persist).toBeGreaterThan(0);
          expect(result.phaseElapsedMs.persist)
            .toBeLessThanOrEqual(getSafetyScoreV9PublicationBudgetMs(start, start + 180_000));
          expect((await store.loadSafetyScoreV9PublicationIdentityEnvelope(db))?.publicationGenerationId)
            .toBe(candidate.publicationGenerationId);
          expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL")
            .get(candidate.publicationGenerationId)!.n).toBe(398);
        } else {
          expect(result).toMatchObject({
            stage: "publication-write",
            abortCause: { source: "publication-deadline", name: "TimeoutError" },
            journal: { status: "skipped", reason: "publication-failed" },
          });
          expect(acceptedRows.all(...acceptedKeys)).toEqual(before);
          expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_public_manifests WHERE generation_id = ? AND retired_at IS NULL")
            .get(candidate.publicationGenerationId)!.n).toBe(0);
          expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL")
            .get(candidate.publicationGenerationId)!.n).toBe(0);
          expect(await publicationAttempts.loadSafetyScoreV9FailedPublicationAttempt(db)).toMatchObject({
            outcome: "failed", failure: { stage: "publication-write",
              abortCause: { source: "publication-deadline", name: "TimeoutError" } },
          });
        }
      } finally { clock.mockRestore(); timeout.mockRestore(); }
    } finally { sqlite.close(); }
  });

  it.each([
    { latencyMs: 400, expected: "materialized" },
    { latencyMs: 20_000, expected: "failed" },
  ] as const)("accepts before real 397-card staging, which is $expected with $latencyMs ms D1 latency inside the inherited lane", async ({ latencyMs, expected }) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const prior = makeWorkerSafetyScoreV9Publication({
      publishedAtSec: fixedInput.clockSec - 100, publicationGenerationId: "report-cards:v9:prior",
    });
    const candidate = makeWorkerSafetyScoreV9Publication({
      baseInputGenerationId: fixedInput.baseInputGenerationId, publishedAtSec: fixedInput.clockSec,
      publicationGenerationId: "report-cards:v9:large-cohort",
      cards: Array.from({ length: 397 }, (_, index) => makeWorkerV9Card({
        id: index === 0 ? "usdc-circle" : `v9-staging-coin-${String(index).padStart(3, "0")}`,
        evidence: { level: "adequate", freshness: "current", reasons: [{
          code: "unresolved-control-identity", message: "\u00e9".repeat(6_000), path: "control:incidentState",
        }] },
      })),
    });
    const start = Date.now();
    let elapsedMs = 0;
    let stagingCalls = 0;
    const deadline = new AbortController();
    const stagingStatements = new WeakSet<D1PreparedStatement>();
    const delayedDb: D1Database = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (sql.startsWith("INSERT OR IGNORE INTO safety_score_")) {
          const bind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            const bound = bind(...values);
            stagingStatements.add(bound);
            return bound;
          };
        }
        return statement;
      },
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const result = await db.batch<T>(statements);
        if (statements.every(statement => stagingStatements.has(statement))) {
          stagingCalls++;
          // Model elapsed I/O and its real abort signal without sleeping for
          // three minutes. A completed staged write still cannot select itself.
          elapsedMs += latencyMs;
          if (elapsedMs >= getSafetyScoreV9PublicationBudgetMs(start, start + 180_000)) {
            deadline.abort(new DOMException("Staging exhausted the publication window", "TimeoutError"));
          }
        }
        return result;
      },
    };
    try {
      const persistedPrior = await store.persistSafetyScoreV9Publication(db, { ...currentInput(prior), deferPublicMaterialization: true });
      await materializeV9AcceptedPublication(db, persistedPrior.acceptedMaterialization!);
      const acceptedRows = sqlite.prepare(`SELECT key, value, updated_at FROM cache
        WHERE key IN (?, ?, ?, ?, ?) ORDER BY key`);
      const acceptedKeys = [
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.publication,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline,
        publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral,
      ];
      const before = acceptedRows.all(...acceptedKeys);
      mocks.loadBaseline.mockResolvedValue(acceptedBaseline(prior));
      mocks.build.mockImplementationOnce(() => {
        elapsedMs = 16_000;
        return { candidate, quarantines: [], quarantineAffectedAssetIds: [], bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry };
      });
      mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
      mocks.persistAttempt.mockImplementation(store.persistSafetyScoreV9PublicationAttempt);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => start + elapsedMs);
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      try {
        const result = await runSafetyScoreV9Publication({
          db: delayedDb, fixedInput, nowSec: fixedInput.clockSec, publicationDeadlineMs: start + 180_000,
          deferPublicMaterialization: true,
        });
        expect(timeout).toHaveBeenNthCalledWith(1, 165_000);
        expect(stagingCalls).toBeGreaterThan(0);
        // Acceptance no longer waits on staging: slow staging cannot fail the publication.
        expect(result.status).toBe("published");
        if (result.status !== "published") throw new Error("expected published");
        expect(acceptedRows.all(...acceptedKeys)).not.toEqual(before);
        expect((await store.loadSafetyScoreV9PublicationIdentityEnvelope(db))?.publicationGenerationId)
          .toBe(candidate.publicationGenerationId);
        expect(result.subphaseElapsedMs.materializeStage).toBeGreaterThan(0);
        expect(result.subphaseElapsedMs.persistCommit).toEqual(expect.any(Number));
        expect(mocks.persistAttempt).not.toHaveBeenCalled();
        if (expected === "materialized") {
          expect(stagingCalls).toBeLessThanOrEqual(40);
          expect(elapsedMs).toBeLessThan(165_000);
          expect(result).toMatchObject({
            publicationGenerationId: candidate.publicationGenerationId, abortCause: null, warnings: [],
            publicMaterialization: { status: "materialized", publicationGenerationId: candidate.publicationGenerationId, siteRepresentationCount: 398 },
          });
          expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL")
            .get(candidate.publicationGenerationId)!.n).toBe(398);
        } else {
          expect(result).toMatchObject({
            abortCause: { source: "publication-deadline", name: "TimeoutError" },
            warnings: expect.arrayContaining(["public-materialization-failed", "publication-committed-before-abort"]),
            publicMaterialization: { status: "failed", publicationGenerationId: candidate.publicationGenerationId, attempts: 1 },
            postCommitFailure: null,
            journal: { status: "written" },
          });
          // Readers keep the prior whole generation; the accepted one is not selected.
          expect(sqlite.prepare("SELECT generation_id FROM safety_score_public_manifests WHERE retired_at IS NULL").all())
            .toEqual([{ generation_id: prior.publicationGenerationId }]);
          expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests WHERE generation_id = ? AND retired_at IS NULL")
            .get(candidate.publicationGenerationId)!.n).toBe(0);
        }
      } finally { clock.mockRestore(); timeout.mockRestore(); }
    } finally { sqlite.close(); }
  });

  it("refuses a slot below the usable floor before enrichment or compilation", async () => {
    const result = await runSafetyScoreV9Publication({
      db: {} as D1Database, fixedInput, publicationDeadlineMs: Date.now() + 24_000,
    });
    expect(result).toMatchObject({
      status: "failed", stage: "base-input", abortCause: { source: "publication-deadline" },
      message: "Insufficient publication window after settlement reserve",
    });
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.persistAttempt).toHaveBeenCalledOnce();
  });

  it("uses more than 120 seconds when the inherited window authorizes it and records every phase", async () => {
    const clock = vi.spyOn(Date, "now");
    const start = Date.now();
    clock.mockReturnValue(start);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      mocks.build.mockImplementationOnce(() => {
        clock.mockReturnValue(start + 125_000);
        return { candidate: makeWorkerSafetyScoreV9Publication({
          baseInputGenerationId: fixedInput.baseInputGenerationId, publishedAtSec: fixedInput.clockSec,
        }), quarantines: [], quarantineAffectedAssetIds: [], bridgeJoinDiagnostics: [], measuredExitExpiry: noMeasuredExitExpiry };
      });
      const result = await runSafetyScoreV9Publication({
        db: {} as D1Database, fixedInput, publicationDeadlineMs: start + 240_000,
      });
      expect(timeout).toHaveBeenNthCalledWith(1, 225_000);
      expect(result).toMatchObject({ status: "published", phaseElapsedMs: {
        enrichment: 0, baselineLoad: 0, compile: 125_000, assess: 0,
        serialize: 0, persist: 0, journal: 0, archive: 0,
      }, abortCause: null, phaseTimingBasis: "workers-io-boundary-attributed" });
    } finally { clock.mockRestore(); timeout.mockRestore(); }
  });

  it("keeps compile as the failing phase when synchronous work overruns the deadline", async () => {
    const clock = vi.spyOn(Date, "now");
    const start = Date.now();
    clock.mockReturnValue(start);
    const pipeline = mocks.build.getMockImplementation()!();
    mocks.build.mockImplementationOnce(() => {
      clock.mockReturnValue(start + 166_000);
      return pipeline;
    });
    try {
      const result = await runSafetyScoreV9Publication({
        db: {} as D1Database, fixedInput, publicationDeadlineMs: start + 180_000,
      });
      expect(result).toMatchObject({ status: "failed", stage: "compile",
        code: "safety-score-v9-publication-compile-TimeoutError",
        phaseElapsedMs: { compile: 166_000, assess: null },
        abortCause: { source: "publication-deadline", name: "TimeoutError" },
      });
      expect(mocks.persistAttempt).toHaveBeenCalledOnce();
      expect(mocks.persist).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("preserves the enrichment phase when the actual timeout signal aborts", async () => {
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    try {
      const result = await runSafetyScoreV9Publication({
        db: {} as D1Database, fixedInput,
        prepareFixedInput: async () => {
          timeout.abort(new DOMException("deadline", "TimeoutError"));
          throw timeout.signal.reason;
        },
      });
      expect(result).toMatchObject({ status: "failed", stage: "v9-enrichment",
        phaseElapsedMs: { enrichment: expect.any(Number), baselineLoad: null },
        abortCause: { source: "publication-deadline", name: "TimeoutError", message: "deadline" },
      });
      expect(mocks.persistAttempt.mock.calls[0]![1].signal.aborted).toBe(false);
    } finally { timer.mockRestore(); }
  });

  it("reports published with a warning when cancellation follows the canonical batch commit", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const caller = new AbortController();
    const batch = db.batch.bind(db);
    const batchSpy = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      const result = await batch(statements);
      if (sqlite.prepare("SELECT 1 FROM cache WHERE key = ?").get(publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.publication)) {
        caller.abort(new DOMException("cancelled after commit", "AbortError"));
      }
      return result;
    });
    mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
    try {
      const result = await runSafetyScoreV9Publication({ db, fixedInput, signal: caller.signal });
      expect(result).toMatchObject({ status: "published",
        publicationGenerationId: mocks.build.mock.results[0]!.value.candidate.publicationGenerationId,
        warnings: ["publication-committed-before-post-commit-failure"],
        abortCause: { source: "caller" }, phaseElapsedMs: { persist: expect.any(Number) },
      });
      expect((await publicationHealth.loadSafetyScoreV9PublicationHealth(db))?.status).toBe("current");
      expect(mocks.persistAttempt).not.toHaveBeenCalled();
    } finally { batchSpy.mockRestore(); sqlite.close(); }
  });

  it("keeps an accepted publication published when archive cancellation is non-fatal", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const caller = new AbortController();
    mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
    const put = vi.fn(async () => {
      caller.abort(new DOMException("archive cancelled", "AbortError"));
      return { key: "stored" };
    });
    try {
      const result = await runSafetyScoreV9Publication({
        db, fixedInput, fixedInputCacheValue: "exact-base", signal: caller.signal,
        captureArchiveBucket: { put } as unknown as R2Bucket,
      });
      expect(result).toMatchObject({
        status: "published", warnings: ["publication-committed-before-abort"],
        publicMaterialization: { status: "skipped", reason: "post-commit-interrupted" },
        postCommitFailure: { stage: "archive", message: "archive cancelled" },
        abortCause: { source: "caller", name: "AbortError" },
        phaseElapsedMs: { journal: expect.any(Number), archive: expect.any(Number) },
      });
      expect(mocks.persistAttempt).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });

  it("recovers an exact committed identity after a non-abort lost batch response", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const batch = db.batch.bind(db);
    const batchSpy = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      const result = await batch(statements);
      if (sqlite.prepare("SELECT 1 FROM cache WHERE key = ?").get(publicationHealth.SAFETY_SCORE_V9_CACHE_KEYS.publication)) {
        throw new Error("D1 response lost after commit");
      }
      return result;
    });
    mocks.persist.mockImplementation(store.persistSafetyScoreV9Publication);
    try {
      const result = await runSafetyScoreV9Publication({ db, fixedInput });
      expect(result).toMatchObject({
        status: "published", abortCause: null,
        warnings: ["publication-committed-before-post-commit-failure"],
        postCommitFailure: { stage: "publication-write", message: "D1 response lost after commit" },
        phaseTimingBasis: "workers-io-boundary-attributed",
      });
      const recoverySignal = mocks.loadIdentity.mock.calls[0]![1];
      expect(recoverySignal).toBeInstanceOf(AbortSignal);
      expect(recoverySignal!.aborted).toBe(false);
      expect(mocks.loadHealth.mock.lastCall![1]).toBe(recoverySignal);
      expect(mocks.persistAttempt).not.toHaveBeenCalled();
    } finally {
      batchSpy.mockRestore(); sqlite.close();
    }
  });

  it("honors the independent signal before and after the compact identity read", async () => {
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const controller = new AbortController();
    const first = vi.fn(async () => {
      controller.abort(new DOMException("recovery budget expired", "TimeoutError"));
      return null;
    });
    const prepare = vi.fn(() => ({ bind: () => ({ first }) }));
    const db = { prepare } as unknown as D1Database;
    await expect(store.loadSafetyScoreV9PublicationIdentityEnvelope(db, controller.signal))
      .rejects.toThrow("recovery budget expired");
    first.mockClear(); prepare.mockClear();
    await expect(store.loadSafetyScoreV9PublicationIdentityEnvelope(db, controller.signal))
      .rejects.toThrow("recovery budget expired");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("retains acknowledged held state when cancellation interrupts the later journal", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const caller = new AbortController();
    mocks.assess.mockReturnValue({ decision: "hold", reasons: [{ code: "dex-stale" }], affectedAssetIds: [] });
    mocks.persist.mockImplementationOnce(async (database, input) => {
      const result = await store.persistSafetyScoreV9Publication(database, input);
      caller.abort(new DOMException("journal cancelled", "AbortError"));
      return result;
    });
    try {
      const result = await runSafetyScoreV9Publication({ db, fixedInput, signal: caller.signal });
      expect(result).toMatchObject({
        status: "held", warnings: ["held-state-committed-before-journal-failure"],
        abortCause: { source: "caller" },
        journal: { status: "skipped", reason: "post-commit-interrupted" },
      });
      expect((await publicationHealth.loadSafetyScoreV9PublicationHealth(db))?.status).toBe("held");
      expect(mocks.persistAttempt).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });

  it("does not treat an older accepted identity as a successful aborted write", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const store = await vi.importActual<typeof PublicationStore>("../safety-score-v9/publication-store");
    const caller = new AbortController();
    try {
      await store.persistSafetyScoreV9Publication(db, currentInput(makeWorkerSafetyScoreV9Publication({
        publishedAtSec: fixedInput.clockSec - 100, publicationGenerationId: "report-cards:v9:prior",
      })));
      mocks.persist.mockImplementationOnce(async () => {
        caller.abort(new DOMException("cancelled before commit", "AbortError"));
        throw caller.signal.reason;
      });
      const result = await runSafetyScoreV9Publication({ db, fixedInput, signal: caller.signal });
      expect(result).toMatchObject({ status: "failed", stage: "publication-write", abortCause: { source: "caller" } });
      expect(mocks.persistAttempt).toHaveBeenCalledOnce();
    } finally { sqlite.close(); }
  });
});
