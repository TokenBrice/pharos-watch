import { deleteCache, getCache } from "../lib/db-cache";
import { batchExecute } from "../lib/db";
import { breakerKeyForConfig, type ConfiguredCoin } from "./sync-live-reserves-shared";
import { rotateFromCursor } from "./shared/cursor-rotation";
import {
  buildReserveSyncAttemptHistoryInsertStatement,
  buildReserveSyncRecordDeferredStatement,
} from "../lib/live-reserves-store";

const RESERVE_SYNC_CURSOR_CACHE_KEY = "live-reserves:run-cursor";

interface LiveReserveCursorState {
  nextStablecoinId: string | null;
  deferredCount: number;
  deferredAt: number;
  reason: "run-budget-exhausted";
  tailState?: "recording" | "incomplete" | "complete";
  cursorRecordedAt?: number;
  tailCompletedAt?: number;
  tailError?: string;
}

export function rotateConfiguredCoins(
  configuredCoins: readonly ConfiguredCoin[],
  nextStablecoinId: string | null,
): ConfiguredCoin[] {
  return rotateFromCursor(configuredCoins, nextStablecoinId, (coin) => coin.id).items;
}

export async function loadLiveReserveCursorState(db: D1Database): Promise<{
  nextStablecoinId: string | null;
  deferredCount: number;
  deferredAt: number;
  tailState: "recording" | "incomplete" | "complete" | null;
  cursorRecordedAt: number | null;
  tailCompletedAt: number | null;
} | null> {
  const cached = await getCache(db, RESERVE_SYNC_CURSOR_CACHE_KEY);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value) as Partial<LiveReserveCursorState>;
    const tailState =
      parsed.tailState === "recording" || parsed.tailState === "incomplete" || parsed.tailState === "complete"
        ? parsed.tailState
        : null;
    return parsed.reason === "run-budget-exhausted" && typeof parsed.deferredAt === "number"
      ? {
          nextStablecoinId: typeof parsed.nextStablecoinId === "string" ? parsed.nextStablecoinId : null,
          deferredCount: typeof parsed.deferredCount === "number" ? parsed.deferredCount : 0,
          deferredAt: parsed.deferredAt,
          tailState,
          cursorRecordedAt: typeof parsed.cursorRecordedAt === "number" ? parsed.cursorRecordedAt : null,
          tailCompletedAt: typeof parsed.tailCompletedAt === "number" ? parsed.tailCompletedAt : null,
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
): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
    )
    .bind(
      RESERVE_SYNC_CURSOR_CACHE_KEY,
      JSON.stringify(state),
      updatedAt,
    )
    .run();
}

export async function recordDeferredTail(
  db: D1Database,
  remainingCoins: readonly ConfiguredCoin[],
  breakerKeys: Set<string>,
  attemptedAt: number,
): Promise<{ deferredCoins: number; nextCursorStablecoinId: string | null }> {
  const deferredCoins = remainingCoins.length;
  const nextCursorStablecoinId = remainingCoins[0]?.id ?? null;
  const statements: D1PreparedStatement[] = [];
  const metadata = {
    failureCategory: "run-budget-exhausted",
    deferredTail: true,
  };
  const cursorBaseState = nextCursorStablecoinId
    ? {
        nextStablecoinId: nextCursorStablecoinId,
        deferredCount: deferredCoins,
        deferredAt: attemptedAt,
        reason: "run-budget-exhausted" as const,
        cursorRecordedAt: attemptedAt,
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
    );
  }

  for (const remaining of remainingCoins) {
    const remainingConfig = remaining.liveReservesConfig!;
    const remainingBreakerKey = breakerKeyForConfig(remainingConfig);
    breakerKeys.add(remainingBreakerKey);
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
      await batchExecute(db, statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cursorBaseState) {
        try {
          await writeLiveReserveCursorState(
            db,
            {
              ...cursorBaseState,
              tailState: "incomplete",
              tailError: message,
            },
            Math.floor(Date.now() / 1000),
          );
        } catch (cursorError) {
          console.warn("[sync-live-reserves] Failed to mark deferred cursor incomplete:", cursorError);
        }
      }
      throw new Error(`Failed to record deferred reserve tail state: ${message}`);
    }
  }

  if (cursorBaseState) {
    await writeLiveReserveCursorState(
      db,
      {
        ...cursorBaseState,
        tailState: "complete",
        tailCompletedAt: Math.floor(Date.now() / 1000),
      },
      Math.floor(Date.now() / 1000),
    );
  }

  return {
    deferredCoins,
    nextCursorStablecoinId,
  };
}

export async function persistLiveReserveCursorState(
  db: D1Database,
  deferredCoins: number,
  nextCursorStablecoinId: string | null,
): Promise<void> {
  if (deferredCoins > 0 && nextCursorStablecoinId) {
    return;
  }

  await deleteCache(db, RESERVE_SYNC_CURSOR_CACHE_KEY);
}
