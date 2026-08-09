import { getCache } from "../lib/db-cache";
import { batchExecute } from "../lib/db";
import { throwIfAborted } from "../lib/abort";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { LIVE_RESERVE_RUN_CURSOR_CACHE_KEY } from "../lib/operational-cache-keys";
import { breakerKeyForConfig, type ConfiguredCoin } from "./sync-live-reserves-shared";
import { toErrorMessage } from "../lib/error-utils";
import {
  buildReserveSyncAttemptHistoryInsertStatement,
  buildReserveSyncRecordDeferredStatement,
} from "../lib/live-reserves-store-statements";
import { logCronEvent } from "../lib/cron-logger";

export type LiveReserveCursorTailState = "recording" | "incomplete" | "complete";

export interface LiveReserveGlobalCursorOwner {
  scheduleKey: string;
  slotStartedAt: number;
  attemptNo: number;
  executionGeneration: number;
  invocationId: string;
  queueHash: string;
}

interface LiveReserveCursorState {
  nextStablecoinId: string | null;
  deferredCount: number;
  deferredAt: number;
  reason: "run-budget-exhausted";
  tailState?: LiveReserveCursorTailState;
  cursorRecordedAt?: number;
  tailCompletedAt?: number;
  tailFailedAt?: number;
  tailError?: string;
  runBudgetTruncationCount?: number;
  cursorOwner?: LiveReserveGlobalCursorOwner;
}

export interface LoadedLiveReserveCursorState {
  nextStablecoinId: string | null;
  deferredCount: number;
  deferredAt: number;
  tailState: LiveReserveCursorTailState | null;
  cursorRecordedAt: number | null;
  tailCompletedAt: number | null;
  tailFailedAt: number | null;
  tailError: string | null;
  runBudgetTruncationCount: number;
  cursorOwner?: LiveReserveGlobalCursorOwner;
  rawValue?: string;
}

export interface RecordDeferredTailResult {
  deferredCoins: number;
  nextCursorStablecoinId: string | null;
  cursorTailState: LiveReserveCursorTailState | null;
  cursorRecordedAt: number | null;
  cursorTailCompletedAt: number | null;
  cursorTailFailedAt: number | null;
  cursorTailError: string | null;
  runBudgetTruncationCount: number;
  /** Breaker keys for the deferred coins; merge into the run's breaker-key set. */
  additionalBreakerKeys: Set<string>;
}

export function selectConfiguredCoinRunQueue(
  configuredCoins: readonly ConfiguredCoin[],
  nextStablecoinId: string | null,
): ConfiguredCoin[] {
  if (!nextStablecoinId) return [...configuredCoins];

  const cursorIndex = configuredCoins.findIndex((coin) => coin.id === nextStablecoinId);
  if (cursorIndex < 0) return [...configuredCoins];

  return configuredCoins.slice(cursorIndex);
}

function parseCursorOwner(value: unknown): LiveReserveGlobalCursorOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const owner = value as Partial<LiveReserveGlobalCursorOwner>;
  return typeof owner.scheduleKey === "string"
    && typeof owner.slotStartedAt === "number"
    && typeof owner.attemptNo === "number"
    && typeof owner.executionGeneration === "number"
    && typeof owner.invocationId === "string"
    && typeof owner.queueHash === "string"
    ? owner as LiveReserveGlobalCursorOwner
    : null;
}

export async function loadLiveReserveCursorState(db: D1Database): Promise<LoadedLiveReserveCursorState | null> {
  const cached = await getCache(db, LIVE_RESERVE_RUN_CURSOR_CACHE_KEY);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value) as Partial<LiveReserveCursorState>;
    const tailState =
      parsed.tailState === "recording" || parsed.tailState === "incomplete" || parsed.tailState === "complete"
        ? parsed.tailState
        : null;
    const cursorOwner = parseCursorOwner(parsed.cursorOwner);
    return parsed.reason === "run-budget-exhausted" && typeof parsed.deferredAt === "number"
      ? {
          nextStablecoinId: typeof parsed.nextStablecoinId === "string" ? parsed.nextStablecoinId : null,
          deferredCount: typeof parsed.deferredCount === "number" ? parsed.deferredCount : 0,
          deferredAt: parsed.deferredAt,
          tailState,
          cursorRecordedAt: typeof parsed.cursorRecordedAt === "number" ? parsed.cursorRecordedAt : null,
          tailCompletedAt: typeof parsed.tailCompletedAt === "number" ? parsed.tailCompletedAt : null,
          tailFailedAt: typeof parsed.tailFailedAt === "number" ? parsed.tailFailedAt : null,
          tailError: typeof parsed.tailError === "string" ? parsed.tailError : null,
          runBudgetTruncationCount:
            typeof parsed.runBudgetTruncationCount === "number" && parsed.runBudgetTruncationCount > 0
              ? parsed.runBudgetTruncationCount
              : 1,
          ...(cursorOwner ? { cursorOwner, rawValue: cached.value } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

async function writeLiveReserveCursorState(
  db: D1Database,
  state: LiveReserveCursorState,
  updatedAt: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
      )
      .bind(
        LIVE_RESERVE_RUN_CURSOR_CACHE_KEY,
        JSON.stringify(state),
        updatedAt,
      )
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
}

async function deleteLiveReserveCursorState(db: D1Database, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await runWithOverloadRetry(() =>
    db.prepare("DELETE FROM cache WHERE key = ?").bind(LIVE_RESERVE_RUN_CURSOR_CACHE_KEY).run(),
    3,
    signal,
  );
  throwIfAborted(signal);
}

export async function recordDeferredTail(
  db: D1Database,
  remainingCoins: readonly ConfiguredCoin[],
  attemptedAt: number,
  signal?: AbortSignal,
  options: {
    manageGlobalCursor?: boolean;
    globalCursorOwner?: LiveReserveGlobalCursorOwner | null;
  } = {},
): Promise<RecordDeferredTailResult> {
  throwIfAborted(signal);
  const manageGlobalCursor = options.manageGlobalCursor ?? true;
  const deferredCoins = remainingCoins.length;
  const nextCursorStablecoinId = remainingCoins[0]?.id ?? null;
  const additionalBreakerKeys = new Set<string>();
  let previousCursorState: LoadedLiveReserveCursorState | null = null;
  if (manageGlobalCursor) {
    try {
      previousCursorState = await loadLiveReserveCursorState(db);
    } catch (error) {
      await logCronEvent(db, {
        job: "sync-live-reserves",
        eventType: "live-reserve-cursor-read-failed",
        severity: "warning",
        message: "Failed to read previous deferred reserve cursor state; truncation count will restart from one.",
        metadata: {
          error: toErrorMessage(error),
        },
      });
    }
  }
  const runBudgetTruncationCount = manageGlobalCursor
    ? previousCursorState
      ? previousCursorState.runBudgetTruncationCount + 1
      : 1
    : 0;
  const statements: D1PreparedStatement[] = [];
  const metadata = {
    failureCategory: "run-budget-exhausted",
    deferredTail: true,
  };
  const cursorBaseState = manageGlobalCursor && nextCursorStablecoinId
    ? {
        nextStablecoinId: nextCursorStablecoinId,
        deferredCount: deferredCoins,
        deferredAt: attemptedAt,
        reason: "run-budget-exhausted" as const,
        cursorRecordedAt: attemptedAt,
        runBudgetTruncationCount,
        ...(options.globalCursorOwner ? { cursorOwner: options.globalCursorOwner } : {}),
      }
    : null;

  if (cursorBaseState) {
    await writeLiveReserveCursorState(
      db,
      {
        ...cursorBaseState,
        tailState: "recording",
      },
      attemptedAt,
      signal,
    );
  }

  for (const remaining of remainingCoins) {
    const remainingConfig = remaining.liveReservesConfig!;
    const remainingBreakerKey = breakerKeyForConfig(remainingConfig);
    additionalBreakerKeys.add(remainingBreakerKey);
    statements.push(
      buildReserveSyncRecordDeferredStatement(db, {
        stablecoinId: remaining.id,
        adapterKey: remainingConfig.adapter,
        breakerKey: remainingBreakerKey,
        attemptedAt,
        reason: "run-budget-exhausted",
      }),
      buildReserveSyncAttemptHistoryInsertStatement(db, {
        stablecoinId: remaining.id,
        attemptedAt,
        adapterKey: remainingConfig.adapter,
        breakerKey: remainingBreakerKey,
        status: "skipped",
        warningCount: 0,
        warnings: [],
        lastError: "run-budget-exhausted",
        metadata,
        attemptId: null,
      }),
    );
  }

  if (statements.length > 0) {
    try {
      await batchExecute(db, statements, { signal });
    } catch (error) {
      const message = toErrorMessage(error);
      if (cursorBaseState) {
        const failedAt = Math.floor(Date.now() / 1000);
        try {
          await writeLiveReserveCursorState(
            db,
            {
              ...cursorBaseState,
              tailState: "incomplete",
              tailFailedAt: failedAt,
              tailError: message,
            },
            failedAt,
            signal,
          );
        } catch (cursorError) {
          console.warn("[sync-live-reserves] Failed to mark deferred cursor incomplete:", cursorError);
        }
      }
      throw new Error(`Failed to record deferred reserve tail state: ${message}`);
    }
  }

  let cursorTailState: LiveReserveCursorTailState | null = null;
  let cursorRecordedAt: number | null = null;
  let cursorTailCompletedAt: number | null = null;
  const cursorTailFailedAt: number | null = null;
  const cursorTailError: string | null = null;
  if (cursorBaseState) {
    const completedAt = Math.floor(Date.now() / 1000);
    await writeLiveReserveCursorState(
      db,
      {
        ...cursorBaseState,
        tailState: "complete",
        tailCompletedAt: completedAt,
      },
      completedAt,
      signal,
    );
    cursorTailState = "complete";
    cursorRecordedAt = cursorBaseState.cursorRecordedAt;
    cursorTailCompletedAt = completedAt;
  }

  return {
    deferredCoins,
    nextCursorStablecoinId,
    cursorTailState,
    cursorRecordedAt,
    cursorTailCompletedAt,
    cursorTailFailedAt,
    cursorTailError,
    runBudgetTruncationCount,
    additionalBreakerKeys,
  };
}

/**
 * Deferred-tail runs persist their cursor before finalization; completed runs
 * clear any previous cursor row so the next run starts from the beginning.
 */
export async function clearCursorStateIfComplete(
  db: D1Database,
  deferredCoins: number,
  nextCursorStablecoinId: string | null,
  signal?: AbortSignal,
): Promise<void> {
  if (deferredCoins > 0 && nextCursorStablecoinId) {
    return;
  }

  await deleteLiveReserveCursorState(db, signal);
}

export async function retireRecoveryOwnedGlobalCursor(
  db: D1Database,
  recoveryOwner: Pick<LiveReserveGlobalCursorOwner, "scheduleKey" | "slotStartedAt" | "queueHash">,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const cursor = await loadLiveReserveCursorState(db);
  if (
    !cursor?.cursorOwner
    || !cursor.rawValue
    || cursor.cursorOwner.scheduleKey !== recoveryOwner.scheduleKey
    || cursor.cursorOwner.slotStartedAt !== recoveryOwner.slotStartedAt
    || cursor.cursorOwner.queueHash !== recoveryOwner.queueHash
  ) {
    return false;
  }
  const result = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM cache WHERE key = ? AND value = ?")
      .bind(LIVE_RESERVE_RUN_CURSOR_CACHE_KEY, cursor.rawValue)
      .run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return (result.meta.changes ?? 0) === 1;
}
