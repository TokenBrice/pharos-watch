import { batchExecute } from "../lib/db";
import { throwIfAborted } from "../lib/abort";
import {
  breakerKeyForConfig,
  type ConfiguredCoin,
  type LiveReserveCursorTailState,
  type LiveReserveDeferredTailOutcome,
  type LiveReserveQueueCounts,
} from "./sync-live-reserves-shared";
import { toErrorMessage } from "@shared/lib/error-utils";
import {
  buildReserveSyncAttemptHistoryInsertStatement,
  buildReserveSyncRecordDeferredStatement,
} from "../lib/live-reserves/store-statements";


export interface RecordDeferredTailResult {
  counts: Pick<LiveReserveQueueCounts, "deferredCoins">;
  deferredTail: LiveReserveDeferredTailOutcome;
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


export async function recordDeferredTail(
  db: D1Database,
  remainingCoins: readonly ConfiguredCoin[],
  attemptedAt: number,
  signal?: AbortSignal,
): Promise<RecordDeferredTailResult> {
  throwIfAborted(signal);
  const deferredCoins = remainingCoins.length;
  const nextCursorStablecoinId = remainingCoins[0]?.id ?? null;
  const additionalBreakerKeys = new Set<string>();
  const runBudgetTruncationCount = deferredCoins > 0 ? 1 : 0;
  const statements: D1PreparedStatement[] = [];
  const metadata = {
    failureCategory: "run-budget-exhausted",
    deferredTail: true,
  };

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

  let cursorTailState: LiveReserveCursorTailState | null = null;
  let cursorTailCompletedAt: number | null = null;
  let cursorTailFailedAt: number | null = null;
  let cursorTailError: string | null = null;
  if (statements.length > 0) {
    try {
      await batchExecute(db, statements, { signal });
      cursorTailState = "complete";
      cursorTailCompletedAt = Math.floor(Date.now() / 1000);
    } catch (error) {
      cursorTailState = "incomplete";
      cursorTailFailedAt = Math.floor(Date.now() / 1000);
      cursorTailError = toErrorMessage(error);
      throw new Error(`Failed to record deferred reserve tail state: ${cursorTailError}`);
    }
  }

  return {
    counts: { deferredCoins },
    deferredTail: {
      nextCursorStablecoinId,
      cursorTailState,
      cursorRecordedAt: deferredCoins > 0 ? attemptedAt : null,
      cursorTailCompletedAt,
      cursorTailFailedAt,
      cursorTailError,
      runBudgetTruncationCount,
    },
    additionalBreakerKeys,
  };
}
