import { afterEach, describe, expect, it, vi } from "vitest";

// Synthetic calldata, as in the join suite: the ABI proof re-decode is mocked;
// target/quote identity, clock and capacity-curve checks stay real.
vi.mock("../../measured-execution/quoter-v2", async () => {
  const actual = await vi.importActual("../../measured-execution/quoter-v2");
  return { ...actual, validateQuoterV2ProfileProof: vi.fn(() => []) };
});

import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { DexApiPool } from "../../../lib/dex-api-common";
import type { UniV3ExecutionCandidate } from "../../measured-execution/candidate-types";
import { buildUniV3ExecutionCandidateKey } from "../../measured-execution/inventory";
import { joinDexMeasuredExecutionEvidence } from "../../measured-execution/join";
import { buildDexMeasuredExecutionProfile } from "../../measured-execution/profiles";
import { getDexMeasuredExecutionDeployment } from "../../measured-execution/registry";
import { makeJoinPoints, makeJoinPool, makeJoinQuote } from "../../measured-execution/__tests__/join.test-support";
import { buildRegisteredDirectApiExecutionTarget } from "../process-pool-execution-capability";
import { UNIV3_CANDIDATE_SNAPSHOT_MAX_AGE_SEC } from "../constants";
import {
  mergeUniV3CandidateSnapshot,
  reconcileUniV3CandidateSnapshots,
  univ3CandidateSnapshotCacheKey,
} from "../univ3-candidate-snapshot";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const EURC = "0x1abaea1f7c830bd89acc67ec4af516284b1bc33c";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const NOW = 1_791_573_008;

function candidate(chain: string, poolAddress: string, tokens: [string, string], feePips = 500): UniV3ExecutionCandidate {
  return {
    chain,
    poolAddress,
    feePips,
    tvlUsd: 5_600_000,
    token0Price: 1.08,
    token1Price: 0.925,
    tokens: [
      { address: tokens[0], symbol: "A", decimals: 6 },
      { address: tokens[1], symbol: "B", decimals: 6 },
    ],
  };
}

function candidateMap(...rows: UniV3ExecutionCandidate[]): Map<string, UniV3ExecutionCandidate[]> {
  const map = new Map<string, UniV3ExecutionCandidate[]>();
  for (const row of rows) {
    const key = buildUniV3ExecutionCandidateKey(row.chain, row.tokens.map((token) => token.address), row.feePips)!;
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
}

const ETH_EURC_USDC = candidate("ethereum", "0x95dbb3c7546f22bce375900abfdd64a4e5bd73d6", [EURC, USDC]);
const ETH_EURC_USDT = candidate("ethereum", "0x6d074d42d50399581cc3d303b8024000a7897290", [EURC, USDT], 3000);
const BASE_POOL = candidate("base", "0xe4498baca2d45b775ce820a9b9b52a87d583867c", [EURC, USDC]);

describe("reconcileUniV3CandidateSnapshots", () => {
  it("persists answered chains and leaves failed chains without a snapshot unresolved", async () => {
    const { db, sqlite } = fixtures.open();
    const candidates = candidateMap(ETH_EURC_USDC, BASE_POOL);

    const telemetry = await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum", "base"], failedChains: new Set(["base"]), candidates,
    });

    expect(telemetry).toEqual([
      { chain: "ethereum", outcome: "persisted", candidates: 1 },
      { chain: "base", outcome: "unavailable", reason: "missing" },
    ]);
    const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .get(univ3CandidateSnapshotCacheKey("ethereum")) as { value: string; updated_at: number };
    expect(row.updated_at).toBe(NOW);
    expect(JSON.parse(row.value)).toEqual({ version: 1, chain: "ethereum", fetchedAt: NOW, candidates: [ETH_EURC_USDC] });
    // The live base candidate stays; nothing was written for the failed chain.
    expect(candidates.size).toBe(2);
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(univ3CandidateSnapshotCacheKey("base"))).toBeUndefined();
  });

  it("readmits the last-known-good candidates of a failed chain and reports the carry", async () => {
    const { db } = fixtures.open();
    await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW - 3_600, chains: ["ethereum"], failedChains: new Set(),
      candidates: candidateMap(ETH_EURC_USDC, ETH_EURC_USDT),
    });

    const candidates = candidateMap(BASE_POOL);
    const telemetry = await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum", "base"], failedChains: new Set(["ethereum"]), candidates,
    });

    expect(telemetry).toEqual([
      { chain: "ethereum", outcome: "carried", fetchedAt: NOW - 3_600, ageSec: 3_600, candidates: 2, added: 2 },
      { chain: "base", outcome: "persisted", candidates: 1 },
    ]);
    const eurcUsdc = candidates.get(buildUniV3ExecutionCandidateKey("ethereum", [EURC, USDC], 500)!);
    const eurcUsdt = candidates.get(buildUniV3ExecutionCandidateKey("ethereum", [EURC, USDT], 3000)!);
    expect(eurcUsdc).toEqual([ETH_EURC_USDC]);
    expect(eurcUsdt).toEqual([ETH_EURC_USDT]);
  });

  it("does not overwrite a good snapshot with the partial pages of a failed chain", async () => {
    const { db, sqlite } = fixtures.open();
    await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW - 3_600, chains: ["ethereum"], failedChains: new Set(),
      candidates: candidateMap(ETH_EURC_USDC, ETH_EURC_USDT),
    });

    // Page one answered (the USDC pool), page two timed out: the chain is failed.
    const candidates = candidateMap(ETH_EURC_USDC);
    const telemetry = await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum"], failedChains: new Set(["ethereum"]), candidates,
    });

    expect(telemetry).toEqual([
      { chain: "ethereum", outcome: "carried", fetchedAt: NOW - 3_600, ageSec: 3_600, candidates: 2, added: 1 },
    ]);
    expect([...candidates.values()].flat()).toHaveLength(2);
    const row = sqlite.prepare("SELECT updated_at FROM cache WHERE key = ?")
      .get(univ3CandidateSnapshotCacheKey("ethereum")) as { updated_at: number };
    expect(row.updated_at).toBe(NOW - 3_600);
  });

  it("refuses a snapshot older than the carry bound", async () => {
    const { db } = fixtures.open();
    const fetchedAt = NOW - UNIV3_CANDIDATE_SNAPSHOT_MAX_AGE_SEC - 1;
    await reconcileUniV3CandidateSnapshots({
      db, nowSec: fetchedAt, chains: ["ethereum"], failedChains: new Set(), candidates: candidateMap(ETH_EURC_USDC),
    });

    const candidates = new Map<string, UniV3ExecutionCandidate[]>();
    const telemetry = await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum"], failedChains: new Set(["ethereum"]), candidates,
    });

    expect(telemetry).toEqual([{ chain: "ethereum", outcome: "unavailable", reason: "stale" }]);
    expect(candidates.size).toBe(0);
  });

  it("refuses a malformed or foreign-chain snapshot and leaves the row for inspection", async () => {
    const { db, sqlite } = fixtures.open();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run(univ3CandidateSnapshotCacheKey("ethereum"), JSON.stringify({ version: 1, chain: "base", fetchedAt: NOW, candidates: [] }), NOW);
    insert.run(univ3CandidateSnapshotCacheKey("base"), "{not json", NOW);

    const candidates = new Map<string, UniV3ExecutionCandidate[]>();
    const telemetry = await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum", "base"], failedChains: new Set(["ethereum", "base"]), candidates,
    });

    expect(telemetry).toEqual([
      { chain: "ethereum", outcome: "unavailable", reason: "invalid" },
      { chain: "base", outcome: "unavailable", reason: "invalid" },
    ]);
    expect(candidates.size).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cache").get()).toEqual({ n: 2 });
  });

  it("reports a D1 failure on either side without throwing", async () => {
    const db = mockD1([{ match: "cache", rows: [], throwError: new Error("D1_ERROR: no such table: cache") }]);
    const telemetry = await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum", "base"], failedChains: new Set(["base"]), candidates: candidateMap(ETH_EURC_USDC),
    });

    expect(telemetry).toEqual([
      { chain: "ethereum", outcome: "persist-failed", candidates: 1, error: "D1_ERROR: no such table: cache" },
      { chain: "base", outcome: "unavailable", reason: "read-failed" },
    ]);
  });
});

describe("mergeUniV3CandidateSnapshot", () => {
  it("adds only pools the live fetch did not produce, keyed by the live execution key", () => {
    const into = candidateMap(ETH_EURC_USDC);
    const livePoolCopy = { ...ETH_EURC_USDC, poolAddress: ETH_EURC_USDC.poolAddress.toUpperCase() };

    expect(mergeUniV3CandidateSnapshot(into, [livePoolCopy, ETH_EURC_USDT, ETH_EURC_USDT])).toBe(1);
    expect([...into.values()].flat()).toEqual([ETH_EURC_USDC, ETH_EURC_USDT]);
  });
});

/**
 * The production scenario behind the 2026-10-05..09 Exit flip-flops: a
 * DefiLlama fingerprint pool (no physical address, no fee metadata) must still
 * resolve to its QuoterV2 target when the Ethereum subgraph times out, and the
 * carried identity must publish whatever the newest live quote measures.
 */
describe("carried Uni V3 identity through the target and quote join", () => {
  const POOL = "0x95dbb3c7546f22bce375900abfdd64a4e5bd73d6";
  const LIVE: UniV3ExecutionCandidate = {
    chain: "ethereum", poolAddress: POOL, feePips: 500, tvlUsd: 2_510_499,
    token0Price: 1.0812, token1Price: 0.9249,
    tokens: [{ address: EURC, symbol: "EURC", decimals: 6 }, { address: USDC, symbol: "USDC", decimals: 6 }],
  };

  function resolveFingerprintPool(candidates: Map<string, UniV3ExecutionCandidate[]>) {
    const pool: DexApiPool = {
      source: "uniswap-v3-shadow", chain: "ethereum", poolAddress: `fp:ethereum:uniswap-v3:${EURC}:${USDC}`,
      poolType: "uniswap-v3-unknown-fee",
      tokens: [{ address: EURC, symbol: "EURC", decimals: 6 }, { address: USDC, symbol: "USDC", decimals: 6 }],
      price: 1.08, tvlUsd: 2_510_499, volume24hUsd: 300_000, feeRate: null, balances: null,
    };
    return buildRegisteredDirectApiExecutionTarget({
      pool, stablecoinId: "eurc-circle",
      chainAddressToId: new Map([[`ethereum:${EURC}`, "eurc-circle"], [`ethereum:${USDC}`, "usdc-circle"]]),
      symbolToChainScopedIds: new Map(),
      stablecoinPriceById: new Map([["eurc-circle", 1.0812], ["usdc-circle", 1]]),
      validationReferences: { rates: {}, type: "none", updatedAt: null },
      executionTargetContext: {
        uniV3ExecutionCandidates: candidates, uniswapV4ExecutionCandidates: new Map(),
        measuredTargetCapturedAt: NOW, contractMetaByChainAddress: new Map(),
      },
    });
  }

  async function carriedTarget() {
    const { db } = fixtures.open();
    await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW - 3_600, chains: ["ethereum"], failedChains: new Set(), candidates: candidateMap(LIVE),
    });
    const carried = new Map<string, UniV3ExecutionCandidate[]>();
    await reconcileUniV3CandidateSnapshots({
      db, nowSec: NOW, chains: ["ethereum"], failedChains: new Set(["ethereum"]), candidates: carried,
    });
    return resolveFingerprintPool(carried)?.measuredExecutionTarget;
  }

  it("resolves the fingerprint pool to the same QuoterV2 target as the live listing", async () => {
    const live = resolveFingerprintPool(candidateMap(LIVE))?.measuredExecutionTarget;
    const carried = await carriedTarget();

    expect(live?.poolId).toBe(`ethereum:${POOL}`);
    expect(carried?.targetId).toBe(live?.targetId);
    expect(carried).toMatchObject({ poolId: `ethereum:${POOL}`, feePips: 500, tokenIn: { trackedAssetId: "eurc-circle" } });
    expect(resolveFingerprintPool(new Map())?.executionCapabilityGate?.reason).toBe("target-unresolved");
  });

  it("publishes the newest live quote's depth, not the depth seen before the listing failed", async () => {
    const target = (await carriedTarget())!;
    const deployment = getDexMeasuredExecutionDeployment(target.adapterProfileId, target.chain)!;
    // Raw amounts must round-trip through the target's own reference prices (EURC ≈ $1.08 in, USDC $1 out).
    const quote = (points: readonly (readonly [number, number])[], quotedAt: number) =>
      buildDexMeasuredExecutionProfile({
        target, targetGenerationId: "dex-measured-targets-carried", quoteGenerationId: `dex-measured-quotes-${quotedAt}`,
        quotedAt, blockNumber: 23_000_000, endpointAddress: deployment.endpointAddress,
        endpointCodeHash: deployment.expectedCodeHash,
        points: makeJoinPoints(points).map((point) => ({
          ...point,
          amountInRaw: String(Math.round(point.inputUsd / target.tokenIn.referencePriceUsd * 1_000_000)),
          amountOutRaw: String(Math.round(point.outputUsd / target.tokenOut.referencePriceUsd * 1_000_000)),
        })),
      });
    // Before the outage: $100k executes within 10 bps. After: the pool is drained and $100k costs 10%.
    const before = quote([[1_000, 999.9], [100_000, 99_900]], NOW + 300);
    const drained = quote([[1_000, 999.9], [100_000, 90_000]], NOW + 900);
    const depthAt100k = (curve: readonly { requestedNotionalUsd: number; executableUsd: number }[]) =>
      curve.find((point) => point.requestedNotionalUsd === 100_000)!.executableUsd;
    expect(depthAt100k(drained.capacityCurve)).toBeLessThan(depthAt100k(before.capacityCurve));

    const pool = makeJoinPool(target);
    const diagnostics = joinDexMeasuredExecutionEvidence({
      poolsByStablecoin: new Map([[target.stablecoinId, [pool]]]),
      evidence: {
        quoteGenerationId: drained.quoteGenerationId, targetGenerationId: drained.targetGenerationId,
        publishedAt: NOW + 900, byTargetId: new Map([[target.targetId, makeJoinQuote(target, drained)]]),
      },
      nowSec: NOW + 1_000,
    });

    expect(diagnostics).toMatchObject({ measuredCount: 1, gatedCount: 0, lastKnownGoodCount: 0 });
    expect(pool.extra?.measuredExecution?.quotedAt).toBe(NOW + 900);
    expect(depthAt100k(pool.extra!.measuredExecution!.capacityCurve)).toBe(depthAt100k(drained.capacityCurve));
  });
});
