import { afterEach, describe, expect, it, vi } from "vitest";
import { computePegScore } from "@shared/lib/peg-score";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "@shared/types/safety-score-cache-keys";
import { V9_PUBLIC_MATERIALIZATION_CACHE_KEY } from "@shared/types/report-cards-v9-materialization";
import {
  V9_CONTINUATION_QUEUE_NAME,
  type V9ContinuationMessage,
} from "@shared/types/v9-continuation";
import { computeSafetyScoreV9 } from "../compute-safety-score-v9";
import { handleV9ContinuationBatch } from "../../handlers/v9-continuation";
import type { HeavyEnv } from "../../lib/env";
import {
  createNativeSafetyScoreV9CohortInput,
  createNativeSafetyScoreV9FullRegistryInput,
} from "../../lib/__tests__/fixtures/safety-score-v9-full-registry-input";
import {
  buildSafetyScoreV9CaptureControl,
  SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY,
} from "../../lib/safety-score-v9/capture-control";
import {
  currentV9PolicyDigestForClock,
  resumeActiveChunkedV9Evaluation,
} from "../../lib/safety-score-v9/chunked-eval-pipeline";
import { partitionV9DependencyChunks } from "../../lib/safety-score-v9/chunked-eval-plan";
import {
  encodeV9EvalChunkParts,
  loadV9EvalRun,
  readV9EvalChunk,
  sweepStaleV9EvalRuns,
  V9_EVAL_CHUNK_MAX_ROW_BYTES,
  writeV9EvalChunk,
} from "../../lib/safety-score-v9/chunked-eval-store";
import {
  buildNativeV9InputCacheEntry,
  NATIVE_V9_INPUT_CACHE_KEY,
  normalizeNativeV9Input,
  type NativeSafetyScoreV9Input,
} from "../../lib/safety-score-v9/native-input";
import {
  buildSafetyScoreV9PegProvenanceSeedCacheEntry,
  captureSafetyScoreV9PegProvenanceById,
  SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY,
} from "../../lib/safety-score-v9/peg-provenance";
import { loadSafetyScoreV9PublicationHealth } from "../../lib/safety-score-v9/publication-health";
import { loadSafetyScoreV9Publication } from "../../lib/safety-score-v9/publication-store";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

function makePublishableInput(raw: NativeSafetyScoreV9Input): NativeSafetyScoreV9Input {
  const { baseInputGenerationId: _oldBase, ...withoutIdentity } = raw;
  const prepared = normalizeNativeV9Input({
    ...withoutIdentity,
    v9PublicationInputHealth: {
      dex: { state: "current", generationId: raw.dexGenerationId, updatedAtSec: raw.clockSec - 100 },
      redemption: { state: "not-applicable", generationId: null, updatedAtSec: null },
      liveReserves: { state: "available", coverageRatio: 1 },
    },
  });
  for (const peg of Object.values(prepared.pegDataById)) {
    Object.assign(peg, computePegScore([], peg.historyCoverage!.startedAt!, raw.clockSec));
  }
  const { baseInputGenerationId: _base, ...finalPayload } = prepared;
  return normalizeNativeV9Input(finalPayload);
}

const FULL_REGISTRY_INPUT = makePublishableInput(createNativeSafetyScoreV9FullRegistryInput());
const COHORT_ASSET_IDS = [
  "usdc-circle",
  "usdt-tether",
  "dai-makerdao",
  "usds-sky",
  "susds-sky",
  "usde-ethena",
  "susde-ethena",
  "frax-frax",
  "gho-aave",
  "lusd-liquity",
  "crvusd-curve",
  "buidl-blackrock",
] as const;
const COHORT_INPUT = makePublishableInput(createNativeSafetyScoreV9CohortInput(COHORT_ASSET_IDS));

async function seedV9Inputs(db: D1Database, input: NativeSafetyScoreV9Input): Promise<void> {
  const identity = buildSafetyScoreV9InputIdentity({
    methodologyVersion: input.methodologyVersion,
    baseInputGenerationId: input.baseInputGenerationId,
    publicationGenerationId: input.sourceGeneration,
  });
  const fixedEntry = await buildNativeV9InputCacheEntry(input, identity);
  const pegProvenanceById = captureSafetyScoreV9PegProvenanceById(input, {
    clockSec: input.clockSec,
    eventsByCoin: new Map(),
  });
  const pegSeedEntry = buildSafetyScoreV9PegProvenanceSeedCacheEntry({
    sourceGeneration: input.sourceGeneration,
    clockSec: input.clockSec,
    safetyScoreIdentity: identity,
    pegProvenanceById,
  });
  const control = buildSafetyScoreV9CaptureControl(
    {
      safetyScoreIdentity: identity,
      baseInputGenerationId: input.baseInputGenerationId,
      sourceGeneration: input.sourceGeneration,
      clockSec: input.clockSec,
      registryFingerprint: input.registryFingerprint,
      workerVersion: "worker-v9-queue-test",
      workerUploadedAtSec: input.clockSec - 60,
    },
    input.clockSec,
  );
  const dexUpdatedAt = input.inputFreshness.dexLiquidity.updatedAt ?? input.clockSec - 100;

  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind("stablecoins", "{}", input.updatedAt),
    db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(NATIVE_V9_INPUT_CACHE_KEY, fixedEntry.value, input.clockSec),
    db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(SAFETY_SCORE_V9_PEG_PROVENANCE_SEED_CACHE_KEY, pegSeedEntry.value, input.clockSec),
    db.prepare(`INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, JSON.stringify(control), input.clockSec),
    db.prepare(
      `INSERT INTO dex_liquidity_publication_generations
        (generation_id, started_at, state, expected_row_count, written_row_count, current_row_count, created_at, published_at)
       VALUES (?, ?, 'published', ?, ?, ?, ?, ?)`,
    ).bind(
      input.dexGenerationId,
      dexUpdatedAt,
      ACTIVE_STABLECOINS.length,
      ACTIVE_STABLECOINS.length,
      ACTIVE_STABLECOINS.length,
      dexUpdatedAt,
      dexUpdatedAt,
    ),
  ];
  for (const coin of ACTIVE_STABLECOINS) {
    statements.push(
      db.prepare(
        `INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id)
         VALUES (?, ?, ?, ?)`,
      ).bind(coin.id, coin.symbol, dexUpdatedAt, input.dexGenerationId),
    );
  }
  await db.batch(statements);
}

interface DeliveryOutcome {
  acked: boolean;
  retried: boolean;
  sent: V9ContinuationMessage[];
}

function makeHeavyEnv(
  db: D1Database,
  sent: V9ContinuationMessage[],
  mode: "on" | "off" = "on",
): HeavyEnv {
  return {
    DB: db,
    CF_VERSION_METADATA: { id: "worker-v9-queue-test", tag: "", timestamp: "2026-11-25T12:00:00Z" },
    WORKER_V9_QUEUE_MODE: mode,
    SAFETY_V9_DEFERRED_MATERIALIZATION: "on",
    V9_CONTINUATION_QUEUE: {
      send: vi.fn(async (body: V9ContinuationMessage) => {
        sent.push(body);
      }),
      sendBatch: vi.fn(),
    },
  } as unknown as HeavyEnv;
}

async function deliverMessage(
  db: D1Database,
  message: V9ContinuationMessage,
  options: {
    deliveryId?: string;
    mode?: "on" | "off";
    onBeforeEvaluateAsset?: (assetId: string, index: number, quarantineEpoch: number) => void;
  } = {},
): Promise<DeliveryOutcome> {
  const sent: V9ContinuationMessage[] = [];
  const env = makeHeavyEnv(db, sent, options.mode ?? "on");
  const ack = vi.fn();
  const retry = vi.fn();
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  const batch = {
    queue: V9_CONTINUATION_QUEUE_NAME,
    messages: [
      {
        id: options.deliveryId ?? `del-${message.stage}-${message.chunkIndex ?? "na"}-e${message.quarantineEpoch}-g${message.executionGeneration}`,
        timestamp: new Date(),
        body: message,
        attempts: 1,
        ack,
        retry,
      },
    ],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;

  await handleV9ContinuationBatch(batch, env, ctx, Date.now(), {
    onBeforeEvaluateAsset: options.onBeforeEvaluateAsset,
  });
  await Promise.allSettled(waitUntilPromises);
  return {
    acked: ack.mock.calls.length > 0,
    retried: retry.mock.calls.length > 0,
    sent,
  };
}

async function drainQueueChain(
  db: D1Database,
  initial: V9ContinuationMessage,
  options: {
    maxSteps?: number;
    onBeforeStep?: (stepIndex: number, msg: V9ContinuationMessage) => Promise<void>;
    onBeforeEvaluateAsset?: (assetId: string, index: number, quarantineEpoch: number) => void;
  } = {},
): Promise<V9ContinuationMessage[]> {
  const processed: V9ContinuationMessage[] = [];
  const queue: V9ContinuationMessage[] = [initial];
  const maxSteps = options.maxSteps ?? 20;
  while (queue.length > 0) {
    if (processed.length >= maxSteps) {
      throw new Error(`V9 queue chain exceeded ${maxSteps} steps`);
    }
    const next = queue.shift()!;
    await options.onBeforeStep?.(processed.length, next);
    processed.push(next);
    const outcome = await deliverMessage(db, next, {
      deliveryId: `step-${processed.length}-${next.stage}-${next.chunkIndex ?? "na"}-e${next.quarantineEpoch}`,
      onBeforeEvaluateAsset: options.onBeforeEvaluateAsset,
    });
    expect(outcome.acked).toBe(true);
    expect(outcome.retried).toBe(false);
    queue.push(...outcome.sent);
  }
  return processed;
}

describe("Safety Score V9 ADR-26 chunked Queue evaluation", () => {
  it("achieves exact single-pass digest and materialized parity across the full active registry while keeping every staging chunk <= 512 KiB", async () => {
    const monoFixture = fixtures.open();
    const chunkFixture = fixtures.open();
    await Promise.all([
      seedV9Inputs(monoFixture.db, FULL_REGISTRY_INPUT),
      seedV9Inputs(chunkFixture.db, FULL_REGISTRY_INPUT),
    ]);

    const monoResult = await computeSafetyScoreV9(monoFixture.db, undefined, undefined, {
      queueMode: "off",
      deferPublicMaterialization: true,
    });
    expect((JSON.parse(monoResult.metadata!) as { publication: { status: string } }).publication.status).toBe("published");

    let firstContinuation: V9ContinuationMessage | undefined;
    const seedResult = await computeSafetyScoreV9(chunkFixture.db, undefined, undefined, {
      queueMode: "on",
      deferPublicMaterialization: true,
      maxChunkAssets: 140,
      slotStartedAt: FULL_REGISTRY_INPUT.clockSec,
      sourceInvocationId: "test:seed:full",
      onContinuation: (msg) => {
        firstContinuation = msg;
      },
    });
    expect((JSON.parse(seedResult.metadata!) as { mode: string }).mode).toBe("queue-seed");
    expect(firstContinuation).toBeDefined();
    expect(firstContinuation!.stage).toBe("eval");
    expect(firstContinuation!.chunkIndex).toBe(0);

    let maxObservedChunkBytes = 0;
    const steps = await drainQueueChain(chunkFixture.db, firstContinuation!, {
      onBeforeStep: async () => {
        const row = await chunkFixture.db
          .prepare(`SELECT COALESCE(MAX(LENGTH(CAST(payload AS BLOB))), 0) AS max_bytes FROM v9_eval_chunks`)
          .first<{ max_bytes: number }>();
        maxObservedChunkBytes = Math.max(maxObservedChunkBytes, row?.max_bytes ?? 0);
      },
    });

    const evalSteps = steps.filter((step) => step.stage === "eval");
    expect(evalSteps.length).toBe(Math.ceil(FULL_REGISTRY_INPUT.activeAssetIds.length / 140));
    expect(steps.some((step) => step.stage === "commit")).toBe(true);
    expect(steps.some((step) => step.stage === "materialize")).toBe(true);
    expect(maxObservedChunkBytes).toBeGreaterThan(0);
    expect(maxObservedChunkBytes).toBeLessThanOrEqual(V9_EVAL_CHUNK_MAX_ROW_BYTES);

    const [monoPub, chunkPub] = await Promise.all([
      loadSafetyScoreV9Publication(monoFixture.db),
      loadSafetyScoreV9Publication(chunkFixture.db),
    ]);
    expect(monoPub).not.toBeNull();
    expect(chunkPub).not.toBeNull();
    expect(chunkPub!.factSetDigest).toBe(monoPub!.factSetDigest);
    expect(chunkPub!.resultDigest).toBe(monoPub!.resultDigest);
    expect(chunkPub!.candidateId).toBe(monoPub!.candidateId);
    expect(chunkPub!.publicationGenerationId).toBe(monoPub!.publicationGenerationId);
    expect(chunkPub).toEqual(monoPub);

    const [monoPubRow, chunkMat] = await Promise.all([
      monoFixture.db.prepare(`SELECT value FROM cache WHERE key = ?`).bind(SAFETY_SCORE_V9_CACHE_KEYS.publication).first<{ value: string }>(),
      chunkFixture.db.prepare(`SELECT value FROM cache WHERE key = ?`).bind(V9_PUBLIC_MATERIALIZATION_CACHE_KEY).first<{ value: string }>(),
    ]);
    expect(chunkMat?.value).toBeTruthy();
    expect(JSON.parse(chunkMat!.value)).toMatchObject({
      publicationGenerationId: monoPub!.publicationGenerationId,
      payloadSha256: (JSON.parse(monoPubRow!.value) as { payloadSha256: string }).payloadSha256,
    });

    const manifestRow = await chunkFixture.db
      .prepare(`SELECT manifest FROM safety_score_public_manifests LIMIT 1`)
      .first<{ manifest: string }>();
    const publicManifest = JSON.parse(manifestRow!.manifest) as { bytes: number };
    // Verify expanded public wire response stays well inside the 24 MiB Pages proxy cap.
    expect(publicManifest.bytes).toBeGreaterThan(1_000_000);
    expect(publicManifest.bytes).toBeLessThan(24 * 1024 * 1024);

    const runRow = await loadV9EvalRun(chunkFixture.db, firstContinuation!.runId);
    expect(runRow?.state).toBe("completed");
    expect(runRow?.stage).toBe("completed");
    expect(runRow?.policy_digest).toBe(currentV9PolicyDigestForClock(FULL_REGISTRY_INPUT.clockSec));
    const remainingChunks = await chunkFixture.db
      .prepare(`SELECT COUNT(*) AS count FROM v9_eval_chunks WHERE run_id = ?`)
      .bind(firstContinuation!.runId)
      .first<{ count: number }>();
    expect(remainingChunks?.count).toBe(0);
    // Partitioning keeps SCCs intact inside one chunk and preserves topological order.
    const demoPlan = partitionV9DependencyChunks(
      {
        topologicalOrder: ["root-a", "scc-1", "scc-2", "leaf-b"],
        cyclicComponents: [["scc-1", "scc-2"]],
        cyclicAssetIds: new Set(["scc-1", "scc-2"]),
      } as never,
      new Map([
        ["root-a", []],
        ["scc-1", ["root-a", "scc-2"]],
        ["scc-2", ["scc-1"]],
        ["leaf-b", ["scc-1"]],
      ]),
      2,
    );
    expect(demoPlan.chunks).toEqual([["root-a"], ["scc-1", "scc-2"], ["leaf-b"]]);
    expect(demoPlan.exportedUpstreamsByChunk).toEqual([["root-a"], ["scc-1"], []]);
    expect(demoPlan.requiredPriorChunksByChunk).toEqual([[], [0], [1]]);
    expect(
      await resumeActiveChunkedV9Evaluation({
        db: chunkFixture.db,
        sourceInvocationId: "test:resume:idle",
        options: { deadlineMs: Date.now() + 60_000 },
      }),
    ).toBeNull();
  }, 180_000);

  it("handles R8 quarantine escalation without partial visibility and rejects duplicate/stale deliveries", async () => {
    const fixture = fixtures.open();
    await seedV9Inputs(fixture.db, COHORT_INPUT);

    let firstContinuation: V9ContinuationMessage | undefined;
    await computeSafetyScoreV9(fixture.db, undefined, undefined, {
      queueMode: "on",
      maxChunkAssets: 3,
      slotStartedAt: COHORT_INPUT.clockSec,
      sourceInvocationId: "test:seed:quarantine",
      onContinuation: (msg) => {
        firstContinuation = msg;
      },
    });
    expect(firstContinuation).toBeDefined();

    // Inject a deterministic epoch-0 evaluation failure on `usds-sky` (upstream of `susds-sky`).
    let injected = false;
    const steps = await drainQueueChain(fixture.db, firstContinuation!, {
      onBeforeStep: async (_idx, msg) => {
        if (msg.stage === "eval") {
          // Never expose partial publication before commit.
          expect(await loadSafetyScoreV9Publication(fixture.db)).toBeNull();
        }
      },
      onBeforeEvaluateAsset: (assetId, _index, quarantineEpoch) => {
        if (assetId === "usds-sky" && quarantineEpoch === 0) {
          injected = true;
          throw new Error("simulated-v9-chunk-eval-error");
        }
      },
    });
    expect(injected).toBe(true);
    expect(steps.some((step) => step.quarantineEpoch === 1)).toBe(true);

    const run = await loadV9EvalRun(fixture.db, firstContinuation!.runId);
    expect(run?.quarantine_epoch).toBe(1);
    expect(run?.state).toBe("completed");

    // Verify quarantined asset + downstream wrapper propagation recorded on the attempt without exposing partial publication.
    const attemptRow = await fixture.db
      .prepare(`SELECT value FROM cache WHERE key = ?`)
      .bind(SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt)
      .first<{ value: string }>();
    const attempt = JSON.parse(attemptRow!.value) as {
      quarantines: Array<{ assetId: string }>;
      affectedAssetIds: string[];
    };
    expect(attempt.quarantines.map((q) => q.assetId)).toContain("usds-sky");
    expect(attempt.affectedAssetIds).toContain("usds-sky");
    expect(attempt.affectedAssetIds).toContain("susds-sky");
    expect(attempt.affectedAssetIds).not.toContain("usdc-circle");

    // Duplicate delivery ID and stale epoch-0 continuation must both ack neutrally without re-running.
    const countBefore = await fixture.db
      .prepare(`SELECT COUNT(*) AS count FROM v9_eval_queue_executions`)
      .first<{ count: number }>();
    const dupOutcome = await deliverMessage(fixture.db, firstContinuation!, {
      deliveryId: "step-1-eval-0-e0",
    });
    const staleOutcome = await deliverMessage(fixture.db, firstContinuation!, {
      deliveryId: "brand-new-stale-delivery",
    });
    expect(dupOutcome).toEqual({ acked: true, retried: false, sent: [] });
    expect(staleOutcome).toEqual({ acked: true, retried: false, sent: [] });
    const countAfter = await fixture.db
      .prepare(`SELECT COUNT(*) AS count FROM v9_eval_queue_executions`)
      .first<{ count: number }>();
    expect(countAfter?.count).toBe(countBefore?.count);
  }, 60_000);

  it("fails closed on evaluator build drift and prunes staging chunks without publishing", async () => {
    const fixture = fixtures.open();
    await seedV9Inputs(fixture.db, COHORT_INPUT);

    let firstContinuation: V9ContinuationMessage | undefined;
    await computeSafetyScoreV9(fixture.db, undefined, undefined, {
      queueMode: "on",
      maxChunkAssets: 4,
      slotStartedAt: COHORT_INPUT.clockSec,
      sourceInvocationId: "test:seed:drift",
      onContinuation: (msg) => {
        firstContinuation = msg;
      },
    });
    expect(firstContinuation).toBeDefined();

    // Simulate a Worker deploy changing evaluation_build_digest mid-run.
    await fixture.db
      .prepare(`UPDATE v9_eval_runs SET evaluation_build_digest = ? WHERE run_id = ?`)
      .bind("f".repeat(64), firstContinuation!.runId)
      .run();

    const outcome = await deliverMessage(fixture.db, firstContinuation!);
    expect(outcome).toEqual({ acked: true, retried: false, sent: [] });

    const run = await loadV9EvalRun(fixture.db, firstContinuation!.runId);
    expect(run?.state).toBe("failed");
    expect(run?.stage).toBe("failed");
    expect(run?.failure_reason).toBe("build-drift-aborted");
    expect(await loadSafetyScoreV9Publication(fixture.db)).toBeNull();
    const chunks = await fixture.db
      .prepare(`SELECT COUNT(*) AS count FROM v9_eval_chunks WHERE run_id = ?`)
      .bind(firstContinuation!.runId)
      .first<{ count: number }>();
    expect(chunks?.count).toBe(0);
  });

  it("resumes an interrupted chain on :52 second chance, fences the dropped hint, and completes via Queue", async () => {
    const fixture = fixtures.open();
    await seedV9Inputs(fixture.db, COHORT_INPUT);

    let firstContinuation: V9ContinuationMessage | undefined;
    await computeSafetyScoreV9(fixture.db, undefined, undefined, {
      queueMode: "on",
      maxChunkAssets: 4,
      slotStartedAt: COHORT_INPUT.clockSec,
      sourceInvocationId: "test:seed:resume",
      onContinuation: (msg) => {
        firstContinuation = msg;
      },
    });
    // Process chunk 0 only, then drop the emitted chunk 1 hint to simulate Queue exhaustion.
    const chunk0Outcome = await deliverMessage(fixture.db, firstContinuation!);
    expect(chunk0Outcome.acked).toBe(true);
    expect(chunk0Outcome.sent).toHaveLength(1);
    const droppedChunk1Hint = chunk0Outcome.sent[0]!;
    expect(droppedChunk1Hint.stage).toBe("eval");
    expect(droppedChunk1Hint.chunkIndex).toBe(1);

    // :52 second-chance resumes chunk 1 directly and emits the next continuation (chunk 2).
    let resumedNext: V9ContinuationMessage | undefined;
    const resumeResult = await computeSafetyScoreV9(fixture.db, undefined, undefined, {
      queueMode: "on",
      isSecondChance: true,
      slotStartedAt: COHORT_INPUT.clockSec + 1_800,
      sourceInvocationId: "test:resume:52",
      onContinuation: (msg) => {
        resumedNext = msg;
      },
    });
    expect(resumeResult.status).toBe("ok");
    expect(resumedNext).toBeDefined();
    expect(resumedNext!.chunkIndex).toBe(2);

    // Late replay of the dropped chunk-1 hint must be rejected because :52 bumped execution_generation.
    const lateReplay = await deliverMessage(fixture.db, droppedChunk1Hint, {
      deliveryId: "late-dropped-chunk1",
    });
    expect(lateReplay).toEqual({ acked: true, retried: false, sent: [] });

    // Drain remaining chunks + commit cleanly (12-asset cohort holds under V9_MINIMUM_RATEABLE_ASSETS).
    await drainQueueChain(fixture.db, resumedNext!);
    const run = await loadV9EvalRun(fixture.db, firstContinuation!.runId);
    expect(run?.state).toBe("completed");
    expect((await loadSafetyScoreV9PublicationHealth(fixture.db))?.status).toBe("held");
    const remainingChunks = await fixture.db
      .prepare(`SELECT COUNT(*) AS count FROM v9_eval_chunks WHERE run_id = ?`)
      .bind(firstContinuation!.runId)
      .first<{ count: number }>();
    expect(remainingChunks?.count).toBe(0);
  });

  it("keeps queueMode='off' strictly monolithic, acks off-mode deliveries neutrally, enforces chunk integrity, and sweeps >1h stale runs", async () => {
    const fixture = fixtures.open();
    await seedV9Inputs(fixture.db, COHORT_INPUT);

    // Monolithic "off" writes zero v9_eval_runs rows.
    const offResult = await computeSafetyScoreV9(fixture.db, undefined, undefined, {
      queueMode: "off",
      deferPublicMaterialization: true,
    });
    expect((JSON.parse(offResult.metadata!) as { publication: { status: string } }).publication.status).toBe("held");
    const runCount = await fixture.db.prepare(`SELECT COUNT(*) AS count FROM v9_eval_runs`).first<{ count: number }>();
    expect(runCount?.count).toBe(0);

    // Consumer in WORKER_V9_QUEUE_MODE="off" acks neutrally with zero sends.
    const dummyMsg: V9ContinuationMessage = {
      version: 1,
      runId: "v9-run-off",
      scheduleKey: "v9PublicationOffset",
      slotStartedAt: COHORT_INPUT.clockSec,
      stage: "eval",
      chunkIndex: 0,
      quarantineEpoch: 0,
      attemptNo: 1,
      executionGeneration: 1,
      sourceInvocationId: "test:off",
      evaluationBuildDigest: "a".repeat(64),
      registryFingerprint: "b".repeat(64),
      policyDigest: "c".repeat(64),
    };
    const offDelivery = await deliverMessage(fixture.db, dummyMsg, { mode: "off" });
    expect(offDelivery).toEqual({ acked: true, retried: false, sent: [] });

    // Multi-part chunk splitting, SHA-256 tamper detection, and >1h stale run sweep.
    const nowSec = Math.floor(Date.now() / 1_000);
    const staleSec = nowSec - 4_000;
    await fixture.db
      .prepare(
        `INSERT INTO v9_eval_runs (
          run_id, schema_version, schedule_key, slot_started_at, clock_sec,
          source_generation, base_input_generation_id, registry_fingerprint,
          evaluation_build_digest, plan_digest, policy_digest,
          quarantine_epoch, chunk_count, next_chunk_index,
          materialize_step_count, next_materialize_step,
          stage, state, execution_generation, execution_owner,
          created_at, updated_at
        ) VALUES (?, 1, 'v9PublicationOffset', ?, ?, 'src', 'base', ?, ?, ?, ?, 0, 2, 0, 1, 0, 'evaluating', 'active', 1, 'owner', ?, ?)`,
      )
      .bind(
        "stale-run-1",
        staleSec,
        staleSec,
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        staleSec,
        staleSec,
      )
      .run();

    const payload = { items: Array.from({ length: 120 }, (_, i) => `item-${i}-${"x".repeat(20)}`) };
    const parts = encodeV9EvalChunkParts(payload, 128);
    expect(parts.length).toBeGreaterThan(1);
    const written = await writeV9EvalChunk(fixture.db, {
      runId: "stale-run-1",
      chunkKind: "fact_shard",
      chunkIndex: 0,
      quarantineEpoch: 0,
      value: payload,
      createdAt: staleSec,
      maxPartBytes: 128,
    });
    expect(written.partCount).toBe(parts.length);
    expect(
      await readV9EvalChunk<typeof payload>(fixture.db, {
        runId: "stale-run-1",
        chunkKind: "fact_shard",
        chunkIndex: 0,
        quarantineEpoch: 0,
      }),
    ).toEqual(payload);

    // Tampering with a stored part triggers SHA-256 verification failure.
    await fixture.db
      .prepare(`UPDATE v9_eval_chunks SET payload_sha256 = ? WHERE run_id = 'stale-run-1' AND part_index = 0`)
      .bind("0".repeat(64))
      .run();
    await expect(
      readV9EvalChunk(fixture.db, {
        runId: "stale-run-1",
        chunkKind: "fact_shard",
        chunkIndex: 0,
        quarantineEpoch: 0,
      }),
    ).rejects.toThrow(/integrity check/);

    // >1h stale sweep marks run failed and prunes all staging chunks.
    const swept = await sweepStaleV9EvalRuns(fixture.db, nowSec, nowSec * 1_000);
    expect(swept.sweptRunIds).toEqual(["stale-run-1"]);
    const sweptRun = await loadV9EvalRun(fixture.db, "stale-run-1");
    expect(sweptRun?.state).toBe("failed");
    expect(sweptRun?.failure_reason).toBe("stale-run-swept");
    const sweptChunks = await fixture.db
      .prepare(`SELECT COUNT(*) AS count FROM v9_eval_chunks WHERE run_id = 'stale-run-1'`)
      .first<{ count: number }>();
    expect(sweptChunks?.count).toBe(0);
  });
});
