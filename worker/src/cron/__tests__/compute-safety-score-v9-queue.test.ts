import { createReportCardEvidenceJournalV1 } from "@shared/lib/report-card-evidence-journal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "@shared/types/safety-score-cache-keys";
import { V9_PUBLIC_MATERIALIZATION_CACHE_KEY } from "@shared/types/report-cards-v9-materialization";
import type { V9ContinuationMessage } from "@shared/types/v9-continuation";

const coverageFloor = vi.hoisted(() => ({ minRateableAssets: 3 }));
vi.mock("@shared/types/safety-score-v9-coverage", () => ({
  get V9_MINIMUM_RATEABLE_ASSETS() { return coverageFloor.minRateableAssets; },
}));

import { computeSafetyScoreV9 } from "../compute-safety-score-v9";
import { createNativeSafetyScoreV9CohortInput } from "../../lib/__tests__/fixtures/safety-score-v9-full-registry-input";
import { resumeActiveChunkedV9Evaluation, runChunkedV9EvalStep, seedChunkedV9Evaluation } from "../../lib/safety-score-v9/chunked-eval-pipeline";
import { partitionV9DependencyChunks } from "../../lib/safety-score-v9/chunked-eval-plan";
import {
  cleanupAbandonedV9EvalRunsOnOffMode, encodeV9EvalChunkParts, loadV9EvalRun,
  markV9EvalRunCompletedAndPrune, readV9EvalChunk, sweepStaleV9EvalRuns,
  V9_EVAL_CHUNK_MAX_ROW_BYTES, writeV9EvalChunk,
} from "../../lib/safety-score-v9/chunked-eval-store";
import { ALERT_SAFETY_V9_SOURCE_CACHE_KEY } from "../../lib/alert-safety-source-cache";
import { compileSafetyScoreV9AssetSlice, compileSafetyScoreV9FactSetFromExtensionSource } from "../../lib/safety-score-v9/fact-set";
import { createV9FactSetAssetValidator } from "@shared/lib/safety-score-v9/compile";
import { createSafetyScoreV9BaselineExtensionSource } from "../../lib/safety-score-v9/extension";
import { withNormalizedV9JournalProjections } from "../../lib/safety-score-v9/native-input";
import { loadSafetyScoreV9PublicationHealth } from "../../lib/safety-score-v9/publication-health";
import { loadSafetyScoreV9Publication } from "../../lib/safety-score-v9/publication-store";
import * as supplyAttrGen from "../../lib/safety-score-v9/supply-attribution-generation";
import {
  countRows, deliverV9Continuation, insertSyntheticV9Exec, insertSyntheticV9Run, makePublishableV9Input,
  prepareV9SeedPayload, seedPreparedV9Db, V9_QUEUE_TEST_WORKER_META, V9_QUEUE_TEST_WORKER_VERSION,
} from "../../test-helpers/v9-queue-harness";

const COHORT_IDS = ["usdc-circle", "usds-sky", "susds-sky", "buidl-blackrock"] as const;
const COHORT_INPUT = makePublishableV9Input(createNativeSafetyScoreV9CohortInput(COHORT_IDS));
let cachedSeed: ReturnType<typeof prepareV9SeedPayload> | null = null;
const seedDb = (db: D1Database) => (cachedSeed ??= prepareV9SeedPayload(COHORT_INPUT)).then((p) => seedPreparedV9Db(db, p));
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); coverageFloor.minRateableAssets = 3; vi.restoreAllMocks(); });

async function seedRun(db: D1Database, maxChunkAssets = 2, sourceInvocationId = "test:seed", deferPublicMaterialization = true, input = COHORT_INPUT) {
  let first: V9ContinuationMessage | undefined;
  const res = await computeSafetyScoreV9(db, undefined, undefined, {
    queueMode: "on", deferPublicMaterialization, maxChunkAssets, slotStartedAt: input.clockSec,
    sourceInvocationId, workerMetadata: V9_QUEUE_TEST_WORKER_META, onContinuation: (m) => { first = m; },
  });
  return { res, first: first! };
}

describe("Safety Score V9 ADR-26 chunked Queue evaluation", () => {
  it("rejects pending reserve evidence hashes in monolithic compilation, Seed and Eval", async () => {
    const { db } = fixtures.open();
    const id = "usdfr-forest-road";
    const input = makePublishableV9Input(createNativeSafetyScoreV9CohortInput([id]));
    const clockSec = input.clockSec;
    const fixedInput = withNormalizedV9JournalProjections({
      ...input, liveReserveMap: {}, liveReserveProvenanceMap: {},
      evidenceJournalById: { [id]: [createReportCardEvidenceJournalV1({
        schemaVersion: 1, lane: "reserve", assetId: id, attemptId: "pending-test", sourceId: "reserve-test",
        sourceOriginClass: "onchain-observation", attemptCode: "reserve.collector.attempted",
        admissionCode: "reserve.admission.rejected-upstream", fallbackCode: "reserve.fallback.unavailable",
        attemptedAtSec: clockSec, completedAtSec: clockSec, sourceTimestampSec: null, sourceBlock: null,
        contentSha256: "0".repeat(64), sidecarMaterializationSha256: null,
      })] },
    });
    const message = "V9 publication evidence cannot retain a pending research hash";
    expect(() => compileSafetyScoreV9FactSetFromExtensionSource(fixedInput, createSafetyScoreV9BaselineExtensionSource(fixedInput))).toThrow(message);
    await expect(seedChunkedV9Evaluation({
      db, fixedInput, transferMaterialityGeneration: null, slotStartedAt: clockSec,
      sourceInvocationId: "test:pending", workerVersion: V9_QUEUE_TEST_WORKER_VERSION, deferPublicMaterialization: true, maxChunkAssets: 4,
    })).rejects.toThrow(message);
    await seedPreparedV9Db(db, await prepareV9SeedPayload(input));
    const { first } = await seedRun(db, 4, "test:eval-pending", true, input);
    await writeV9EvalChunk(db, {
      runId: first.runId, chunkKind: "run_context", chunkIndex: 1, quarantineEpoch: 0, value: { schemaVersion: 1, fixedInput }, createdAt: clockSec,
    });
    await expect(runChunkedV9EvalStep(db, (await loadV9EvalRun(db, first.runId))!, "test:pending", {
      workerVersion: V9_QUEUE_TEST_WORKER_VERSION, deadlineMs: Date.now() + 60_000,
    })).rejects.toThrow(message);

    // Eval slice admission rejects extension registry fingerprint mismatch and preserves cohort asset indices.
    const two = makePublishableV9Input(createNativeSafetyScoreV9CohortInput(["usdc-circle", "usdt-tether"]));
    const compiledTwo = compileSafetyScoreV9FactSetFromExtensionSource(two, createSafetyScoreV9BaselineExtensionSource(two));
    const { assets: twoAssets, v9FactSetDigest: _digest, ...twoHeader } = compiledTwo.factSet;
    const mismatchSource = createSafetyScoreV9BaselineExtensionSource(two);
    const mismatchExt = { ...mismatchSource.extension, registryFingerprint: "f".repeat(64) };
    expect(() => [...compileSafetyScoreV9AssetSlice(two, { ...mismatchSource, extension: mismatchExt }, twoHeader, ["usdc-circle"], new Map())])
      .toThrow(/registry fingerprint/i);
    const { validateAsset } = createV9FactSetAssetValidator({ ...twoHeader, sourceFingerprints: { ...twoHeader.sourceFingerprints, dex: { ...twoHeader.sourceFingerprints.dex, generationId: "dex:mismatch" } } });
    expect(() => validateAsset(twoAssets[1]!)).toThrow(/"assets",\s*1/s);
  });

  it("matches monolithic publication across cross-chunk upstreams, cleans N6 rollback, recovers N3 crash, records N4 evidence, and checks SCC partitioning", async () => {
    const [mono, chunk] = [fixtures.open(), fixtures.open()];
    await Promise.all([seedDb(mono.db), seedDb(chunk.db)]);

    const nowSec = Math.floor(Date.now() / 1_000);
    expect(await cleanupAbandonedV9EvalRunsOnOffMode(mono.db, nowSec, nowSec * 1_000)).toEqual({ abortedRunIds: [], reconciledExecutions: 0 });
    // maxChunkAssets=1 forces cross-chunk upstream_state handoff from usds-sky -> susds-sky.
    const { res: seedRes, first } = await seedRun(chunk.db, 1, "test:seed:cohort");
    expect((JSON.parse(seedRes.metadata!) as { mode: string }).mode).toBe("queue-seed");

    await insertSyntheticV9Run(mono.db, "rollback-run", nowSec, COHORT_INPUT.registryFingerprint, { evalDigest: first.evaluationBuildDigest });
    await writeV9EvalChunk(mono.db, { runId: "rollback-run", chunkKind: "fact_shard", chunkIndex: 0, quarantineEpoch: 0, value: { a: 1 }, createdAt: nowSec });
    await insertSyntheticV9Exec(mono.db, { ...first, runId: "rollback-run" }, "expired-exec", "running", null, 1_000);
    expect(await deliverV9Continuation(mono.db, { ...first, runId: "rollback-run" }, { mode: "off" })).toEqual({ acked: true, retried: false, sent: [] });
    const monoRes = await computeSafetyScoreV9(mono.db, undefined, undefined, { queueMode: "off", deferPublicMaterialization: true, workerMetadata: V9_QUEUE_TEST_WORKER_META });
    expect((JSON.parse(monoRes.metadata!) as { publication: { status: string } }).publication.status).toBe("published");
    expect((await loadV9EvalRun(mono.db, "rollback-run"))?.failure_reason).toBe("off-mode-rollback-aborted");
    expect(await countRows(mono.db, "SELECT COUNT(*) AS c FROM v9_eval_chunks WHERE run_id = 'rollback-run'")).toBe(0);
    expect(await mono.db.prepare("SELECT state, result_status, failure_reason FROM v9_eval_queue_executions WHERE delivery_id = 'expired-exec'").first())
      .toEqual({ state: "finished", result_status: "error", failure_reason: "off-mode-rollback-reconciled" });

    let maxBytes = 0;
    let cur: V9ContinuationMessage | undefined = first;
    let evals = 0;
    while (cur && cur.stage === "eval") {
      const r = await chunk.db.prepare("SELECT COALESCE(MAX(LENGTH(CAST(payload AS BLOB))), 0) AS m FROM v9_eval_chunks").first<{ m: number }>();
      maxBytes = Math.max(maxBytes, r?.m ?? 0);
      evals += 1;
      const out = await deliverV9Continuation(chunk.db, cur);
      expect(out.acked).toBe(true);
      cur = out.sent[0];
    }
    expect(evals).toBe(4);
    expect(cur?.stage).toBe("commit");
    expect(maxBytes).toBeGreaterThan(0);
    expect(maxBytes).toBeLessThanOrEqual(V9_EVAL_CHUNK_MAX_ROW_BYTES);

    const origBatch = chunk.db.batch.bind(chunk.db);
    let crashedOnce = false;
    chunk.db.batch = (async (stmts: D1PreparedStatement[]) => {
      if (!crashedOnce && stmts.length >= 3 &&
        await countRows(chunk.db, "SELECT COUNT(*) AS c FROM cache WHERE key = ?", SAFETY_SCORE_V9_CACHE_KEYS.publication) > 0) {
        crashedOnce = true;
        throw new Error("sim-crash-before-transition");
      }
      return origBatch(stmts);
    }) as D1Database["batch"];
    expect(await deliverV9Continuation(chunk.db, cur!, { deliveryId: "commit-1", attempts: 1 })).toEqual({ acked: false, retried: true, sent: [] });
    expect(crashedOnce).toBe(true);
    chunk.db.batch = origBatch;

    await chunk.db.prepare("DELETE FROM cache WHERE key = ?").bind(ALERT_SAFETY_V9_SOURCE_CACHE_KEY).run();
    const recovered = await deliverV9Continuation(chunk.db, cur!, { deliveryId: "commit-1", attempts: 2 });
    expect(recovered.acked).toBe(true);
    const alert = await chunk.db.prepare("SELECT json_extract(value, '$.publicationGenerationId') AS generation FROM cache WHERE key = ?")
      .bind(ALERT_SAFETY_V9_SOURCE_CACHE_KEY).first<{ generation: string }>();
    expect(recovered.sent[0]?.stage).toBe("materialize");
    expect((await deliverV9Continuation(chunk.db, recovered.sent[0]!)).acked).toBe(true);

    const [monoPub, chunkPub, monoRow, chunkMat, runRow, cronRow, headRow, surfaceRow] = await Promise.all([
      loadSafetyScoreV9Publication(mono.db), loadSafetyScoreV9Publication(chunk.db),
      mono.db.prepare("SELECT value FROM cache WHERE key = ?").bind(SAFETY_SCORE_V9_CACHE_KEYS.publication).first<{ value: string }>(),
      chunk.db.prepare("SELECT value FROM cache WHERE key = ?").bind(V9_PUBLIC_MATERIALIZATION_CACHE_KEY).first<{ value: string }>(),
      loadV9EvalRun(chunk.db, first.runId),
      chunk.db.prepare("SELECT status, productive, publication_count, item_count, metadata FROM cron_runs WHERE idempotency_key = ?").bind(`v9-queue-commit:${first.runId}`).first<{ status: string; productive: number; publication_count: number; item_count: number; metadata: string }>(),
      chunk.db.prepare("SELECT last_outcome, last_productive_item_count, last_publication_at FROM worker_producer_heads WHERE job = 'compute-safety-score-v9'").first(),
      chunk.db.prepare("SELECT generation_id, published_at, state FROM surface_publication_generations WHERE surface = 'safety-score-v9'").first(),
    ]);
    expect(chunkPub).toEqual(monoPub);
    expect(alert?.generation).toBe(monoPub!.publicationGenerationId);
    expect(JSON.parse(chunkMat!.value)).toMatchObject({ publicationGenerationId: monoPub!.publicationGenerationId, payloadSha256: (JSON.parse(monoRow!.value) as { payloadSha256: string }).payloadSha256 });
    expect(runRow?.state).toBe("completed");
    expect(await countRows(chunk.db, "SELECT COUNT(*) AS c FROM v9_eval_chunks WHERE run_id = ?", first.runId)).toBe(0);
    expect(await countRows(chunk.db, "SELECT COUNT(*) AS c FROM safety_score_publication_attempts WHERE attempt_id = ?", `safety-score-v9-publication:${first.runId}`)).toBe(1);
    expect(await countRows(chunk.db, "SELECT COUNT(*) AS c FROM cron_slot_executions")).toBe(0);
    expect(cronRow).toMatchObject({ status: "ok", productive: 1, publication_count: 1, item_count: COHORT_IDS.length });
    expect((JSON.parse(cronRow!.metadata) as { outputPublishedAt: number }).outputPublishedAt).toBe(COHORT_INPUT.clockSec);
    expect(headRow).toEqual({ last_outcome: "ok", last_productive_item_count: COHORT_IDS.length, last_publication_at: COHORT_INPUT.clockSec });
    expect(surfaceRow).toEqual({ generation_id: monoPub!.publicationGenerationId, published_at: COHORT_INPUT.clockSec, state: "published" });

    expect(partitionV9DependencyChunks(
      { topologicalOrder: ["root-a", "scc-1", "scc-2", "leaf-b"], cyclicComponents: [["scc-1", "scc-2"]], serialPaths: [], basketPaths: [], exitPaths: [], controlPaths: [], oracleNavPaths: [] } as never,
      new Map([["root-a", []], ["scc-1", ["root-a", "scc-2"]], ["scc-2", ["scc-1"]], ["leaf-b", ["scc-1"]]]), 2,
    )).toMatchObject({ chunks: [["root-a"], ["scc-1", "scc-2"], ["leaf-b"]], exportedUpstreamsByChunk: [["root-a"], ["scc-1"], []], requiredPriorChunksByChunk: [[], [0], [1]] });
    expect(() => partitionV9DependencyChunks({ topologicalOrder: ["a", "b"], cyclicComponents: [], serialPaths: [{ assetId: "a", upstreamAssetId: "b" }], basketPaths: [], exitPaths: [], controlPaths: [], oracleNavPaths: [] } as never, new Map(), 1)).toThrow(/topological order/);
    expect(() => partitionV9DependencyChunks({} as never, new Map(), 71)).toThrow(/Invalid V9 maxChunkAssets/);
    expect(await resumeActiveChunkedV9Evaluation({ db: chunk.db, sourceInvocationId: "test:idle", options: { workerVersion: V9_QUEUE_TEST_WORKER_VERSION, deadlineMs: Date.now() + 60_000 } })).toBeNull();
  });

  it("recovers an inline commit after acceptance when completing the run fails", async () => {
    const { db } = fixtures.open();
    await seedDb(db);
    const { first } = await seedRun(db, COHORT_IDS.length, "test:inline", false);
    const commit = (await deliverV9Continuation(db, first)).sent[0]!;
    expect(commit.stage).toBe("commit");
    const store = await import("../../lib/safety-score-v9/chunked-eval-store");
    vi.spyOn(store, "markV9EvalRunCompletedAndPrune").mockRejectedValueOnce(new Error("completion unavailable"));
    expect((await deliverV9Continuation(db, commit, { deliveryId: "inline-commit" })).retried).toBe(true);
    const accepted = await loadSafetyScoreV9Publication(db);
    expect(accepted?.cards).toHaveLength(COHORT_IDS.length);
    expect(await deliverV9Continuation(db, commit, { deliveryId: "inline-commit", attempts: 2 }))
      .toEqual({ acked: true, retried: false, sent: [] });
    const run = await loadV9EvalRun(db, first.runId);
    const stored = await db.prepare("SELECT json_extract(value, '$.payloadSha256') AS sha FROM cache WHERE key = ?")
      .bind(SAFETY_SCORE_V9_CACHE_KEYS.publication).first<{ sha: string }>();
    expect(run).toMatchObject({ state: "completed", publication_generation_id: accepted!.publicationGenerationId, payload_sha256: stored!.sha });
  });

  it("handles R8 quarantine escalation, N5 failed/evicted reclaim, held cron_runs, and duplicate/stale rejection", async () => {
    const f = fixtures.open();
    await seedDb(f.db);
    const { first } = await seedRun(f.db, 2, "test:seed:q-n5");

    let msg: V9ContinuationMessage | undefined = first;
    let injected = false;
    while (msg && msg.quarantineEpoch === 0) {
      expect(await loadSafetyScoreV9Publication(f.db)).toBeNull();
      const out = await deliverV9Continuation(f.db, msg, {
        deliveryId: `e0-${msg.chunkIndex}`,
        onBeforeEvaluateAsset: (a, _i, ep) => { if (a === "usds-sky" && ep === 0) { injected = true; throw new Error("sim-eval"); } },
      });
      expect(out.acked).toBe(true);
      msg = out.sent[0];
    }
    expect(injected).toBe(true);
    expect(msg?.quarantineEpoch).toBe(1);

    const futureMs = Date.now() + 60_000;
    await insertSyntheticV9Exec(f.db, msg!, "reclaim-err", "finished", "error", futureMs);
    const r0 = await deliverV9Continuation(f.db, msg!, { deliveryId: "reclaim-err", attempts: 2 });
    await insertSyntheticV9Exec(f.db, r0.sent[0]!, "reclaim-evict", "running", null, futureMs);
    const r1 = await deliverV9Continuation(f.db, r0.sent[0]!, { deliveryId: "reclaim-evict", attempts: 2 });
    expect((await deliverV9Continuation(f.db, r1.sent[0]!, { deliveryId: "commit-held" })).acked).toBe(true);

    const [run, attemptRow, heldCron] = await Promise.all([
      loadV9EvalRun(f.db, first.runId),
      f.db.prepare("SELECT value FROM cache WHERE key = ?").bind(SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt).first<{ value: string }>(),
      f.db.prepare("SELECT status, productive, degraded_reason, metadata FROM cron_runs WHERE idempotency_key = ?").bind(`v9-queue-commit:${first.runId}`).first<{ status: string; productive: number; degraded_reason: string; metadata: string }>(),
    ]);
    expect(run).toMatchObject({ state: "completed", quarantine_epoch: 1 });
    expect((await loadSafetyScoreV9PublicationHealth(f.db))?.status).toBe("held");
    const attempt = JSON.parse(attemptRow!.value) as { quarantines: Array<{ assetId: string }>; affectedAssetIds: string[] };
    expect(attempt.quarantines.map((q) => q.assetId)).toContain("usds-sky");
    expect(attempt.affectedAssetIds).toEqual(expect.arrayContaining(["usds-sky", "susds-sky"]));
    expect(attempt.affectedAssetIds).not.toContain("usdc-circle");
    expect(heldCron).toMatchObject({ status: "degraded", productive: 0, degraded_reason: "v9-publication-held" });
    expect((JSON.parse(heldCron!.metadata) as { outputPublishedAt: number | null }).outputPublishedAt).toBeNull();

    const before = await countRows(f.db, "SELECT COUNT(*) AS c FROM v9_eval_queue_executions");
    expect(await deliverV9Continuation(f.db, first, { deliveryId: "e0-0" })).toEqual({ acked: true, retried: false, sent: [] });
    expect(await deliverV9Continuation(f.db, first, { deliveryId: "stale-new" })).toEqual({ acked: true, retried: false, sent: [] });
    expect(await countRows(f.db, "SELECT COUNT(*) AS c FROM v9_eval_queue_executions")).toBe(before);
  });

  it("enforces B1 drift, N1/N2 fencing and missing-blob abort, N3 baseline-drift, N4 :52 R3 inline commit, Nit 2 guard, chunk integrity, and stale sweep", async () => {
    const f = fixtures.open();
    await seedDb(f.db);
    // deferPublicMaterialization=false covers the inline published-materialized commit branch.
    const { first: msg } = await seedRun(f.db, 2, "test:fence", false);

    await expect(writeV9EvalChunk(f.db, {
      runId: msg.runId, chunkKind: "chunk_summary", chunkIndex: 0, quarantineEpoch: 0, value: { ok: 1 }, createdAt: COHORT_INPUT.clockSec,
      fence: { executionGeneration: 99, expectedQuarantineEpoch: 0 },
    })).rejects.toThrow(/lost ownership/);
    expect(await markV9EvalRunCompletedAndPrune(f.db, {
      runId: msg.runId, expectedGeneration: 99, publicationGenerationId: null, payloadSha256: null, nowSec: COHORT_INPUT.clockSec + 5,
    })).toBe(false);
    expect(await countRows(f.db, "SELECT COUNT(*) AS c FROM v9_eval_chunks WHERE run_id = ?", msg.runId)).toBeGreaterThan(0);

    let nextAfter52: V9ContinuationMessage | undefined;
    const resEval52 = await computeSafetyScoreV9(f.db, undefined, undefined, {
      queueMode: "on", isSecondChance: true, slotStartedAt: COHORT_INPUT.clockSec + 1_800,
      sourceInvocationId: "test:52:eval0", workerMetadata: V9_QUEUE_TEST_WORKER_META, onContinuation: (m) => { nextAfter52 = m; },
    });
    expect(resEval52.status).toBe("ok");
    expect(await deliverV9Continuation(f.db, msg, { deliveryId: "late-c0" })).toEqual({ acked: true, retried: false, sent: [] });
    expect((await deliverV9Continuation(f.db, nextAfter52!)).sent[0]?.stage).toBe("commit");
    const resumeCommit = await computeSafetyScoreV9(f.db, undefined, undefined, {
      queueMode: "on", isSecondChance: true, slotStartedAt: COHORT_INPUT.clockSec + 1_860,
      sourceInvocationId: "test:52:commit", workerMetadata: V9_QUEUE_TEST_WORKER_META,
    });
    expect(resumeCommit.status).toBe("ok");
    expect(resumeCommit.productivity?.publications?.[0]?.publishedAt).toBe(COHORT_INPUT.clockSec);
    expect((await loadV9EvalRun(f.db, msg.runId))?.state).toBe("completed");

    const fDrift = fixtures.open();
    await seedDb(fDrift.db);
    const { first: driftRun } = await seedRun(fDrift.db, 4, "test:n3:drift");
    expect((await deliverV9Continuation(fDrift.db, driftRun)).sent[0]?.stage).toBe("commit");
    await fDrift.db.prepare("UPDATE v9_eval_runs SET accepted_baseline_generation_id = 'stale-pinned-gen' WHERE run_id = ?").bind(driftRun.runId).run();
    const drifted = await computeSafetyScoreV9(fDrift.db, undefined, undefined, {
      queueMode: "on", isSecondChance: true, slotStartedAt: COHORT_INPUT.clockSec + 1_900,
      sourceInvocationId: "test:n3:commit", workerMetadata: V9_QUEUE_TEST_WORKER_META,
    });
    expect(drifted.status).toBe("degraded");
    expect((await loadV9EvalRun(fDrift.db, driftRun.runId))?.failure_reason).toBe("accepted-baseline-drift");
    expect(await loadSafetyScoreV9Publication(fDrift.db)).toBeNull();

    const nowSec = Math.floor(Date.now() / 1_000);
    await insertSyntheticV9Run(f.db, "drift-digest", nowSec, COHORT_INPUT.registryFingerprint, { evalDigest: "f".repeat(64) });
    expect(await deliverV9Continuation(f.db, { ...msg, runId: "drift-digest" })).toEqual({ acked: true, retried: false, sent: [] });
    expect((await loadV9EvalRun(f.db, "drift-digest"))?.failure_reason).toBe("build-drift-aborted");

    await insertSyntheticV9Run(f.db, "drift-worker", nowSec, COHORT_INPUT.registryFingerprint, { evalDigest: msg.evaluationBuildDigest });
    expect(await deliverV9Continuation(f.db, { ...msg, runId: "drift-worker" }, { workerVersion: "worker-other" })).toEqual({ acked: true, retried: false, sent: [] });
    expect((await loadV9EvalRun(f.db, "drift-worker"))?.failure_reason).toBe("worker-version-drift-aborted");

    await insertSyntheticV9Run(f.db, "drift-resume", nowSec + 5, COHORT_INPUT.registryFingerprint, { evalDigest: msg.evaluationBuildDigest });
    expect(await resumeActiveChunkedV9Evaluation({ db: f.db, sourceInvocationId: "r-ver", options: { workerVersion: "worker-other", deadlineMs: Date.now() + 60_000 } })).toBeNull();
    expect((await loadV9EvalRun(f.db, "drift-resume"))?.failure_reason).toBe("worker-version-drift-aborted");

    await insertSyntheticV9Run(f.db, "missing-blob", nowSec, COHORT_INPUT.registryFingerprint, { evalDigest: msg.evaluationBuildDigest });
    expect(await deliverV9Continuation(f.db, { ...msg, runId: "missing-blob" })).toEqual({ acked: true, retried: false, sent: [] });
    expect((await loadV9EvalRun(f.db, "missing-blob"))?.failure_reason).toBe("missing-staging-blob:run_context[0]");
    expect(await deliverV9Continuation(f.db, { invalid: true })).toEqual({ acked: true, retried: false, sent: [] });

    const origApply = supplyAttrGen.applySafetyScoreV9SupplyAttributionGeneration;
    vi.spyOn(supplyAttrGen, "applySafetyScoreV9SupplyAttributionGeneration").mockImplementationOnce((inp, gen, last) => ({
      ...origApply(inp, gen, last), fixedInput: { ...origApply(inp, gen, last).fixedInput, baseInputGenerationId: "mutated-base-id" },
    }));
    await expect(seedRun(fDrift.db, 4, "test:nit2")).rejects.toThrow(/changed the authoritative fixed input/);

    const staleSec = nowSec - 4_000;
    await insertSyntheticV9Run(f.db, "stale-run-1", staleSec, COHORT_INPUT.registryFingerprint, { evalDigest: msg.evaluationBuildDigest });
    const payload = { items: Array.from({ length: 120 }, (_, i) => `item-${i}-${"x".repeat(20)}`) };
    expect(encodeV9EvalChunkParts(payload, 128).length).toBeGreaterThan(1);
    await writeV9EvalChunk(f.db, { runId: "stale-run-1", chunkKind: "fact_shard", chunkIndex: 0, quarantineEpoch: 0, value: payload, createdAt: staleSec, maxPartBytes: 128 });
    expect(await readV9EvalChunk<typeof payload>(f.db, { runId: "stale-run-1", chunkKind: "fact_shard", chunkIndex: 0, quarantineEpoch: 0 })).toEqual(payload);
    await f.db.prepare("UPDATE v9_eval_chunks SET payload_sha256 = ? WHERE run_id = 'stale-run-1' AND part_index = 0").bind("0".repeat(64)).run();
    await expect(readV9EvalChunk(f.db, { runId: "stale-run-1", chunkKind: "fact_shard", chunkIndex: 0, quarantineEpoch: 0 })).rejects.toThrow(/integrity check/);
    expect((await sweepStaleV9EvalRuns(f.db, nowSec, nowSec * 1_000)).sweptRunIds).toEqual(["stale-run-1"]);
    expect((await loadV9EvalRun(f.db, "stale-run-1"))?.failure_reason).toBe("stale-run-swept");
    expect(await countRows(f.db, "SELECT COUNT(*) AS c FROM v9_eval_chunks WHERE run_id = 'stale-run-1'")).toBe(0);
  });
});
