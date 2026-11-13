import { DEX_FRESHNESS_SEC } from "@shared/lib/depeg-config";
import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { WORKER_ACTIVE_IDS, WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { DEX_VOLUME_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/dex-volume-availability";
import { CHAIN_META } from "@shared/types/chain-identity";
import { canonicalExitRouteChain, canonicalExitRouteScopedId } from "@shared/types/exit-route-identity";
import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { CG_CHAIN_MAP } from "../../lib/chain-registry";
import { recordOutcome, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { CG_ONCHAIN_MIN_RESERVE_USD, fetchCgPoolsByAddressesWithStatus, fitsCgPoolBatch, isAddressableCgPoolId, onchainRateLimit, type CgPoolsByAddressResult } from "../../lib/coingecko-onchain";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import type { SlotDeadline } from "../../lib/cron-timeouts";
import type { PriceValidationReferences } from "../../lib/price-validation";
import { parseCgPool } from "./coingecko-onchain-shared";
import { evaluatePoolPriceCoherence } from "./pool-price-coherence";
import { isPlausibleDexObservationPrice } from "./price-sanity";
import { applyPoolVolumeEligibility, buildDexPriceObservationsFromRetainedPools, filterRetainedPools, hasDexPricePrimaryReference, isP4OnlyPausedBalancerPool, oldestPriceObservation, quarantineProtocolTvlOutliers } from "./scoring-helpers";
import { suiCoinType } from "./sui/identity";
import { TEMPO_PRICE_BUDGET_MS } from "./tempo-price";
import type { DexPriceObs, PoolEntry, SourcePoolGraph } from "./types";

const PRICE_REFRESH_POLICY = {
  // Full demand (about 1,400 pools, 95 requests) needs 54 to 78 s and hit the 90 s budget in 5 of 26
  // measured hours (2026-11-11 to 13); the readiness cutoff still bounds a late start.
  budgetMs: 150_000,
  // Nov 11-13 evidence: max persistence 64.289 s + 15.711 s margin = 80 s;
  // refresh-end/Tempo timings are unavailable. Margin also covers progress/USDA and
  // the phase remainder (max 5.732 s). Reserve Tempo's separate 20 s cap before this boundary.
  persistenceReserveMs: 80_000,
  requestTimeoutMs: 8_000,
  maxRequests: 125,
  maxConsecutiveFailures: 3,
} as const;

export function priceRefreshDeadlines(readinessDeadlineMs = Infinity, deadline?: SlotDeadline) {
  const tempo = Math.min(deadline?.platformDeadlineMs ?? Infinity, readinessDeadlineMs)
    - PRICE_REFRESH_POLICY.persistenceReserveMs;
  return { refresh: tempo - TEMPO_PRICE_BUDGET_MS, tempo };
}

interface Contributor {
  stablecoinId: string;
  pool: PoolEntry;
  evidence: DexPriceObs;
}
interface Candidate {
  chain: string;
  network: string;
  address: string;
  contributors: Contributor[];
  oldestObservedAt: number | null;
}
interface RefreshGraph {
  metrics: ReadonlyMap<string, SourcePoolGraph>;
  protocolTvlCaps: Map<string, number>;
  primaryPrices: ReadonlyMap<string, number>;
  registryEvaluatedAtSec: number;
  priceObservations?: Map<string, DexPriceObs[]>;
  /** Quote identities captured before the registry merge, never inferred from retained age. */
  observedThisRun?: ReadonlySet<string>;
}

interface Batch {
  network: string;
  candidates: Candidate[];
  split?: true;
}

type PriceRefreshStopReason = "completed" | "request-cap" | "budget" | "deadline" | "consecutive-failures" | "aborted";

function oldestFirst(a: Candidate, b: Candidate): number {
  return (a.oldestObservedAt ?? -Infinity) - (b.oldestObservedAt ?? -Infinity) || a.address.localeCompare(b.address);
}

function oldestBatchFirst(a: Batch, b: Batch): number {
  return oldestFirst(a.candidates[0]!, b.candidates[0]!) || a.network.localeCompare(b.network);
}

// Provider pool IDs include bytes32, suffixed EVM and case-sensitive native identifiers.
function canonicalPoolId(chain: string, id: string): string {
  if (chain === "sui") return canonicalExitRouteScopedId(chain, id);
  return CHAIN_META[chain]?.type === "evm" && /^0x(?:[\da-f]{40}|[\da-f]{64})(?:[._:-]|$)/i.test(id)
    ? id.toLowerCase() : id;
}

function cgPoolId(chain: string, network: string, id: string): string | null {
  return id.startsWith(`${network}_`) ? canonicalPoolId(chain, id.slice(network.length + 1)) : null;
}

function cgScopedId(chain: string, network: string, id: string): string | null {
  return id.startsWith(`${network}_`) ? canonicalExitRouteScopedId(chain, id.slice(network.length + 1)) : null;
}

function observationKey(stablecoinId: string, row: DexPriceObs): string {
  return JSON.stringify([stablecoinId, row.poolKey, row.price, row.observedAt]);
}

function graphPriceEvidence(input: Pick<RefreshGraph, "metrics" | "priceObservations">) {
  return buildDexPriceObservationsFromRetainedPools(
    new Map([...input.metrics].map(([id, graph]) => [id, graph.pools])), input.priceObservations, false,
  );
}

/** Capture only successfully observed live-lane quotes before retained registry rows enter the graph. */
export function captureObservedPoolPrices(input: Pick<RefreshGraph, "metrics" | "priceObservations">, sourceStartedAtSec: number): Set<string> {
  const keys = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  for (const [id, observations] of graphPriceEvidence(input)) for (const row of observations) {
    if (row.poolKey && typeof row.observedAt === "number" && row.observedAt >= sourceStartedAtSec && row.observedAt <= now) {
      keys.add(observationKey(id, row));
    }
  }
  return keys;
}

function planPriceRefresh(input: RefreshGraph) {
  // Eligibility mutates volume views; evaluate snapshots without changing the source graph.
  const originals = new WeakMap<PoolEntry, PoolEntry>();
  const retained = new Map<string, PoolEntry[]>();
  for (const [id, graph] of input.metrics) {
    if (!WORKER_ACTIVE_IDS.has(id)) continue;
    const snapshots = graph.pools.map((pool) => {
      const copy = { ...pool, extra: pool.extra && { ...pool.extra, measurement: pool.extra.measurement && { ...pool.extra.measurement } } };
      originals.set(copy, pool);
      return copy;
    });
    applyPoolVolumeEligibility(snapshots, { asOfSec: input.registryEvaluatedAtSec, maxObservationAgeSec: DEX_VOLUME_OBSERVATION_MAX_AGE_SEC });
    retained.set(id, filterRetainedPools(snapshots.filter((pool) => !isP4OnlyPausedBalancerPool(pool))));
  }
  quarantineProtocolTvlOutliers(retained, input.protocolTvlCaps);
  const metrics = new Map([...retained].filter(([id]) => hasDexPricePrimaryReference(input.primaryPrices.get(id)))
    .map(([id, pools]) => [id, { ...input.metrics.get(id)!, pools: pools.map((pool) => originals.get(pool)!) }]));
  const evidence = graphPriceEvidence({ ...input, metrics });
  const candidates = new Map<string, Candidate>();
  const unsupported: Array<Contributor & { reason: string }> = [];
  let observedThisRun = 0;
  for (const [stablecoinId, graph] of metrics) {
    const byPool = new Map<string, DexPriceObs[]>();
    for (const observation of evidence.get(stablecoinId) ?? []) {
      if (!observation.poolKey || observation.sourceFamily === "cg_tickers") continue;
      const group = byPool.get(observation.poolKey) ?? [];
      group.push(observation);
      byPool.set(observation.poolKey, group);
    }
    for (const pool of graph.pools) {
      const observations = byPool.get(pool.poolId);
      if (!observations?.length) continue;
      if (observations.every((row) => input.observedThisRun?.has(observationKey(stablecoinId, row)))) {
        observedThisRun++;
        continue;
      }
      // Multiple exact fallbacks collapse to one newly read quote; keep their smallest support bound.
      const observation = observations.reduce((a, b) => a.tvl <= b.tvl ? a : b);
      const contributor = { stablecoinId, pool, evidence: observation };
      const chain = canonicalExitRouteChain(pool.chain);
      const network = CG_CHAIN_MAP[chain] ?? CHAIN_META[chain]?.providers?.coingecko;
      const separator = pool.poolId.indexOf(":");
      const id = separator >= 0 && canonicalExitRouteChain(pool.poolId.slice(0, separator)) === chain
        ? pool.poolId.slice(separator + 1) : pool.poolId;
      const address = canonicalPoolId(chain, id);
      const key = `${chain}:${address}`;
      const reason = !network ? "unmapped-network"
        : (address.length > 200 || /^orderbook(?:[:.-]|$)/i.test(address) || !isAddressableCgPoolId(network, address))
          ? "unaddressable-pool" : null;
      if (reason || !network) {
        unsupported.push({ ...contributor, reason: reason! });
        continue;
      }
      const clock = oldestPriceObservation(observations);
      const candidate = candidates.get(key) ?? { chain, network, address, contributors: [], oldestObservedAt: clock };
      candidate.oldestObservedAt = clock == null || candidate.oldestObservedAt == null ? null : Math.min(clock, candidate.oldestObservedAt);
      candidate.contributors.push(contributor);
      candidates.set(key, candidate);
    }
  }
  const networks = new Map<string, Candidate[]>();
  for (const candidate of candidates.values()) {
    const pools = networks.get(candidate.network) ?? [];
    pools.push(candidate);
    networks.set(candidate.network, pools);
  }
  const batches: Batch[] = [];
  for (const [network, pools] of networks) {
    pools.sort(oldestFirst);
    let batch: Batch | undefined;
    for (const candidate of pools) {
      if (!batch || !fitsCgPoolBatch(network, [...batch.candidates.map((row) => row.address), candidate.address])) {
        batch = { network, candidates: [] };
        batches.push(batch);
      }
      batch.candidates.push(candidate);
    }
  }
  batches.sort(oldestBatchFirst);
  return { candidates: [...candidates.values()], batches, unsupported, observedThisRun };
}

/** Full contributor graph demand, including exact direct-evidence fallbacks; never the display top ten. */
export function measurePriceRefreshDemand(input: RefreshGraph, plan = planPriceRefresh(input)) {
  const counts = new Map<string, number>();
  for (const candidate of plan.candidates) counts.set(candidate.network, (counts.get(candidate.network) ?? 0) + 1);
  const networks = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([network, pools]) => ({
    network, pools, requests: plan.batches.filter((batch) => batch.network === network).length,
  }));
  return {
    networks,
    pools: plan.candidates.length,
    requests: networks.reduce((sum, row) => sum + row.requests, 0),
    unsupportedAttributions: plan.unsupported.length,
    observedThisRun: plan.observedThisRun,
  };
}

/** A post-resolution quote overlay: it writes no registry rows and cannot renew value/volume evidence. */
export async function refreshPoolPrices(input: RefreshGraph & {
  db: D1Database;
  sourceStartedAtSec: number;
  apiKey?: string | null;
  references?: PriceValidationReferences;
  signal?: AbortSignal;
  deadline?: SlotDeadline;
  readinessDeadlineMs?: number;
}) {
  const startedAtMs = Date.now();
  const plan = planPriceRefresh(input);
  const summary = {
    elapsedMs: 0,
    stopReason: "completed" as PriceRefreshStopReason,
    sourceStartedAtSec: input.sourceStartedAtSec,
    freshnessBudgetSec: DEX_FRESHNESS_SEC,
    demand: measurePriceRefreshDemand(input, plan),
    requests: 0,
    breakerWrites: 0,
    refreshed: 0,
    unchangedByReason: {} as Record<string, number>,
    byCoin: {} as Record<string, Record<string, number>>,
    byCoinOmitted: 0,
    batchFailures: {} as Record<string, number>,
    batchSplits: 0,
    failures: [] as Array<{ stablecoinId: string; poolId: string; observedAt: number | null; reason: string }>,
    failuresOmitted: 0,
  };
  const omittedCoins = new Set<string>();
  function unchanged(contributor: Contributor, reason: string) {
    summary.unchangedByReason[reason] = (summary.unchangedByReason[reason] ?? 0) + 1;
    if (summary.byCoin[contributor.stablecoinId] || Object.keys(summary.byCoin).length < 25) {
      const coin = summary.byCoin[contributor.stablecoinId] ??= {};
      coin[reason] = (coin[reason] ?? 0) + 1;
    } else omittedCoins.add(contributor.stablecoinId);
    // Samples only: counts live in unchangedByReason/byCoin, and 64 samples (~10 KB)
    // crowded the run's diagnostics out of the 16 KiB sync-dex-liquidity metadata budget.
    if (summary.failures.length < 8) summary.failures.push({
      stablecoinId: contributor.stablecoinId, poolId: contributor.pool.poolId,
      observedAt: contributor.evidence.observedAt ?? null, reason,
    });
    else summary.failuresOmitted++;
  }
  for (const contributor of plan.unsupported) unchanged(contributor, contributor.reason);
  const wallDeadlineMs = startedAtMs + PRICE_REFRESH_POLICY.budgetMs;
  const readinessDeadlineMs = priceRefreshDeadlines(input.readinessDeadlineMs, input.deadline).refresh;
  const deadlineMs = Math.min(wallDeadlineMs, readinessDeadlineMs);
  let blockedReason = !input.apiKey?.trim() ? "missing-api-key" : null;
  if (!blockedReason && plan.candidates.length && !input.signal?.aborted) {
    try {
      if (!await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.CG_ONCHAIN)) blockedReason = "circuit-open";
    } catch {
      blockedReason = "breaker-read-failed";
    }
  }
  let consecutiveFailures = 0;
  function admissionFailure(): string | null {
    if (input.signal?.aborted) {
      summary.stopReason = "aborted";
      return "aborted";
    }
    if (consecutiveFailures >= PRICE_REFRESH_POLICY.maxConsecutiveFailures) {
      summary.stopReason = "consecutive-failures";
      return "consecutive-failures";
    }
    if (blockedReason) {
      summary.stopReason = "aborted";
      return blockedReason;
    }
    if (summary.requests >= PRICE_REFRESH_POLICY.maxRequests) {
      summary.stopReason = "request-cap";
      return "request-cap";
    }
    if (Date.now() + PRICE_REFRESH_POLICY.requestTimeoutMs >= deadlineMs) {
      summary.stopReason = readinessDeadlineMs <= wallDeadlineMs ? "deadline" : "budget";
      return "budget-exhausted";
    }
    return null;
  }
  for (let index = 0; index < plan.batches.length; index++) {
    const batch = plan.batches[index]!;
    let deferredReason = admissionFailure();
    if (!deferredReason) {
      try {
        await onchainRateLimit(summary.requests, input.signal);
      } catch {
        blockedReason = "pacing-failed";
      }
      deferredReason = admissionFailure();
    }
    if (deferredReason) {
      for (const candidate of batch.candidates) for (const contributor of candidate.contributors) unchanged(contributor, deferredReason);
      continue;
    }
    const observedAt = Math.floor(Date.now() / 1000);
    const timeout = createTimeoutSignal({
      timeoutMs: PRICE_REFRESH_POLICY.requestTimeoutMs,
      timeoutReason: new DOMException("DEX price refresh timed out", "TimeoutError"),
      parentSignal: input.signal,
    });
    summary.requests++;
    let result: CgPoolsByAddressResult;
    let transportReason = "coingecko-transport-failure";
    try {
      result = await fetchCgPoolsByAddressesWithStatus(batch.network, batch.candidates.map((row) => row.address), timeout.signal,
        input.apiKey, { timeoutMs: PRICE_REFRESH_POLICY.requestTimeoutMs, maxRetries: 0 });
    } catch (error) {
      transportReason = error instanceof SyntaxError ? "malformed-payload"
        : timeout.isTimedOut() ? "request-timeout" : transportReason;
      result = { transportOk: false, schemaDegraded: false, pools: [] };
    } finally {
      timeout.dispose();
    }
    if (result.rejectedAddresses?.length === batch.candidates.length) {
      summary.requests--;
      for (const candidate of batch.candidates) for (const contributor of candidate.contributors) unchanged(contributor, "unaddressable-pool");
      continue;
    }
    if (input.signal?.aborted) {
      transportReason = "aborted";
      blockedReason = "aborted";
      result = { transportOk: false, schemaDegraded: false, pools: [] };
      summary.stopReason = "aborted";
    } else {
      const success = result.transportOk && !result.schemaDegraded;
      consecutiveFailures = success ? 0 : consecutiveFailures + 1;
      try {
        const outcome = await recordOutcome(input.db, CIRCUIT_SOURCE.CG_ONCHAIN, success);
        summary.breakerWrites++;
        if (outcome.after.state === "open") blockedReason = "circuit-open";
      } catch {
        blockedReason = "breaker-write-failed";
      }
    }
    if (result.batchRejected) {
      const reason = batch.split ? "split-batch-rejected" : "coingecko-batch-rejected";
      summary.batchFailures[reason] = (summary.batchFailures[reason] ?? 0) + 1;
      if (!batch.split && batch.candidates.length > 1) {
        const middle = Math.ceil(batch.candidates.length / 2);
        const remaining: Batch[] = [
          { network: batch.network, candidates: batch.candidates.slice(0, middle), split: true },
          { network: batch.network, candidates: batch.candidates.slice(middle), split: true },
          ...plan.batches.slice(index + 1),
        ];
        remaining.sort(oldestBatchFirst);
        plan.batches.splice(index + 1, plan.batches.length - index - 1, ...remaining);
        summary.batchSplits++;
        continue;
      }
      transportReason = "batch-rejected";
    }
    for (const candidate of batch.candidates) {
      const exactRows = result.pools.filter((row) => cgPoolId(candidate.chain, batch.network, row.id) === candidate.address);
      // Attribute-only matches diagnose wrong IDs; only the indexed network/pool ID admits a quote.
      const rows = exactRows.length ? exactRows : result.pools.filter((row) =>
        canonicalPoolId(candidate.chain, row.attributes.address) === candidate.address);
      const row = rows.length === 1 ? rows[0] : undefined;
      const parsed = row && parseCgPool(row, candidate.chain);
      const tokenIds = row ? [row.relationships.base_token, row.relationships.quote_token].map((leg) =>
        leg.data.type === "token" ? cgScopedId(candidate.chain, batch.network, leg.data.id) : null) : [];
      const identityOk = row && row.type === "pool" &&
        cgPoolId(candidate.chain, batch.network, row.id) === candidate.address &&
        tokenIds.every((id) => id && (CHAIN_META[candidate.chain]?.type === "evm" ? canonicalEvmAddress(id)
          : candidate.chain === "sui" ? suiCoinType(id) : true));
      for (const contributor of candidate.contributors) {
        let reason = result.rejectedAddresses?.includes(candidate.address) ? "unaddressable-pool"
          : !result.transportOk ? transportReason
          : rows.length > 1 ? "ambiguous-pool-identity"
            : !row ? result.schemaDegraded ? "malformed-payload" : "not-returned"
            : !parsed ? "malformed-pool" : !identityOk ? "identity-mismatch" : null;
        if (!reason && parsed) {
          const meta = WORKER_TRACKED_META_BY_ID.get(contributor.stablecoinId);
          const deployments = [...(meta?.contracts ?? []), ...(meta?.tradedContracts ?? [])]
            .filter((deployment) => canonicalExitRouteChain(deployment.chain) === candidate.chain)
            .map((deployment) => canonicalExitRouteScopedId(candidate.chain, deployment.address));
          // Provider network prefixes delimit the identity; Move type names can contain underscores.
          const base = deployments.includes(tokenIds[0]!);
          const quote = deployments.includes(tokenIds[1]!);
          const side = base !== quote ? base ? "base" : "quote" : null;
          const price = side === "base" ? parsed.baseTokenPriceUsd : parsed.quoteTokenPriceUsd;
          const support = Math.min(contributor.pool.tvlUsd, contributor.evidence.tvl, parsed.tvlUsd);
          reason = !side ? "tracked-leg-mismatch"
            : !Number.isFinite(price) || price <= 0 ? "invalid-price"
              : !Number.isFinite(parsed.tvlUsd) || parsed.tvlUsd < CG_ONCHAIN_MIN_RESERVE_USD ? "invalid-support-tvl"
                : evaluatePoolPriceCoherence(side, parsed).verdict === "reject" ? "incoherent-price"
                  : !isPlausibleDexObservationPrice(contributor.stablecoinId, price, input.references) ? "implausible-price" : null;
          if (!reason) {
            Object.assign(contributor.pool, { price, priceObservedAt: observedAt, priceSource: "cg_onchain", priceEvidenceTvlUsd: support });
            summary.refreshed++;
          }
        }
        if (reason) unchanged(contributor, reason);
      }
    }
  }
  summary.elapsedMs = Date.now() - startedAtMs;
  summary.byCoinOmitted = omittedCoins.size;
  return summary;
}

export type PriceRefreshSummary = Awaited<ReturnType<typeof refreshPoolPrices>>;
