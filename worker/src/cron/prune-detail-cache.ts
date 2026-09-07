import { WORKER_READABLE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { SECONDS } from "../lib/time-constants";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { createCronResult } from "../lib/cron-result";
import { batchExecute } from "../lib/db";

const DETAIL_KEY_PREFIX = "detail:";

// Demand-refreshed detail rows older than 24h are never served (they force the
// synchronous cold-miss refresh path on access), so anything past a week is
// either an unvisited coin whose next visit refreshes it anyway or an orphan.
// Production accumulated 221 such rows (46.7 MB) including legacy numeric keys
// because no DELETE path existed for detail:* at all.
const DETAIL_ROW_MAX_AGE_SEC = SECONDS.ONE_WEEK;
const DETAIL_CACHE_PAGE_SIZE = 500;

export async function runPruneDetailCache(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - DETAIL_ROW_MAX_AGE_SEC;

  let orphanCount = 0;
  let staleCount = 0;
  let scanned = 0;
  let lastKey = "";

  while (true) {
    throwIfAborted(signal);
    const rows = await runWithOverloadRetry(() =>
      db
        .prepare("SELECT key, updated_at FROM cache WHERE key LIKE ? AND key > ? ORDER BY key LIMIT ?")
        .bind(`${DETAIL_KEY_PREFIX}%`, lastKey, DETAIL_CACHE_PAGE_SIZE)
        .all<{ key: string; updated_at: number }>(),
      3,
      signal,
    );
    throwIfAborted(signal);

    const pageRows = rows.results ?? [];
    if (pageRows.length === 0) break;
    scanned += pageRows.length;

    const doomedKeys: string[] = [];
    for (const row of pageRows) {
      const stablecoinId = row.key.slice(DETAIL_KEY_PREFIX.length);
      if (!WORKER_READABLE_IDS.has(stablecoinId)) {
        orphanCount += 1;
        doomedKeys.push(row.key);
      } else if (row.updated_at < cutoff) {
        staleCount += 1;
        doomedKeys.push(row.key);
      }
    }

    if (doomedKeys.length > 0) {
      await batchExecute(
        db,
        doomedKeys.map((key) => db.prepare("DELETE FROM cache WHERE key = ?").bind(key)),
        { signal },
      );
    }

    if (pageRows.length < DETAIL_CACHE_PAGE_SIZE) break;
    const nextLastKey = pageRows[pageRows.length - 1]?.key;
    if (!nextLastKey || nextLastKey <= lastKey) break;
    lastKey = nextLastKey;
  }

  return createCronResult({
    status: "ok",
    itemCount: orphanCount + staleCount,
    metadata: {
      scanned,
      orphansDeleted: orphanCount,
      staleDeleted: staleCount,
      cutoffSec: cutoff,
    },
  });
}
