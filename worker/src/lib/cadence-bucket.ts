import { getCache } from "./db-cache";
import type { CronResult } from "./cron-logger";
import { parseJsonObject } from "./json-parse";
import { logWorkerEvent } from "./structured-log";

interface CadenceMarker {
  version: 1;
  bucket: number;
  state: "claimed" | "failed" | "completed";
  generation: string;
  claimedAt: number;
  completedAt?: number;
}

export interface CadenceBucketClaim {
  key: string;
  bucket: number;
  generation: string;
  serializedClaim: string;
}

export type CadenceBucketClaimResult =
  | { kind: "claimed"; claim: CadenceBucketClaim }
  | { kind: "skip"; reason: "already-completed" | "in-progress"; bucket: number };

function parseMarker(value: string): CadenceMarker | null {
  const parsed = parseJsonObject<Partial<CadenceMarker>>(value);
  if (
    !parsed
    || parsed.version !== 1
    || !Number.isInteger(parsed.bucket)
    || (parsed.state !== "claimed" && parsed.state !== "failed" && parsed.state !== "completed")
    || typeof parsed.generation !== "string"
    || !Number.isFinite(parsed.claimedAt)
  ) {
    return null;
  }
  return parsed as CadenceMarker;
}

function createGeneration(bucket: number, nowSec: number): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const random = cryptoObj?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${bucket}:${nowSec}:${random}`;
}

function changes(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === "number" ? result.meta.changes : 0;
}

export function cadenceBucketFor(scheduledAtSec: number, cadenceSec: number): number {
  if (!Number.isFinite(scheduledAtSec) || !Number.isFinite(cadenceSec) || cadenceSec <= 0) {
    throw new Error("Invalid cadence bucket input");
  }
  return Math.floor(scheduledAtSec / cadenceSec);
}

export function appendCadenceResultMetadata(
  result: CronResult,
  cadence: Record<string, unknown>,
): CronResult {
  let metadata: Record<string, unknown> = {};
  const parsed = parseJsonObject(result.metadata);
  if (parsed) {
    metadata = parsed;
  } else if (result.metadata) {
    metadata = { originalMetadata: result.metadata };
  }
  return { ...result, metadata: JSON.stringify({ ...metadata, cadence }) };
}

export async function claimCadenceBucket(
  db: D1Database,
  options: {
    key: string;
    bucket: number;
    nowSec: number;
    staleClaimAfterSec: number;
  },
): Promise<CadenceBucketClaimResult> {
  const existingRow = await getCache(db, options.key);
  const existing = existingRow ? parseMarker(existingRow.value) : null;
  if (existing && existing.bucket > options.bucket) {
    return { kind: "skip", reason: "already-completed", bucket: existing.bucket };
  }
  if (existing && existing.bucket === options.bucket) {
    if (existing.state === "completed") {
      return { kind: "skip", reason: "already-completed", bucket: existing.bucket };
    }
    if (
      existing.state === "claimed"
      && options.nowSec - existing.claimedAt < options.staleClaimAfterSec
    ) {
      return { kind: "skip", reason: "in-progress", bucket: existing.bucket };
    }
  }

  const generation = createGeneration(options.bucket, options.nowSec);
  const serializedClaim = JSON.stringify({
    version: 1,
    bucket: options.bucket,
    state: "claimed",
    generation,
    claimedAt: options.nowSec,
  } satisfies CadenceMarker);

  let result: D1Result<unknown>;
  if (existingRow) {
    result = await db
      .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
      .bind(serializedClaim, options.nowSec, options.key, existingRow.value)
      .run();
  } else {
    result = await db
      .prepare("INSERT OR IGNORE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(options.key, serializedClaim, options.nowSec)
      .run();
  }

  if (changes(result) !== 1) {
    return { kind: "skip", reason: "in-progress", bucket: options.bucket };
  }
  return {
    kind: "claimed",
    claim: { key: options.key, bucket: options.bucket, generation, serializedClaim },
  };
}

async function transitionClaim(
  db: D1Database,
  claim: CadenceBucketClaim,
  state: "failed" | "completed",
  nowSec: number,
): Promise<boolean> {
  const marker: CadenceMarker = {
    version: 1,
    bucket: claim.bucket,
    state,
    generation: claim.generation,
    claimedAt: Number(claim.generation.split(":", 2)[1]) || nowSec,
    ...(state === "completed" ? { completedAt: nowSec } : {}),
  };
  const result = await db
    .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
    .bind(JSON.stringify(marker), nowSec, claim.key, claim.serializedClaim)
    .run();
  return changes(result) === 1;
}

export function completeCadenceBucket(
  db: D1Database,
  claim: CadenceBucketClaim,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  return transitionClaim(db, claim, "completed", nowSec);
}

export function failCadenceBucket(
  db: D1Database,
  claim: CadenceBucketClaim,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  return transitionClaim(db, claim, "failed", nowSec);
}

export async function runCadenceBucketPublication(
  db: D1Database,
  options: {
    key: string;
    cadenceSec: number;
    staleClaimAfterSec: number;
    scheduledAtSec: number;
    startedAtSec: number;
    job: string;
    releaseFailureEvent: string;
    releaseFailureMessage: string;
    publication: (startedAtSec: number) => Promise<CronResult>;
  },
): Promise<CronResult> {
  const bucket = cadenceBucketFor(options.scheduledAtSec, options.cadenceSec);
  const claimResult = await claimCadenceBucket(db, {
    key: options.key,
    bucket,
    nowSec: options.startedAtSec,
    staleClaimAfterSec: options.staleClaimAfterSec,
  });
  if (claimResult.kind === "skip") {
    return {
      itemCount: 0,
      metadata: JSON.stringify({
        reason: claimResult.reason === "already-completed"
          ? "cadence_bucket_completed"
          : "cadence_bucket_in_progress",
        cadence: {
          bucket,
          observedBucket: claimResult.bucket,
          cadenceSec: options.cadenceSec,
        },
      }),
    };
  }

  try {
    const result = await options.publication(options.startedAtSec);
    const resultMetadata = parseJsonObject(result.metadata) ?? {};
    if (resultMetadata.lastWriteAdvanced !== true) {
      await failCadenceBucket(db, claimResult.claim);
      return appendCadenceResultMetadata(
        { ...result, status: "degraded" },
        { bucket, cadenceSec: options.cadenceSec, completed: false, retryable: true },
      );
    }
    const completed = await completeCadenceBucket(db, claimResult.claim);
    return appendCadenceResultMetadata(
      completed ? result : { ...result, status: "degraded" },
      { bucket, cadenceSec: options.cadenceSec, completed, retryable: !completed },
    );
  } catch (error) {
    try {
      await failCadenceBucket(db, claimResult.claim);
    } catch (transitionError) {
      logWorkerEvent({
        scope: "lib",
        level: "warn",
        event: options.releaseFailureEvent,
        job: options.job,
        message: options.releaseFailureMessage,
        error: transitionError,
        metadata: { bucket },
      });
    }
    throw error;
  }
}
