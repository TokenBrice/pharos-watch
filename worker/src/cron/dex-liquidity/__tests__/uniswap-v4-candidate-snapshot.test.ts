import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { UniswapV4ExecutionCandidate } from "../../measured-execution/candidate-types";
import { buildUniswapV4ExecutionCandidateKey, buildUniswapV4MeasuredExecutionTarget } from "../../measured-execution/inventory";
import { computeUniswapV4PoolId, UNISWAP_V4_HOOK_FREE_ADDRESS } from "../../measured-execution/uniswap-v4";
import { UNISWAP_V4_CANDIDATE_SNAPSHOT_MAX_AGE_SEC } from "../constants";
import {
  reconcileUniswapV4CandidateSnapshots,
  uniswapV4CandidateSnapshotCacheKey,
} from "../uniswap-v4-candidate-snapshot";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const NOW = 1_792_761_098;

function candidate(chain: string, feePips: number): UniswapV4ExecutionCandidate {
  return {
    chain,
    poolId: computeUniswapV4PoolId({
      currency0: USDC, currency1: USDT, feePips, tickSpacing: 1, hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    }),
    hookAddress: UNISWAP_V4_HOOK_FREE_ADDRESS,
    feePips,
    tickSpacing: 1,
    activeLiquidity: "1215742317323",
    tvlUsd: 4_000_000,
    token0Price: 1,
    token1Price: 1,
    tokens: [
      { address: USDC, symbol: "USDC", decimals: 6 },
      { address: USDT, symbol: "USDT", decimals: 6 },
    ],
  };
}

function candidateMap(...rows: UniswapV4ExecutionCandidate[]): Map<string, UniswapV4ExecutionCandidate[]> {
  const map = new Map<string, UniswapV4ExecutionCandidate[]>();
  for (const row of rows) {
    const key = buildUniswapV4ExecutionCandidateKey(row.chain, row.tokens.map((token) => token.address), row.feePips)!;
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

const ETH_100 = candidate("ethereum", 100);
const ETH_500 = candidate("ethereum", 500);
const BASE_100 = candidate("base", 100);

async function seed(db: D1Database, nowSec: number, ...rows: UniswapV4ExecutionCandidate[]) {
  await reconcileUniswapV4CandidateSnapshots({
    db, nowSec, chains: [...new Set(rows.map((row) => row.chain))], failedChains: new Set(),
    candidates: candidateMap(...rows), exactAnsweredPoolIdsByChain: new Map(),
  });
}

describe("reconcileUniswapV4CandidateSnapshots", () => {
  it("persists fully answered chains and leaves a failed chain without a snapshot unresolved", async () => {
    const { db, sqlite } = fixtures.open();
    const candidates = candidateMap(ETH_100, BASE_100);

    const telemetry = await reconcileUniswapV4CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum", "base"], failedChains: new Set(["base"]), candidates,
      exactAnsweredPoolIdsByChain: new Map(),
    });

    expect(telemetry).toEqual([
      { chain: "ethereum", outcome: "persisted", candidates: 1 },
      { chain: "base", outcome: "unavailable", reason: "missing" },
    ]);
    const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?")
      .get(uniswapV4CandidateSnapshotCacheKey("ethereum")) as { value: string };
    expect(JSON.parse(row.value)).toEqual({ version: 1, chain: "ethereum", fetchedAt: NOW, candidates: [ETH_100] });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(uniswapV4CandidateSnapshotCacheKey("base"))).toBeUndefined();
  });

  it("carries a failed chain's last-known-good identity, flagged, without duplicating live or answered pools", async () => {
    const { db } = fixtures.open();
    await seed(db, NOW - 3_600, ETH_100, ETH_500);

    // The live run kept ETH_100; an exact batch answered ETH_500 as absent.
    const candidates = candidateMap(ETH_100);
    const telemetry = await reconcileUniswapV4CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum"], failedChains: new Set(["ethereum"]), candidates,
      exactAnsweredPoolIdsByChain: new Map([["ethereum", new Set([ETH_500.poolId])]]),
    });
    expect(telemetry).toEqual([
      { chain: "ethereum", outcome: "carried", fetchedAt: NOW - 3_600, ageSec: 3_600, candidates: 2, added: 0 },
    ]);
    expect([...candidates.values()].flat()).toEqual([ETH_100]);

    const empty = candidateMap();
    await reconcileUniswapV4CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum"], failedChains: new Set(["ethereum"]), candidates: empty,
      exactAnsweredPoolIdsByChain: new Map(),
    });
    expect([...empty.values()].flat()).toEqual([
      { ...ETH_100, carriedFromSnapshot: true },
      { ...ETH_500, carriedFromSnapshot: true },
    ]);
  });

  it("rejects a snapshot older than the named max age", async () => {
    const { db } = fixtures.open();
    await seed(db, NOW - UNISWAP_V4_CANDIDATE_SNAPSHOT_MAX_AGE_SEC - 1, ETH_100);
    const candidates = candidateMap();

    const telemetry = await reconcileUniswapV4CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum"], failedChains: new Set(["ethereum"]), candidates,
      exactAnsweredPoolIdsByChain: new Map(),
    });

    expect(telemetry).toEqual([{ chain: "ethereum", outcome: "unavailable", reason: "stale" }]);
    expect(candidates.size).toBe(0);
  });

  it("lets a carried identity build only exact-pool-id targets, never a token-fee TVL match", () => {
    const input = {
      stablecoinId: "usdc-circle",
      stablecoinPriceById: new Map([["usdc-circle", 1], ["usdt-tether", 1]]),
      chainAddressToId: new Map([[`ethereum:${USDC}`, "usdc-circle"], [`ethereum:${USDT}`, "usdt-tether"]]),
      retainedTvlUsd: 4_000_000,
      capturedAt: NOW,
    };
    const carried = { ...ETH_100, carriedFromSnapshot: true as const };

    expect(buildUniswapV4MeasuredExecutionTarget({ ...input, candidate: ETH_100, identityMatch: "token-fee" }))
      .not.toBeNull();
    expect(buildUniswapV4MeasuredExecutionTarget({ ...input, candidate: carried, identityMatch: "token-fee" }))
      .toBeNull();
    expect(buildUniswapV4MeasuredExecutionTarget({ ...input, candidate: carried, identityMatch: "exact-pool-id" }))
      .toMatchObject({ protocol: "uniswap-v4", carriedFromSnapshot: true });
  });
});
