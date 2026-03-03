import { D1_BATCH_SIZE } from "./constants";
import { SECONDS } from "./time-constants";
import { sendAlert } from "./alerts";

/** Execute D1 prepared statements in chunks to stay within the batch limit */
export async function batchExecute(db: D1Database, stmts: D1PreparedStatement[], chunkSize = D1_BATCH_SIZE): Promise<void> {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }
}

/** Build WHERE, LIMIT, and OFFSET clauses for paginated SQL queries */
export function buildPaginatedQuery(opts: {
  conditions: string[];
  limit: number;
  offset: number;
}): { where: string; limitClause: string; offsetClause: string; paginationBindings: number[] } {
  const where = opts.conditions.length > 0 ? ` WHERE ${opts.conditions.join(" AND ")}` : "";
  const limitClause = opts.limit > 0 ? " LIMIT ?" : opts.offset > 0 ? " LIMIT -1" : "";
  const offsetClause = opts.offset > 0 ? " OFFSET ?" : "";
  const paginationBindings: number[] = [];
  if (opts.limit > 0) paginationBindings.push(opts.limit);
  if (opts.offset > 0) paginationBindings.push(opts.offset);
  return { where, limitClause, offsetClause, paginationBindings };
}

export async function getCache(db: D1Database, key: string): Promise<{ value: string; updatedAt: number } | null> {
  const row = await db
    .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
    .bind(key)
    .first<{ value: string; updated_at: number }>();
  if (!row) return null;
  return { value: row.value, updatedAt: row.updated_at };
}

export async function setCache(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, value, Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Compare-and-swap cache write: only updates if the existing row is older than `syncStartSec`.
 * Prevents a slow cron run from overwriting a newer run's data.
 */
export async function setCacheIfNewer(db: D1Database, key: string, value: string, syncStartSec: number): Promise<void> {
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE cache.updated_at <= excluded.updated_at`
    )
    .bind(key, value, syncStartSec)
    .run();
  if (result.meta.changes === 0) {
    console.log(`[cache] Skipped write for "${key}" — existing data is newer (started_at > ${syncStartSec})`);
  }
}

export async function getLastBlock(db: D1Database, configKey: string): Promise<number> {
  const row = await db
    .prepare("SELECT last_block FROM blacklist_sync_state WHERE config_key = ?")
    .bind(configKey)
    .first<{ last_block: number }>();
  return row?.last_block ?? 0;
}

export async function setLastBlock(db: D1Database, configKey: string, block: number): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO blacklist_sync_state (config_key, last_block) VALUES (?, ?)")
    .bind(configKey, block)
    .run();
}

export async function getPriceCache(db: D1Database): Promise<Map<string, { price: number; updatedAt: number }>> {
  const result = await db
    .prepare("SELECT asset_id, price, updated_at FROM price_cache")
    .all<{ asset_id: string; price: number; updated_at: number }>();
  const map = new Map<string, { price: number; updatedAt: number }>();
  for (const row of result.results ?? []) {
    map.set(row.asset_id, { price: row.price, updatedAt: row.updated_at });
  }
  return map;
}

export async function savePriceCache(db: D1Database, entries: { id: string; price: number }[]): Promise<void> {
  if (entries.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = entries.map((e) =>
    db.prepare("INSERT OR REPLACE INTO price_cache (asset_id, price, updated_at) VALUES (?, ?, ?)").bind(e.id, e.price, now)
  );
  await batchExecute(db, stmts);
}

export interface OnchainSupplyRow {
  stablecoin_id: string;
  chain: string;
  supply: number;
  updated_at: number;
}

/** Read all on-chain supply rows fresher than maxAgeSec */
export async function getOnchainSupply(db: D1Database, maxAgeSec: number): Promise<OnchainSupplyRow[]> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  const result = await db
    .prepare("SELECT stablecoin_id, chain, supply, updated_at FROM onchain_supply WHERE updated_at > ?")
    .bind(cutoff)
    .all<OnchainSupplyRow>();
  return result.results ?? [];
}

/** Upsert on-chain supply for a stablecoin on a specific chain */
export async function upsertOnchainSupply(
  db: D1Database,
  rows: { stablecoinId: string; chain: string; supply: number }[]
): Promise<void> {
  if (rows.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmts = rows.map((r) =>
    db.prepare("INSERT OR REPLACE INTO onchain_supply (stablecoin_id, chain, supply, updated_at) VALUES (?, ?, ?, ?)")
      .bind(r.stablecoinId, r.chain, r.supply, now)
  );
  await batchExecute(db, stmts);
}

// --- Coin first-seen dates (for peg score tracking window) ---

/** Earliest supply_history snapshot per coin — used so young coins aren't scored over a phantom 4-year window. */
export async function getFirstSeenDates(db: D1Database): Promise<Map<string, number>> {
  const result = await db
    .prepare("SELECT stablecoin_id, MIN(snapshot_date) as first_seen FROM supply_history GROUP BY stablecoin_id")
    .all<{ stablecoin_id: string; first_seen: number }>();
  const map = new Map<string, number>();
  for (const row of result.results ?? []) {
    map.set(row.stablecoin_id, row.first_seen);
  }
  return map;
}

// --- Cron run logging ---

export interface CronResult {
  itemCount?: number;
  metadata?: string;
  status?: "ok" | "skipped_locked";
}

// --- Cron lease primitives ---

export interface CronLeaseOptions {
  ttlSec?: number;
  heartbeatSec?: number;
  owner?: string;
  maxRenewFailures?: number;
}

export interface CronLeaseRunResult<T> {
  status: "ok" | "skipped_locked";
  leaseOwner: string;
  renewFailures: number;
  leaseLost?: boolean;
  result?: T;
}

export class CronLeaseLostError extends Error {
  constructor(job: string, renewFailures: number) {
    super(`Cron lease lost for "${job}" after ${renewFailures} failed renewals`);
    this.name = "CronLeaseLostError";
  }
}

export class CronTimeoutError extends Error {
  constructor(job: string, timeoutMs: number) {
    super(`Cron job "${job}" timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "CronTimeoutError";
  }
}

function createLeaseOwner(job: string): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${job}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Acquire or take over an expired cron lease. Returns false when another active owner holds the lease. */
export async function acquireCronLease(
  db: D1Database,
  job: string,
  owner: string,
  ttlSec: number,
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const leaseUntil = nowSec + ttlSec;
  const result = await db
    .prepare(
      `INSERT INTO cron_leases (job, lease_owner, lease_until, heartbeat_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job) DO UPDATE SET
         lease_owner = excluded.lease_owner,
         lease_until = excluded.lease_until,
         heartbeat_at = excluded.heartbeat_at,
         updated_at = excluded.updated_at
       WHERE cron_leases.lease_until < ? OR cron_leases.lease_owner = excluded.lease_owner`
    )
    .bind(job, owner, leaseUntil, nowSec, nowSec, nowSec)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Renew an existing lease. Returns false when lease ownership was lost. */
export async function renewCronLease(
  db: D1Database,
  job: string,
  owner: string,
  ttlSec: number,
): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const leaseUntil = nowSec + ttlSec;
  const result = await db
    .prepare(
      `UPDATE cron_leases
       SET lease_until = ?, heartbeat_at = ?, updated_at = ?
       WHERE job = ? AND lease_owner = ?`
    )
    .bind(leaseUntil, nowSec, nowSec, job, owner)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Release a lease if and only if caller still owns it. */
export async function releaseCronLease(
  db: D1Database,
  job: string,
  owner: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM cron_leases WHERE job = ? AND lease_owner = ?")
    .bind(job, owner)
    .run();
}

/**
 * Lease wrapper primitive for cron jobs. Acquires lease, keeps it alive with heartbeats,
 * runs the job, and releases lease in finally.
 *
 * This helper does not yet wire cron status logging; integration is handled separately.
 */
export async function runCronWithLease<T>(
  db: D1Database,
  job: string,
  fn: (ctx: { leaseOwner: string; signal: AbortSignal }) => Promise<T>,
  opts?: CronLeaseOptions,
): Promise<CronLeaseRunResult<T>> {
  const timeoutSec = Math.ceil((CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS) / 1000);
  const ttlSec = opts?.ttlSec ?? timeoutSec + 60;
  const heartbeatSec = opts?.heartbeatSec ?? Math.max(15, Math.floor(ttlSec / 3));
  const maxRenewFailures = opts?.maxRenewFailures ?? 2;
  const owner = opts?.owner ?? createLeaseOwner(job);

  const acquired = await acquireCronLease(db, job, owner, ttlSec);
  if (!acquired) {
    return {
      status: "skipped_locked",
      leaseOwner: owner,
      renewFailures: 0,
    };
  }

  let renewFailures = 0;
  let leaseLost = false;
  const leaseController = new AbortController();
  const markLeaseFailure = () => {
    renewFailures++;
    if (!leaseLost && renewFailures >= maxRenewFailures) {
      leaseLost = true;
      leaseController.abort(new CronLeaseLostError(job, renewFailures));
    }
  };

  const timer = setInterval(() => {
    void renewCronLease(db, job, owner, ttlSec)
      .then((ok) => {
        if (!ok) markLeaseFailure();
      })
      .catch(() => {
        markLeaseFailure();
      });
  }, heartbeatSec * 1000);

  const leaseLossPromise = new Promise<never>((_resolve, reject) => {
    const rejectReason = () => {
      const reason = leaseController.signal.reason;
      reject(reason instanceof Error ? reason : new CronLeaseLostError(job, renewFailures));
    };
    if (leaseController.signal.aborted) {
      rejectReason();
      return;
    }
    leaseController.signal.addEventListener("abort", rejectReason, { once: true });
  });

  try {
    const result = await Promise.race([
      fn({ leaseOwner: owner, signal: leaseController.signal }),
      leaseLossPromise,
    ]);
    return {
      status: "ok",
      leaseOwner: owner,
      renewFailures,
      leaseLost,
      result,
    };
  } finally {
    clearInterval(timer);
    await releaseCronLease(db, job, owner);
  }
}

// --- Per-job cron timeout configuration ---

const CRON_TIMEOUT_MS: Record<string, number> = {
  "sync-dex-liquidity": 10 * 60_000,
  "sync-blacklist":      8 * 60_000,
  "sync-mint-burn":      8 * 60_000,
  "daily-digest":        8 * 60_000,
};
const DEFAULT_CRON_TIMEOUT_MS = 5 * 60_000;

/**
 * Wraps a cron job function with execution logging and an AbortController timeout.
 * Logs start time, duration, status, and optional item count to cron_runs table.
 * Prunes rows older than 7 days after each insert.
 */
export async function logCronRun(
  db: D1Database,
  job: string,
  fn: (signal: AbortSignal) => Promise<CronResult | void>
): Promise<void> {
  const startMs = Date.now();
  const startSec = Math.floor(startMs / 1000);
  const timeoutMs = CRON_TIMEOUT_MS[job] ?? DEFAULT_CRON_TIMEOUT_MS;
  const ac = new AbortController();
  const timeoutError = new CronTimeoutError(job, timeoutMs);
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      ac.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      fn(ac.signal),
      timeoutPromise,
    ]);
    await db
      .prepare(
        "INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        job,
        startSec,
        Date.now() - startMs,
        result?.status ?? "ok",
        result?.itemCount ?? null,
        result?.metadata ?? null
      )
      .run();
  } catch (e) {
    try {
      await db
        .prepare(
          "INSERT INTO cron_runs (job, started_at, duration_ms, status, error) VALUES (?, ?, ?, ?, ?)"
        )
        .bind(job, startSec, Date.now() - startMs, "error", String(e))
        .run();
    } catch (logErr) {
      console.error(`[db] Failed to log cron error for ${job}:`, logErr);
    }
    // Alert on cron failure (non-blocking)
    sendAlert(`Cron failure: ${job}`, `Error: ${String(e).slice(0, 500)}`).catch(() => {});
    throw e;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  // Prune rows older than 7 days
  try {
    await db
      .prepare("DELETE FROM cron_runs WHERE started_at < ?")
      .bind(Math.floor(Date.now() / 1000) - SECONDS.ONE_WEEK)
      .run();
  } catch (e) {
    console.error("[db] Failed to prune old cron runs:", e);
    // Safety valve: if time-based prune fails, keep only most recent 5000 rows
    try {
      await db
        .prepare("DELETE FROM cron_runs WHERE rowid NOT IN (SELECT rowid FROM cron_runs ORDER BY started_at DESC LIMIT 5000)")
        .run();
    } catch (e2) {
      console.error("[db] Safety valve prune also failed:", e2);
    }
  }
}
