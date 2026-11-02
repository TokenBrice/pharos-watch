import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEvent } from "./structured-log";

const TWITTER_DIGEST_MAX_ATTEMPTS = 3;
const TWITTER_DIGEST_SENDING_TTL_SEC = 120;

export class TwitterDigestLedgerPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwitterDigestLedgerPersistenceError";
  }
}

export type TwitterDigestDeliveryState = "queued" | "sending" | "sent" | "execution_unknown" | "failed";

export interface TwitterDigestDeliveryRecord {
  schemaVersion: 1;
  state: TwitterDigestDeliveryState;
  editionNumber: number | null;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  sendingAt?: number;
  completedAt?: number;
  tweetId?: string;
  lastError?: string;
  /** Unique per claim attempt so a replayed write can be told from a new owner. */
  claimToken?: string;
}

interface TwitterDeliveryErrorShape {
  twitterDeliveryFailureKind?: unknown;
}

export interface TwitterDigestPostResult {
  tweetId: string;
  mediaAttached: boolean;
}

export type TwitterDigestLedgerResult =
  | { status: "sent"; post: TwitterDigestPostResult }
  | { status: "skipped"; reason: "already-sent" | "execution-unknown" | "attempt-limit" | "in-flight" };

function parseRecord(value: string): TwitterDigestDeliveryRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<TwitterDigestDeliveryRecord>;
    if (
      parsed.schemaVersion !== 1
      || !["queued", "sending", "sent", "execution_unknown", "failed"].includes(String(parsed.state))
      || typeof parsed.attempts !== "number"
      || typeof parsed.createdAt !== "number"
      || typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return parsed as TwitterDigestDeliveryRecord;
  } catch {
    return null;
  }
}

/** The pre-ledger same-day marker shapes are delivery evidence; anything else unreadable is not. */
function isLegacyDeliveryMarker(value: string): boolean {
  if (value === "sent") return true;
  try {
    const parsed = JSON.parse(value) as { state?: unknown; sentAt?: unknown } | null;
    return parsed != null && typeof parsed === "object"
      && (parsed.state === "sent" || (parsed.state == null && typeof parsed.sentAt === "number"));
  } catch {
    return false;
  }
}

/** Existing editions need durable evidence before another attempt is allowed. */
export async function readTwitterDigestDeliveryStatus(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return "skipped: execution-unknown";
  const record = parseRecord(row.value);
  if (!record) {
    // Marker presence alone never proves a tweet; only the known legacy marker
    // shapes (or a terminal sent row) are duplicate-safe.
    return isLegacyDeliveryMarker(row.value) ? "skipped: already-sent" : "skipped: execution-unknown";
  }
  if (record.state === "sent") return "skipped: already-sent";
  if (record.state === "execution_unknown") return "skipped: execution-unknown";
  if (record.state === "failed" && record.attempts >= TWITTER_DIGEST_MAX_ATTEMPTS) {
    return "skipped: attempt-limit";
  }
  // The claim owner resolves live/expired sending and fences every attempt.
  return null;
}

async function replaceRecord(
  db: D1Database,
  key: string,
  previousValue: string,
  next: TwitterDigestDeliveryRecord,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const nextValue = JSON.stringify(next);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
      .bind(nextValue, next.updatedAt, key, previousValue)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (Number(result.meta.changes ?? 0) === 1) return true;
  // A transport-ambiguous retry can replay an UPDATE this run already
  // committed and report zero changes because the WHERE now compares the
  // pre-write value. Read the row back: only the intended record (including
  // this claim's token) proves the write landed; a different record is a lost
  // fence.
  const row = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT value FROM cache WHERE key = ?")
      .bind(key)
      .first<{ value: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (!row) throw new Error(`Twitter digest delivery ledger disappeared (${key})`);
  return row.value === nextValue;
}

function createClaimToken(nowSec: number): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return cryptoObj?.randomUUID?.() ?? `${nowSec}:${Math.random().toString(36).slice(2)}`;
}

async function claimDelivery(
  db: D1Database,
  key: string,
  editionNumber: number | null,
  nowSec: number,
  signal?: AbortSignal,
): Promise<{ record: TwitterDigestDeliveryRecord; value: string } | TwitterDigestLedgerResult> {
  const queued: TwitterDigestDeliveryRecord = {
    schemaVersion: 1,
    state: "queued",
    editionNumber,
    attempts: 0,
    createdAt: nowSec,
    updatedAt: nowSec,
  };
  const queuedValue = JSON.stringify(queued);
  const insert = await runWithOverloadRetry(() =>
    db
      .prepare("INSERT OR IGNORE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, queuedValue, nowSec)
      .run(),
    3,
    signal,
  );

  let candidate = queued;
  let candidateValue = queuedValue;
  if (Number(insert.meta.changes ?? 0) === 0) {
    const row = await runWithOverloadRetry(() =>
      db
        .prepare("SELECT value FROM cache WHERE key = ?")
        .bind(key)
        .first<{ value: string }>(),
      3,
      signal,
    );
    if (!row) throw new Error(`Twitter digest delivery ledger disappeared (${key})`);
    candidateValue = row.value;
    const parsed = parseRecord(row.value);
    if (!parsed) {
      if (isLegacyDeliveryMarker(row.value)) return { status: "skipped", reason: "already-sent" };
      logExecutionUnknown(key, 0, "unreadable_ledger_record");
      return { status: "skipped", reason: "execution-unknown" };
    }
    candidate = parsed;

    if (candidate.state === "sent") return { status: "skipped", reason: "already-sent" };
    if (candidate.state === "execution_unknown") return { status: "skipped", reason: "execution-unknown" };
    if (candidate.state === "sending") {
      if (nowSec - (candidate.sendingAt ?? candidate.updatedAt) < TWITTER_DIGEST_SENDING_TTL_SEC) {
        return { status: "skipped", reason: "in-flight" };
      }
      const executionUnknown: TwitterDigestDeliveryRecord = {
        ...candidate,
        state: "execution_unknown",
        updatedAt: nowSec,
        completedAt: nowSec,
        lastError: "delivery_owner_lost",
      };
      if (!(await replaceRecord(db, key, candidateValue, executionUnknown, signal))) {
        return { status: "skipped", reason: "in-flight" };
      }
      logExecutionUnknown(key, candidate.attempts, "delivery_owner_lost");
      return { status: "skipped", reason: "execution-unknown" };
    }
    if (candidate.state === "failed" && candidate.attempts >= TWITTER_DIGEST_MAX_ATTEMPTS) {
      logAttemptsExhausted(key, candidate.attempts);
      return { status: "skipped", reason: "attempt-limit" };
    }
  }

  const sending: TwitterDigestDeliveryRecord = {
    ...candidate,
    state: "sending",
    attempts: candidate.attempts + 1,
    updatedAt: nowSec,
    sendingAt: nowSec,
    completedAt: undefined,
    tweetId: undefined,
    lastError: undefined,
    claimToken: createClaimToken(nowSec),
  };
  if (!(await replaceRecord(db, key, candidateValue, sending, signal))) {
    return { status: "skipped", reason: "in-flight" };
  }
  return { record: sending, value: JSON.stringify(sending) };
}

function logExecutionUnknown(key: string, attempts: number, error: string): void {
  logWorkerEvent({
    scope: "handler",
    level: "error",
    event: "twitter_digest_execution_unknown",
    job: "daily-digest",
    message: "Twitter digest delivery outcome is unknown; automatic retry is disabled pending manual reconciliation",
    metadata: {
      key,
      attempts,
      error,
      manualReconciliation: "Check the Twitter/X account for the dated digest, then repair the cache ledger state before retrying",
    },
  });
}

function logAttemptsExhausted(key: string, attempts: number): void {
  logWorkerEvent({
    scope: "handler",
    level: "error",
    event: "twitter_digest_attempts_exhausted",
    job: "daily-digest",
    message: "Twitter digest delivery attempts are exhausted; automatic retry is disabled",
    metadata: {
      key,
      attempts,
      maxAttempts: TWITTER_DIGEST_MAX_ATTEMPTS,
    },
  });
}

export async function deliverTwitterDigestWithLedger(
  db: D1Database,
  key: string,
  editionNumber: number | null,
  nowSec: number,
  post: () => Promise<TwitterDigestPostResult>,
  signal?: AbortSignal,
): Promise<TwitterDigestLedgerResult> {
  let claim: Awaited<ReturnType<typeof claimDelivery>>;
  try {
    claim = await claimDelivery(db, key, editionNumber, nowSec, signal);
  } catch (error) {
    throw new TwitterDigestLedgerPersistenceError(`Twitter digest delivery ledger write failed (${key}): ${toErrorMessage(error)}`);
  }
  if ("status" in claim) return claim;

  let posted: TwitterDigestPostResult;
  try {
    posted = await post();
  } catch (error) {
    const failureKind = (error as TwitterDeliveryErrorShape | null)?.twitterDeliveryFailureKind;
    const definitive = failureKind === "definitive_failure";
    const retryable = failureKind === "retryable_failure";
    const terminal: TwitterDigestDeliveryRecord = {
      ...claim.record,
      state: definitive || retryable ? "failed" : "execution_unknown",
      attempts: retryable ? Math.max(0, claim.record.attempts - 1) : claim.record.attempts,
      updatedAt: nowSec,
      completedAt: nowSec,
      lastError: toErrorMessage(error).slice(0, 300),
    };
    let persisted: boolean;
    try {
      persisted = await replaceRecord(db, key, claim.value, terminal, signal);
    } catch (persistenceError) {
      logExecutionUnknown(key, claim.record.attempts, "terminal_state_persistence_failed");
      throw new TwitterDigestLedgerPersistenceError(`Twitter digest terminal state write failed (${key}): ${toErrorMessage(persistenceError)}`);
    }
    if (!persisted) {
      logExecutionUnknown(key, claim.record.attempts, "terminal_state_persistence_lost");
      throw new TwitterDigestLedgerPersistenceError(`Twitter digest terminal state was not confirmed (${key}): ${toErrorMessage(error)}`);
    }
    if (!definitive && !retryable) logExecutionUnknown(key, claim.record.attempts, terminal.lastError ?? "unknown");
    throw error;
  }

  const sent: TwitterDigestDeliveryRecord = {
    ...claim.record,
    state: "sent",
    updatedAt: nowSec,
    completedAt: nowSec,
    tweetId: posted.tweetId,
  };
  let sentPersisted: boolean;
  try {
    sentPersisted = await replaceRecord(db, key, claim.value, sent, signal);
  } catch (error) {
    logExecutionUnknown(key, claim.record.attempts, "accepted_tweet_persistence_failed");
    throw new TwitterDigestLedgerPersistenceError(`Twitter digest sent state write failed (${key}): ${toErrorMessage(error)}`);
  }
  if (!sentPersisted) {
    logExecutionUnknown(key, claim.record.attempts, "accepted_tweet_persistence_lost");
    throw new TwitterDigestLedgerPersistenceError(`Twitter digest sent state was not confirmed (${key})`);
  }
  return { status: "sent", post: posted };
}
