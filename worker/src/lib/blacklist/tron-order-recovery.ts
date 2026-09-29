import { rethrowIfAborted } from "../abort";
import { batchExecute } from "../db";
import { invalidateBlacklistDerivedCaches } from "../blacklist-cache-invalidation";
import { logWorkerEventArgs } from "../structured-log";
import { blacklistRuntimeBudgetReached, blacklistSubrequestBudgetReached, type BlacklistRunBudget } from "./run-budget";
import { fetchTronBlockTransactionPositions, type TronReplayProviderContext } from "./tron-replay-provider";

/** Conflicting blocks enriched per maintenance pass. */
const TRON_ORDER_MAX_BLOCKS_PER_RUN = 8;
const TRON_ORDER_RETRY_KEY_PREFIX = "blacklist:order-retry:";
const TRON_ORDER_BASE_RETRY_DELAY_SEC = 5 * 60;
const TRON_ORDER_MAX_RETRY_DELAY_SEC = 6 * 60 * 60;
// A clean confirmed read that still cannot fill its rows (stored timestamp or
// transaction membership disagreeing with the confirmed block) is immutable
// evidence: retrying cannot change it, so the block parks far out and stays
// visible as an unresolved gap for the operator repair path.
const TRON_ORDER_PARKED_RETRY_DELAY_SEC = 7 * 24 * 60 * 60;

// The due-time filter runs inside the candidate SQL so not-yet-due blocks are
// removed BEFORE the selection limit; otherwise any number of parked blocks
// larger than the window would hide every later conflicting block. Malformed
// state fails open (due immediately); a missing dueAt field reads as 0.
const TRON_ORDER_DUE_FILTER = `(retry.value IS NULL OR NOT json_valid(retry.value)
    OR COALESCE(CAST(json_extract(retry.value, '$.dueAt') AS INTEGER), 0) <= ?`;
const TRON_ORDER_GROUP_HAVING = `COUNT(DISTINCT events.tx_hash) > 1 AND COUNT(DISTINCT events.event_type) > 1
      AND SUM(events.event_type = 'blacklist') > 0 AND SUM(events.transaction_index IS NULL) > 0`;

export interface TronOrderBackfillResult {
  blocksAttempted: number;
  positionsResolved: number;
  blocksDeferred: number;
}

interface TronOrderRetryState {
  attempts: number;
  dueAt: number;
}

function parseRetryState(raw: unknown): TronOrderRetryState | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { attempts, dueAt } = parsed as Record<string, unknown>;
  if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0) return null;
  if (typeof dueAt !== "number" || !Number.isSafeInteger(dueAt)) return null;
  return { attempts, dueAt };
}

/** Repair both legacy and newly ingested conflicts; no cursor rewind required.
 * `blocksDeferred` counts conflicting blocks held back by backoff plus admitted
 * blocks skipped when the run budget closed; conflicting blocks beyond the
 * per-run selection limit are not admitted and not counted. */
export async function resolveTronBlacklistOrder(
  db: D1Database,
  provider: TronReplayProviderContext,
  runBudget: BlacklistRunBudget,
): Promise<TronOrderBackfillResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  // Retry state lives in the existing durable cache table (no migration): a
  // block whose evidence could not be filled backs off instead of occupying the
  // head of the block-ordered window on every run.
  const candidates = await db.prepare(`
    /* blacklist-tron-order-candidates */
    SELECT DISTINCT events.block_number AS block_number, retry.value AS retry_state
    FROM blacklist_events AS events
    LEFT JOIN cache AS retry ON retry.key = '${TRON_ORDER_RETRY_KEY_PREFIX}' || events.block_number
    WHERE events.chain_id = 'tron' AND events.suppression_reason IS NULL
      AND ${TRON_ORDER_DUE_FILTER})
    GROUP BY events.stablecoin, COALESCE(events.config_key, events.contract_address, ''), events.address,
      events.block_number, retry.value
    HAVING ${TRON_ORDER_GROUP_HAVING}
    ORDER BY events.block_number ASC
    LIMIT ?
  `).bind(nowSec, TRON_ORDER_MAX_BLOCKS_PER_RUN).all<{ block_number: number; retry_state: string | null }>();
  const deferredRows = await db.prepare(`
    /* blacklist-tron-order-deferred */
    SELECT COUNT(*) AS deferred FROM (
      SELECT DISTINCT events.block_number
      FROM blacklist_events AS events
      JOIN cache AS retry ON retry.key = '${TRON_ORDER_RETRY_KEY_PREFIX}' || events.block_number
      WHERE events.chain_id = 'tron' AND events.suppression_reason IS NULL
        AND json_valid(retry.value)
        AND CAST(json_extract(retry.value, '$.dueAt') AS INTEGER) IS NOT NULL
        AND CAST(json_extract(retry.value, '$.dueAt') AS INTEGER) > ?
      GROUP BY events.stablecoin, COALESCE(events.config_key, events.contract_address, ''), events.address,
        events.block_number, retry.value
      HAVING ${TRON_ORDER_GROUP_HAVING}
    )
  `).bind(nowSec).first<{ deferred: number }>();
  const result: TronOrderBackfillResult = {
    blocksAttempted: 0,
    positionsResolved: 0,
    blocksDeferred: Math.max(0, deferredRows?.deferred ?? 0),
  };

  const seenBlocks = new Set<number>();
  const admitted: Array<{ blockNumber: number; retry: TronOrderRetryState | null }> = [];
  for (const row of candidates.results ?? []) {
    if (seenBlocks.has(row.block_number)) continue;
    seenBlocks.add(row.block_number);
    // The SQL filter already proved due-ness; JS parsing only recovers the
    // attempt count for the backoff exponent, failing open to zero attempts.
    admitted.push({ blockNumber: row.block_number, retry: parseRetryState(row.retry_state) });
  }

  for (const [index, candidate] of admitted.entries()) {
    if (blacklistRuntimeBudgetReached(runBudget) || blacklistSubrequestBudgetReached(runBudget)) {
      // An admitted block the budget closed out is deferred, not failed: no
      // attempt is booked and no backoff is written for it.
      result.blocksDeferred += admitted.length - index;
      break;
    }
    const blockNumber = candidate.blockNumber;
    const retry = candidate.retry;
    result.blocksAttempted++;
    let confirmedEvidenceIncomplete = false;
    try {
      const block = await fetchTronBlockTransactionPositions(provider, blockNumber);
      const pendingRows = await db.prepare(`
        SELECT id, tx_hash, timestamp FROM blacklist_events
        WHERE chain_id = 'tron' AND block_number = ? AND transaction_index IS NULL
      `).bind(blockNumber).all<{ id: string; tx_hash: string; timestamp: number }>();
      const statements: D1PreparedStatement[] = [];
      for (const pendingRow of pendingRows.results ?? []) {
        const position = block.positions.get(pendingRow.tx_hash.toLowerCase());
        if (position == null || pendingRow.timestamp !== block.timestamp) continue;
        statements.push(db.prepare(`UPDATE blacklist_events SET transaction_index = ?
          WHERE id = ? AND chain_id = 'tron' AND block_number = ?
            AND tx_hash = ? AND timestamp = ? AND transaction_index IS NULL`)
          .bind(position, pendingRow.id, blockNumber, pendingRow.tx_hash, pendingRow.timestamp));
      }
      confirmedEvidenceIncomplete = statements.length < (pendingRows.results?.length ?? 0);
      if (statements.length > 0) {
        try {
          result.positionsResolved += await batchExecute(db, statements, { signal: provider.signal });
        } finally {
          // Partial D1 batch success must also invalidate old ambiguous snapshots.
          await invalidateBlacklistDerivedCaches(db);
        }
      }
    } catch (error) {
      rethrowIfAborted(error, provider.signal);
      // Leave unknown positions intact; the public fold retains the reason.
      logWorkerEventArgs("lib", "warn", "[sync-blacklist] Tron order remains unresolved", blockNumber, error);
    }
    await recordBlockOutcome(db, {
      blockNumber,
      priorAttempts: retry?.attempts ?? 0,
      park: confirmedEvidenceIncomplete,
      nowSec,
    });
  }
  return result;
}

async function blockStillConflicts(db: D1Database, blockNumber: number): Promise<boolean> {
  const row = await db.prepare(`
    /* blacklist-tron-order-remaining */
    SELECT 1 AS conflicting FROM blacklist_events
    WHERE chain_id = 'tron' AND suppression_reason IS NULL AND block_number = ?
    GROUP BY stablecoin, COALESCE(config_key, contract_address, ''), address
    HAVING COUNT(DISTINCT tx_hash) > 1 AND COUNT(DISTINCT event_type) > 1
      AND SUM(event_type = 'blacklist') > 0 AND SUM(transaction_index IS NULL) > 0
    LIMIT 1
  `).bind(blockNumber).first<{ conflicting: number }>();
  return row != null;
}

/** Durable per-block attempt bookkeeping in the cache table; best-effort so a
 * failed bookkeeping write never fails the repair pass itself. */
async function recordBlockOutcome(
  db: D1Database,
  args: { blockNumber: number; priorAttempts: number; park: boolean; nowSec: number },
): Promise<void> {
  const key = `${TRON_ORDER_RETRY_KEY_PREFIX}${args.blockNumber}`;
  try {
    if (!(await blockStillConflicts(db, args.blockNumber))) {
      // The block left the lane; drop its state (even a malformed leftover) so
      // a future conflict starts fresh.
      await db.prepare("DELETE FROM cache WHERE key = ?").bind(key).run();
      return;
    }
    // Exponent capped at 7 so the doubling (5min * 2^7 = 640min) actually
    // reaches the six-hour maximum instead of stalling at 5h20m.
    const delaySec = args.park
      ? TRON_ORDER_PARKED_RETRY_DELAY_SEC
      : Math.min(TRON_ORDER_MAX_RETRY_DELAY_SEC,
        TRON_ORDER_BASE_RETRY_DELAY_SEC * 2 ** Math.min(7, Math.max(0, args.priorAttempts)));
    await db.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, JSON.stringify({ attempts: args.priorAttempts + 1, dueAt: args.nowSec + delaySec }), args.nowSec)
      .run();
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[sync-blacklist] Tron order retry bookkeeping failed", args.blockNumber, error);
  }
}
