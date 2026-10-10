import { z } from "zod";
import { canonicalExitRouteAssetKey } from "@shared/types/exit-route-identity";
import { toErrorMessage } from "@shared/lib/error-utils";
import { readCacheWithPolicy, writeCacheWithPolicy, type CachePolicy, type PolicyCacheRead } from "../../lib/db-cache";
import { logWorkerEvent } from "../../lib/structured-log";
import type { UniV3ExecutionCandidate } from "../measured-execution/candidate-types";
import { buildUniV3ExecutionCandidateKey } from "../measured-execution/inventory";
import { UNIV3_CANDIDATE_SNAPSHOT_MAX_AGE_SEC } from "./constants";

/**
 * Last-known-good Uni V3 execution candidates per chain.
 *
 * The subgraph is the only source of the pool identity (address, token pair,
 * fee, decimals) a QuoterV2 target is built from, and that identity is rebuilt
 * from scratch every hourly source stage. Without this store one failed page
 * erased every Uni V3 target on the chain, so each asset whose best exit route
 * was such a pool fell back to a weaker route and climbed back the next hour.
 *
 * Only candidate identity is persisted and readmitted; price observations from
 * the same pages are measurements and are never carried.
 */

const SNAPSHOT_VERSION = 1;

const SnapshotTokenSchema = z.object({
  address: z.string().min(1),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(255),
});

const SnapshotCandidateSchema = z.object({
  chain: z.string().min(1),
  poolAddress: z.string().min(1),
  feePips: z.number().int().min(0).max(1_000_000),
  tvlUsd: z.number().finite().positive(),
  token0Price: z.number().finite().positive(),
  token1Price: z.number().finite().positive(),
  tokens: z.tuple([SnapshotTokenSchema, SnapshotTokenSchema]),
});

const SnapshotPayloadSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  chain: z.string().min(1),
  fetchedAt: z.number().int().nonnegative(),
  candidates: z.array(SnapshotCandidateSchema),
});

type SnapshotPayload = z.infer<typeof SnapshotPayloadSchema>;

export function univ3CandidateSnapshotCacheKey(chain: string): string {
  return `dex-liquidity:univ3-execution-candidates:v${SNAPSHOT_VERSION}:${chain}`;
}

function snapshotPolicy(chain: string): CachePolicy<SnapshotPayload> {
  return {
    key: univ3CandidateSnapshotCacheKey(chain),
    storage: "d1-kv",
    schemaId: `dex-liquidity:univ3-execution-candidates:v${SNAPSHOT_VERSION}`,
    ttlSec: UNIV3_CANDIDATE_SNAPSHOT_MAX_AGE_SEC,
    stale: "reject",
    invalid: "retain",
    decode: (value) => {
      const parsed = SnapshotPayloadSchema.safeParse(JSON.parse(value));
      return parsed.success && parsed.data.chain === chain ? parsed.data : null;
    },
    encode: (value) => JSON.stringify(value),
  };
}

export type UniV3CandidateCarryForwardEntry =
  | { chain: string; outcome: "persisted"; candidates: number }
  | { chain: string; outcome: "persist-failed"; candidates: number; error: string }
  | { chain: string; outcome: "carried"; fetchedAt: number; ageSec: number; candidates: number; added: number }
  | { chain: string; outcome: "unavailable"; reason: "missing" | "stale" | "invalid" | "read-failed" };

export type UniV3CandidateCarryForwardTelemetry = UniV3CandidateCarryForwardEntry[];

function candidatesForChain(
  candidates: ReadonlyMap<string, readonly UniV3ExecutionCandidate[]>,
  chain: string,
): UniV3ExecutionCandidate[] {
  const rows: UniV3ExecutionCandidate[] = [];
  for (const bucket of candidates.values()) {
    for (const candidate of bucket) if (candidate.chain === chain) rows.push(candidate);
  }
  return rows;
}

/**
 * Add snapshot candidates whose physical pool the live fetch did not already
 * produce (a chain that failed on a later page keeps its earlier pages).
 * Returns the number of candidates added.
 */
export function mergeUniV3CandidateSnapshot(
  into: Map<string, UniV3ExecutionCandidate[]>,
  snapshot: readonly UniV3ExecutionCandidate[],
): number {
  const present = new Set<string>();
  for (const bucket of into.values()) {
    for (const candidate of bucket) present.add(canonicalExitRouteAssetKey(candidate.chain, candidate.poolAddress));
  }
  let added = 0;
  for (const candidate of snapshot) {
    const poolKey = canonicalExitRouteAssetKey(candidate.chain, candidate.poolAddress);
    if (present.has(poolKey)) continue;
    const key = buildUniV3ExecutionCandidateKey(
      candidate.chain,
      candidate.tokens.map((token) => token.address),
      candidate.feePips,
    );
    if (key == null) continue;
    const bucket = into.get(key) ?? [];
    bucket.push(candidate);
    into.set(key, bucket);
    present.add(poolKey);
    added++;
  }
  return added;
}

/**
 * Persist the chains the subgraph answered this run and readmit the bounded
 * last-known-good candidates for the chains it did not. Mutates `candidates`
 * for carried chains; the returned telemetry names every decision so the
 * generation records what was read live and what was carried (ADR-33).
 */
export async function reconcileUniV3CandidateSnapshots(input: {
  db: D1Database;
  nowSec: number;
  chains: readonly string[];
  failedChains: ReadonlySet<string>;
  candidates: Map<string, UniV3ExecutionCandidate[]>;
  signal?: AbortSignal;
}): Promise<UniV3CandidateCarryForwardTelemetry> {
  const telemetry: UniV3CandidateCarryForwardTelemetry = [];
  for (const chain of input.chains) {
    const policy = snapshotPolicy(chain);
    if (!input.failedChains.has(chain)) {
      const rows = candidatesForChain(input.candidates, chain);
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
          scope: "handler", level: "warn", event: "univ3-candidate-snapshot-persist-failed",
          message: "Failed to persist the Uni V3 execution-candidate snapshot", job: "sync-dex-liquidity",
          source: "univ3-subgraph", error, metadata: { chain, candidates: rows.length },
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
        scope: "handler", level: "warn", event: "univ3-candidate-snapshot-read-failed",
        message: "Failed to read the Uni V3 execution-candidate snapshot", job: "sync-dex-liquidity",
        source: "univ3-subgraph", error, metadata: { chain },
      });
      continue;
    }
    if (read.state !== "fresh") {
      // `stale` is never usable under this policy (`stale: "reject"`).
      telemetry.push({ chain, outcome: "unavailable", reason: read.state });
      continue;
    }
    const added = mergeUniV3CandidateSnapshot(input.candidates, read.value.candidates);
    const entry = {
      chain, outcome: "carried" as const, fetchedAt: read.value.fetchedAt,
      ageSec: Math.max(0, input.nowSec - read.value.fetchedAt), candidates: read.value.candidates.length, added,
    };
    telemetry.push(entry);
    logWorkerEvent({
      scope: "handler", level: "warn", event: "univ3-candidate-snapshot-carried",
      message: "Uni V3 subgraph did not answer; carried the last-known-good execution candidates",
      job: "sync-dex-liquidity", source: "univ3-subgraph", metadata: entry,
    });
  }
  return telemetry;
}
