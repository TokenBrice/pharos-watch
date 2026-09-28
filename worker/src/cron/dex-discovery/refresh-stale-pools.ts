import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { CHAIN_META } from "@shared/lib/chains";
import { canonicalExitRouteScopedId, canonicalExitRouteScopedKey } from "@shared/lib/exit-route-identity";
import type { ContractDeployment } from "@shared/types/core";
import { rethrowIfAborted, sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { CG_CHAIN_MAP } from "../../lib/chain-registry";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import {
  CG_ONCHAIN_MULTI_POOL_MAX_ADDRESSES,
  fetchCgPoolsByAddressesWithStatus,
  type CgPoolsByAddressResult,
} from "../../lib/coingecko-onchain";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { RATE_LIMITS } from "../../lib/rate-limit";
import { logWorkerEvent } from "../../lib/structured-log";
import { parseCgPool } from "../dex-liquidity/coingecko-onchain-shared";
import { createPoolPriceCoherenceAdmissionGate } from "../dex-liquidity/pool-price-coherence";
import {
  admitCgOnchainPool,
  classifyCoinGeckoResult,
  classifyCoinGeckoThrownError,
} from "./crawl-coingecko-pools";
import { upsertStagedPools } from "./persistence";
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
} as const;

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
const SELECT_REFRESH_CANDIDATES_SQL = `SELECT r.pool_id, r.stablecoin_id, r.source, r.chain, r.tvl_usd, r.refreshed_at
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
  /** Distinct pools due for refresh this run (before the request cap). */
  poolsDue: number;
  /** Pools packed into this run's planned requests. */
  poolsSelected: number;
  requests: number;
  /** Pools with at least one admitted row persisted. */
  refreshed: number;
  /** Attempted pools not refreshed: transport failure, not returned, or not admitted. */
  failed: number;
  /** Due pools not attempted this run; they stay due for the next run. */
  deferred: number;
  rowsWritten: number;
  /** Due rows on chains without a CoinGecko onchain network (left to cohort discovery). */
  unsupportedPools: number;
  /** Expired pools (no in-window reading) still without one after this run. */
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

/**
 * Collapse due registry rows into one candidate per physical pool id, ordered
 * stale-first: pools with no in-window reading before pools merely due, then
 * by retained TVL descending, then pool id for a deterministic tie-break.
 */
function buildStalePoolRefreshCandidates(
  rows: readonly RefreshCandidateRow[],
  nowSec: number,
): { candidates: StalePoolRefreshCandidate[]; unsupportedPools: number } {
  const staleCutoff = nowSec - STALE_POOL_REFRESH_POLICY.staleAgeSec;
  const byPoolId = new Map<string, StalePoolRefreshCandidate & { latestCgRefreshAt: number | null }>();
  const unsupported = new Set<string>();
  for (const row of rows) {
    const network = CG_CHAIN_MAP[row.chain] ?? CHAIN_META[row.chain]?.providers?.coingecko;
    const prefix = `${row.chain}:`;
    if (!network || !row.pool_id.startsWith(prefix) || row.pool_id.length === prefix.length) {
      unsupported.add(row.pool_id);
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
  const candidates: StalePoolRefreshCandidate[] = [];
  for (const { latestCgRefreshAt, ...candidate } of byPoolId.values()) {
    candidate.expired = latestCgRefreshAt == null || latestCgRefreshAt < staleCutoff;
    candidate.stablecoinIds.sort();
    candidates.push(candidate);
  }
  candidates.sort((a, b) =>
    Number(b.expired) - Number(a.expired) ||
    b.tvlUsd - a.tvlUsd ||
    (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
  for (const poolId of byPoolId.keys()) unsupported.delete(poolId);
  return { candidates, unsupportedPools: unsupported.size };
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
      const key = `${coin.id}\u0000${chain}`;
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
    deferred: 0,
    rowsWritten: 0,
    unsupportedPools: 0,
    stalePoolsRemaining: 0,
    staleTvlRemaining: 0,
  };
  const apiKey = cgApiKey?.trim() ? cgApiKey : null;
  if (!apiKey) return { ...summary, outcome: "skipped-no-api-key" };

  const passDeadlineMs = Math.min(deadlineMs, Date.now() + policy.budgetMs);
  const coherence = createPoolPriceCoherenceAdmissionGate("dex-discovery", "CG onchain stale refresh");
  const refreshedPoolIds = new Set<string>();
  let attempted = 0;
  let candidates: StalePoolRefreshCandidate[] = [];

  try {
    const rows = await db
      .prepare(SELECT_REFRESH_CANDIDATES_SQL)
      .bind(
        nowSec - policy.horizonSec,
        ...SLIPSTREAM_REFRESH_SCOPES.flatMap((scope) => [scope.chain, scope.poolTypePrefix]),
        nowSec - policy.dueAgeSec,
      )
      .all<RefreshCandidateRow>();
    const built = buildStalePoolRefreshCandidates(rows.results ?? [], nowSec);
    candidates = built.candidates;
    summary.unsupportedPools = built.unsupportedPools;
    summary.poolsDue = candidates.length;

    if (candidates.length === 0) {
      summary.outcome = "no-due-pools";
    } else if (Date.now() + policy.requestTimeoutMs >= passDeadlineMs) {
      summary.outcome = "skipped-insufficient-budget";
    } else if (!(await dependencies.shouldAttemptFetch(db, CIRCUIT_SOURCE.CG_ONCHAIN))) {
      summary.outcome = "skipped-circuit-open";
    } else {
      const batches = planStalePoolRefreshBatches(candidates, policy.maxRequestsPerRun);
      summary.poolsSelected = batches.reduce((total, batch) => total + batch.candidates.length, 0);
      const deployments = buildDeploymentIndex(stablecoins);
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
        attempted += batch.candidates.length;

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

        const candidateByPoolId = new Map(batch.candidates.map((candidate) => [candidate.poolId, candidate]));
        const staged: StagedPool[] = [];
        const stagedPoolIds = new Set<string>();
        for (const pool of result.pools) {
          const parsed = parseCgPool(pool, batch.candidates[0]!.chain);
          if (!parsed) continue;
          const poolId = canonicalExitRouteScopedKey(batch.candidates[0]!.chain, parsed.poolAddress);
          const candidate = candidateByPoolId.get(poolId);
          if (!candidate) continue;
          for (const stablecoinId of candidate.stablecoinIds) {
            const tracked = deployments.get(`${stablecoinId}\u0000${candidate.chain}`);
            const trackedAddress = tracked?.has(parsed.baseTokenAddress)
              ? parsed.baseTokenAddress
              : tracked?.has(parsed.quoteTokenAddress)
                ? parsed.quoteTokenAddress
                : null;
            if (!trackedAddress) continue;
            const admitted = admitCgOnchainPool({
              pool,
              parsed,
              poolId,
              chain: candidate.chain,
              trackedAddress,
              context: { stablecoinId, nowSec, references },
              coherence,
            });
            if (!admitted) continue;
            staged.push(admitted);
            stagedPoolIds.add(poolId);
          }
        }
        if (staged.length > 0) {
          summary.rowsWritten += await upsertStagedPools(db, staged, signal);
          for (const poolId of stagedPoolIds) refreshedPoolIds.add(poolId);
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

  summary.refreshed = refreshedPoolIds.size;
  summary.failed = attempted - refreshedPoolIds.size;
  summary.deferred = summary.poolsDue - attempted;
  for (const candidate of candidates) {
    if (!candidate.expired || refreshedPoolIds.has(candidate.poolId)) continue;
    summary.stalePoolsRemaining += 1;
    summary.staleTvlRemaining += candidate.tvlUsd;
  }
  summary.staleTvlRemaining = Math.round(summary.staleTvlRemaining);
  return summary;
}
