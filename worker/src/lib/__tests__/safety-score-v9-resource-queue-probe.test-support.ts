import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { V9_PUBLIC_MATERIALIZATION_CACHE_KEY } from "@shared/types/report-cards-v9-materialization";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "@shared/types/safety-score-cache-keys";
import type { V9ContinuationMessage } from "@shared/types/v9-continuation";
import { computeSafetyScoreV9 } from "../../cron/compute-safety-score-v9";
import {
  deliverV9Continuation, makePublishableV9Input, prepareV9SeedPayload, seedPreparedV9Db, V9_QUEUE_TEST_WORKER_META,
} from "../../test-helpers/v9-queue-harness";
import { createNativeSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS } from "../safety-score-v9/chunked-eval-plan";
import {
  loadV9EvalRun, readV9EvalChunk, V9_EVAL_CHUNK_MAX_JSON_BYTES, V9_EVAL_CHUNK_MAX_ROW_BYTES,
} from "../safety-score-v9/chunked-eval-store";

const count = Number(process.env.PHAROS_QUEUE_ASSETS);
const escalation = process.env.PHAROS_QUEUE_ESCALATION === "true";
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
  await seedPreparedV9Db(mono, payload);
  await seedPreparedV9Db(db, payload);
  return input.clockSec;
}
const clockSec = await seedInputs();
const peaks: Record<string, { heap: number; postGc: number; rss: number; jsonBytes: number; rowBytes: number }> = {};
let stage = "seed";
function sample(collect = false) {
  if (!stage) return;
  const peak = peaks[stage] ??= { heap: 0, postGc: 0, rss: 0, jsonBytes: 0, rowBytes: 0 };
  const { heapUsed, rss } = process.memoryUsage();
  peak.heap = Math.max(peak.heap, heapUsed);
  peak.rss = Math.max(peak.rss, rss);
  if (collect) {
    global.gc!();
    peak.postGc = Math.max(peak.postGc, process.memoryUsage().heapUsed);
  }
}
let injected = false;
let assetsSeen = 0;
Object.assign(globalThis, {
  __pharosResourcePhase(phase: string, assetId?: string) {
    if (phase === "evaluate" && escalation && !injected && assetId === target) {
      injected = true;
      throw new Error("resource-probe-quarantine");
    }
    if (phase === "asset-compiled") sample(++assetsSeen % 24 === 0);
    else if (phase !== "evaluate") sample(true);
  },
});
const batch = db.batch.bind(db);
db.batch = (stmts) => { sample(); return batch(stmts); };

function measureStaging(where: string) {
  const peak = peaks[stage]!;
  const rows = queueSqlite.prepare(`SELECT chunk_kind, chunk_index, payload FROM v9_eval_chunks
    WHERE ${where} ORDER BY chunk_kind, chunk_index, part_index`).all();
  const parts = new Map<string, string[]>();
  for (const { chunk_kind, chunk_index, payload } of rows) {
    assert.notEqual(chunk_kind, "fact_shard");
    const key = `${chunk_kind}:${chunk_index}`;
    const list = parts.get(key) ?? [];
    list.push(String(payload));
    parts.set(key, list);
    peak.rowBytes = Math.max(peak.rowBytes, String(payload).length);
  }
  for (const blobs of parts.values()) {
    const raw = inflateRawSync(Buffer.from(blobs.join(""), "base64")).byteLength;
    peak.jsonBytes = Math.max(peak.jsonBytes, raw);
  }
}
const canonicalSha = (sqlite: DatabaseSync) => sqlite.prepare(
  "SELECT json_extract(value, '$.payloadSha256') AS sha FROM cache WHERE key = ?",
).get(SAFETY_SCORE_V9_CACHE_KEYS.publication)?.sha;

try {
  sample(true);
  let first: V9ContinuationMessage | undefined;
  const seeded = await computeSafetyScoreV9(db, undefined, undefined, {
    ...options, queueMode: "on", slotStartedAt: clockSec, sourceInvocationId: "v9-resource:seed",
    onContinuation: (message) => { first = message; },
  });
  assert.ok(first, seeded.metadata ?? "Seed returned no continuation");
  sample(true);
  measureStaging("1 = 1");
  const plan = await readV9EvalChunk<{ chunkAssetIds: string[][] }>(db, {
    runId: first.runId, chunkKind: "run_context", chunkIndex: 0, quarantineEpoch: 0,
  });
  const chunkSizes = plan!.chunkAssetIds.map((chunkIds) => chunkIds.length);
  assert.equal(chunkSizes.reduce((a, b) => a + b), count);
  assert.ok(Math.max(...chunkSizes) <= V9_EVAL_DEFAULT_MAX_CHUNK_ASSETS);
  let delivered = 0;
  let message: V9ContinuationMessage | undefined = first;
  while (message) {
    const { chunkIndex, quarantineEpoch, stage: kind } = message;
    assert.ok(delivered++ < chunkSizes.length * 2 + 3);
    stage = `e${quarantineEpoch}:${kind}${kind === "eval" ? chunkIndex : ""}`;
    sample(true);
    const result = await deliverV9Continuation(db, message, { deliveryId: `resources-${delivered}` });
    sample(true);
    assert.equal(result.acked, true, stage);
    const next = result.sent[0];
    measureStaging(kind === "eval" && next?.quarantineEpoch === quarantineEpoch
      ? `(chunk_kind = 'run_context' AND chunk_index = 3) OR (chunk_kind != 'run_context' AND chunk_index = ${chunkIndex})`
      : "1 = 1");
    message = next;
  }
  console.info(`queue-telemetry: ${JSON.stringify({ count, escalation, chunkSizes, peaks })}`);
  stage = "";
  for (const [name, peak] of Object.entries(peaks)) {
    assert.ok(peak.postGc <= 110 * 1024 * 1024, `${name}: ${peak.postGc} post-GC bytes`);
    assert.ok(peak.jsonBytes <= V9_EVAL_CHUNK_MAX_JSON_BYTES, `${name}: ${peak.jsonBytes} JSON bytes`);
    assert.ok(peak.rowBytes <= V9_EVAL_CHUNK_MAX_ROW_BYTES, `${name}: ${peak.rowBytes} row bytes`);
  }
  const run = await loadV9EvalRun(db, first.runId);
  const marker = JSON.parse(String(queueSqlite.prepare("SELECT value FROM cache WHERE key = ?").get(V9_PUBLIC_MATERIALIZATION_CACHE_KEY)?.value));
  const sha = canonicalSha(queueSqlite);
  assert.match(String(sha), /^[0-9a-f]{64}$/u);
  assert.equal(marker.payloadSha256, sha);
  assert.equal(marker.publicationGenerationId, run?.publication_generation_id);
  assert.equal(run?.state, "completed");
  assert.equal(run.quarantine_epoch, escalation ? 1 : 0);
  assert.equal(injected, escalation);
  assert.equal(queueSqlite.prepare("SELECT COUNT(*) AS count FROM v9_eval_chunks").get()?.count, 0);
  queueSqlite.close();

  // The canonical store SHA covers every publication byte, including identities and openEvidence.
  injected = false;
  const monoRes = await computeSafetyScoreV9(mono, undefined, undefined, { ...options, queueMode: "off" });
  assert.equal(JSON.parse(monoRes.metadata!).publication.status, "published", monoRes.metadata ?? "Monolithic publication failed");
  assert.equal(canonicalSha(monoSqlite), sha);
  assert.equal(injected, escalation);
} finally {
  if (queueSqlite.isOpen) queueSqlite.close();
  monoSqlite.close();
}
