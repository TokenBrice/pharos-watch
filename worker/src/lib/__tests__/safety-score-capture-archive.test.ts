import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { SafetyScoreCaptureArchiveCacheRows } from "@shared/types/safety-score-capture-archive";
import { SafetyScoreCaptureArchiveObjectSchema } from "@shared/types/safety-score-capture-archive";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput } from "./safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES } from "../safety-score-v9/publication-codec";
import { archiveSafetyScoreCapture, SAFETY_SCORE_CAPTURE_ARCHIVE_MAX_OBJECT_BYTES } from "../safety-score-v9/capture-archive";
import { SAFETY_SCORE_CAPTURE_ARCHIVE_WAIT_MS, SAFETY_SCORE_CAPTURE_ARCHIVE_CONTINUATION_MS } from "../safety-score-v9/capture-archive";
import * as structuredLog from "../structured-log";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); vi.restoreAllMocks(); });

function bucketFixture() {
  const put = vi.fn().mockResolvedValue({ key: "stored" });
  return { put, bucket: { put } as unknown as R2Bucket };
}
function rows(): SafetyScoreCaptureArchiveCacheRows {
  return {
    base: { key: "report-cards:v9:accepted-replay-base:v1", value: "base", updatedAt: 10 },
    delta: { key: "report-cards:v9:accepted-replay:v1", value: "delta", updatedAt: 10 },
    cards: { key: "report-cards:v9", value: "cards", updatedAt: 10 },
  };
}

function deferredUpload() {
  let resolve!: (object: R2Object) => void;
  let reject!: (error: Error) => void;
  let started!: () => void;
  const uploadStarted = new Promise<void>(done => { started = done; });
  const pending = new Promise<R2Object>((done, fail) => { resolve = done; reject = fail; });
  const put = vi.fn().mockImplementation(() => { started(); return pending; });
  return { put, pending, resolve, reject, uploadStarted, bucket: { put } as unknown as R2Bucket };
}

function backgroundContext() {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); } } as unknown as ExecutionContext;
  return { ctx, waits };
}

describe("accepted Safety capture archive", () => {
  it("stores exact committed strings/clocks and indexes the exact R2 SHA/bytes after upload", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    const { sqlite, db } = fixtures.open();
    const publication = makeWorkerSafetyScoreV9Publication();
    const cacheRows = await persistSafetyScoreV9Publication(db, {
      ...currentInput(publication), publicationReplayBaseValue: ' {"base":"é"} ',
      publicationReplayCaptureValue: '{"delta":"雪"}\n',
    });
    const { bucket, put } = bucketFixture();
    put.mockImplementation(async () => {
      expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
      return { key: "stored" };
    });
    const result = await archiveSafetyScoreCapture({ db, bucket, publication, cacheRows });
    expect(result.status).toBe("written");
    expect(put).toHaveBeenCalledOnce();
    const [key, value, options] = put.mock.calls[0]!;
    const object = SafetyScoreCaptureArchiveObjectSchema.parse(JSON.parse(value));
    for (const row of [object.base, object.delta, object.cards]) {
      const stored = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(row.key);
      expect(row.value).toBe(stored?.value);
      expect(row.updatedAt).toBe(stored?.updated_at);
    }
    const digest = createHash("sha256").update(value).digest("hex");
    const bytes = Buffer.byteLength(value, "utf8");
    expect(key).toBe(`captures/safety-score-v9-accepted/${new Date(publication.publishedAtSec * 1_000).toISOString().slice(0, 10)}/${publication.publicationGenerationId}.json`);
    expect(options).toMatchObject({ httpMetadata: { contentType: "application/json" }, customMetadata: {
      sha256: digest, generationId: publication.publicationGenerationId,
      methodologyVersion: publication.policyVersion, policyDigest: publication.policy.semanticDigest,
      evaluationBuildDigest: publication.evaluationBuildDigest,
    } });
    expect(sqlite.prepare("SELECT * FROM safety_score_capture_archive").get()).toEqual({
      generation_id: publication.publicationGenerationId, published_at: publication.publishedAtSec,
      methodology_version: publication.policyVersion, policy_digest: publication.policy.semanticDigest,
      evaluation_build_digest: publication.evaluationBuildDigest, r2_key: key,
      object_sha256: digest, object_bytes: bytes, archived_at: Math.floor(Date.now() / 1_000),
    });
    expect(result.bytes).toBe(bytes);
    // D1 stores only discovery/integrity metadata, never the three large values.
    expect(sqlite.prepare("PRAGMA table_info(safety_score_capture_archive)").all().map(row => row.name))
      .not.toContain("base_value");
  });

  it("isolates an R2 failure without writing the index", async () => {
    const { sqlite, db } = fixtures.open();
    const { bucket, put } = bucketFixture();
    put.mockRejectedValue(new Error("R2 unavailable"));
    await expect(archiveSafetyScoreCapture({ db, bucket, publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() }))
      .resolves.toMatchObject({ status: "failed", reason: "capture-upload-failed" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
  });

  it("isolates index failure after upload, leaving object expiry to the lifecycle", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec("DROP TABLE safety_score_capture_archive");
    const { bucket, put } = bucketFixture();
    await expect(archiveSafetyScoreCapture({ db, bucket, publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() }))
      .resolves.toMatchObject({ status: "failed", reason: "capture-index-write-failed" });
    expect(put).toHaveBeenCalledOnce();
  });

  it.each(["base", "delta", "cards"] as const)("skips an oversized %s transport before R2/D1 writes", async field => {
    const { sqlite, db } = fixtures.open();
    const { bucket, put } = bucketFixture();
    const cacheRows = rows();
    cacheRows[field].value = "é".repeat(Math.floor(SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES / 2) + 1);
    await expect(archiveSafetyScoreCapture({ db, bucket, publication: makeWorkerSafetyScoreV9Publication(), cacheRows }))
      .resolves.toMatchObject({ status: "skipped", reason: "capture-too-large", bytes: SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES + 2 });
    expect(put).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
  });

  it("guards total JSON bytes including escaping even when each value fits", async () => {
    const { db } = fixtures.open();
    const { bucket, put } = bucketFixture();
    const cacheRows = rows();
    for (const row of Object.values(cacheRows)) row.value = "\u0000".repeat(500_000);
    const result = await archiveSafetyScoreCapture({ db, bucket, publication: makeWorkerSafetyScoreV9Publication(), cacheRows });
    expect(result).toMatchObject({ status: "skipped", reason: "capture-too-large" });
    expect(result.bytes).toBeGreaterThan(SAFETY_SCORE_CAPTURE_ARCHIVE_MAX_OBJECT_BYTES);
    expect(put).not.toHaveBeenCalled();
  });

  it("accepts a value at the exact stored-byte boundary", async () => {
    const { db } = fixtures.open();
    const { bucket, put } = bucketFixture();
    const cacheRows = rows();
    cacheRows.base.value = "a".repeat(SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES);
    await expect(archiveSafetyScoreCapture({ db, bucket, publication: makeWorkerSafetyScoreV9Publication(), cacheRows }))
      .resolves.toMatchObject({ status: "written" });
    expect(put).toHaveBeenCalledOnce();
  });

  it("skips absent binding or absent accepted replay without I/O", async () => {
    const { db } = fixtures.open();
    const publication = makeWorkerSafetyScoreV9Publication();
    const { bucket, put } = bucketFixture();
    await expect(archiveSafetyScoreCapture({ db, publication, cacheRows: rows() }))
      .resolves.toEqual({ status: "skipped", reason: "archive-binding-unavailable" });
    await expect(archiveSafetyScoreCapture({ db, bucket, publication, cacheRows: null }))
      .resolves.toEqual({ status: "skipped", reason: "accepted-replay-unavailable" });
    expect(put).not.toHaveBeenCalled();
  });
  it("records abort before upload without starting any R2/D1 work", async () => {
    const { sqlite, db } = fixtures.open();
    const { bucket, put } = bucketFixture();
    const signal = AbortSignal.abort(new Error("caller cancelled"));
    await expect(archiveSafetyScoreCapture({ db, bucket, signal,
      publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() }))
      .resolves.toMatchObject({ status: "failed", reason: "capture-aborted" });
    expect(put).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
  });

  it("settles abort during PUT promptly and owns late success with waitUntil", async () => {
    const { sqlite, db } = fixtures.open();
    const upload = deferredUpload();
    const { ctx, waits } = backgroundContext();
    const caller = new AbortController();
    const result = archiveSafetyScoreCapture({ db, bucket: upload.bucket, ctx, signal: caller.signal,
      publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() });
    await upload.uploadStarted;
    caller.abort(new Error("caller cancelled"));
    await expect(result).resolves.toMatchObject({ status: "failed", reason: "capture-aborted",
      outcome: "pending-continuation" });
    expect(waits).toHaveLength(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
    upload.resolve({ key: "stored" } as R2Object);
    await Promise.all(waits);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(1);
  });

  it("times out within the remaining publication budget and indexes a late upload independently", async () => {
    vi.useFakeTimers();
    const { sqlite, db } = fixtures.open();
    const upload = deferredUpload();
    const { ctx, waits } = backgroundContext();
    const logger = vi.spyOn(structuredLog, "logWorkerEvent");
    const result = archiveSafetyScoreCapture({ db, bucket: upload.bucket, ctx,
      deadlineMs: Date.now() + 3_000,
      publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() });
    await upload.uploadStarted;
    await vi.advanceTimersByTimeAsync(999);
    expect(waits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: "failed", reason: "capture-upload-timeout",
      outcome: "pending-continuation" });
    upload.resolve({ key: "stored" } as R2Object);
    await Promise.all(waits);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(1);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      event: "safety_score_capture_archive_late_indexed",
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles late R2 failure without indexing or rejecting the owned continuation", async () => {
    vi.useFakeTimers();
    const { sqlite, db } = fixtures.open();
    const upload = deferredUpload();
    const { ctx, waits } = backgroundContext();
    const logger = vi.spyOn(structuredLog, "logWorkerEvent");
    const result = archiveSafetyScoreCapture({ db, bucket: upload.bucket, ctx,
      publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() });
    await upload.uploadStarted;
    await vi.advanceTimersByTimeAsync(SAFETY_SCORE_CAPTURE_ARCHIVE_WAIT_MS);
    await expect(result).resolves.toMatchObject({ reason: "capture-upload-timeout" });
    upload.reject(new Error("late R2 failure"));
    await Promise.all(waits);
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      event: "safety_score_capture_archive_late_failed",
      metadata: expect.objectContaining({ reason: "capture-upload-failed" }),
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the continuation and records outcome unknown if R2 never settles", async () => {
    vi.useFakeTimers();
    const { sqlite, db } = fixtures.open();
    const upload = deferredUpload();
    const { ctx, waits } = backgroundContext();
    const logger = vi.spyOn(structuredLog, "logWorkerEvent");
    const result = archiveSafetyScoreCapture({ db, bucket: upload.bucket, ctx,
      publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() });
    await upload.uploadStarted;
    await vi.advanceTimersByTimeAsync(SAFETY_SCORE_CAPTURE_ARCHIVE_WAIT_MS);
    await result;
    await vi.advanceTimersByTimeAsync(SAFETY_SCORE_CAPTURE_ARCHIVE_CONTINUATION_MS);
    await Promise.all(waits);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      event: "safety_score_capture_archive_late_failed",
      metadata: expect.objectContaining({ reason: "capture-continuation-timeout", outcome: "outcome-unknown" }),
    }));
    upload.resolve({ key: "stored" } as R2Object);
    await upload.pending;
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records outcome unknown when no ExecutionContext can own a pending PUT", async () => {
    vi.useFakeTimers();
    const { sqlite, db } = fixtures.open();
    const upload = deferredUpload();
    const result = archiveSafetyScoreCapture({ db, bucket: upload.bucket,
      publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() });
    await upload.uploadStarted;
    await vi.advanceTimersByTimeAsync(SAFETY_SCORE_CAPTURE_ARCHIVE_WAIT_MS);
    await expect(result).resolves.toMatchObject({ status: "failed", reason: "capture-upload-timeout",
      outcome: "outcome-unknown" });
    upload.resolve({ key: "stored" } as R2Object);
    await upload.pending;
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_capture_archive").get()?.n).toBe(0);
  });

  it("repeated same-generation upload uses identical bytes and INSERT OR IGNORE preserves one index", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { sqlite, db } = fixtures.open();
    const { bucket, put } = bucketFixture();
    const input = { db, bucket, publication: makeWorkerSafetyScoreV9Publication(), cacheRows: rows() };
    await expect(archiveSafetyScoreCapture(input)).resolves.toMatchObject({ status: "written" });
    const firstIndex = sqlite.prepare("SELECT * FROM safety_score_capture_archive").get();
    vi.setSystemTime(Date.now() + 1_000);
    await expect(archiveSafetyScoreCapture(input)).resolves.toMatchObject({ status: "written" });
    expect(put.mock.calls[1]).toEqual(put.mock.calls[0]);
    expect(sqlite.prepare("SELECT * FROM safety_score_capture_archive").all()).toEqual([firstIndex]);
  });
});
