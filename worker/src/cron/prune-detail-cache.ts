import { READABLE_IDS } from "@shared/lib/stablecoins/registry";
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

export async function runPruneDetailCache(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - DETAIL_ROW_MAX_AGE_SEC;

  const rows = await runWithOverloadRetry(() =>
    db
      .prepare("SELECT key, updated_at FROM cache WHERE key LIKE ?")
      .bind(`${DETAIL_KEY_PREFIX}%`)
      .all<{ key: string; updated_at: number }>(),
    3,
    signal,
  );
  throwIfAborted(signal);

  let orphanCount = 0;
  let staleCount = 0;
  const doomedKeys: string[] = [];
  for (const row of rows.results ?? []) {
    const stablecoinId = row.key.slice(DETAIL_KEY_PREFIX.length);
    if (!READABLE_IDS.has(stablecoinId)) {
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

  return createCronResult({
    status: "ok",
    itemCount: doomedKeys.length,
    metadata: {
      scanned: rows.results?.length ?? 0,
      orphansDeleted: orphanCount,
      staleDeleted: staleCount,
      cutoffSec: cutoff,
    },
  });
}
