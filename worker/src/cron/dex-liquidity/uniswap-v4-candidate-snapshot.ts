import { z } from "zod";
import { toErrorMessage } from "@shared/lib/error-utils";
import { readCacheWithPolicy, writeCacheWithPolicy, type CachePolicy, type PolicyCacheRead } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import type { UniswapV4ExecutionCandidate } from "../measured-execution/candidate-types";
import { buildUniswapV4ExecutionCandidateKey } from "../measured-execution/inventory";
import { UNISWAP_V4_CANDIDATE_SNAPSHOT_MAX_AGE_SEC } from "./constants";
import type { UniV3CandidateCarryForwardTelemetry } from "./univ3-candidate-snapshot";

/**
 * Last-known-good Uniswap V4 execution candidates per chain, mirroring the
 * Uni V3 store in `univ3-candidate-snapshot.ts`.
 *
 * The V4 subgraph is the only bulk source of pool identity (pool id,
 * currencies, fee, tick spacing, hook) a V4 quote target is built from, and the
 * Ethereum deployment failed most hourly source stages in 2026-10. Only
 * identity is readmitted: a carried candidate is flagged `carriedFromSnapshot`,
 * cannot supply an implied USD reference, and cannot satisfy the token-fee TVL
 * identity match, so its stored TVL and spot never stand in for current
 * measurements.
 */

const SNAPSHOT_VERSION = 1;

const SnapshotTokenSchema = z.object({
  address: z.string().min(1),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(255),
});

const SnapshotCandidateSchema = z.object({
  chain: z.string().min(1),
  poolId: z.string().regex(/^0x[a-f0-9]{64}$/).transform((value) => value as `0x${string}`),
  hookAddress: z.string().regex(/^0x[a-f0-9]{40}$/).transform((value) => value as `0x${string}`),
  feePips: z.number().int().min(0).max(1_000_000),
  tickSpacing: z.number().int().min(1).max(32_767),
  activeLiquidity: z.string().regex(/^[0-9]+$/),
  tvlUsd: z.number().finite(),
  token0Price: z.number().finite().positive(),
  token1Price: z.number().finite().positive(),
  tokens: z.tuple([SnapshotTokenSchema, SnapshotTokenSchema]).readonly(),
});

const SnapshotPayloadSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  chain: z.string().min(1),
  fetchedAt: z.number().int().nonnegative(),
  candidates: z.array(SnapshotCandidateSchema),
});

type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

/** Same per-chain decision vocabulary as the Uni V3 store. */
export type UniswapV4CandidateCarryForwardTelemetry = UniV3CandidateCarryForwardTelemetry;

export function uniswapV4CandidateSnapshotCacheKey(chain: string): string {
  return `dex-liquidity:uniswap-v4-execution-candidates:v${SNAPSHOT_VERSION}:${chain}`;
}

function snapshotPolicy(chain: string): CachePolicy<SnapshotPayload> {
  return {
    key: uniswapV4CandidateSnapshotCacheKey(chain),
    storage: "d1-kv",
    schemaId: `dex-liquidity:uniswap-v4-execution-candidates:v${SNAPSHOT_VERSION}`,
    ttlSec: UNISWAP_V4_CANDIDATE_SNAPSHOT_MAX_AGE_SEC,
    stale: "reject",
    invalid: "retain",
    decode: (value) => {
      const parsed = SnapshotPayloadSchema.safeParse(JSON.parse(value));
      return parsed.success && parsed.data.chain === chain ? parsed.data : null;
    },
    encode: (value) => JSON.stringify(value),
  };
}

/**
 * Add snapshot candidates whose pool id the live fetch neither produced nor
 * answered. An exact batch that answered a pool as absent or invalid is current
 * evidence and is never overridden by an older listing. Returns the number added.
 */
export function mergeUniswapV4CandidateSnapshot(
  into: Map<string, UniswapV4ExecutionCandidate[]>,
  snapshot: readonly UniswapV4ExecutionCandidate[],
  answeredPoolIds: ReadonlySet<string> = new Set(),
): number {
  const present = new Set<string>();
  for (const bucket of into.values()) {
    for (const candidate of bucket) present.add(`${candidate.chain}:${candidate.poolId}`);
  }
  let added = 0;
  for (const candidate of snapshot) {
    const poolKey = `${candidate.chain}:${candidate.poolId}`;
    if (present.has(poolKey) || answeredPoolIds.has(candidate.poolId)) continue;
    const key = buildUniswapV4ExecutionCandidateKey(
      candidate.chain,
      candidate.tokens.map((token) => token.address),
      candidate.feePips,
    );
    if (key == null) continue;
    const bucket = into.get(key) ?? [];
    bucket.push({ ...candidate, carriedFromSnapshot: true });
    into.set(key, bucket);
    present.add(poolKey);
    added++;
  }
  return added;
}

/**
 * Persist the chains the V4 subgraph fully answered this run (listing and
 * exact reads) and readmit the bounded last-known-good candidates for the
 * chains it did not. Mutates `candidates` for carried chains; the returned
 * telemetry names every decision (ADR-33).
 */
export async function reconcileUniswapV4CandidateSnapshots(input: {
  db: D1Database;
  nowSec: number;
  chains: readonly string[];
  failedChains: ReadonlySet<string>;
  candidates: Map<string, UniswapV4ExecutionCandidate[]>;
  exactAnsweredPoolIdsByChain: ReadonlyMap<string, ReadonlySet<string>>;
  signal?: AbortSignal;
}): Promise<UniswapV4CandidateCarryForwardTelemetry> {
  const telemetry: UniswapV4CandidateCarryForwardTelemetry = [];
  for (const chain of input.chains) {
    const policy = snapshotPolicy(chain);
    if (!input.failedChains.has(chain)) {
      const rows: UniswapV4ExecutionCandidate[] = [];
      for (const bucket of input.candidates.values()) {
        for (const candidate of bucket) if (candidate.chain === chain) rows.push(candidate);
      }
      try {
        await writeCacheWithPolicy(
          input.db,
          policy,
          { version: SNAPSHOT_VERSION, chain, fetchedAt: input.nowSec, candidates: rows },
          input.nowSec,
          input.signal,
        );
        telemetry.push({ chain, outcome: "persisted", candidates: rows.length });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        telemetry.push({ chain, outcome: "persist-failed", candidates: rows.length, error: toErrorMessage(error) });
        logWorkerEvent({
          scope: "handler", level: "warn", event: "uniswap-v4-candidate-snapshot-persist-failed",
          message: "Failed to persist the Uniswap V4 execution-candidate snapshot", job: "sync-dex-liquidity",
          source: "uniswap-v4-subgraph", error, metadata: { chain, candidates: rows.length },
        });
      }
      continue;
    }
    let read: PolicyCacheRead<SnapshotPayload>;
    try {
      read = await readCacheWithPolicy(input.db, policy, input.nowSec, input.signal);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      telemetry.push({ chain, outcome: "unavailable", reason: "read-failed" });
      logWorkerEvent({
        scope: "handler", level: "warn", event: "uniswap-v4-candidate-snapshot-read-failed",
        message: "Failed to read the Uniswap V4 execution-candidate snapshot", job: "sync-dex-liquidity",
        source: "uniswap-v4-subgraph", error, metadata: { chain },
      });
      continue;
    }
    if (read.state !== "fresh") {
      // `stale` is never usable under this policy (`stale: "reject"`).
      telemetry.push({ chain, outcome: "unavailable", reason: read.state });
      continue;
    }
    const added = mergeUniswapV4CandidateSnapshot(
      input.candidates, read.value.candidates, input.exactAnsweredPoolIdsByChain.get(chain),
    );
    const entry = {
      chain, outcome: "carried" as const, fetchedAt: read.value.fetchedAt,
      ageSec: Math.max(0, input.nowSec - read.value.fetchedAt), candidates: read.value.candidates.length, added,
    };
    telemetry.push(entry);
    logWorkerEvent({
      scope: "handler", level: "warn", event: "uniswap-v4-candidate-snapshot-carried",
      message: "Uniswap V4 subgraph did not fully answer; carried the last-known-good execution candidates",
      job: "sync-dex-liquidity", source: "uniswap-v4-subgraph", metadata: entry,
    });
  }
  return telemetry;
}
