import { WORKER_ACTIVE_IDS, WORKER_READABLE_IDS } from "@shared/lib/stablecoins/worker-runtime-registry";
import { CACHE_RETENTION_POLICIES } from "@shared/lib/retention-policy";
import type { CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { WEEK_SECONDS } from "@shared/lib/time-constants";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { createCronResult } from "../lib/cron-result";
import { batchExecute } from "../lib/db";
import { RETENTION_DELETE_BATCH_LIMIT, RETENTION_DELETE_RUN_LIMIT } from "../lib/bounded-prune";
import { deleteCappedGroup } from "./shared/capped-delete";

const DETAIL_KEY_PREFIX = "detail:";

// Demand-refreshed detail rows older than 24h are never served (they force the
// synchronous cold-miss refresh path on access), so anything past a week is
// either an unvisited coin whose next visit refreshes it anyway or an orphan.
// Production accumulated 221 such rows (46.7 MB) including legacy numeric keys
// because no DELETE path existed for detail:* at all.
// Non-active readable coins (frozen, quarantined, delisted) are exempt from the age
// rule: the detail API never refreshes them, so their last row is the only copy and
// deleting it turns every later read into a permanent 404.
const DETAIL_ROW_MAX_AGE_SEC = WEEK_SECONDS;
const DETAIL_CACHE_PAGE_SIZE = 500;

export async function runPruneDetailCache(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  throwIfAborted(signal);
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - DETAIL_ROW_MAX_AGE_SEC;

  let orphanCount = 0;
  let staleCount = 0;
  let scanned = 0;
  let deleteCandidates = 0;
  let lastKey = "";
  let detailTruncated = false;

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

    const orphanKeys: string[] = [];
    const staleRows: Array<{ key: string; updated_at: number }> = [];
    for (const row of pageRows) {
      if (deleteCandidates >= RETENTION_DELETE_RUN_LIMIT) {
        detailTruncated = true;
        break;
      }
      const stablecoinId = row.key.slice(DETAIL_KEY_PREFIX.length);
      if (!WORKER_READABLE_IDS.has(stablecoinId)) {
        orphanKeys.push(row.key);
        deleteCandidates += 1;
      } else if (row.updated_at < cutoff && WORKER_ACTIVE_IDS.has(stablecoinId)) {
        staleRows.push(row);
        deleteCandidates += 1;
      }
    }

    orphanCount += await batchExecute(
      db,
      orphanKeys.map((key) => db.prepare("DELETE FROM cache WHERE key = ?").bind(key)),
      { signal },
    );
    staleCount += await batchExecute(
      db,
      staleRows.map((row) => db
        .prepare("DELETE FROM cache WHERE key = ? AND updated_at = ? AND updated_at < ?")
        .bind(row.key, row.updated_at, cutoff)),
      { signal },
    );

    detailTruncated ||= deleteCandidates >= RETENTION_DELETE_RUN_LIMIT;
    if (pageRows.length < DETAIL_CACHE_PAGE_SIZE) break;
    if (detailTruncated) break;
    const nextLastKey = pageRows[pageRows.length - 1]?.key;
    if (!nextLastKey || nextLastKey <= lastKey) break;
    lastKey = nextLastKey;
  }

  const hygiene = await deleteCappedGroup(db, CACHE_RETENTION_POLICIES.map((policy) => ({
    sql: `DELETE FROM cache WHERE rowid IN (
      SELECT rowid FROM cache WHERE key ${policy.match === "prefix" ? "GLOB" : "="} ?
      ${policy.windowSec == null ? "" : "AND updated_at < ?"}
      ORDER BY updated_at ASC, key ASC LIMIT ?
    )`,
    bindsForLimit: (limit: number) => [
      policy.match === "prefix" ? `${policy.key}*` : policy.key,
      ...(policy.windowSec == null ? [] : [now - policy.windowSec]),
      limit,
    ],
    batchLimit: RETENTION_DELETE_BATCH_LIMIT,
    runLimit: RETENTION_DELETE_BATCH_LIMIT,
  })), signal);
  const cacheHygiene = Object.fromEntries(CACHE_RETENTION_POLICIES.map((policy, index) => [
    policy.name,
    { deleted: hygiene[index].pruned, retentionTruncated: hygiene[index].cappedAtLimit },
  ]));
  const hygieneDeleted = hygiene.reduce((total, result) => total + result.pruned, 0);
  return createCronResult({
    status: "ok",
    itemCount: orphanCount + staleCount + hygieneDeleted,
    metadata: {
      scanned,
      orphansDeleted: orphanCount,
      staleDeleted: staleCount,
      cutoffSec: cutoff,
      cacheHygiene,
      retentionTruncated: {
        detail: detailTruncated,
        ...Object.fromEntries(CACHE_RETENTION_POLICIES.map((policy, index) => [policy.name, hygiene[index].cappedAtLimit])),
      },
    },
  });
}
