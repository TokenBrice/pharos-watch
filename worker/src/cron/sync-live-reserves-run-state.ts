import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { recordReserveSyncDeferred } from "../lib/live-reserves-store";
import { breakerKeyForConfig, type ConfiguredCoin } from "./sync-live-reserves-shared";

const RESERVE_SYNC_CURSOR_CACHE_KEY = "live-reserves:run-cursor";

interface LiveReserveCursorState {
  nextStablecoinId: string | null;
  deferredCount: number;
  deferredAt: number;
  reason: "run-budget-exhausted";
}

export function rotateConfiguredCoins(
  configuredCoins: readonly ConfiguredCoin[],
  nextStablecoinId: string | null,
): ConfiguredCoin[] {
  if (!nextStablecoinId) {
    return [...configuredCoins];
  }
  const startIndex = configuredCoins.findIndex((coin) => coin.id === nextStablecoinId);
  if (startIndex <= 0) {
    return [...configuredCoins];
  }
  return [
    ...configuredCoins.slice(startIndex),
    ...configuredCoins.slice(0, startIndex),
  ];
}

export async function loadLiveReserveCursorState(db: D1Database): Promise<{
  nextStablecoinId: string | null;
  deferredCount: number;
  deferredAt: number;
} | null> {
  const cached = await getCache(db, RESERVE_SYNC_CURSOR_CACHE_KEY);
  if (!cached) return null;
  try {
    const parsed = JSON.parse(cached.value) as Partial<LiveReserveCursorState>;
    return parsed.reason === "run-budget-exhausted" && typeof parsed.deferredAt === "number"
      ? {
          nextStablecoinId: typeof parsed.nextStablecoinId === "string" ? parsed.nextStablecoinId : null,
          deferredCount: typeof parsed.deferredCount === "number" ? parsed.deferredCount : 0,
          deferredAt: parsed.deferredAt,
        }
      : null;
  } catch {
    return null;
  }
}

export async function recordDeferredTail(
  db: D1Database,
  remainingCoins: readonly ConfiguredCoin[],
  breakerKeys: Set<string>,
  attemptedAt: number,
): Promise<{ deferredCoins: number; nextCursorStablecoinId: string | null }> {
  const deferredCoins = remainingCoins.length;
  const nextCursorStablecoinId = remainingCoins[0]?.id ?? null;

  for (const remaining of remainingCoins) {
    const remainingConfig = remaining.liveReservesConfig!;
    const remainingBreakerKey = breakerKeyForConfig(remainingConfig);
    breakerKeys.add(remainingBreakerKey);
    try {
      await recordReserveSyncDeferred(db, {
        stablecoinId: remaining.id,
        adapterKey: remainingConfig.adapter,
        breakerKey: remainingBreakerKey,
        attemptedAt,
        reason: "run-budget-exhausted",
      });
    } catch (error) {
      console.warn(`[sync-live-reserves] Failed to record deferred sync for ${remaining.id}:`, error);
    }
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
  deferredAt: number,
): Promise<void> {
  if (deferredCoins > 0 && nextCursorStablecoinId) {
    await setCache(
      db,
      RESERVE_SYNC_CURSOR_CACHE_KEY,
      JSON.stringify({
        nextStablecoinId: nextCursorStablecoinId,
        deferredCount: deferredCoins,
        deferredAt,
        reason: "run-budget-exhausted",
      } satisfies LiveReserveCursorState),
    );
    return;
  }

  await deleteCache(db, RESERVE_SYNC_CURSOR_CACHE_KEY);
}
