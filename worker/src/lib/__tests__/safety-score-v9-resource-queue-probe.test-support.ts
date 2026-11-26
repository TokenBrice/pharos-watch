import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { V9_PUBLIC_MATERIALIZATION_CACHE_KEY } from "@shared/types/report-cards-v9-materialization";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "@shared/types/safety-score-cache-keys";
import type { V9ContinuationMessage } from "@shared/types/v9-continuation";
import { getDexMeasuredExecutionFreshnessMaxSec } from "@shared/types/measured-execution";
import { makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput } from "./safety-score-v9-publication-store.test-support";
import { buildSafetyScoreV9AcceptedProjections } from "../safety-score-v9/accepted-projections";
import { persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { computeSafetyScoreV9 } from "../../cron/compute-safety-score-v9";
import {
  deliverV9Continuation, makePublishableV9Input, prepareV9SeedPayload, seedPreparedV9Db, V9_QUEUE_TEST_WORKER_META,
} from "../../test-helpers/v9-queue-harness";
import { createNativeSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS } from "../safety-score-v9/chunked-eval-plan";
import {
  loadV9EvalRun, readV9EvalChunk, V9_EVAL_CHUNK_MAX_ROW_BYTES,
} from "../safety-score-v9/chunked-eval-store";

const count = Number(process.env.PHAROS_QUEUE_ASSETS);
const escalation = process.env.PHAROS_QUEUE_ESCALATION;
const startedAt = performance.now();
const bootArrayBuffers = process.memoryUsage().arrayBuffers;
assert.ok(process.execArgv.includes("--max-old-space-size=128"));
const active = ACTIVE_STABLECOINS as Array<(typeof ACTIVE_STABLECOINS)[number]>;
const metaById = ACTIVE_META_BY_ID as Map<string, (typeof active)[number]>;
const template = active.find(({ id }) => id === "usdc-circle")!;
for (let i = active.length; i < count; i++) {
  const meta = { id: `resource-${i}`, name: `Resource ${i}`, symbol: `R${i}`, flags: template.flags,
    contracts: [], reserves: template.reserves };
  active.push(meta);
  metaById.set(meta.id, meta);
  (ACTIVE_IDS as Set<string>).add(meta.id);
}
const ids = active.slice(0, count).map(({ id }) => id);
const target = ids[ids.length - 1];
const monoSqlite = new DatabaseSync(":memory:");
const queueSqlite = new DatabaseSync(":memory:");
for (const sqlite of [monoSqlite, queueSqlite]) sqlite.deserialize(readFileSync(process.env.PHAROS_QUEUE_TEMPLATE!));
const db = createSqliteD1(queueSqlite);
const mono = createSqliteD1(monoSqlite);
const options = { deferPublicMaterialization: true, workerMetadata: V9_QUEUE_TEST_WORKER_META };
async function seedInputs() {
  const input = makePublishableV9Input(createNativeSafetyScoreV9FullRegistryInput(undefined, ids));
  const payload = await prepareV9SeedPayload(input);
  for (const destination of [mono, db]) {
    if (escalation === "commit-expiry") {
      const publishedAtSec = input.clockSec - 1_800;
      const accepted = makeWorkerSafetyScoreV9Publication({
        cards: [makeReportCardsV9PipelineGapCard(null, "A", { id: target })],
        publishedAtSec, asOfSec: publishedAtSec,
      });
      await persistSafetyScoreV9Publication(destination, {
        ...currentInput(accepted),
        deferPublicMaterialization: true,
        buildAcceptedProjections: (publication) => buildSafetyScoreV9AcceptedProjections(publication, {
          [target]: [{
            routeId: input.dexLiqMap[target]!.exitRouteObservations![0]!.routeId,
            dexGenerationId: input.dexGenerationId,
            observationWindowEndedAt: input.clockSec - getDexMeasuredExecutionFreshnessMaxSec() - 1,
            freshnessMaxSec: getDexMeasuredExecutionFreshnessMaxSec(),
          }],
        }),
      });
    }
    await seedPreparedV9Db(destination, payload);
  }
  return input.clockSec;
}
const peaks: Record<string, { heap: number; arrayBuffers: number; combined: number; rss: number; jsonBytes: number; fixedInputBytes: number; rowBytes: number }> = {};
const phaseHits = new Set<string>();
let stage = "";
function sample() {
  if (!stage) return;
  const peak = peaks[stage] ??= { heap: 0, arrayBuffers: 0, combined: 0, rss: 0, jsonBytes: 0, fixedInputBytes: 0, rowBytes: 0 };
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage();
  const buffersAboveBoot = Math.max(0, arrayBuffers - bootArrayBuffers);
  peak.heap = Math.max(peak.heap, heapUsed);
  peak.arrayBuffers = Math.max(peak.arrayBuffers, buffersAboveBoot);
  peak.combined = Math.max(peak.combined, heapUsed + buffersAboveBoot);
  peak.rss = Math.max(peak.rss, rss);
}
let injected = false;
let assetsSeen = 0;
Object.assign(globalThis, {
  __pharosResourcePhase(phase: string, detail?: string | { jsonBytes: number; fixedInput: boolean; rowBytes: number }) {
    if (phase === "evaluate" && escalation === "eval" && !injected && detail === target) {
      injected = true;
      throw new Error("resource-probe-quarantine");
    }
    if (!stage) return;
    if (phase === "queue-staging-encoded" && typeof detail === "object") {
      const peak = peaks[stage]!;
      if (detail.fixedInput) peak.fixedInputBytes = Math.max(peak.fixedInputBytes, detail.jsonBytes);
      else peak.jsonBytes = Math.max(peak.jsonBytes, detail.jsonBytes);
      peak.rowBytes = Math.max(peak.rowBytes, detail.rowBytes);
      return;
    }
    if (phase.startsWith("queue-")) phaseHits.add(phase);
    if (phase !== "evaluate" && (phase !== "asset-compiled" || ++assetsSeen % 8 === 0)) sample();
  },
});
const batch = db.batch.bind(db);
db.batch = (stmts) => { sample(); return batch(stmts); };

const canonicalSha = (sqlite: DatabaseSync) => sqlite.prepare(
  "SELECT json_extract(value, '$.payloadSha256') AS sha FROM cache WHERE key = ?",
).get(SAFETY_SCORE_V9_CACHE_KEYS.publication)?.sha;

try {
  const clockSec = await seedInputs().catch((error: unknown) => {
    throw new Error(`Queue resource setup failed: ${String(error)}`);
  });
  stage = "seed";
  sample();
  let first: V9ContinuationMessage | undefined;
  const seeded = await computeSafetyScoreV9(db, undefined, undefined, {
    ...options, queueMode: "on", slotStartedAt: clockSec, sourceInvocationId: "v9-resource:seed",
    onContinuation: (message) => { first = message; },
  });
  assert.ok(first, seeded.metadata ?? "Seed returned no continuation");
  sample();
  assert.ok(peaks.seed!.fixedInputBytes > 0);
  const plan = await readV9EvalChunk<{ chunkAssetIds: string[][] }>(db, {
    runId: first.runId, chunkKind: "run_context", chunkIndex: 0, quarantineEpoch: 0,
  });
  const chunkSizes = plan!.chunkAssetIds.map((chunkIds) => chunkIds.length);
  assert.equal(chunkSizes.reduce((a, b) => a + b), count);
  assert.ok(Math.max(...chunkSizes) <= V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS);
  let delivered = 0;
  let message: V9ContinuationMessage | undefined = first;
  let escalatedAt: string | undefined;
  let lastStage: string | undefined;
  while (message) {
    const { chunkIndex, quarantineEpoch, stage: kind } = message;
    lastStage = kind;
    assert.ok(delivered++ < chunkSizes.length * 2 + 3);
    stage = `e${quarantineEpoch}:${kind}${kind === "eval" ? chunkIndex : ""}`;
    sample();
    const result = await deliverV9Continuation(db, message, { deliveryId: `resources-${delivered}` });
    sample();
    assert.equal(result.acked, true, stage);
    const next = result.sent[0];
    if (next && next.quarantineEpoch !== quarantineEpoch) escalatedAt = kind;
    assert.equal(queueSqlite.prepare("SELECT COUNT(*) AS count FROM v9_eval_chunks WHERE chunk_kind = 'fact_shard'").get()?.count, 0);
    message = next;
  }
  const queueMs = Math.round(performance.now() - startedAt);
  assert.equal(escalatedAt, escalation === "commit-expiry" ? "commit" : escalation === "eval" ? "eval" : undefined);
  assert.equal(lastStage, "materialize", String(queueSqlite.prepare("SELECT value FROM cache WHERE key = ?")
    .get(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth)?.value));
  for (const phase of ["queue-commit-summaries", "queue-commit-shards", "queue-candidate", "queue-materialize-decoded", "queue-materialize-staged"]) {
    assert.ok(phaseHits.has(phase), `missing sample: ${phase}`);
  }
  stage = "";
  for (const [name, peak] of Object.entries(peaks)) {
    assert.ok(peak.combined <= 128 * 1024 * 1024, `${name}: ${peak.combined} heap and buffer bytes (${JSON.stringify(peak)})`);
    assert.ok(peak.jsonBytes <= 4 * 1024 * 1024, `${name}: ${peak.jsonBytes} staging JSON bytes`);
    assert.ok(peak.fixedInputBytes <= 6 * 1024 * 1024, `${name}: ${peak.fixedInputBytes} pinned input JSON bytes`);
    assert.ok(peak.rowBytes <= V9_EVAL_CHUNK_MAX_ROW_BYTES, `${name}: ${peak.rowBytes} row bytes`);
  }
  const run = await loadV9EvalRun(db, first.runId);
  const marker = JSON.parse(String(queueSqlite.prepare("SELECT value FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)?.value));
  const sha = canonicalSha(queueSqlite);
  assert.match(String(sha), /^[0-9a-f]{64}$/u);
  assert.equal(marker.payloadSha256, sha);
  assert.equal(marker.publicationGenerationId, run?.publication_generation_id);
  assert.equal(run?.state, "completed");
  assert.equal(run.quarantine_epoch, escalation === "none" ? 0 : 1);
  assert.equal(injected, escalation === "eval");
  assert.equal(queueSqlite.prepare("SELECT COUNT(*) AS count FROM v9_eval_chunks").get()?.count, 0);
  queueSqlite.close();

  // The canonical store SHA covers every publication byte, including identities and openEvidence.
  injected = false;
  const monoRes = await computeSafetyScoreV9(mono, undefined, undefined, { ...options, queueMode: "off" });
  assert.equal(JSON.parse(monoRes.metadata!).publication.status, "published", monoRes.metadata ?? "Monolithic publication failed");
  assert.equal(canonicalSha(monoSqlite), sha);
  assert.equal(injected, escalation === "eval");
  console.info(`queue-telemetry: ${JSON.stringify({
    count, escalation, escalatedAt, chunkSizes, bootArrayBuffers, queueMs, totalMs: Math.round(performance.now() - startedAt), peaks,
  })}`);
} finally {
  if (queueSqlite.isOpen) queueSqlite.close();
  monoSqlite.close();
}
