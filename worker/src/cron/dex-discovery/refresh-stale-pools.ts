import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { CHAIN_META } from "@shared/types/chain-identity";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/types/exit-route-identity";
import type { ContractDeployment } from "@shared/types/core";
import { rethrowIfAborted, sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { CG_CHAIN_MAP } from "../../lib/chain-registry";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  CG_ONCHAIN_MULTI_POOL_MAX_ADDRESSES,
  fetchCgPoolsByAddressesWithStatus,
  type CgPool,
  type CgPoolsByAddressResult,
} from "../../lib/coingecko-onchain";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { isBlockedDexId } from "../../lib/dex-cron-constants";
import { tryParseJson } from "../../lib/json-parse";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { logWorkerEvent } from "../../lib/structured-log";
import { parseCgPool } from "../dex-liquidity/coingecko-onchain-shared";
import type { ParsedPool } from "../dex-liquidity/crawl-helpers";
import {
  createPoolPriceCoherenceAdmissionGate,
  type PoolPriceCoherenceAdmissionGate,
} from "../dex-liquidity/pool-price-coherence";
import {
  admitCgOnchainPool,
  classifyCoinGeckoResult,
  classifyCoinGeckoThrownError,
  type CgOnchainPoolRejectReason,
} from "./crawl-coingecko-pools";
import { hasValidStagedPoolTvl, isValidStagedPoolId, upsertStagedPools } from "./persistence";
import { buildStageSignal, DISCOVERY_STAGE_TIMEOUT_MS } from "./staged-pool";
import {
  STAGED_POOL_CONFIDENCE_HORIZON_HOURS,
  STAGED_POOL_FRESH_HOURS,
  type StagedPool,
} from "./types";

/**
 * Stale-first registry refresh. Coin-cohort discovery revisits most footprints
 * weekly, so a retained CoinGecko-onchain row outlives its 24h volume reading
 * long before its coin is crawled again, and the Sugar-backed Aerodrome and
 * Velodrome Slipstream rows carry no 24h volume at all. This pass re-reads those
 * exact pools by address through CoinGecko's `/pools/multi` endpoint (same
 * provider, key, circuit and pacing as the discovery CG stage) and writes fresh
 * `cg_onchain` rows through the crawl's own admission policy and upsert path.
 */
export const STALE_POOL_REFRESH_POLICY = {
  /** A reading past this age no longer counts as in-window 24h volume. */
  staleAgeSec: STAGED_POOL_FRESH_HOURS * 3600,
  /**
   * Refresh two discovery ticks before expiry so a pool refreshed on one run
   * is re-read while its reading is still in-window, even if one run is capped.
   */
  dueAgeSec: STAGED_POOL_FRESH_HOURS * 3600 - 2 * CRON_INTERVALS["sync-dex-discovery"],
  /** Rows past the confidence horizon are no longer retained by the merge. */
  horizonSec: STAGED_POOL_CONFIDENCE_HORIZON_HOURS * 3600,
  addressesPerRequest: CG_ONCHAIN_MULTI_POOL_MAX_ADDRESSES,
  /**
   * 125 x 30 = 3,750 pools per run: sized so the 2026-09-28 backlog (~2,330
   * pools packing into ~122 requests) clears in one run. At the measured
   * ~0.5 s per paced request that is about a minute; `budgetMs` still bounds
   * a slow or failing provider.
   */
  maxRequestsPerRun: 125,
  /** Wall-clock slice of the 12-minute discovery budget; cohort crawling keeps the rest. */
  budgetMs: 150_000,
  maxConsecutiveFailures: 3,
  requestTimeoutMs: DISCOVERY_STAGE_TIMEOUT_MS.cgOnchain,
  /**
   * A pool the provider answered for but that still could not be refreshed
   * (not returned, untracked legs, or refused by admission) waits this long
   * before its next attempt, doubling per consecutive miss up to
   * `backoffMaxSec`, so a dead or permanently rejected pool stops spending a
   * request slot and a `failed` count on every two-hour run.
   */
  backoffBaseSec: 3 * CRON_INTERVALS["sync-dex-discovery"],
  /** Retry ceiling: a pool refused for days is still re-read every four days until it leaves the horizon. */
  backoffMaxSec: 4 * 24 * 3600,
  /**
   * Serialized backoff row ceiling, half of D1's 2 MB value limit. The due set
   * is uncapped (the 2026-09-28 horizon held ~7,700 CG-family and Slipstream
   * ids, ~0.9 MB if all were backed off), so the lowest-TVL entries are pruned
   * past it rather than letting the write fail.
   */
  backoffMaxRowBytes: 1_000_000,
} as const;

/** kv_config row holding the per-pool backoff map (one read and at most one write per run). */
const STALE_POOL_REFRESH_BACKOFF_KEY = "dex_stale_pool_refresh_backoff";

/**
 * Why an attempted pool was not refreshed, in pipeline order: a pool with
 * several stablecoin attributions reports the furthest stage any of them
 * reached. `transport` (failed request, or a pool missing from a
 * schema-degraded answer) is a provider failure and never backs a pool off.
 */
const STALE_POOL_REFRESH_FAILURE_REASONS = [
  "transport",
  "notReturned",
  "parseFailed",
  "poolIdMismatch",
  "untrackedToken",
  "blockedDex",
  "minTvl",
  "incoherentPrice",
  "implausiblePrice",
  "turnoverCeiling",
  "invalidRow",
] as const;

export type StalePoolRefreshFailureReason = (typeof STALE_POOL_REFRESH_FAILURE_REASONS)[number];

const FAILURE_BY_ADMISSION_REJECT: Readonly<Record<CgOnchainPoolRejectReason, StalePoolRefreshFailureReason>> = {
  "blocked-dex": "blockedDex",
  "untracked-leg": "untrackedToken",
  "min-tvl": "minTvl",
  "incoherent-price": "incoherentPrice",
  "implausible-price": "implausiblePrice",
  "turnover-ceiling": "turnoverCeiling",
};

function furtherFailure(
  a: StalePoolRefreshFailureReason,
  b: StalePoolRefreshFailureReason,
): StalePoolRefreshFailureReason {
  return STALE_POOL_REFRESH_FAILURE_REASONS.indexOf(b) > STALE_POOL_REFRESH_FAILURE_REASONS.indexOf(a) ? b : a;
}

interface StalePoolRefreshBackoffEntry {
  /** Consecutive attempted runs that ended without a refresh (transport failures excluded). */
  misses: number;
  /** `nowSec` of the latest such attempt. */
  at: number;
  reason: StalePoolRefreshFailureReason;
}

/**
 * Direct-API families that publish no 24h volume. Their exact pool ids are
 * refreshed through CoinGecko onchain so a same-id `cg_onchain` reading exists.
 */
const SLIPSTREAM_REFRESH_SCOPES = [
  { chain: "base", poolTypePrefix: "aerodrome-slipstream" },
  { chain: "optimism", poolTypePrefix: "velodrome-slipstream" },
] as const;

const SLIPSTREAM_SCOPE_SQL = SLIPSTREAM_REFRESH_SCOPES
  .map(() => "(r.chain = ? AND r.pool_type LIKE ? || '%')")
  .join(" OR ");

// One row per stablecoin attribution whose CG-family reading is due, plus
// retained Slipstream rows lacking a fresh same-id CG-family reading. The
// NOT EXISTS probe rides the (stablecoin_id, pool_id, source) primary key.
const SELECT_REFRESH_CANDIDATES_SQL = `SELECT r.pool_id, r.stablecoin_id, r.source, r.chain, r.protocol, r.dex_id, r.tvl_usd, r.refreshed_at
  FROM dex_pool_registry r
 WHERE r.refreshed_at >= ?
   AND (r.source IN ('cg_onchain', 'gecko_terminal')
     OR (r.source = 'direct_api' AND (${SLIPSTREAM_SCOPE_SQL})))
   AND NOT EXISTS (
     SELECT 1 FROM dex_pool_registry f
      WHERE f.stablecoin_id = r.stablecoin_id
        AND f.pool_id = r.pool_id
        AND f.source IN ('cg_onchain', 'gecko_terminal')
        AND f.refreshed_at >= ?)`;

interface RefreshCandidateRow {
  pool_id: string;
  stablecoin_id: string;
  source: string;
  chain: string;
  protocol: string;
  dex_id: string | null;
  tvl_usd: number | null;
  refreshed_at: number;
}

export interface StalePoolRefreshCandidate {
  poolId: string;
  chain: string;
  network: string;
  address: string;
  /** Largest retained TVL across the pool's stablecoin attributions. */
  tvlUsd: number;
  /** No CG-family reading inside the 24h window (includes never-read Slipstream pools). */
  expired: boolean;
  stablecoinIds: string[];
}

interface StalePoolRefreshBatch {
  network: string;
  candidates: StalePoolRefreshCandidate[];
}

type StalePoolRefreshOutcome =
  | "completed"
  | "no-due-pools"
  | "skipped-no-api-key"
  | "skipped-circuit-open"
  | "skipped-insufficient-budget"
  | "stopped-budget"
  | "stopped-provider-failures"
  | "stopped-circuit-opened"
  | "failed";

export interface StalePoolRefreshSummary {
  outcome: StalePoolRefreshOutcome;
  /** Distinct tracked pools due for refresh this run (before backoff and the request cap). */
  poolsDue: number;
  /** Pools packed into this run's planned requests. */
  poolsSelected: number;
  requests: number;
  /** Pools with at least one admitted row persisted. */
  refreshed: number;
  /** Attempted pools not refreshed; always the sum of `failures`. */
  failed: number;
  /** Attempted pools not refreshed, by the furthest pipeline stage they reached. */
  failures: Record<StalePoolRefreshFailureReason, number>;
  /** Due pools skipped this run because an earlier attempt returned them unrefreshable. */
  backedOff: number;
  /** Largest retained attribution TVL summed over the backed-off pools. */
  backedOffTvl: number;
  /** Backoff entries dropped (lowest TVL first) to keep the state row under `backoffMaxRowBytes`. */
  backoffPruned: number;
  /** Eligible due pools not attempted this run; they stay due for the next run. */
  deferred: number;
  rowsWritten: number;
  /** Due rows on chains without a CoinGecko onchain network (left to cohort discovery). */
  unsupportedPools: number;
  /** Due pools none of whose attributions is an active stablecoin deployed on the pool's chain. */
  untrackedPools: number;
  /** Expired pools (no in-window reading) still without one after this run, backed-off pools included. */
  stalePoolsRemaining: number;
  staleTvlRemaining: number;
  error?: string;
}

export interface StalePoolRefreshDependencies {
  shouldAttemptFetch: typeof shouldAttemptFetch;
  recordOutcome: typeof recordOutcome;
  fetchCgPoolsByAddressesWithStatus: typeof fetchCgPoolsByAddressesWithStatus;
  sleepWithSignal: typeof sleepWithSignal;
}

const defaultDependencies: StalePoolRefreshDependencies = {
  shouldAttemptFetch,
  recordOutcome,
  fetchCgPoolsByAddressesWithStatus,
  sleepWithSignal,
};

type RefreshStablecoin = {
  id: string;
  contracts?: readonly Pick<ContractDeployment, "chain" | "address">[];
  tradedContracts?: readonly Pick<ContractDeployment, "chain" | "address">[];
};

interface RefreshStalePoolsOptions {
  db: D1Database;
  cgApiKey: string | null;
  stablecoins: readonly RefreshStablecoin[];
  nowSec: number;
  /** Hard stop for this pass; the caller subtracts its own finalization reserve. */
  deadlineMs: number;
  signal?: AbortSignal;
  references?: PriceValidationReferences;
  dependencies?: StalePoolRefreshDependencies;
}

type RankedCandidate = StalePoolRefreshCandidate & { backoff: StalePoolRefreshBackoffEntry | null };

type AttemptOutcome = StalePoolRefreshFailureReason | "refreshed";

function deploymentKey(stablecoinId: string, chain: string): string {
  return `${stablecoinId}\u0000${chain}`;
}

/**
 * Collapse due registry rows into one candidate per physical pool id, ordered
 * stale-first: pools with no in-window reading before pools merely due, then
 * by retained TVL descending, then pool id for a deterministic tie-break.
 * Blocked DEX rows are never candidates: admission would reject every reading,
 * so they would only spend request slots and count as stale TVL until they age
 * out of the registry horizon. Attributions to a stablecoin with no tracked
 * deployment on the pool's chain (inactive or frozen coins) are dropped for the
 * same reason, since no pool leg can ever match. A pool still inside its
 * backoff window is returned in `backedOff` instead of `candidates`; a backoff
 * entry older than the pool's newest CG-family reading is discarded, because
 * another writer admitted the pool after that miss.
 */
function buildStalePoolRefreshCandidates(
  rows: readonly RefreshCandidateRow[],
  nowSec: number,
  deployments: ReadonlyMap<string, ReadonlySet<string>>,
  backoff: ReadonlyMap<string, StalePoolRefreshBackoffEntry>,
): { candidates: RankedCandidate[]; backedOff: RankedCandidate[]; unsupportedPools: number; untrackedPools: number } {
  const policy = STALE_POOL_REFRESH_POLICY;
  const staleCutoff = nowSec - policy.staleAgeSec;
  const byPoolId = new Map<string, StalePoolRefreshCandidate & { latestCgRefreshAt: number | null }>();
  const unsupported = new Set<string>();
  const untracked = new Set<string>();
  for (const row of rows) {
    if (isBlockedDexId(row.dex_id) || isBlockedDexId(row.protocol)) continue;
    const network = CG_CHAIN_MAP[row.chain] ?? CHAIN_META[row.chain]?.providers?.coingecko;
    const prefix = `${row.chain}:`;
    if (!network || !row.pool_id.startsWith(prefix) || row.pool_id.length === prefix.length) {
      unsupported.add(row.pool_id);
      continue;
    }
    if (!deployments.has(deploymentKey(row.stablecoin_id, row.chain))) {
      untracked.add(row.pool_id);
      continue;
    }
    let candidate = byPoolId.get(row.pool_id);
    if (!candidate) {
      candidate = {
        poolId: row.pool_id,
        chain: row.chain,
        network,
        address: row.pool_id.slice(prefix.length),
        tvlUsd: 0,
        expired: true,
        stablecoinIds: [],
        latestCgRefreshAt: null,
      };
      byPoolId.set(row.pool_id, candidate);
    }
    if (row.tvl_usd != null && Number.isFinite(row.tvl_usd)) {
      candidate.tvlUsd = Math.max(candidate.tvlUsd, row.tvl_usd);
    }
    if (!candidate.stablecoinIds.includes(row.stablecoin_id)) candidate.stablecoinIds.push(row.stablecoin_id);
    if (row.source !== "direct_api") {
      candidate.latestCgRefreshAt = Math.max(candidate.latestCgRefreshAt ?? row.refreshed_at, row.refreshed_at);
    }
  }
  const ranked: RankedCandidate[] = [];
  for (const { latestCgRefreshAt, ...candidate } of byPoolId.values()) {
    candidate.expired = latestCgRefreshAt == null || latestCgRefreshAt < staleCutoff;
    candidate.stablecoinIds.sort();
    const entry = backoff.get(candidate.poolId) ?? null;
    const current = entry && (latestCgRefreshAt == null || latestCgRefreshAt <= entry.at) ? entry : null;
    ranked.push({ ...candidate, backoff: current });
  }
  ranked.sort((a, b) =>
    Number(b.expired) - Number(a.expired) ||
    b.tvlUsd - a.tvlUsd ||
    (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
  // Half a tick of slack so cron start jitter never pushes a retry one run late.
  const slackSec = CRON_INTERVALS["sync-dex-discovery"] / 2;
  const candidates: RankedCandidate[] = [];
  const backedOff: RankedCandidate[] = [];
  for (const candidate of ranked) {
    const entry = candidate.backoff;
    const retryAt = entry
      ? entry.at + Math.min(policy.backoffBaseSec * 2 ** (entry.misses - 1), policy.backoffMaxSec) - slackSec
      : nowSec;
    (nowSec >= retryAt ? candidates : backedOff).push(candidate);
  }
  for (const poolId of byPoolId.keys()) {
    unsupported.delete(poolId);
    untracked.delete(poolId);
  }
  return { candidates, backedOff, unsupportedPools: unsupported.size, untrackedPools: untracked.size };
}

async function readStalePoolRefreshBackoff(
  db: D1Database,
): Promise<{ raw: string | null; entries: Map<string, StalePoolRefreshBackoffEntry> }> {
  const row = await db
    .prepare("SELECT value FROM kv_config WHERE key = ?")
    .bind(STALE_POOL_REFRESH_BACKOFF_KEY)
    .first<{ value?: string }>();
  const raw = row?.value ?? null;
  const entries = new Map<string, StalePoolRefreshBackoffEntry>();
  // A malformed payload degrades to "no backoff": every due pool is attempted once more.
  const parsed = tryParseJson(raw, "dex stale pool refresh backoff");
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return { raw, entries };
  for (const [poolId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value == null || typeof value !== "object") continue;
    const { misses, at, reason } = value as Record<string, unknown>;
    if (
      typeof misses === "number" && Number.isInteger(misses) && misses >= 1 &&
      typeof at === "number" && Number.isFinite(at) &&
      typeof reason === "string" && (STALE_POOL_REFRESH_FAILURE_REASONS as readonly string[]).includes(reason)
    ) {
      entries.set(poolId, { misses, at, reason: reason as StalePoolRefreshFailureReason });
    }
  }
  return { raw, entries };
}

/**
 * Pack prioritized candidates into per-network requests. A request opens at
 * its highest-priority member's rank, and lower-priority pools on the same
 * network ride along until the address ceiling, so the per-run cap spends
 * requests on the most valuable networks first without wasting address slots.
 */
export function planStalePoolRefreshBatches(
  candidates: readonly StalePoolRefreshCandidate[],
  maxRequests: number,
  addressesPerRequest: number = STALE_POOL_REFRESH_POLICY.addressesPerRequest,
): StalePoolRefreshBatch[] {
  const batches: StalePoolRefreshBatch[] = [];
  const openByNetwork = new Map<string, StalePoolRefreshBatch>();
  for (const candidate of candidates) {
    let batch = openByNetwork.get(candidate.network);
    if (!batch || batch.candidates.length >= addressesPerRequest) {
      batch = { network: candidate.network, candidates: [] };
      batches.push(batch);
      openByNetwork.set(candidate.network, batch);
    }
    batch.candidates.push(candidate);
  }
  return batches.slice(0, Math.max(0, maxRequests));
}

function buildDeploymentIndex(stablecoins: readonly RefreshStablecoin[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const coin of stablecoins) {
    for (const { chain, address } of [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])]) {
      const key = deploymentKey(coin.id, chain);
      const addresses = index.get(key) ?? new Set<string>();
      addresses.add(canonicalExitRouteScopedId(chain, address));
      index.set(key, addresses);
    }
  }
  return index;
}

export async function refreshStaleRegistryPools({
  db,
  cgApiKey,
  stablecoins,
  nowSec,
  deadlineMs,
  signal,
  references,
  dependencies = defaultDependencies,
}: RefreshStalePoolsOptions): Promise<StalePoolRefreshSummary> {
  const policy = STALE_POOL_REFRESH_POLICY;
  const summary: StalePoolRefreshSummary = {
    outcome: "completed",
    poolsDue: 0,
    poolsSelected: 0,
    requests: 0,
    refreshed: 0,
    failed: 0,
    failures: Object.fromEntries(STALE_POOL_REFRESH_FAILURE_REASONS.map((reason) => [reason, 0])) as Record<
      StalePoolRefreshFailureReason,
      number
    >,
    backedOff: 0,
    backedOffTvl: 0,
    backoffPruned: 0,
    deferred: 0,
    rowsWritten: 0,
    unsupportedPools: 0,
    untrackedPools: 0,
    stalePoolsRemaining: 0,
    staleTvlRemaining: 0,
  };
  const apiKey = cgApiKey?.trim() ? cgApiKey : null;
  if (!apiKey) return { ...summary, outcome: "skipped-no-api-key" };

  const passDeadlineMs = Math.min(deadlineMs, Date.now() + policy.budgetMs);
  const coherence = createPoolPriceCoherenceAdmissionGate("dex-discovery", "CG onchain stale refresh");
  const deployments = buildDeploymentIndex(stablecoins);
  const attemptOutcomes = new Map<string, AttemptOutcome>();
  let candidates: RankedCandidate[] = [];
  let backedOff: RankedCandidate[] = [];
  // Stays undefined until the backoff row is read, so a failed registry read never rewrites it.
  let backoffRaw: string | null | undefined;

  try {
    const rows = await db
      .prepare(SELECT_REFRESH_CANDIDATES_SQL)
      .bind(
        nowSec - policy.horizonSec,
        ...SLIPSTREAM_REFRESH_SCOPES.flatMap((scope) => [scope.chain, scope.poolTypePrefix]),
        nowSec - policy.dueAgeSec,
      )
      .all<RefreshCandidateRow>();
    const backoff = await readStalePoolRefreshBackoff(db);
    backoffRaw = backoff.raw;
    const built = buildStalePoolRefreshCandidates(rows.results ?? [], nowSec, deployments, backoff.entries);
    candidates = built.candidates;
    backedOff = built.backedOff;
    summary.unsupportedPools = built.unsupportedPools;
    summary.untrackedPools = built.untrackedPools;
    summary.poolsDue = candidates.length + backedOff.length;
    summary.backedOff = backedOff.length;
    summary.backedOffTvl = Math.round(backedOff.reduce((total, candidate) => total + candidate.tvlUsd, 0));

    if (candidates.length === 0) {
      summary.outcome = "no-due-pools";
    } else if (Date.now() + policy.requestTimeoutMs >= passDeadlineMs) {
      summary.outcome = "skipped-insufficient-budget";
    } else if (!(await dependencies.shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_ONCHAIN))) {
      summary.outcome = "skipped-circuit-open";
    } else {
      const batches = planStalePoolRefreshBatches(candidates, policy.maxRequestsPerRun);
      summary.poolsSelected = batches.reduce((total, batch) => total + batch.candidates.length, 0);
      let consecutiveFailures = 0;

      for (const batch of batches) {
        throwIfAborted(signal);
        if (consecutiveFailures >= policy.maxConsecutiveFailures) {
          summary.outcome = "stopped-provider-failures";
          break;
        }
        if (Date.now() + policy.requestTimeoutMs >= passDeadlineMs) {
          summary.outcome = "stopped-budget";
          break;
        }
        if (summary.requests > 0) {
          await dependencies.sleepWithSignal(RATE_LIMITS.COINGECKO_ONCHAIN_MS, signal);
        }
        summary.requests += 1;

        let result: CgPoolsByAddressResult;
        let succeeded: boolean;
        try {
          result = await dependencies.fetchCgPoolsByAddressesWithStatus(
            batch.network,
            batch.candidates.map((candidate) => candidate.address),
            buildStageSignal(signal, passDeadlineMs, policy.requestTimeoutMs),
            apiKey,
            { maxRetries: 0, timeoutMs: policy.requestTimeoutMs },
          );
          const classification = classifyCoinGeckoResult(result);
          succeeded = classification.retryable !== true;
        } catch (err) {
          // Only the run's own abort escapes; a per-request timeout is a provider failure.
          if (signal?.aborted) throw err;
          result = { transportOk: false, schemaDegraded: false, pools: [] };
          succeeded = classifyCoinGeckoThrownError(err).retryable !== true;
        }
        const circuit = await dependencies.recordOutcome(db, CIRCUIT_SOURCE.CG_ONCHAIN, succeeded);
        consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;

        if (succeeded && result.transportOk) {
          // A schema-degraded answer dropped rows it could not validate, so a
          // missing pool there is unproven absence and must not back off.
          const classified = classifyRefreshBatch(
            batch,
            result.pools,
            result.schemaDegraded ? "transport" : "notReturned",
            deployments,
            nowSec,
            references,
            coherence,
          );
          if (classified.staged.length > 0) {
            summary.rowsWritten += await upsertStagedPools(db, classified.staged, signal);
          }
          for (const [poolId, outcome] of classified.outcomes) attemptOutcomes.set(poolId, outcome);
        } else {
          for (const candidate of batch.candidates) attemptOutcomes.set(candidate.poolId, "transport");
        }
        if (circuit.after.state === "open") {
          summary.outcome = "stopped-circuit-opened";
          break;
        }
      }
    }
  } catch (err) {
    rethrowIfAborted(err, signal);
    summary.outcome = "failed";
    summary.error = err instanceof Error ? err.message : String(err);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dex_discovery.stale_pool_refresh_failed",
      job: "sync-dex-discovery",
      message: "Stale registry pool refresh failed; cohort discovery continues",
      error: err,
    });
  } finally {
    coherence.flush();
  }

  for (const outcome of attemptOutcomes.values()) {
    if (outcome === "refreshed") summary.refreshed += 1;
    else summary.failures[outcome] += 1;
  }
  summary.failed = attemptOutcomes.size - summary.refreshed;
  summary.deferred = candidates.length - attemptOutcomes.size;
  const duePools = [...candidates, ...backedOff];
  for (const candidate of duePools) {
    if (!candidate.expired || attemptOutcomes.get(candidate.poolId) === "refreshed") continue;
    summary.stalePoolsRemaining += 1;
    summary.staleTvlRemaining += candidate.tvlUsd;
  }
  summary.staleTvlRemaining = Math.round(summary.staleTvlRemaining);

  if (backoffRaw !== undefined) {
    summary.backoffPruned = await writeStalePoolRefreshBackoff(db, backoffRaw, duePools, attemptOutcomes, nowSec, signal);
  }
  return summary;
}

/**
 * Match one `/pools/multi` answer back to its requested candidates and run each
 * returned pool through parse, pool-id key, tracked-leg and admission checks.
 * Every candidate gets exactly one outcome; admitted rows that
 * `upsertStagedPools` would drop count as `invalidRow`, never as refreshed.
 * `absentOutcome` labels a requested pool missing from the answer.
 */
function classifyRefreshBatch(
  batch: StalePoolRefreshBatch,
  pools: readonly CgPool[],
  absentOutcome: "notReturned" | "transport",
  deployments: ReadonlyMap<string, ReadonlySet<string>>,
  nowSec: number,
  references: PriceValidationReferences | undefined,
  coherence: PoolPriceCoherenceAdmissionGate,
): { staged: StagedPool[]; outcomes: Map<string, AttemptOutcome> } {
  const chain = batch.candidates[0]!.chain;
  const parsedByPoolId = new Map<string, { pool: CgPool; parsed: ParsedPool }>();
  // Raw provider address → pool, only to tell "not returned" from a pool that
  // came back unparseable or under a different canonical key.
  const returnedByAddress = new Map<string, CgPool>();
  for (const pool of pools) {
    const address = pool.attributes.address?.trim().toLowerCase();
    if (address) returnedByAddress.set(address, pool);
    const parsed = parseCgPool(pool, chain);
    if (parsed) parsedByPoolId.set(canonicalExitRouteScopedKey(chain, parsed.poolAddress), { pool, parsed });
  }

  const staged: StagedPool[] = [];
  const outcomes = new Map<string, AttemptOutcome>();
  for (const candidate of batch.candidates) {
    const hit = parsedByPoolId.get(candidate.poolId);
    if (!hit) {
      const returned = returnedByAddress.get(candidate.address.toLowerCase());
      outcomes.set(
        candidate.poolId,
        !returned ? absentOutcome : parseCgPool(returned, chain) ? "poolIdMismatch" : "parseFailed",
      );
      continue;
    }
    const { pool, parsed } = hit;
    let failure: StalePoolRefreshFailureReason = "untrackedToken";
    let admitted = false;
    for (const stablecoinId of candidate.stablecoinIds) {
      const tracked = deployments.get(deploymentKey(stablecoinId, candidate.chain));
      const trackedAddress = tracked?.has(parsed.baseTokenAddress)
        ? parsed.baseTokenAddress
        : tracked?.has(parsed.quoteTokenAddress)
          ? parsed.quoteTokenAddress
          : null;
      if (!trackedAddress) continue;
      const admission = admitCgOnchainPool({
        pool,
        parsed,
        poolId: candidate.poolId,
        chain: candidate.chain,
        trackedAddress,
        context: { stablecoinId, nowSec, references },
        coherence,
      });
      if (!("pool" in admission)) {
        failure = furtherFailure(failure, FAILURE_BY_ADMISSION_REJECT[admission.reason]);
      } else if (!isValidStagedPoolId(admission.pool.poolId) || !hasValidStagedPoolTvl(admission.pool)) {
        failure = furtherFailure(failure, "invalidRow");
      } else {
        staged.push(admission.pool);
        admitted = true;
      }
    }
    outcomes.set(candidate.poolId, admitted ? "refreshed" : failure);
  }
  return { staged, outcomes };
}

/**
 * Persist the next backoff map, keyed only by pools still due. A refreshed pool
 * leaves the map; a pool the provider answered for without a refresh records
 * one more miss; a transport failure or an unattempted pool keeps its entry
 * unchanged. The due set is not capped by the request budget, so a row over
 * `backoffMaxRowBytes` keeps the highest-TVL entries (pool id breaks ties) and
 * drops the rest, which are simply re-attempted next run. A write failure is
 * logged and never fails the pass: runs keep re-attempting every due pool
 * until a write succeeds. Returns the number of entries pruned.
 */
async function writeStalePoolRefreshBackoff(
  db: D1Database,
  previousRaw: string | null,
  duePools: readonly RankedCandidate[],
  attemptOutcomes: ReadonlyMap<string, AttemptOutcome>,
  nowSec: number,
  signal?: AbortSignal,
): Promise<number> {
  const entries: Array<{ candidate: RankedCandidate; entry: StalePoolRefreshBackoffEntry; bytes: number }> = [];
  // Pool ids are ASCII (isValidStagedPoolId), so string length equals UTF-8 bytes.
  let totalBytes = 2;
  for (const candidate of duePools) {
    const outcome = attemptOutcomes.get(candidate.poolId);
    if (outcome === "refreshed") continue;
    let entry: StalePoolRefreshBackoffEntry | null;
    if (outcome === undefined || outcome === "transport") {
      entry = candidate.backoff;
    } else {
      entry = { misses: (candidate.backoff?.misses ?? 0) + 1, at: nowSec, reason: outcome };
    }
    if (!entry) continue;
    // `"id":{...}` plus its separating comma.
    const bytes = JSON.stringify(candidate.poolId).length + JSON.stringify(entry).length + 2;
    entries.push({ candidate, entry, bytes });
    totalBytes += bytes;
  }
  let kept = entries;
  if (totalBytes > STALE_POOL_REFRESH_POLICY.backoffMaxRowBytes) {
    const byValue = [...entries].sort((a, b) =>
      b.candidate.tvlUsd - a.candidate.tvlUsd ||
      (a.candidate.poolId < b.candidate.poolId ? -1 : a.candidate.poolId > b.candidate.poolId ? 1 : 0));
    const keep = new Set<string>();
    let bytes = 2;
    for (const item of byValue) {
      if (bytes + item.bytes > STALE_POOL_REFRESH_POLICY.backoffMaxRowBytes) break;
      bytes += item.bytes;
      keep.add(item.candidate.poolId);
    }
    kept = entries.filter((item) => keep.has(item.candidate.poolId));
  }
  const next: Record<string, StalePoolRefreshBackoffEntry> = {};
  for (const { candidate, entry } of kept) next[candidate.poolId] = entry;
  const pruned = entries.length - kept.length;
  const serialized = JSON.stringify(next);
  if (serialized === (previousRaw ?? "{}")) return pruned;
  try {
    throwIfAborted(signal);
    await db
      .prepare(
        `INSERT INTO kv_config (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .bind(STALE_POOL_REFRESH_BACKOFF_KEY, serialized)
      .run();
  } catch (err) {
    rethrowIfAborted(err, signal);
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "dex_discovery.stale_pool_refresh_backoff_write_failed",
      job: "sync-dex-discovery",
      message: "Stale pool refresh backoff state was not saved; the next run retries those pools",
      error: err,
    });
  }
  return pruned;
}
