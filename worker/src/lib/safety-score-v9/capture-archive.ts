import { Buffer as NodeBuffer } from "node:buffer";
import type { SafetyScoreCaptureArchiveCacheRows, SafetyScoreCaptureArchiveObject } from "@shared/types/safety-score-capture-archive";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { createTimeoutSignal, type TimeoutSignalHandle } from "@shared/lib/timeout-signal";
import { throwIfAborted } from "../abort";
import { executeAtomicBatch } from "../db";
import { sha256Hex } from "../hash";
import { logWorkerEvent } from "../structured-log";
import { SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES } from "./publication-codec";

// Correct the ambient Workers Buffer declaration without encoding payloads
// solely to count bytes; nodejs_compat supplies the native Node constructor.
const Buffer = NodeBuffer as BufferConstructor;

export const SAFETY_SCORE_CAPTURE_ARCHIVE_MAX_OBJECT_BYTES = 8_000_000;
export const SAFETY_SCORE_CAPTURE_ARCHIVE_WAIT_MS = 15_000;
const SAFETY_SCORE_CAPTURE_ARCHIVE_FINALIZATION_MARGIN_MS = 2_000;
export const SAFETY_SCORE_CAPTURE_ARCHIVE_CONTINUATION_MS = 30_000;
export type SafetyScoreCaptureArchiveResult = {
  status: "written" | "failed" | "skipped";
  reason?: string;
  bytes?: number;
  outcome?: "pending-continuation" | "outcome-unknown";
  uploaded?: boolean;
};

type ArchiveIndex = Pick<SafetyScoreCaptureArchiveObject,
  "generationId" | "publishedAt" | "methodologyVersion" | "policyDigest" | "evaluationBuildDigest"> & {
  key: string;
  digest: string;
  bytes: number;
};

function waitForArchiveOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("capture-aborted"));
    };
    // Attach both settlement handlers even if already aborted: an uncancellable
    // operation's eventual rejection must remain observed.
    void operation.then(value => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function persistArchiveIndex(db: D1Database, index: ArchiveIndex, signal: AbortSignal): Promise<void> {
  await executeAtomicBatch(db, [db.prepare(`INSERT OR IGNORE INTO safety_score_capture_archive
    (generation_id, published_at, methodology_version, policy_digest, evaluation_build_digest,
     r2_key, object_sha256, object_bytes, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    index.generationId, index.publishedAt, index.methodologyVersion, index.policyDigest,
    index.evaluationBuildDigest, index.key, index.digest, index.bytes, Math.floor(Date.now() / 1_000),
  )], { signal });
}

async function persistArchiveIndexWithinBudget(db: D1Database, index: ArchiveIndex): Promise<void> {
  const timeout = createTimeoutSignal({
    timeoutMs: SAFETY_SCORE_CAPTURE_ARCHIVE_CONTINUATION_MS, timeoutReason: "capture-index-write-timeout",
  });
  try {
    await waitForArchiveOperation(persistArchiveIndex(db, index, timeout.signal), timeout.signal);
  } finally {
    timeout.dispose();
  }
}

function handOffArchiveOperation(
  pending: Promise<unknown>, db: D1Database, index: ArchiveIndex,
  phase: "upload" | "index", ctx?: ExecutionContext,
): "pending-continuation" | "outcome-unknown" {
  if (!ctx) {
    logWorkerEvent({ scope: "lib", level: "warn", event: "safety_score_capture_archive_outcome_unknown",
      job: "compute-safety-score-v9", message: "Uncancellable archive operation has no background lifetime owner",
      metadata: { generationId: index.generationId, phase, outcome: "outcome-unknown" } });
    return "outcome-unknown";
  }
  // Independent of caller/publication cancellation; retain only the narrow
  // index identity here, not the decoded publication or input graphs.
  ctx.waitUntil((async () => {
    const continuation = createTimeoutSignal({
      timeoutMs: SAFETY_SCORE_CAPTURE_ARCHIVE_CONTINUATION_MS,
      timeoutReason: "capture-continuation-timeout",
    });
    let uploaded = phase === "index";
    try {
      await waitForArchiveOperation(pending, continuation.signal);
      uploaded = true;
      if (phase === "upload") {
        await waitForArchiveOperation(persistArchiveIndex(db, index, continuation.signal), continuation.signal);
      }
      logWorkerEvent({ scope: "lib", level: "info", event: "safety_score_capture_archive_late_indexed",
        job: "compute-safety-score-v9", message: "Late Safety capture upload/index completed",
        metadata: { generationId: index.generationId, bytes: index.bytes } });
    } catch (error) {
      logWorkerEvent({ scope: "lib", level: "warn", event: "safety_score_capture_archive_late_failed",
        job: "compute-safety-score-v9", message: "Late Safety capture completion did not confirm indexing",
        metadata: { generationId: index.generationId, uploaded,
          reason: continuation.isTimedOut() ? "capture-continuation-timeout"
            : uploaded ? "capture-index-write-failed" : "capture-upload-failed",
          ...(continuation.isTimedOut() || (error instanceof Error && error.message === "capture-index-write-timeout")
            ? { outcome: "outcome-unknown" } : {}),
          error: String(error).slice(0, 200) } });
    } finally {
      continuation.dispose();
    }
  })());
  return "pending-continuation";
}

/** Best effort after canonical persistence; never inflate or re-encode cache values. */
export async function archiveSafetyScoreCapture(input: {
  db: D1Database;
  bucket?: R2Bucket;
  publication: Readonly<SafetyScoreV9CurrentResponse>;
  cacheRows: SafetyScoreCaptureArchiveCacheRows | null;
  signal?: AbortSignal;
  /** Earlier of the publication timeout and the scheduled execution-window deadline. */
  deadlineMs?: number;
  ctx?: ExecutionContext;
}): Promise<SafetyScoreCaptureArchiveResult> {
  const startedAtMs = Date.now();
  let reason = "capture-upload-failed";
  let bytes: number | undefined;
  let budget: TimeoutSignalHandle | undefined;
  let pending: Promise<unknown> | undefined;
  let index: ArchiveIndex | undefined;
  let phase: "upload" | "index" = "upload";
  try {
    if (!input.bucket) return { status: "skipped", reason: "archive-binding-unavailable" };
    if (!input.cacheRows) return { status: "skipped", reason: "accepted-replay-unavailable" };
    throwIfAborted(input.signal);
    for (const row of [input.cacheRows.base, input.cacheRows.delta, input.cacheRows.cards]) {
      const valueBytes = Buffer.byteLength(row.value, "utf8");
      if (valueBytes > SAFETY_SCORE_V9_PUBLICATION_MAX_STORED_BYTES) {
        return { status: "skipped", reason: "capture-too-large", bytes: valueBytes };
      }
    }
    const publication = input.publication;
    const object: SafetyScoreCaptureArchiveObject = {
      schemaVersion: 1,
      generationId: publication.publicationGenerationId,
      publishedAt: publication.publishedAtSec,
      methodologyVersion: publication.policyVersion,
      policyDigest: publication.policy.semanticDigest,
      evaluationBuildDigest: publication.evaluationBuildDigest,
      ...input.cacheRows,
    };
    // Values are already gzip-base64 envelopes. Never inflate or re-encode them.
    const value = JSON.stringify(object);
    const objectBytes = Buffer.byteLength(value, "utf8");
    bytes = objectBytes;
    if (objectBytes > SAFETY_SCORE_CAPTURE_ARCHIVE_MAX_OBJECT_BYTES) {
      return { status: "skipped", reason: "capture-too-large", bytes };
    }
    const digest = await sha256Hex(value);
    throwIfAborted(input.signal);
    const nowMs = Date.now();
    const waitMs = Math.max(0, Math.min(
      SAFETY_SCORE_CAPTURE_ARCHIVE_WAIT_MS - (nowMs - startedAtMs),
      input.deadlineMs === undefined ? SAFETY_SCORE_CAPTURE_ARCHIVE_WAIT_MS
        : input.deadlineMs - nowMs - SAFETY_SCORE_CAPTURE_ARCHIVE_FINALIZATION_MARGIN_MS,
    ));
    if (waitMs === 0) return { status: "failed", reason: "capture-upload-timeout", bytes, uploaded: false };
    budget = createTimeoutSignal({ timeoutMs: waitMs, timeoutReason: "capture-upload-timeout",
      parentSignal: input.signal });
    const day = new Date(publication.publishedAtSec * 1_000).toISOString().slice(0, 10);
    const key = `captures/safety-score-v9-accepted/${day}/${publication.publicationGenerationId}.json`;
    index = {
      generationId: object.generationId, publishedAt: object.publishedAt,
      methodologyVersion: object.methodologyVersion, policyDigest: object.policyDigest,
      evaluationBuildDigest: object.evaluationBuildDigest, key, digest, bytes: objectBytes,
    };
    const upload = input.bucket.put(key, value, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        sha256: digest, generationId: object.generationId, publishedAt: String(object.publishedAt),
        methodologyVersion: object.methodologyVersion, policyDigest: object.policyDigest,
        evaluationBuildDigest: object.evaluationBuildDigest,
      },
    }).then(stored => {
      if (!stored) throw new Error("capture-upload-not-stored");
      return stored;
    });
    pending = upload;
    await waitForArchiveOperation(upload, budget.signal);
    phase = "index";
    reason = "capture-index-write-failed";
    pending = persistArchiveIndexWithinBudget(input.db, index);
    await waitForArchiveOperation(pending, budget.signal);
    return { status: "written", bytes };
  } catch (error) {
    const interrupted = input.signal?.aborted || budget?.isTimedOut();
    if (input.signal?.aborted) reason = "capture-aborted";
    else if (budget?.isTimedOut() && phase === "upload") reason = "capture-upload-timeout";
    const outcome = interrupted && pending && index
      ? handOffArchiveOperation(pending, input.db, index, phase, input.ctx) : undefined;
    logWorkerEvent({ scope: "lib", level: "warn", event: "safety_score_capture_archive_failed",
      job: "compute-safety-score-v9", message: "Safety capture archive did not confirm completion after publication",
      metadata: { reason, ...(outcome ? { outcome } : {}), ...(phase === "index" ? { uploaded: true } : {}),
        error: String(error).slice(0, 200) } });
    return { status: "failed", reason, ...(bytes === undefined ? {} : { bytes }),
      ...(outcome ? { outcome } : {}), ...(phase === "index" ? { uploaded: true } : {}) };
  } finally {
    budget?.dispose();
  }
}
